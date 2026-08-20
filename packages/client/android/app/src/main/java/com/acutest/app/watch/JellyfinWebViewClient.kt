package com.acutest.app.watch

import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import com.acutest.app.e2ee.E2eeWebViewClient
import com.getcapacitor.Bridge
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.util.concurrent.Callable
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Streams watch-together Jellyfin media to the WebView — the Android
 * transport's media half (plan §5.4, slice 3), the same-origin analog of
 * the desktop `jf` scheme handlers.
 *
 * `https://localhost/_jf/{server_id}/{jellyfin path}` (the Capacitor app
 * origin, so the page CSP sees only 'self') is intercepted BEFORE
 * Capacitor's asset server and forwarded to the server the viewer SAVED
 * under that id — nothing else; an unknown id is an opaque 404 (§5.1).
 * hls.js resolves a manifest's relative variant/segment URLs under the
 * same `/_jf/{server_id}/` base automatically, and `<img>` posters ride
 * the same path (Jellyfin images need no auth — §7.1).
 *
 * GET/HEAD only: `shouldInterceptRequest` never exposes a request body,
 * so anything with one goes over [JellyfinPlugin.request] instead. The
 * response body is passed through as the connection's own InputStream —
 * the engine consumes it lazily, so segments stream without buffering
 * whole bodies in memory (unlike the desktop handler, which must buffer:
 * Tauri's protocol API has no streaming response).
 *
 * Conditional request headers are deliberately NOT forwarded and no
 * cache validators are returned: a 304 cannot be represented in a
 * WebResourceResponse (the [300,399] range is rejected), so revalidation
 * must never be provoked. Media segments are one-shot; nothing here
 * benefits from HTTP caching.
 *
 * Extends [E2eeWebViewClient] so both interceptors ride the one
 * WebViewClient slot Capacitor exposes; everything that isn't `/_jf/`
 * falls through to the E2EE handler and then Capacitor.
 */
class JellyfinWebViewClient(bridge: Bridge) : E2eeWebViewClient(bridge) {
    /** Request headers that cross to the Jellyfin. */
    private val forwardRequest =
        setOf("range", "accept", "authorization", "x-emby-authorization")

    /** Response headers that cross back (Content-Type rides the ctor). */
    private val forwardResponse = setOf("content-range", "accept-ranges")

    /** Mime types a Jellyfin must never execute with app-origin authority:
     * anything document- or script-shaped degrades to octet-stream (the
     * `/_jf/` consumers — hls.js, `<video>`, `<img>` — never need them). */
    private val degradeMimes =
        setOf("text/html", "application/xhtml+xml", "image/svg+xml", "text/xml", "application/xml")

    /** Header wait (connect + response line) runs on this pool so a sleepy
     * NAS can't park the WebView's intercept dispatch for the full connect
     * timeout; past the budget the request is abandoned as a 502. */
    private val headerPool: ExecutorService = Executors.newCachedThreadPool()

    override fun shouldInterceptRequest(
        view: WebView?,
        request: WebResourceRequest?,
    ): WebResourceResponse? {
        val url = request?.url
        if (
            url != null &&
            url.host == "localhost" &&
            url.encodedPath?.startsWith("/_jf/") == true
        ) {
            // Subresource loads only — a media URL must not be openable as
            // its own page (same rule as the E2EE attachment interceptor).
            if (request.isForMainFrame) return notFound()
            if (request.method != "GET" && request.method != "HEAD") return notFound()
            return serve(request)
        }
        return super.shouldInterceptRequest(view, request)
    }

    private fun serve(request: WebResourceRequest): WebResourceResponse {
        // Path validation stays on the intercept thread — pure string work.
        val url = request.url
        // encodedPath = "/_jf/{id}/{rest}"; ids are [A-Za-z0-9_-] so the
        // decoded segment equals its encoded form.
        val segments = url.pathSegments
        if (segments.size < 3) return notFound()
        val serverId = segments[1]
        val entry = JellyfinServers.get(serverId) ?: return notFound()
        val encodedPath = url.encodedPath ?: return notFound()
        val prefix = "/_jf/$serverId"
        if (!encodedPath.startsWith(prefix)) return notFound()
        var pathAndQuery = encodedPath.substring(prefix.length)
        if (!pathAndQuery.startsWith("/")) return notFound()
        url.encodedQuery?.let { pathAndQuery += "?$it" }

        // The header wait (connect + response line) blocks, and the WebView
        // dispatches intercepts on a small shared pool — so it runs on OUR
        // pool with a budget. `claimed` decides who owns the connection if
        // the budget and the worker finish neck-and-neck: whoever loses the
        // claim disconnects/discards.
        val claimed = AtomicBoolean(false)
        val task = headerPool.submit(Callable { fetch(request, entry, pathAndQuery, claimed) })
        return try {
            task.get(HEADER_BUDGET_MS, TimeUnit.MILLISECONDS)
        } catch (e: TimeoutException) {
            if (claimed.compareAndSet(false, true)) {
                // Abandoned: the worker sees the lost claim and disconnects.
                opaque(502)
            } else {
                // The worker finished between the timeout and our claim.
                try {
                    task.get()
                } catch (inner: Exception) {
                    opaque(502)
                }
            }
        } catch (e: Exception) {
            // Opaque: DNS/refused/TLS/timeout all look the same out here.
            opaque(502)
        }
    }

    /** The blocking half of [serve]; runs on [headerPool]. */
    private fun fetch(
        request: WebResourceRequest,
        entry: JellyfinServers.Entry,
        pathAndQuery: String,
        claimed: AtomicBoolean,
    ): WebResourceResponse {
        var conn: HttpURLConnection? = null
        try {
            val c = JellyfinServers.open(entry, pathAndQuery)
            conn = c
            c.requestMethod = request.method
            for ((k, v) in request.requestHeaders) {
                if (k.lowercase() in forwardRequest) c.setRequestProperty(k, v)
            }
            val status = c.responseCode
            // Redirects are never followed (JellyfinServers.open) and can't
            // be represented in a WebResourceResponse anyway.
            if (status in 300..399) {
                c.disconnect()
                return opaque(502)
            }
            val reason = c.responseMessage?.takeIf { it.isNotBlank() }
                ?: if (status < 400) "OK" else "Error"
            val contentType = c.contentType
            var mime = contentType?.substringBefore(';')?.trim()?.takeIf { it.isNotEmpty() }
                ?: "application/octet-stream"
            // Server-controlled bytes on the app origin: nothing document-
            // or script-shaped may keep a mime the engine would execute.
            if (mime.lowercase() in degradeMimes) mime = "application/octet-stream"
            val encoding = contentType?.let {
                val idx = it.lowercase().indexOf("charset=")
                if (idx >= 0) it.substring(idx + "charset=".length).substringBefore(';').trim()
                else null
            }
            val headers = HashMap<String, String>()
            for (name in forwardResponse) {
                c.getHeaderField(name)?.let { headers[name] = it }
            }
            headers["Cache-Control"] = "no-store"
            headers["X-Content-Type-Options"] = "nosniff"
            // Same rule as the E2EE attachment interceptor: even if a
            // response does get framed, it carries no app-origin authority.
            headers["Content-Security-Policy"] = "sandbox"
            val stream =
                try {
                    if (status >= 400) c.errorStream else c.inputStream
                } catch (e: Exception) {
                    null
                }
            // An empty-body response (errorStream == null) hands back no
            // stream to close later — release the connection now.
            if (stream == null) c.disconnect()
            val response =
                WebResourceResponse(mime, encoding, stream ?: ByteArrayInputStream(ByteArray(0)))
            response.setStatusCodeAndReasonPhrase(status, reason)
            response.responseHeaders = headers
            if (!claimed.compareAndSet(false, true)) {
                // The intercept thread already gave up on this request.
                c.disconnect()
                return opaque(502)
            }
            return response
        } catch (error: Throwable) {
            try {
                conn?.disconnect()
            } catch (ignored: Exception) {
                /* already dead */
            }
            return opaque(502)
        }
    }

    private fun opaque(status: Int): WebResourceResponse {
        val response =
            WebResourceResponse("text/plain", null, ByteArrayInputStream(ByteArray(0)))
        response.setStatusCodeAndReasonPhrase(status, if (status == 404) "Not Found" else "Bad Gateway")
        return response
    }

    private fun notFound(): WebResourceResponse = opaque(404)
}

/** Budget for the blocking header wait before an intercept is abandoned. */
private const val HEADER_BUDGET_MS = 10_000L
