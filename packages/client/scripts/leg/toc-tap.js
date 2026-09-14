/*
 * toc-tap.js — the per-frame RTP payload tap for the OBSERVER seat of the
 * "never publish unpaused" acceptance leg (rejoin-leak-HANDOFF §7.8 / §7.9,
 * wave 3, lane L10).
 *
 * PASTE THIS INTO THE OBSERVER SEAT'S DEVTOOLS CONSOLE **BEFORE THE OBSERVER
 * JOINS THE CALL**. It hooks the RTCPeerConnection constructor and attaches an
 * RTCRtpScriptTransform to every inbound AUDIO receiver the moment its `track`
 * event fires; a seat that is already in a call has no peer connection left to
 * hook and no receiver left to tap, and the tap would then record nothing and
 * look green.
 *
 * What it records: for every encoded audio frame that reaches this seat,
 *   { t, ssrc, len, head: [first 6 bytes], tail: [last 4 bytes], h, rx }
 * where `h` is the FNV-1a 32-bit hash of the whole payload as UNPADDED
 * lowercase hex (e.g. "38e82bf") — the same record shape and the same hash
 * formatting as the run-3 console paste, so toc-reduce.mjs treats the run-3
 * dump and a dump from this file alike — plus `rx`, the page-side receiver
 * index, which `stats().trackEvents[*].receiverIndex` maps to the livekit
 * participantSid|trackSid of that receiver's `track` event. The dump also
 * carries `clockProbes: [armProbe, saveProbe]`: a GET on the capture
 * receiver at arm and again at save, each `{ t0, t1, serverMs, skewMs,
 * rttMs }` (or `{ error }`), where skewMs = receiver clock minus this seat's
 * clock and the reducer ADDS it to every tap `t`.
 *
 * Paste order: shims v2 → sampler → tap, OR tap → sampler. BOTH orders work.
 * The wrapper keeps `prototype` and inherits the previous constructor's statics
 * (`Object.setPrototypeOf(Wrapped, Real)`), so the sampler's own hook static
 * (`__slogaLegRegister`) is reachable whichever wrapper is outermost, and
 * `instanceof RTCPeerConnection` still holds for every pc either way.
 *
 * ---------------------------------------------------------------------------
 * What this file NEVER does. Each rule below has a measured reason.
 *
 * 1. NEVER `encodedInsertableStreams: true` and NEVER createEncodedStreams().
 *    Either one makes livekit itself claim the receiver (setupE2EEReceiver)
 *    and throw "Encoded streams already created" (§7.8 pass (a)). The only
 *    mechanism used is `receiver.transform = new RTCRtpScriptTransform(...)`
 *    set inside the `track` event, once per receiver.
 *
 * 2. NEVER touches a sender. This is a read-only tap on what the SFU delivers
 *    to this seat; what the subject publishes is decided by the subject's own
 *    gate-trace, not here.
 *
 * 3. NEVER modifies, drops or reorders a frame. The worker's transform posts a
 *    summary and then `controller.enqueue(frame)` UNCHANGED, on every path —
 *    a post error is caught and counted, and the frame is still enqueued.
 *
 * 4. NEVER decides "blank" BY LENGTH. Run 3 measured the SFU's injected
 *    silence (LiveKit-server's OpusSilenceFrame `f8 ff fe` + zero padding) as
 *    81 B because that seat's publication still carried a RED byte in front;
 *    a publication made after the E2EE flip has no RED byte and the same blank
 *    is 80 B, and a plain seat could in principle see other framing again. A
 *    length rule would therefore split one phenomenon across runs and could
 *    silently match nothing on a plain seat. `isBlankLike` decides by the
 *    signature (`f8 ff fe` at offset 0, or at offset 1 behind a RED byte), an
 *    all-zero tail, AND membership in a run of identical hashes on the same
 *    ssrc (this frame's `h` equals the `h` of the two frames immediately
 *    before it on that ssrc). The ≥2-predecessor rule means the first two
 *    frames of every blank run classify as NOT blank-like; the reducer should
 *    exclude blanks by HASH — `stats().perSsrc[x].blankLike.hashes` lists the
 *    hashes the rule confirmed — which catches the run leaders too.
 *
 * 5. NEVER `<a download>`. save(label) POSTs to the capture receiver at
 *    http://127.0.0.1:5189/<label> (capture_receiver.py, which writes
 *    <label>-<epoch>.json under /home/mcp/leg-rejoin/captures/) so the file
 *    lands in WSL, not on the Chrome machine.
 *
 * ---------------------------------------------------------------------------
 * Operator sequence:
 *
 *   1. paste this file                     -> SLOGA_TOC.arm() runs on paste
 *   2. join the call as the observer       -> "[leg-toc] tapped receiver #n"
 *   3. run the leg
 *   4. SLOGA_TOC.stats()                   -> per-ssrc table (console.table)
 *      SLOGA_TOC.save("b-consent-run4-toc") -> receiver's reply is printed
 *   SLOGA_TOC.frames() is the raw frame array (capped at 500000; `dropped`
 *   counts the rest); SLOGA_TOC.reset() clears the frames and keeps the hook
 *   and every tapped receiver.
 *
 * This file is a console script on purpose. It has no dependencies, is never
 * imported by the app, never bundled, and is outside tsconfig.json's
 * `include`, rtc-gate.sh's prettier list and rtc-gate.sh's eslint list.
 */
(function () {
  "use strict";

  var SCHEMA = "sloga-leg-toc/1";
  var RECEIVER_URL = "http://127.0.0.1:5189/";
  var MAX_FRAMES = 500000;

  if (typeof window === "undefined") {
    console.warn("[leg-toc] no window — this is a browser console script");
    return;
  }

  var Existing = window.RTCPeerConnection;
  if (Existing && Existing.__slogaTocWrapped) {
    console.warn(
      "[leg-toc] RTCPeerConnection is already wrapped by an earlier tap paste — refusing to double-wrap; the existing window.SLOGA_TOC stays in charge",
    );
    return;
  }

  // --- the hash (ONE definition; shipped into the worker via String()) -----

  // FNV-1a 32-bit over the payload bytes: offset basis 0x811c9dc5, prime
  // 0x01000193, Math.imul for the 32-bit multiply, `>>> 0` to unsign, and
  // toString(16) WITHOUT padding — "38e82bf" is a legal value and is what the
  // run-3 dump holds, so the reducer must never see a padded form from here.
  function fnv1a32(bytes) {
    var h = 0x811c9dc5;
    for (var i = 0; i < bytes.length; i++) {
      h ^= bytes[i] & 0xff;
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  }

  // --- the worker ----------------------------------------------------------

  // Assembled from String(fnv1a32) plus this body. The body is a string on
  // purpose: it is the ONLY code that runs off the page thread, and it must
  // not reach for anything in this closure.
  var WORKER_BODY = [
    "var tocErrors = 0;",
    "function post(m) { try { postMessage(m); } catch (e) { tocErrors += 1; } }",
    "function summarize(frame, rx) {",
    "  var bytes = new Uint8Array(frame.data);",
    "  var md = null;",
    "  try { md = typeof frame.getMetadata === 'function' ? frame.getMetadata() : null; } catch (e) { md = null; }",
    "  var ssrc = md && md.synchronizationSource != null ? md.synchronizationSource : null;",
    "  var n = bytes.length;",
    "  var head = [];",
    "  for (var i = 0; i < 6 && i < n; i++) head.push(bytes[i]);",
    "  var tail = [];",
    "  for (var j = Math.max(0, n - 4); j < n; j++) tail.push(bytes[j]);",
    "  // rx = the page-side receiver index (F4) so the reducer can map ssrc -> receiver -> trackSid",
    "  return { t: Date.now(), ssrc: ssrc, len: n, head: head, tail: tail, h: fnv1a32(bytes), rx: rx };",
    "}",
    "onrtctransform = function (e) {",
    "  var tr = e.transformer;",
    "  var opts = tr && tr.options;",
    "  if (!opts || opts.role !== 'tap') {",
    "    // pass-through: not ours, hand the frames straight back",
    "    tr.readable.pipeTo(tr.writable).catch(function (err) { post({ kind: 'error', msg: 'pass-through pipe: ' + err }); });",
    "    return;",
    "  }",
    "  var rx = opts.receiverIndex != null ? opts.receiverIndex : null;",
    "  var ts = new TransformStream({",
    "    transform: function (frame, controller) {",
    "      try {",
    "        post({ kind: 'frame', frame: summarize(frame, rx) });",
    "      } catch (err) {",
    "        tocErrors += 1;",
    "        post({ kind: 'error', msg: 'summarize: ' + err });",
    "      }",
    "      controller.enqueue(frame);",
    "    }",
    "  });",
    "  tr.readable.pipeThrough(ts).pipeTo(tr.writable).catch(function (err) { post({ kind: 'error', msg: 'tap pipe: ' + err }); });",
    "  post({ kind: 'attached' });",
    "};",
  ].join("\n");

  function workerSource() {
    return String(fnv1a32) + "\n" + WORKER_BODY + "\n";
  }

  // --- state ---------------------------------------------------------------

  var state = {
    armedAtWall: null,
    hookInstalled: false,
    worker: null,
    workerUrl: null,
    workerAttached: 0,
    tapped: new WeakSet(),
    receivers: [],
    receiversTapped: 0,
    trackEvents: [],
    frames: [],
    dropped: 0,
    errors: [],
    clockProbes: { arm: null, save: null },
  };

  function error(where, e) {
    var msg = String(e && e.message ? e.message : e);
    state.errors.push({ t: Date.now(), where: where, msg: msg });
    console.warn("[leg-toc] " + where + ": " + msg);
  }

  function onWorkerMessage(ev) {
    var d = ev && ev.data;
    if (!d) return;
    if (d.kind === "frame") {
      if (state.frames.length >= MAX_FRAMES) {
        state.dropped += 1;
        return;
      }
      state.frames.push(d.frame);
    } else if (d.kind === "error") {
      error("worker", d.msg);
    } else if (d.kind === "attached") {
      state.workerAttached += 1;
    }
  }

  function ensureWorker() {
    if (state.worker) return state.worker;
    if (typeof Worker !== "function" || typeof Blob !== "function") {
      throw new Error("no Worker/Blob in this page — cannot build the tap worker");
    }
    var blob = new Blob([workerSource()], { type: "application/javascript" });
    var url = URL.createObjectURL(blob);
    var w = new Worker(url);
    w.onmessage = onWorkerMessage;
    w.onerror = function (ev) {
      error("worker.onerror", ev && ev.message ? ev.message : ev);
    };
    state.worker = w;
    state.workerUrl = url;
    return w;
  }

  // --- the receiver tap ----------------------------------------------------

  function tapReceiver(receiver, receiverIndex) {
    if (!receiver) return;
    if (state.tapped.has(receiver)) return;
    state.tapped.add(receiver);
    try {
      if (typeof RTCRtpScriptTransform !== "function") {
        throw new Error("RTCRtpScriptTransform is not available in this browser");
      }
      var w = ensureWorker();
      receiver.transform = new RTCRtpScriptTransform(w, { role: "tap", receiverIndex: receiverIndex });
      state.receiversTapped += 1;
      console.info("[leg-toc] tapped receiver #" + state.receiversTapped + " (rx=" + receiverIndex + ")");
    } catch (e) {
      error("receiver.transform", e);
    }
  }

  function receiverIndexOf(receiver) {
    if (!receiver) return null;
    var i = state.receivers.indexOf(receiver);
    if (i >= 0) return i;
    state.receivers.push(receiver);
    return state.receivers.length - 1;
  }

  function onTrack(ev) {
    var track = ev && ev.track;
    if (!track || track.kind !== "audio") return;
    // livekit packs the remote stream id as <participantSid>|<trackSid>
    // (unpackStreamId, livekit-client 2.15.13); both halves recorded raw.
    var streamId = ev.streams && ev.streams[0] ? String(ev.streams[0].id) : "";
    var participantSid = streamId;
    var trackSid = "";
    var sep = streamId.indexOf("|");
    if (sep >= 0) {
      participantSid = streamId.slice(0, sep);
      trackSid = streamId.slice(sep + 1);
    }
    var rx = receiverIndexOf(ev.receiver);
    state.trackEvents.push({
      t: Date.now(),
      kind: track.kind,
      streamId: streamId,
      trackSid: trackSid,
      participantSid: participantSid,
      mid: ev.transceiver ? ev.transceiver.mid : null,
      receiverIndex: rx,
    });
    if (!ev.receiver) return;
    tapReceiver(ev.receiver, rx);
  }

  // --- clock probe (F2) ----------------------------------------------------

  // GET on the capture receiver returns WSL wall seconds. skewMs is the
  // receiver's (= subject rig's) clock MINUS this observer's clock at the
  // request midpoint: the reducer ADDS skewMs to every tap `t` to place it on
  // the subject's gate-trace timeline. A failed probe is recorded as
  // { error } and logged; it is never thrown.
  function clockProbe(which) {
    var t0 = Date.now();
    var p;
    try {
      p = fetch(RECEIVER_URL).then(function (res) {
        return res.text();
      });
    } catch (e) {
      p = Promise.reject(e);
    }
    return p.then(
      function (txt) {
        var t1 = Date.now();
        var s = parseFloat(txt) * 1000;
        var probe = { t0: t0, t1: t1, serverMs: s, skewMs: s - (t0 + t1) / 2, rttMs: t1 - t0 };
        if (!isFinite(s)) probe = { t0: t0, t1: t1, error: "unparsable receiver reply: " + JSON.stringify(txt) };
        state.clockProbes[which] = probe;
        if (probe.error) {
          console.warn("[leg-toc] clock probe (" + which + ") FAILED: " + probe.error);
        } else {
          console.info(
            "[leg-toc] clock probe (" + which + "): skewMs=" + probe.skewMs.toFixed(1) + " rttMs=" + probe.rttMs,
          );
        }
        return probe;
      },
      function (err) {
        var probe = { t0: t0, t1: Date.now(), error: String(err) };
        state.clockProbes[which] = probe;
        console.warn("[leg-toc] clock probe (" + which + ") FAILED (is capture_receiver.py up on 127.0.0.1:5189?): " + probe.error);
        return probe;
      },
    );
  }

  // --- RTCPeerConnection hook ----------------------------------------------

  function installHook() {
    if (state.hookInstalled) return;
    var Real = window.RTCPeerConnection;
    if (typeof Real !== "function") {
      error("arm", "no window.RTCPeerConnection — cannot arm");
      return;
    }
    if (Real.__slogaTocWrapped) {
      state.hookInstalled = true;
      return;
    }
    var Wrapped = function () {
      // `new Real(...args)` with the same args and no foreign newTarget, so
      // the pc is a real RTCPeerConnection and instanceof holds.
      var pc = new Real(...arguments);
      // Our `track` listener goes on BEFORE the pc is handed back, so it runs
      // ahead of livekit's own listener for every receiver on this pc.
      try {
        pc.addEventListener("track", function (ev) {
          try {
            onTrack(ev);
          } catch (e) {
            error("ontrack", e);
          }
        });
      } catch (e2) {
        error("addEventListener(track)", e2);
      }
      // If a sampler pasted AFTER us took over THIS wrapper (it finds
      // `__slogaLegWrapped` inherited from an inner sampler wrapper and hangs
      // its register hook on the outermost constructor — ours), honour it;
      // the sampler's registerPc dedups by pc, so a second call is harmless.
      var reg = Wrapped.__slogaLegRegister;
      if (typeof reg === "function") {
        try {
          reg(pc, "constructor-hook");
        } catch (e3) {
          /* instrumentation must never break the app under test */
        }
      }
      return pc;
    };
    Wrapped.prototype = Real.prototype;
    Object.setPrototypeOf(Wrapped, Real);
    // Defensive copy of own enumerable statics (a previous wrapper's hook
    // statics); the prototype chain above already makes them reachable.
    Object.keys(Real).forEach(function (k) {
      if (k === "prototype") return;
      try {
        if (!Object.prototype.hasOwnProperty.call(Wrapped, k)) Wrapped[k] = Real[k];
      } catch (e) {
        /* a non-writable static is fine to skip: it is still inherited */
      }
    });
    Wrapped.__slogaTocWrapped = true;
    window.RTCPeerConnection = Wrapped;
    if (window.webkitRTCPeerConnection === Real) {
      window.webkitRTCPeerConnection = Wrapped;
    }
    state.hookInstalled = true;
  }

  // --- pure policy ---------------------------------------------------------

  function hasSignature(head) {
    if (!head || head.length < 3) return false;
    if (head[0] === 0xf8 && head[1] === 0xff && head[2] === 0xfe) return true;
    return head.length >= 4 && head[1] === 0xf8 && head[2] === 0xff && head[3] === 0xfe;
  }

  function tailAllZero(tail) {
    if (!tail || tail.length === 0) return false;
    for (var i = 0; i < tail.length; i++) {
      if (tail[i] !== 0) return false;
    }
    return true;
  }

  // True iff `frame` looks like an SFU-injected blank: the OpusSilenceFrame
  // signature at head offset 0 or 1, an all-zero tail, AND the same hash as
  // the two frames immediately before it on the same ssrc. `prevFrames` is
  // the array of frames captured before `frame` (any ssrc; scanned backwards
  // for the same ssrc). NEVER by length — see header rule 4.
  function isBlankLike(frame, prevFrames) {
    if (!frame) return false;
    if (!hasSignature(frame.head)) return false;
    if (!tailAllZero(frame.tail)) return false;
    if (typeof frame.h !== "string" || frame.h === "") return false;
    var prev = prevFrames || [];
    var same = 0;
    for (var i = prev.length - 1; i >= 0 && same < 2; i--) {
      var p = prev[i];
      if (!p || p.ssrc !== frame.ssrc) continue;
      if (p.h !== frame.h) return false;
      same += 1;
    }
    return same >= 2;
  }

  // --- stats ---------------------------------------------------------------

  function hexBytes(arr) {
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var s = (arr[i] & 0xff).toString(16);
      out.push(s.length < 2 ? "0" + s : s);
    }
    return out.join(" ");
  }

  function topOf(counts, n) {
    var rows = [];
    counts.forEach(function (c, k) {
      rows.push([k, c]);
    });
    rows.sort(function (a, b) {
      return b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    });
    return rows.slice(0, n);
  }

  function bump(map, key) {
    map.set(key, (map.get(key) || 0) + 1);
  }

  function perSsrcStats() {
    var bySsrc = new Map();
    var order = [];
    state.frames.forEach(function (f) {
      var key = String(f.ssrc);
      var s = bySsrc.get(key);
      if (!s) {
        s = {
          list: [],
          n: 0,
          bytes: 0,
          firstWall: f.t,
          lastWall: f.t,
          lens: new Map(),
          heads: new Map(),
          hashes: new Map(),
          tails: new Map(),
          blankN: 0,
          blankHashes: new Map(),
        };
        bySsrc.set(key, s);
        order.push(key);
      }
      var idx = s.list.length;
      s.list.push(f);
      s.n += 1;
      s.bytes += f.len || 0;
      if (f.t < s.firstWall) s.firstWall = f.t;
      if (f.t > s.lastWall) s.lastWall = f.t;
      bump(s.lens, f.len);
      bump(s.heads, hexBytes(f.head || []));
      bump(s.hashes, f.h);
      bump(s.tails, hexBytes(f.tail || []));
      if (isBlankLike(f, s.list.slice(Math.max(0, idx - 2), idx))) {
        s.blankN += 1;
        bump(s.blankHashes, f.h);
      }
    });
    var out = {};
    order.forEach(function (key) {
      var s = bySsrc.get(key);
      var blankHashes = [];
      s.blankHashes.forEach(function (c, h) {
        blankHashes.push(h);
      });
      out[key] = {
        n: s.n,
        bytes: s.bytes,
        firstWall: s.firstWall,
        lastWall: s.lastWall,
        topLens: topOf(s.lens, 8),
        topHeads: topOf(s.heads, 5),
        topHashes: topOf(s.hashes, 5),
        topTails: topOf(s.tails, 5),
        distinctPayloads: s.hashes.size,
        blankLike: { n: s.blankN, hashes: blankHashes },
      };
    });
    return out;
  }

  function stats() {
    return {
      armedAtWall: state.armedAtWall,
      receiversTapped: state.receiversTapped,
      workerAttached: state.workerAttached,
      errors: state.errors.slice(),
      dropped: state.dropped,
      trackEvents: state.trackEvents.slice(),
      clockProbes: [state.clockProbes.arm, state.clockProbes.save],
      perSsrc: perSsrcStats(),
    };
  }

  // --- public API ----------------------------------------------------------

  var api = {
    __v: SCHEMA,
    __pure: { fnv: fnv1a32, isBlankLike: isBlankLike },

    arm: function () {
      var first = state.armedAtWall === null;
      if (first) state.armedAtWall = Date.now();
      // The wrap is synchronous on paste; only the clock probe is awaited,
      // and only by whoever wants its promise (save() reads the stored result).
      installHook();
      if (state.hookInstalled) {
        try {
          ensureWorker();
        } catch (e) {
          error("worker", e);
        }
      }
      if (first) clockProbe("arm");
      console.info(
        "[leg-toc] armed. hookInstalled=" +
          state.hookInstalled +
          " worker=" +
          !!state.worker +
          ". JOIN THE CALL NOW if you have not already — a seat that was already in a call has no RTCPeerConnection left to hook and no receiver left to tap.",
      );
      return state.hookInstalled;
    },

    frames: function () {
      return state.frames;
    },

    stats: function () {
      var s = stats();
      var rows = [];
      Object.keys(s.perSsrc).forEach(function (ssrc) {
        var p = s.perSsrc[ssrc];
        rows.push({
          ssrc: ssrc,
          n: p.n,
          bytes: p.bytes,
          distinctPayloads: p.distinctPayloads,
          blankLike: p.blankLike.n,
          topLen: p.topLens.length ? p.topLens[0][0] + " x" + p.topLens[0][1] : null,
          topHead: p.topHeads.length ? p.topHeads[0][0] : null,
          firstWall: p.firstWall,
          lastWall: p.lastWall,
        });
      });
      console.table(rows);
      console.info(
        "[leg-toc] receiversTapped=" +
          s.receiversTapped +
          " frames=" +
          state.frames.length +
          " dropped=" +
          s.dropped +
          " errors=" +
          s.errors.length,
      );
      return s;
    },

    save: function (label) {
      if (typeof label !== "string" || !/^[A-Za-z0-9._-]+$/.test(label)) {
        console.error(
          "[leg-toc] save(label) refused: label must be a non-empty string of [A-Za-z0-9._-]; got " +
            JSON.stringify(label),
        );
        return undefined;
      }
      // Second clock probe BEFORE the body is built, so the dump carries the
      // skew at both ends of the capture and the drift between them.
      return clockProbe("save").then(function (saveProbe) {
        var armProbe = state.clockProbes.arm;
        if (armProbe && !armProbe.error && !saveProbe.error) {
          console.info(
            "[leg-toc] clock: skew at arm " +
              armProbe.skewMs.toFixed(1) +
              " ms, at save " +
              saveProbe.skewMs.toFixed(1) +
              " ms, drift " +
              (saveProbe.skewMs - armProbe.skewMs).toFixed(1) +
              " ms over " +
              (saveProbe.t0 - armProbe.t0) +
              " ms (skewMs = receiver clock minus this seat; the reducer ADDS it to tap t)",
          );
        } else {
          console.warn("[leg-toc] clock: a probe failed — skew/drift UNKNOWN for this dump (arm=" + JSON.stringify(armProbe) + " save=" + JSON.stringify(saveProbe) + ")");
        }
        var body = JSON.stringify({
          schema: SCHEMA,
          label: label,
          armedAtWall: state.armedAtWall,
          savedAtWall: Date.now(),
          userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
          clockProbes: [armProbe, saveProbe],
          stats: stats(),
          frames: state.frames,
        });
        console.info("[leg-toc] POSTing " + body.length + " bytes to " + RECEIVER_URL + label);
        return fetch(RECEIVER_URL + encodeURIComponent(label), { method: "POST", body: body }).then(
          function (res) {
            return res.text().then(function (txt) {
              console.info("[leg-toc] receiver replied " + res.status + ": " + txt);
              return txt;
            });
          },
          function (err) {
            console.error("[leg-toc] save FAILED (is capture_receiver.py up on 127.0.0.1:5189?): " + err);
            throw err;
          },
        );
      });
    },

    reset: function () {
      state.frames = [];
      state.dropped = 0;
      state.errors = [];
      console.info(
        "[leg-toc] reset: frames cleared; hook, " +
          state.receiversTapped +
          " tapped receiver(s), their track events and the arm clock probe kept",
      );
      return true;
    },

    _state: state,
  };

  window.SLOGA_TOC = api;
  api.arm();
  console.info(
    "[leg-toc] " +
      SCHEMA +
      " ready. Next: join the call, run the leg, then SLOGA_TOC.stats() / SLOGA_TOC.save(<label>) (POSTs to 127.0.0.1:5189).",
  );
})();
