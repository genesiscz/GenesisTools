// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Focus/Activity/FocusSettings.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import CryptoKit
import Foundation

/// Spec 22 (S6) — the privacy surface, as data.
///
/// Read from `~/.genesis/client.json` under `app.focus`. The defaults are the conservative
/// ones on purpose: the exclusion list ships non-empty, and URL paths are off until asked for.
public struct FocusSettings: Equatable {
    public init() {}

    public enum TitleMode: String { case full, appOnly = "app-only", hashed }
    public enum URLMode: String { case off, host, hostPath = "host+path" }

    public struct ProjectRule: Equatable {
        public var name: String
        public var cmuxSession: String?
        public var titleContains: String?
        public var host: String?

        public init(name: String, cmuxSession: String? = nil, titleContains: String? = nil, host: String? = nil) {
            self.name = name
            self.cmuxSession = cmuxSession
            self.titleContains = titleContains
            self.host = host
        }
    }

    public var captureEnabled = true
    public var titleMode: TitleMode = .full
    public var urlMode: URLMode = .host
    public var idleThresholdSec = 120
    public var retentionDays = 365
    /// Up to a hundred years. A larger value falls back to the default rather than overflowing the cutoff.
    public static let retentionRange = 1...36_500
    public var interruptionThresholdSec = 45
    /// `time` shows the countdown, `dot` only the phase dot, `off` removes the item.
    public var menuBarStyle = "time"
    public var excludedBundles: Set<String> = FocusSettings.defaultExcludedBundles
    public var excludedHosts: Set<String> = []
    public var projects: [ProjectRule] = []

    /// Apps whose mere window title is a secret. Shipped non-empty so the first run is already
    /// safe, rather than safe once someone remembers to configure it.
    public static let defaultExcludedBundles: Set<String> = [
        "com.1password.1password",
        "com.agilebits.onepassword7",
        "com.apple.keychainaccess",
        "com.bitwarden.desktop",
    ]

    /// Browsers we know how to read an address from. Anything else records app and title only.
    public static let browserBundles: Set<String> = [
        "com.brave.Browser",
        "com.google.Chrome",
        "com.apple.Safari",
        "company.thebrowser.Browser",
        "org.mozilla.firefox",
    ]

    // MARK: - Decoding

    /// Builds settings from the `app` dictionary of client.json. Unknown values fall back to the
    /// default rather than throwing: a typo in a config file must not stop the recorder.
    public static func from(appConfig: [String: Any]) -> FocusSettings {
        var settings = FocusSettings()
        guard let focus = appConfig["focus"] as? [String: Any] else { return settings }

        if let value = focus["captureEnabled"] as? Bool { settings.captureEnabled = value }
        if let raw = focus["titleMode"] as? String, let mode = TitleMode(rawValue: raw) { settings.titleMode = mode }
        if let raw = focus["urlMode"] as? String, let mode = URLMode(rawValue: raw) { settings.urlMode = mode }
        if let value = focus["idleThresholdSec"] as? Int, value > 0 { settings.idleThresholdSec = value }
        if let value = focus["retentionDays"] as? Int, retentionRange.contains(value) { settings.retentionDays = value }
        if let value = focus["interruptionThresholdSec"] as? Int, value > 0 { settings.interruptionThresholdSec = value }
        if let raw = focus["menuBarStyle"] as? String, ["time", "dot", "off"].contains(raw) { settings.menuBarStyle = raw }
        if let list = focus["excludedBundles"] as? [String] {
            settings.excludedBundles = Set(list).union(defaultExcludedBundles)
        }
        if let list = focus["excludedHosts"] as? [String] { settings.excludedHosts = Set(list) }
        if let rules = focus["projects"] as? [[String: Any]] {
            settings.projects = rules.compactMap { rule in
                guard let name = rule["name"] as? String, !name.isEmpty else { return nil }
                return ProjectRule(name: name,
                                   cmuxSession: rule["cmuxSession"] as? String,
                                   titleContains: rule["titleContains"] as? String,
                                   host: rule["host"] as? String)
            }
        }
        return settings
    }

    // MARK: - Policy

    public func records(bundle: String) -> Bool {
        captureEnabled && !excludedBundles.contains(bundle)
    }

    public func records(host: String) -> Bool {
        let normalized = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        return !excludedHosts.contains { value in
            let excluded = value.trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
            return !excluded.isEmpty && (normalized == excluded || normalized.hasSuffix("." + excluded))
        }
    }

    /// Applies the title policy. `hashed` keeps switch counting honest (the same window is the
    /// same string) while making the title itself unreadable.
    public func title(_ raw: String?, appName: String) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        switch titleMode {
        case .full: return raw
        case .appOnly: return appName
        case .hashed:
            let digest = SHA256.hash(data: Data(raw.utf8))
            return "sha256:" + digest.map { String(format: "%02x", $0) }.joined().prefix(12)
        }
    }

    /// Splits a URL under the current policy. Returns nil host when URLs are off entirely.
    public func urlParts(_ raw: String?) -> (host: String?, path: String?) {
        guard urlMode != .off, let raw, let url = URL(string: raw), let host = url.host else { return (nil, nil) }
        guard records(host: host) else { return (nil, nil) }
        switch urlMode {
        case .off: return (nil, nil)
        case .host: return (host, nil)
        case .hostPath: return (host, url.path.isEmpty ? nil : url.path)
        }
    }

    /// First matching rule wins, checked cmux → title → host, exactly as spec §5.4 says.
    /// No inference: a project that is not in the rules stays nil and shows as unattributed.
    public func project(cmuxSession: String?, title: String?, host: String?) -> String? {
        for rule in projects {
            if let want = rule.cmuxSession, let have = cmuxSession, have.contains(want) { return rule.name }
        }
        for rule in projects {
            if let want = rule.titleContains, let have = title, have.contains(want) { return rule.name }
        }
        for rule in projects {
            if let want = rule.host, let have = host, have == want || have.hasSuffix("." + want) { return rule.name }
        }
        return nil
    }
}

// MARK: - Editing

extension FocusSettings {
    /// The part of `app.focus` these settings own, as client.json stores it. The built-in app exclusions are left out:
    /// they apply whatever is stored, so the stored list holds only what the user added.
    public var storedFields: [String: Any] {
        [
            "captureEnabled": captureEnabled,
            "titleMode": titleMode.rawValue,
            "urlMode": urlMode.rawValue,
            "idleThresholdSec": idleThresholdSec,
            "interruptionThresholdSec": interruptionThresholdSec,
            "retentionDays": retentionDays,
            "menuBarStyle": menuBarStyle,
            "excludedBundles": excludedBundles.subtracting(Self.defaultExcludedBundles).sorted(),
            "excludedHosts": excludedHosts.sorted(),
            "projects": projects.map(\.storedFields),
        ]
    }

    /// What the user typed or pasted for an excluded site ("https://www.example.com/path", "*.example.com",
    /// "Example.com.") as the host name the recorder compares, or nil when it is not a host name.
    public static func normalizedHost(_ raw: String) -> String? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if text.contains("://") {
            guard let host = URL(string: text)?.host else { return nil }
            text = host
        }
        if let slash = text.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" }) { text = String(text[..<slash]) }
        if let colon = text.lastIndex(of: ":"), text[text.index(after: colon)...].allSatisfy(\.isNumber) {
            text = String(text[..<colon])
        }
        if text.hasPrefix("*.") { text.removeFirst(2) }
        text = text.trimmingCharacters(in: CharacterSet(charactersIn: "."))
        guard !text.isEmpty, !text.contains(".."),
              text.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" })
        else { return nil }
        return text
    }
}

extension FocusSettings.ProjectRule {
    var storedFields: [String: Any] {
        var fields: [String: Any] = ["name": name]
        if let cmuxSession { fields["cmuxSession"] = cmuxSession }
        if let titleContains { fields["titleContains"] = titleContains }
        if let host { fields["host"] = host }
        return fields
    }

    /// A rule from the editor's fields: trimmed, with empty conditions dropped and the site normalized. Throws a
    /// sentence the editor shows when the name is empty or taken, or when no condition is left.
    public static func validated(name: String, cmuxSession: String, titleContains: String, host: String,
                                 existingNames: [String]) throws -> Self {
        func clean(_ value: String) -> String? {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        guard let name = clean(name) else { throw FocusRuleError("Give the project a name.") }
        guard !existingNames.contains(where: { $0.caseInsensitiveCompare(name) == .orderedSame }) else {
            throw FocusRuleError("Another rule is already called \(name).")
        }
        var site: String?
        if let rawHost = clean(host) {
            guard let normalized = FocusSettings.normalizedHost(rawHost) else {
                throw FocusRuleError("\(rawHost) is not a site name. Use a name such as example.com.")
            }
            site = normalized
        }
        let rule = Self(name: name, cmuxSession: clean(cmuxSession), titleContains: clean(titleContains), host: site)
        guard rule.cmuxSession != nil || rule.titleContains != nil || rule.host != nil else {
            throw FocusRuleError("Add at least one condition: a cmux session, a window title or a site.")
        }
        return rule
    }
}

public struct FocusRuleError: LocalizedError, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}
