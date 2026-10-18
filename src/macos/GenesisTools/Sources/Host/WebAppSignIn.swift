import Foundation

/// A Safari web app ("Add to Dock", bundle `com.apple.Safari.WebApp.<UUID>`) keeps its own cookies and hands every link
/// outside its site to the default browser, which is this app. A sign-in that leaves it never comes back: the Grok web
/// app sent its X login and `auth.cursor.com/set-cookie` to the router, Brave signed in, and the app stayed signed out
/// (2026-10-16). A web app loads such a link itself when it is opened with it, so the relay sends a sign-in step back to
/// the web app the click came from. Every other link from a web app goes to the browser as before.
package enum WebAppSignIn {
    package static let bundlePrefix = "com.apple.Safari.WebApp."
    private static let hostPrefixes = ["accounts.", "auth.", "login.", "signin.", "sso."]
    private static let pathWords = [
        "oauth", "authorize", "sign-in", "signin", "sign_in", "login", "check-login", "set-cookie", "cookie-chain",
        "callback",
    ]

    /// A link that belongs to a login: an account host, or an OAuth or login path component.
    package static func isSignInStep(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
            let host = url.host?.lowercased()
        else { return false }
        if hostPrefixes.contains(where: { host.hasPrefix($0) }) { return true }
        let components = url.path.lowercased().split(separator: "/").map(String.init)
        return components.contains { pathWords.contains($0) || $0 == "oauth2" }
    }

    package struct ReturnAttempt {
        package let raw: String
        package let sourceBundleID: String
        package let at: Date

        package func isRepeat(_ raw: String, sourceBundleID: String, now: Date) -> Bool {
            self.raw == raw && self.sourceBundleID == sourceBundleID && now.timeIntervalSince(at) < 10
        }
    }

    package static func completeReturn(_ raw: String, error: Error?, fallback: (String) -> Void) {
        if error != nil { fallback(raw) }
    }

    /// Whether a link that arrived while `sourceBundleID` was in front goes back into that web app.
    package static func returnsToWebApp(_ raw: String, sourceBundleID: String?) -> Bool {
        guard let id = sourceBundleID, id.hasPrefix(bundlePrefix), let url = URL(string: raw) else { return false }
        return isSignInStep(url)
    }
}
