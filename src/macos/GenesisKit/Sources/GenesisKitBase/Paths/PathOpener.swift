import AppKit
import SwiftUI

// What every path and copy control does, in both apps: a folder opens in Finder, an item is
// revealed in its folder, a file opens in its own app, Cursor and cmux open a folder or a file, and
// a copy puts text on the pasteboard and confirms it (`CopyToast`). Views never call NSWorkspace or
// NSPasteboard for these themselves. From GenesisTools Hub/HubPathActions.swift (2026-09-30).

// MARK: - Opening paths

/// What is on disk at a path, as far as opening it goes.
public enum PathItemKind: Equatable {
    case missing
    case folder
    /// A directory macOS shows as one item (an `.app`, an `.xcodeproj`): Finder "opens" it by launching it.
    case package
    case file
}

/// What a path control asks for; its label says which one.
public enum PathIntent: String {
    /// "Open in Finder" / "Show in Finder": a folder opens in a Finder window, a file or a package is
    /// revealed in its folder.
    case finder
    /// "Reveal in Finder": Finder shows the parent folder with the item selected.
    case reveal
    /// "Open": a file opens in the app macOS picks for it, a folder opens in Finder.
    case open
    /// A click on the path itself (`PathLabel`): a folder opens in Finder, a file opens in Cursor
    /// (at its line when one is known), a package is revealed.
    case primary
}

/// The one thing a path control does. Decided from the path and what is there, so a test pins it
/// with a spy instead of launching Finder.
public enum PathOpenTarget: Equatable {
    case folderInFinder(URL)
    case revealInFinder(URL)
    case openFile(URL)
    /// A file in the editor (Cursor), at `line` when known.
    case editFile(URL, line: Int?)
    /// Nothing is at the path (tilde expanded).
    case missing(String)
}

/// The side effects of `PathOpener.perform`.
public protocol PathWorkspace {
    func kind(of url: URL) -> PathItemKind
    func openFolderInFinder(_ url: URL)
    func revealInFinder(_ url: URL)
    func openFile(_ url: URL)
    func editFile(_ url: URL, line: Int?)
    func reportMissing(_ path: String)
}

public struct SystemPathWorkspace: PathWorkspace {
    public init() {}

    public func kind(of url: URL) -> PathItemKind {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
            return .missing
        }

        guard isDirectory.boolValue else {
            return .file
        }

        return NSWorkspace.shared.isFilePackage(atPath: url.path) ? .package : .folder
    }

    /// Finder by name, never the folder's default app: LaunchServices on one Mac hands
    /// `public.folder` to QuickTime Player, which answered the session folder chip with "The
    /// specified URL type isn't supported" (2026-09-25).
    public func openFolderInFinder(_ url: URL) {
        guard let finder = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.finder") else {
            KitHost.log("path.open no Finder app, revealing \(url.path) instead")
            revealInFinder(url)
            return
        }

        NSWorkspace.shared.open([url], withApplicationAt: finder, configuration: NSWorkspace.OpenConfiguration()) { _, error in
            if let error {
                KitHost.log("path.open Finder failed for \(url.path): \(error.localizedDescription)")
                CopyToast.post(title: "Finder did not open it", detail: PathDisplay.tilde(url.path), style: .problem)
            }
        }
    }

    public func revealInFinder(_ url: URL) {
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    public func openFile(_ url: URL) {
        NSWorkspace.shared.open(url, configuration: NSWorkspace.OpenConfiguration()) { _, error in
            if let error {
                KitHost.log("path.open failed for \(url.path): \(error.localizedDescription)")
                CopyToast.post(title: "No app opened it", detail: PathDisplay.tilde(url.path), style: .problem)
            }
        }
    }

    public func editFile(_ url: URL, line: Int?) {
        PathOpener.cursor(url.path, line: line)
    }

    public func reportMissing(_ path: String) {
        CopyToast.post(title: "Not on disk", detail: PathDisplay.tilde(path), style: .problem)
    }
}

public enum PathOpener {
    /// A file URL for a path as a person or a transcript wrote it: `~` expanded, `..` and `.` resolved.
    /// Never `URL(string:)`: a path with a space, `#` or a non-ASCII letter is not a URL string.
    public static func fileURL(_ path: String) -> URL {
        URL(fileURLWithPath: (path as NSString).expandingTildeInPath).standardizedFileURL
    }

    public static func target(for url: URL, intent: PathIntent, kind: PathItemKind, line: Int? = nil) -> PathOpenTarget {
        switch (kind, intent) {
        case (.missing, _): return .missing(url.path)
        case (.folder, .finder), (.folder, .open), (.folder, .primary): return .folderInFinder(url)
        case (.file, .primary): return .editFile(url, line: line)
        case (.package, .primary): return .revealInFinder(url)
        case (.file, .open), (.package, .open): return .openFile(url)
        case (_, .reveal), (.file, .finder), (.package, .finder): return .revealInFinder(url)
        }
    }

    /// Does what `intent` says for `path`, and returns what it did.
    @discardableResult public static func perform(_ intent: PathIntent, _ path: String, line: Int? = nil, workspace: PathWorkspace = SystemPathWorkspace()) -> PathOpenTarget {
        let url = fileURL(path)
        let target = target(for: url, intent: intent, kind: workspace.kind(of: url), line: line)
        KitHost.log("path.\(intent.rawValue) \(url.path) -> \(target)")
        switch target {
        case .folderInFinder(let url): workspace.openFolderInFinder(url)
        case .revealInFinder(let url): workspace.revealInFinder(url)
        case .openFile(let url): workspace.openFile(url)
        case .editFile(let url, let line): workspace.editFile(url, line: line)
        case .missing(let path): workspace.reportMissing(path)
        }
        return target
    }

    /// "Open in Finder": a folder in a Finder window, a file selected in its folder.
    public static func finder(_ path: String) {
        perform(.finder, path)
    }

    /// "Reveal in Finder": selected in its parent folder.
    public static func reveal(_ path: String) {
        perform(.reveal, path)
    }

    /// "Open": a file in its default app, a folder in Finder.
    public static func open(_ path: String) {
        perform(.open, path)
    }

    /// What a click on a path does (`PathLabel`): a folder in Finder, a file in Cursor at `line`.
    public static func primary(_ path: String, line: Int? = nil) {
        perform(.primary, path, line: line)
    }

    /// `cursor -g path:line` when a line is known, else the folder or file.
    public static func cursor(_ path: String, line: Int? = nil) {
        let path = fileURL(path).path
        runCursor(cliArguments: line.map { ["-g", "\(path):\($0)"] } ?? [path], paths: [path])
    }

    /// What "Open in Cursor" hands Cursor for a path menu: the whole folder, and for a file its folder
    /// first and then the file, so the file opens inside its folder's window rather than alone.
    public static func cursorWorkspacePaths(for path: String, kind: PathKind) -> [String] {
        let path = fileURL(path).path
        guard kind == .file else { return [path] }
        return [(path as NSString).deletingLastPathComponent, path]
    }

    /// "Open in Cursor" from a path menu (`PathMenu`): the folder as a workspace, a file inside its folder.
    public static func cursorWorkspace(_ path: String, kind: PathKind) {
        let paths = cursorWorkspacePaths(for: path, kind: kind)
        runCursor(cliArguments: paths, paths: paths)
    }

    /// The `cursor` CLI with `cliArguments`, or `open -a Cursor` with `paths` when it is not installed.
    private static func runCursor(cliArguments: [String], paths: [String]) {
        let cli = ["~/.local/bin/cursor", "/usr/local/bin/cursor", "/opt/homebrew/bin/cursor"]
            .map { ($0 as NSString).expandingTildeInPath }
            .first { FileManager.default.isExecutableFile(atPath: $0) }
        let process = Process()
        if let cli {
            process.executableURL = URL(fileURLWithPath: cli)
            process.arguments = cliArguments
        } else {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            process.arguments = ["-a", "Cursor"] + paths
        }
        do {
            try process.run()
        } catch {
            KitHost.log("path.cursor failed for \(paths.joined(separator: " ")): \(error.localizedDescription)")
            CopyToast.post(title: "Cursor did not start", detail: error.localizedDescription, style: .problem)
        }
    }

    /// `obsidian://open?path=<absolute path>`: Obsidian finds the vault that holds the file itself.
    public static func obsidianURL(for path: String) -> URL? {
        var components = URLComponents(string: "obsidian://open")
        components?.queryItems = [URLQueryItem(name: "path", value: fileURL(path).path)]
        return components?.url
    }

    /// "Open in Obsidian": the note in the vault that holds it.
    public static func obsidian(_ path: String) {
        guard let url = obsidianURL(for: path) else { return }
        KitHost.log("path.obsidian \(url.absoluteString)")
        NSWorkspace.shared.open(url)
    }

    /// "Open in Terminal": the app's own terminal (a cmux workspace, `GenesisKitHost.openTerminal`) when it
    /// has one, else Terminal.app in the path's folder (a file: its folder).
    public static func terminal(_ path: String) {
        if KitHost.host?.opensTerminal == true {
            cmux(path)
            return
        }

        let folder = URL(fileURLWithPath: terminalFolder(for: fileURL(path).path))
        guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Terminal") else {
            CopyToast.post(title: "No Terminal app", detail: PathDisplay.tilde(folder.path), style: .problem)
            return
        }

        NSWorkspace.shared.open([folder], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration()) { _, error in
            if let error {
                KitHost.log("path.terminal failed for \(folder.path): \(error.localizedDescription)")
                CopyToast.post(title: "Terminal did not open it", detail: PathDisplay.tilde(folder.path), style: .problem)
            }
        }
    }

    /// The folder a terminal opens in for `path`: the path itself, or a file's folder.
    public static func terminalFolder(for path: String) -> String {
        var isFolder: ObjCBool = false
        let isFile = FileManager.default.fileExists(atPath: path, isDirectory: &isFolder) && !isFolder.boolValue
        return isFile ? (path as NSString).deletingLastPathComponent : path
    }

    /// A shell in the path's folder, through the app's host (`GenesisKitHost.openTerminal`);
    /// nothing in an app without one.
    public static func cmux(_ path: String) {
        let folder = terminalFolder(for: fileURL(path).path)
        guard let host = KitHost.host, host.opensTerminal else {
            KitHost.log("path.cmux \(folder): the app opens no terminal")
            return
        }
        host.openTerminal(folder: folder)
    }

    /// Kept for the many call sites that copy a path or an id: the same as `Clipboard.copy`.
    public static func copy(_ text: String, what: String? = nil) {
        Clipboard.copy(text, what: what)
    }
}

