package com.acutest.app.screenshare

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.util.Base64
import androidx.activity.result.ActivityResult
import androidx.core.app.NotificationCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import io.livekit.android.AudioOptions
import io.livekit.android.ConnectOptions
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.RoomOptions
import io.livekit.android.audio.NoAudioHandler
import io.livekit.android.e2ee.E2EEOptions
import io.livekit.android.e2ee.E2EEState
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.participant.VideoTrackPublishDefaults
import io.livekit.android.room.track.LocalVideoTrackOptions
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoCaptureParameter
import io.livekit.android.room.track.VideoEncoding
import io.livekit.android.room.track.screencapture.ScreenCaptureParams
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import livekit.org.webrtc.FrameCryptor
import livekit.org.webrtc.RtpParameters

/**
 * The native SCREEN LEG publisher (Android screen-share plan §4) — a SECOND
 * LiveKit participant, `{user_id}:{device_id}:screen`, publishing only the
 * MediaProjection capture and subscribing to nothing. The WebView cannot do
 * this itself: no Android web runtime exposes `getDisplayMedia`, and a native
 * capture cannot cross into the WebView's sealed WebRTC stack as a track.
 *
 * TWO-PHASE by design (§4.2): `prepare()` runs the OS consent dialog (which is
 * user-paced and easily outlives the 10 s leg token), THEN the JS side mints
 * the token, THEN `connect()` uses it immediately. The single-use
 * `getMediaProjection()` only happens inside the SDK's track start at publish
 * time, so a failed `connect()` does not burn the consent (probe (e)).
 *
 * E2EE is FAIL-CLOSED, witnessed rather than assumed (§0.4 / §0-R.5):
 *  - the raw-byte key provider is built with `discardFrameWhenCryptorNotReady
 *    = true`, so nothing — not plaintext, not garbage — leaves the phone
 *    before the sender cryptor holds the key (probe (c-i): zero frames over
 *    12 s with no key);
 *  - publish happens only after the E2EE manager reports enabled AND the send
 *    key + key index are installed;
 *  - any sender cryptor state other than OK disconnects the leg (the
 *    manager's own observer surfaces them as `TrackE2EEStateEvent`s);
 *  - `setFrameKey` resolves only after `setKey` AND `setKeyIndex` land on
 *    every sender cryptor — libwebrtc's `setKey` alone does NOT move the
 *    sender's index (§0-R.6, empirical in probe (c-iii)), and a rotation that
 *    silently kept encrypting under the removed member's key is exactly the
 *    hole this contract closes.
 *
 * Hygiene (§4.2): key material is held only inside the native key provider
 * (dropped in [tearDown] via `dispose()`), never logged, and never echoed
 * back through resolve/reject/events.
 */
@CapacitorPlugin(name = "ScreenShare")
class ScreenSharePlugin : Plugin() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    /** The MediaProjection consent, between `prepare()` and first publish. */
    private var consentIntent: Intent? = null

    private var room: Room? = null
    private var keyProvider: RawScreenKeyProvider? = null
    private var legIdentity: String? = null
    private var currentKeyIndex: Int = 0
    private var eventsJob: Job? = null

    /** Set while [tearDown] runs so event handlers do not double-report. */
    private var stopping = false

    /**
     * The WebView call's audio mode, snapshotted before the leg's Room is
     * created. Probe (f) showed `NoAudioHandler` keeps AudioManager untouched
     * through create → connect → publish, but Room/audio TEARDOWN reset the
     * global mode to NORMAL even under NoAudioHandler — which would yank the
     * live WebView call out of `MODE_IN_COMMUNICATION`. Re-asserted in
     * [tearDown] if teardown moved it.
     */
    private var savedAudioMode: Int? = null

    @PluginMethod
    fun isAvailable(call: PluginCall) {
        val result = JSObject()
        // MediaProjection exists on every supported API level (21+; minSdk 24).
        result.put("available", true)
        // AudioPlaybackCapture (slice 4) needs API 29.
        result.put("audioCapture", Build.VERSION.SDK_INT >= 29)
        call.resolve(result)
    }

    /**
     * Phase 1: the OS consent dialog + (deferred) FGS. Resolves once the user
     * has granted capture; the JS side then mints the 10 s leg token and calls
     * [connect]. Consent is per-share by OS rule — every share re-prompts.
     */
    @PluginMethod
    fun prepare(call: PluginCall) {
        val activity: Activity = activity ?: run {
            call.reject("no_activity")
            return
        }
        val manager = activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE)
            as MediaProjectionManager
        startActivityForResult(call, manager.createScreenCaptureIntent(), "onConsentResult")
    }

    @ActivityCallback
    private fun onConsentResult(call: PluginCall, result: ActivityResult) {
        val data = result.data
        if (result.resultCode != Activity.RESULT_OK || data == null) {
            call.reject("consent_denied")
            return
        }
        consentIntent = data
        val ok = JSObject()
        ok.put("ok", true)
        call.resolve(ok)
    }

    /**
     * Phase 2: connect the leg and publish. `e2ee` is REQUIRED for a share
     * inside an encrypted call — the JS gate (§7.2) only omits it on a
     * positively-plaintext call. `audio` is accepted for API stability but
     * inert until slice 4 (§0.6): v1 publishes video only.
     */
    @PluginMethod
    fun connect(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("invalid_argument:url")
        val token = call.getString("token") ?: return call.reject("invalid_argument:token")
        val quality = call.getObject("quality") ?: return call.reject("invalid_argument:quality")
        val e2ee = call.getObject("e2ee")

        if (room != null) {
            call.reject("already_connected")
            return
        }
        val intent = consentIntent
        if (intent == null) {
            call.reject("not_prepared")
            return
        }

        scope.launch {
            try {
                doConnect(call, url, token, quality, e2ee, intent)
            } catch (t: Throwable) {
                // The consent survives a failed connect (probe (e)): the
                // single-use getMediaProjection only happens at publish, so
                // JS may retry connect() with a fresh token, no new dialog.
                // tearDown clears the stored consent (right for an ACTIVE
                // share ending), so restore it around the cleanup — unless
                // the failure was the publish itself, which consumed it.
                val consent = consentIntent
                tearDown(reason = null)
                consentIntent = consent
                call.reject("connect_failed: ${t.message ?: t.javaClass.simpleName}")
            }
        }
    }

    private suspend fun doConnect(
        call: PluginCall,
        url: String,
        token: String,
        quality: JSObject,
        e2ee: JSObject?,
        intent: Intent,
    ) {
        val appContext = context.applicationContext
        val audioManager = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        savedAudioMode = audioManager.mode

        // Constructing any KeyProvider before the first LiveKit.create()
        // throws UnsatisfiedLinkError (probe (a) integration fact 2) — the
        // FrameCryptorFactory JNI lives in the SDK's libwebrtc.
        ensureWebRtcLoaded()

        val provider = if (e2ee != null) RawScreenKeyProvider() else null
        keyProvider = provider

        val longSide = quality.getInteger("longSide") ?: 1080
        val fps = quality.getInteger("fps") ?: 30
        val maxBitrateKbps = quality.getInteger("maxBitrateKbps") ?: 3000
        val degradation = when (quality.getString("degradation")) {
            "maintain-framerate" -> RtpParameters.DegradationPreference.MAINTAIN_FRAMERATE
            "maintain-resolution" -> RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION
            else -> RtpParameters.DegradationPreference.BALANCED
        }
        val (width, height) = captureDimensions(longSide)

        val room = LiveKit.create(
            appContext,
            RoomOptions(
                // The leg subscribes to nothing, so adaptiveStream has nothing
                // to adapt and dynacast's layer bookkeeping is one more thing
                // between the encoder and the wire. Single layer, VP8, no
                // backup codec, no simulcast — the phone table (§7.4 / §0.7):
                // fewer encoders on a thermally-constrained device and no
                // E2EE-backup-codec trap (a silently-dropped backup reads as
                // a black tile on viewers).
                adaptiveStream = false,
                dynacast = false,
                e2eeOptions = provider?.let { E2EEOptions(keyProvider = it) },
                screenShareTrackCaptureDefaults = LocalVideoTrackOptions(
                    isScreencast = true,
                    captureParams = VideoCaptureParameter(width, height, fps),
                ),
                screenShareTrackPublishDefaults = VideoTrackPublishDefaults(
                    videoEncoding = VideoEncoding(maxBitrateKbps * 1000, fps),
                    simulcast = false,
                    videoCodec = "vp8",
                    backupCodec = null,
                    degradationPreference = degradation,
                ),
            ),
            LiveKitOverrides(
                // The default AudioSwitchHandler flips the GLOBAL AudioManager
                // into MODE_IN_COMMUNICATION and re-routes speaker/earpiece AT
                // CONNECT, even for a publish-only room with no audio track
                // (probe (f) control run) — which would fight the live WebView
                // call sharing this process. NoAudioHandler leaves it alone.
                audioOptions = AudioOptions(audioHandler = NoAudioHandler()),
            ),
        )
        this.room = room
        stopping = false

        eventsJob = scope.launch {
            room.events.collect { event -> onRoomEvent(event) }
        }

        // Belt-and-braces on the token's canSubscribe=false (§4.3 step 2).
        room.connect(url, token, ConnectOptions(autoSubscribe = false))

        val identity = room.localParticipant.identity?.value
            ?: throw IllegalStateException("no local identity after connect")
        legIdentity = identity

        if (provider != null) {
            // Witness, not assumption (§0.4): the manager only reports enabled
            // once its setup() ran against this Room. Publishing without it
            // would be libwebrtc's cryptor-not-ready PASSTHROUGH — plaintext.
            val manager = room.e2eeManager
            if (manager == null || !manager.enabled) {
                throw IllegalStateException("e2ee manager not enabled")
            }
            val keyB64 = e2ee!!.getString("keyB64")
                ?: throw IllegalArgumentException("e2ee.keyB64 missing")
            val keyIndex = e2ee.getInteger("keyIndex") ?: 0
            currentKeyIndex = keyIndex
            // Raw 32-byte HKDF material at (identity, index) — the provider's
            // getLatestKeyIndex() hands this index to every cryptor the
            // manager creates from now on, which fixes the at-creation and
            // at-reconnect index for free (probe (a)).
            provider.setRawKey(identity, keyIndex, Base64.decode(keyB64, Base64.DEFAULT))
        }

        // The FGS runs with OUR notification (§4.3 step 1, option (a)): the
        // SDK auto-starts its own ScreenCaptureService inside the track start,
        // declared with foregroundServiceType="mediaProjection" via manifest
        // merge, and only builds a default notification when none is passed —
        // exactly one notification on API 34/35/36 (probe (e)).
        val params = ScreenCaptureParams(
            mediaProjectionPermissionResultData = intent,
            notificationId = NOTIFICATION_ID,
            notification = buildNotification(),
            onStop = {
                // System chip / notification Stop / OS revoke.
                scope.launch { tearDown("system") }
            },
        )
        // The consent is consumed by this publish (single-use by OS rule).
        consentIntent = null
        val published = room.localParticipant.setScreenShareEnabled(true, params)
        if (published != true) {
            throw IllegalStateException("screen share publish refused")
        }

        if (provider != null) {
            // Re-assert the send index on the live sender cryptor(s):
            // getLatestKeyIndex covers creation, but verify rather than trust
            // (§0-R.6) — a cryptor sitting at the wrong index encrypts under
            // a key the wrong epoch's members hold.
            assertSenderKeyIndex(currentKeyIndex)
        }

        notifyListeners("started", JSObject())
        val ok = JSObject()
        ok.put("ok", true)
        call.resolve(ok)
    }

    /**
     * Rotation push from `MlsKeyProvider.applyLocalKey` (§5.2). Resolves only
     * after BOTH the key install and the sender-cryptor index switch landed —
     * the JS side awaits this before reporting the local key installed, so a
     * Remove-driven rotation cannot complete while the leg still encrypts
     * under the removed member's key. Any failure here must be treated by the
     * caller as "stop the leg".
     */
    @PluginMethod
    fun setFrameKey(call: PluginCall) {
        val keyB64 = call.getString("keyB64") ?: return call.reject("invalid_argument:keyB64")
        val keyIndex = call.getInt("keyIndex") ?: return call.reject("invalid_argument:keyIndex")
        scope.launch {
            val provider = keyProvider
            val identity = legIdentity
            if (provider == null || identity == null || room == null) {
                call.reject("not_connected")
                return@launch
            }
            try {
                provider.setRawKey(identity, keyIndex, Base64.decode(keyB64, Base64.DEFAULT))
                currentKeyIndex = keyIndex
                assertSenderKeyIndex(keyIndex)
                call.resolve()
            } catch (t: Throwable) {
                call.reject("set_frame_key_failed: ${t.message ?: t.javaClass.simpleName}")
            }
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        scope.launch {
            tearDown("user")
            call.resolve()
        }
    }

    // ------------------------------------------------------------------

    private fun onRoomEvent(event: RoomEvent) {
        val room = this.room ?: return
        when (event) {
            is RoomEvent.TrackE2EEStateEvent -> {
                // The manager's own per-sender observer, surfaced as an event.
                // NEW is the pre-key transient (discardFrameWhenCryptorNotReady
                // means nothing leaves the phone during it); everything else
                // that is not OK is a sender that cannot be trusted — fail
                // closed, never keep publishing (§4.3 step 3).
                if (event.state != E2EEState.OK && event.state != E2EEState.NEW) {
                    scope.launch { tearDown("error") }
                }
            }
            is RoomEvent.Reconnected -> {
                // A full reconnect does NOT re-publish the screencast track —
                // consent data is single-use, so the SDK cannot silently
                // re-acquire it (probe (c-iv)). No publication after
                // Reconnected ⇒ the share is over; with one, re-assert the
                // send index (a re-created cryptor resets key_index_ to 0).
                val pub = room.localParticipant.getTrackPublication(Track.Source.SCREEN_SHARE)
                if (pub == null) {
                    scope.launch { tearDown("disconnected") }
                } else if (keyProvider != null) {
                    try {
                        assertSenderKeyIndex(currentKeyIndex)
                    } catch (t: Throwable) {
                        scope.launch { tearDown("error") }
                    }
                }
            }
            is RoomEvent.TrackPublished -> {
                if (event.participant === room.localParticipant && keyProvider != null) {
                    try {
                        assertSenderKeyIndex(currentKeyIndex)
                    } catch (t: Throwable) {
                        scope.launch { tearDown("error") }
                    }
                }
            }
            is RoomEvent.TrackMuted -> {
                // Only the server mutes a leg track (mute_track_identity —
                // out-of-band shape or video cap). Surface it; the WebView
                // shows the toast (§4.2 events).
                if (event.participant === room.localParticipant) {
                    val data = JSObject()
                    data.put("muted", true)
                    notifyListeners("muted", data)
                }
            }
            is RoomEvent.TrackUnmuted -> {
                if (event.participant === room.localParticipant) {
                    val data = JSObject()
                    data.put("muted", false)
                    notifyListeners("muted", data)
                }
            }
            is RoomEvent.Disconnected -> {
                // Server-side removal: primary left (ingress removes the leg),
                // moderator kick, orphan eject. tearDown is a no-op when this
                // arrived because WE disconnected.
                if (!stopping) {
                    scope.launch { tearDown("disconnected") }
                }
            }
            else -> {}
        }
    }

    /**
     * `setKey` stores material; only `setKeyIndex` moves the SENDER's index
     * (§0-R.6). `E2EEManager.frameCryptors` is private with no accessor in
     * 2.28.0 — the anticipated reflection interim from probe (a); works with
     * `minifyEnabled false`, verified live in probe (c-iii). Every cryptor in
     * the leg's manager is a sender (the leg subscribes to nothing). Verified
     * after the switch: a cryptor still at the old index after this call is a
     * hole, not a hiccup — throw so callers fail closed.
     */
    private fun senderCryptors(): Collection<FrameCryptor> {
        val manager = room?.e2eeManager ?: return emptyList()
        val field = manager.javaClass.getDeclaredField("frameCryptors")
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        val map = field.get(manager) as Map<*, FrameCryptor>
        return map.values
    }

    private fun assertSenderKeyIndex(index: Int) {
        for (cryptor in senderCryptors()) {
            cryptor.setKeyIndex(index)
        }
        for (cryptor in senderCryptors()) {
            if (cryptor.keyIndex != index) {
                throw IllegalStateException("sender cryptor refused key index switch")
            }
        }
    }

    private suspend fun tearDown(reason: String?) {
        if (stopping) return
        stopping = true
        eventsJob?.cancel()
        eventsJob = null
        val room = this.room
        this.room = null
        legIdentity = null
        try {
            room?.disconnect()
        } catch (_: Throwable) {}
        try {
            room?.release()
        } catch (_: Throwable) {}
        // Drop the native keyring (§4.2 hygiene) — the provider outlives the
        // Room, so its rtcKeyProvider must be disposed explicitly.
        try {
            keyProvider?.dispose()
        } catch (_: Throwable) {}
        keyProvider = null
        // Probe (f) caveat: Room/audio teardown reset the GLOBAL audio mode
        // to NORMAL even under NoAudioHandler. Re-assert the WebView call's
        // mode if teardown moved it, so ending a share does not silently break
        // the call's audio routing.
        savedAudioMode?.let { saved ->
            val audioManager =
                context.applicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            if (audioManager.mode != saved) {
                try {
                    audioManager.mode = saved
                } catch (_: Throwable) {}
            }
        }
        savedAudioMode = null
        consentIntent = null
        if (reason != null) {
            val data = JSObject()
            data.put("reason", reason)
            notifyListeners("stopped", data)
        }
    }

    /**
     * The capture size as (LONG side, SHORT side) — always, regardless of the
     * device's current orientation.
     *
     * 🔴 That is livekit-android's contract for a SCREENCAST track, not a
     * guess: `LocalScreencastVideoTrack.startCapture` ignores
     * `super.startCapture` and re-derives the format itself, documenting
     * *"Use captureParams.width as longest side and captureParams.height as
     * shortest side"* — for a portrait display it passes
     * (params.height, params.width) to the capturer. Handing it a
     * portrait-ordered pair therefore publishes the TRANSPOSE: proven live on
     * 2026-08-25, where a portrait 1080x2340 emulator produced a landscape
     * `WebRTC_ScreenCapture ... 1080 x 498` virtual display and a 1080x498
     * track on the viewer. The SDK also owns rotation from here (see the note
     * further down), so orientation never enters this calculation.
     *
     * The aspect still follows the REAL display — MediaProjection letterboxes
     * a mismatched one — with the long side capped by the tier and both
     * dimensions forced even for the encoder.
     */
    private fun captureDimensions(longSide: Int): Pair<Int, Int> {
        // 🔴 The metrics MUST come from a VISUAL context (the Activity), not
        // the application context. `WindowManager` from an application context
        // is documented as not tracking the display's current configuration,
        // and on the API-36 emulator it reported the screen LANDSCAPE while
        // the device was portrait 1080x2340 — which published a transposed
        // 1080x498 capture (proven on the virtual display: "WebRTC_
        // ScreenCapture ... 1080 x 498"). MediaProjection letterboxes a
        // mismatched aspect, so that is a visibly wrong share on every device
        // the misreport happens on. Fall back to the application resources
        // only if there is no Activity, which cannot happen on the consent
        // path that precedes this.
        val visual: Context = activity ?: context
        val (screenW, screenH) = if (Build.VERSION.SDK_INT >= 30) {
            val windowManager = visual
                .getSystemService(Context.WINDOW_SERVICE) as android.view.WindowManager
            val bounds = windowManager.currentWindowMetrics.bounds
            Pair(bounds.width(), bounds.height())
        } else {
            val metrics = android.util.DisplayMetrics()
            @Suppress("DEPRECATION")
            (visual.getSystemService(Context.WINDOW_SERVICE) as android.view.WindowManager)
                .defaultDisplay.getRealMetrics(metrics)
            Pair(metrics.widthPixels, metrics.heightPixels)
        }
        val longPx = maxOf(screenW, screenH)
        val shortPx = minOf(screenW, screenH)
        val long = minOf(longSide, longPx)
        val short = (long.toLong() * shortPx / longPx).toInt()
        fun even(v: Int) = v and 0x1.inv()
        val dims = Pair(even(long), even(short))
        // Dimensions only — no key material, no call data (§4.2 hygiene). This
        // is the one field-diagnosable cause of a letterboxed share, and it is
        // invisible without a log: MediaProjection silently pillarboxes a
        // mismatched aspect rather than failing.
        android.util.Log.i(
            "ScreenSharePlugin",
            "capture long=${dims.first} short=${dims.second} " +
                "(screen ${screenW}x${screenH}, tier long side $longSide)",
        )
        return dims
    }

    // 🔴 Rotation is the SDK's job, not ours (proven live 2026-08-25).
    // `LocalScreencastVideoTrack` installs its own `OrientationEventListener`
    // and re-runs `changeCaptureFormat` whenever the display dimensions
    // change. An `onConfigurationChanged` hook here would race that with a
    // second, differently-derived format — plan §4.3 step 3's rotation
    // instruction is already satisfied by the SDK, so this plugin
    // deliberately registers nothing.

    private fun buildNotification(): Notification {
        val channelId = CHANNEL_ID
        if (Build.VERSION.SDK_INT >= 26) {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE)
                as NotificationManager
            if (manager.getNotificationChannel(channelId) == null) {
                manager.createNotificationChannel(
                    // Native strings stay hard-coded English like the voice
                    // call service's — the FGS notification renders before the
                    // WebView (and its lingui catalogs) exist.
                    NotificationChannel(
                        channelId,
                        "Screen sharing",
                        NotificationManager.IMPORTANCE_LOW,
                    ),
                )
            }
        }
        return NotificationCompat.Builder(context, channelId)
            .setContentTitle("Sloga")
            .setContentText("Sharing your screen")
            .setSmallIcon(com.acutest.app.R.mipmap.ic_launcher)
            .setOngoing(true)
            .build()
    }

    override fun handleOnDestroy() {
        scope.launch { tearDown(null) }
        super.handleOnDestroy()
    }

    companion object {
        private const val NOTIFICATION_ID = 4243
        private const val CHANNEL_ID = "sloga_screenshare"

        private var webRtcLoaded = false

        @Synchronized
        private fun ensureWebRtcLoaded() {
            if (webRtcLoaded) return
            System.loadLibrary("lkjingle_peerconnection_so")
            webRtcLoaded = true
        }
    }
}
