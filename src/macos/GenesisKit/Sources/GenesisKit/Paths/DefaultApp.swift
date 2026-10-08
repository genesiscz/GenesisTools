import AppKit

// The app macOS opens a file with, by name, and the link that opens that app at a line. A menu says
// "Open in Cursor" rather than "Open", and an editor that has a `<scheme>://file/<path>:<line>` handler
// (Cursor, VS Code and its forks) lands on the line instead of the top of the file.

/// The default app for one file, as Launch Services answers it right now.
public struct DefaultApp: Equatable {
    public let url: URL
    /// "Cursor", "Xcode": the name Finder shows, without `.app`.
    public let name: String
    public let bundleIdentifier: String?
    /// The URL schemes the app declares (`CFBundleURLTypes`), lowercased.
    public let schemes: [String]

    public init(url: URL, name: String, bundleIdentifier: String?, schemes: [String]) {
        self.url = url
        self.name = name
        self.bundleIdentifier = bundleIdentifier
        self.schemes = schemes
    }

    /// The editor schemes that take `<scheme>://file/<absolute path>:<line>`, in the order tried.
    public static let lineSchemes = ["cursor", "vscode", "vscode-insiders", "vscodium", "windsurf"]

    /// A code editor that takes a line link: it shows a file and never runs it.
    public var opensAtLine: Bool {
        DefaultApp.lineSchemes.contains(where: schemes.contains)
    }

    /// nil when no app claims the file.
    public static func forFile(_ file: URL) -> DefaultApp? {
        guard let app = NSWorkspace.shared.urlForApplication(toOpen: file) else {
            return nil
        }

        let bundle = Bundle(url: app)
        let types = bundle?.infoDictionary?["CFBundleURLTypes"] as? [[String: Any]] ?? []
        let schemes = types.flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }.map { $0.lowercased() }
        return DefaultApp(url: app, name: displayName(app), bundleIdentifier: bundle?.bundleIdentifier, schemes: schemes)
    }

    static func displayName(_ app: URL) -> String {
        let name = FileManager.default.displayName(atPath: app.path)
        return name.hasSuffix(".app") ? String(name.dropLast(4)) : name
    }

    /// `cursor://file/<path>:<line>` when the app declares one of `lineSchemes` and a line is known;
    /// nil when the file should simply be opened with the app.
    public func lineURL(path: String, line: Int?) -> URL? {
        guard let line, line >= 1, let scheme = DefaultApp.lineSchemes.first(where: schemes.contains) else {
            return nil
        }

        var components = URLComponents()
        components.scheme = scheme
        components.host = "file"
        components.path = "\(path):\(line)"
        return components.url
    }

    /// Opens `file` with this app: at `line` through the editor's URL scheme when it has one.
    public func open(_ file: URL, line: Int?) {
        if let link = lineURL(path: file.path, line: line) {
            GenesisKit.log("path.defaultApp \(name) \(link.absoluteString)")
            NSWorkspace.shared.open(link)
            return
        }

        GenesisKit.log("path.defaultApp \(name) \(file.path)")
        NSWorkspace.shared.open([file], withApplicationAt: url, configuration: NSWorkspace.OpenConfiguration()) { _, error in
            if let error {
                GenesisKit.log("path.defaultApp \(name) failed for \(file.path): \(error.localizedDescription)")
                CopyToast.post(title: "\(name) did not open it", detail: PathLabel.display(file.path), style: .problem)
            }
        }
    }
}
