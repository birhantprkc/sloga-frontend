package com.acutest.app.watch

import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.X509TrustManager

/**
 * The watch-together Jellyfin forwarding table — the Android analog of the
 * desktop shells' `jf_set_servers` state (plan §5.3/§5.4).
 *
 * The webview registers the viewer's saved-server list (replace-all) and
 * both native carriers — the `/_jf/` interceptor in [JellyfinWebViewClient]
 * and [JellyfinPlugin.request] — forward ONLY to an id in this table; an
 * unknown id is an opaque 404. A watch session broadcast by another user
 * can therefore never make this device contact an arbitrary URL (§5.1).
 *
 * Sloga never hosts, proxies or relays video: every forwarded request goes
 * from this device straight to the viewer's own Jellyfin.
 *
 * Per-server `trustSelfSigned` is the only TLS relaxation and it is scoped
 * to that server's connections — never global.
 */
object JellyfinServers {
    class Entry(
        /** Normalized, no trailing slash (may carry a path: `https://h/jellyfin`). */
        val baseUrl: String,
        val trustSelfSigned: Boolean,
    )

    @Volatile
    private var table: Map<String, Entry> = emptyMap()

    private val idPattern = Regex("^[A-Za-z0-9_-]{8,64}$")

    fun get(id: String): Entry? = table[id]

    /**
     * Replace the table with the webview's saved-server list. Malformed
     * entries are dropped silently (the webview validated them first —
     * this is the second gate). Returns how many were accepted.
     */
    fun replace(specs: List<Spec>): Int {
        val next = HashMap<String, Entry>()
        for (spec in specs) {
            if (!idPattern.matches(spec.id)) continue
            val base = normalizeBase(spec.baseUrl) ?: continue
            next[spec.id] = Entry(base, spec.trustSelfSigned)
        }
        table = next
        return next.size
    }

    class Spec(val id: String, val baseUrl: String, val trustSelfSigned: Boolean)

    /**
     * Accept `http(s)://host[:port][/path]` only — no credentials, query
     * or fragment — and return it without a trailing slash. Null rejects.
     */
    fun normalizeBase(raw: String): String? {
        val uri =
            try {
                URI(raw.trim())
            } catch (e: Exception) {
                return null
            }
        if (uri.scheme != "http" && uri.scheme != "https") return null
        if (uri.userInfo != null) return null
        if (uri.rawQuery != null || uri.rawFragment != null) return null
        if (uri.host.isNullOrEmpty()) return null
        var s = uri.toString()
        while (s.endsWith("/")) s = s.dropLast(1)
        return s
    }

    // Lazily built once; only ever applied to a connection whose server
    // entry opted in (never installed as a process default).
    private val trustAllFactory: SSLSocketFactory by lazy {
        val trustAll =
            object : X509TrustManager {
                override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}

                override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}

                override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
            }
        val ctx = SSLContext.getInstance("TLS")
        ctx.init(null, arrayOf(trustAll), SecureRandom())
        ctx.socketFactory
    }

    /** Open a connection to `{entry.baseUrl}{pathAndQuery}` with the entry's TLS policy. */
    fun open(entry: Entry, pathAndQuery: String): HttpURLConnection {
        val conn = URL(entry.baseUrl + pathAndQuery).openConnection() as HttpURLConnection
        // Never follow redirects: the stack would carry X-Emby-Authorization
        // (and this entry's TLS relaxation) to whatever host the server
        // 302s to, escaping the saved-servers-only rule. The callers map an
        // unfollowed 3xx to an opaque error instead.
        conn.instanceFollowRedirects = false
        if (conn is HttpsURLConnection && entry.trustSelfSigned) {
            conn.sslSocketFactory = trustAllFactory
            conn.setHostnameVerifier { _, _ -> true }
        }
        conn.connectTimeout = 15_000
        // Transcode start-up on a NAS can take several seconds before the
        // first segment exists; playlists poll far faster.
        conn.readTimeout = 60_000
        return conn
    }
}
