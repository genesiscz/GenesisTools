import Foundation

/// Cross-checks a tab read by application name against window titles from the requested process.
public enum BrowserTabInfo {
    public static func checked(
        url: String?, title: String?, appName: String, axWindowTitles: [String]
    ) -> [String: Any]? {
        guard let title, !title.isEmpty else { return nil }
        var tab: [String: Any] = ["title": title]
        if let url { tab["url"] = url }
        let matches = axWindowTitles.contains { $0.localizedCaseInsensitiveContains(title) }
        tab["pidMatch"] = matches
        if !matches {
            tab["warning"] = "tab title not found in this pid's window titles — likely from ANOTHER instance of \(appName) (AppleScript resolves by name, not pid); do not trust for this process"
        }
        return tab
    }
}
