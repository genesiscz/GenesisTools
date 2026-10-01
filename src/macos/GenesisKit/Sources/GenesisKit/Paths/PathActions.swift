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
            GenesisKit.log("path.open no Finder app, revealing \(url.path) instead")
            revealInFinder(url)
            return
        }

        NSWorkspace.shared.open([url], withApplicationAt: finder, configuration: NSWorkspace.OpenConfiguration()) { _, error in
            if let error {
                GenesisKit.log("path.open Finder failed for \(url.path): \(error.localizedDescription)")
                CopyToast.post(title: "Finder did not open it", detail: PathLabel.display(url.path), style: .problem)
            }
        }
    }

    public func revealInFinder(_ url: URL) {
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    public func openFile(_ url: URL) {
        NSWorkspace.shared.open(url, configuration: NSWorkspace.OpenConfiguration()) { _, error in
            if let error {
                GenesisKit.log("path.open failed for \(url.path): \(error.localizedDescription)")
                CopyToast.post(title: "No app opened it", detail: PathLabel.display(url.path), style: .problem)
            }
        }
    }

    public func editFile(_ url: URL, line: Int?) {
        PathOpener.cursor(url.path, line: line)
    }

    public func reportMissing(_ path: String) {
        CopyToast.post(title: "Not on disk", detail: PathLabel.display(path), style: .problem)
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
        GenesisKit.log("path.\(intent.rawValue) \(url.path) -> \(target)")
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
        let cli = ["~/.local/bin/cursor", "/usr/local/bin/cursor", "/opt/homebrew/bin/cursor"]
            .map { ($0 as NSString).expandingTildeInPath }
            .first { FileManager.default.isExecutableFile(atPath: $0) }
        let process = Process()
        if let cli {
            process.executableURL = URL(fileURLWithPath: cli)
            process.arguments = line.map { ["-g", "\(path):\($0)"] } ?? [path]
        } else {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            process.arguments = ["-a", "Cursor", path]
        }
        do {
            try process.run()
        } catch {
            GenesisKit.log("path.cursor failed for \(path): \(error.localizedDescription)")
            CopyToast.post(title: "Cursor did not start", detail: error.localizedDescription, style: .problem)
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
        guard let host = GenesisKit.host, host.opensTerminal else {
            GenesisKit.log("path.cmux \(folder): the app opens no terminal")
            return
        }
        host.openTerminal(folder: folder)
    }

    /// Kept for the many call sites that copy a path or an id: the same as `Clipboard.copy`.
    public static func copy(_ text: String, what: String? = nil) {
        Clipboard.copy(text, what: what)
    }
}

// MARK: - Copying

/// The one way a control copies text: the pasteboard, then the `CopyToast` confirmation.
public enum Clipboard {
    /// `what` names the value in the confirmation ("Copied path"); nil says "Copied".
    public static func copy(_ text: String, what: String? = nil) {
        guard !text.isEmpty else {
            GenesisKit.log("copy \(what ?? "text"): nothing to copy")
            CopyToast.post(title: "Nothing to copy", detail: what.map { "No \($0)" } ?? "", style: .problem)
            return
        }

        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        GenesisKit.log("copy \(what ?? "text") \(text.count) chars")
        // A path under the home folder shows as "~/…": shorter, and the part that says which one stays.
        CopyToast.post(title: what.map { "Copied \($0)" } ?? "Copied", detail: CopyToast.preview(PathLabel.display(text)), style: .copied)
    }
}

/// A small capsule beside the pointer that confirms a copy ("Copied path" and the start of the
/// value), or says why a path did not open. It fades after about 1.2 s. A borderless panel that
/// takes no click and never becomes key, so it shows over any window, popover or web view and
/// nothing under it changes. Not a notification banner, and never a sound.
public enum CopyToast {
    public enum Style {
        case copied
        case problem
    }

    /// Callable from any thread; the panel is shown on the main thread.
    public static func post(title: String, detail: String, style: Style) {
        if Thread.isMainThread {
            MainActor.assumeIsolated { CopyToastPanel.shared.show(title: title, detail: detail, style: style) }
        } else {
            DispatchQueue.main.async {
                MainActor.assumeIsolated { CopyToastPanel.shared.show(title: title, detail: detail, style: style) }
            }
        }
    }

    /// One short line of what was copied: a multi-line text as its line count, a long line with
    /// its middle cut (a path keeps its start and its file name).
    public static func preview(_ text: String, limit: Int = 56) -> String {
        let lines = text.split(whereSeparator: \.isNewline)
        if lines.count > 1 {
            return "\(lines.count) lines"
        }

        let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard line.count > limit else {
            return line
        }

        let half = (limit - 1) / 2
        return "\(line.prefix(half))…\(line.suffix(half))"
    }

    /// Where the capsule goes: above and right of the pointer, inside the visible screen.
    public static func origin(pointer: CGPoint, size: CGSize, screen: CGRect) -> CGPoint {
        var origin = CGPoint(x: pointer.x + 14, y: pointer.y + 10)
        origin.x = min(max(origin.x, screen.minX + 4), screen.maxX - size.width - 4)
        origin.y = min(max(origin.y, screen.minY + 4), screen.maxY - size.height - 4)
        return origin
    }
}

@MainActor
private final class CopyToastPanel {
    static let shared = CopyToastPanel()

    private let panel: NSPanel
    private let host: NSHostingView<CopyToastView>
    private var generation = 0

    private init() {
        host = NSHostingView(rootView: CopyToastView(title: "", detail: "", style: .copied))
        panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.level = .popUpMenu
        panel.collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary, .canJoinAllSpaces]
        panel.contentView = host
    }

    func show(title: String, detail: String, style: CopyToast.Style) {
        generation += 1
        let current = generation
        host.rootView = CopyToastView(title: title, detail: detail, style: style)
        let size = host.fittingSize
        let pointer = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(pointer) } ?? NSScreen.main
        let origin = CopyToast.origin(pointer: pointer, size: size, screen: screen?.visibleFrame ?? CGRect(origin: .zero, size: size))
        panel.setFrame(CGRect(origin: origin, size: size), display: true)
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.12
            panel.animator().alphaValue = 1
        }
        let hold = style == .copied ? 0.9 : 2.2
        DispatchQueue.main.asyncAfter(deadline: .now() + hold) { [weak self] in
            MainActor.assumeIsolated { self?.fade(current) }
        }
    }

    private func fade(_ shown: Int) {
        guard shown == generation else {
            return
        }

        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.3
            panel.animator().alphaValue = 0
        } completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                guard let self, shown == self.generation else { return }
                self.panel.orderOut(nil)
            }
        }
    }
}

struct CopyToastView: View {
    let title: String
    let detail: String
    let style: CopyToast.Style

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: style == .copied ? "checkmark" : "exclamationmark.circle")
                .font(.system(size: 10, weight: .bold))
                .foregroundColor(style == .copied ? KitPalette.added : KitPalette.modified)
            Text(verbatim: title)
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundColor(Color.white.opacity(0.92))
            if !detail.isEmpty {
                Text(verbatim: detail)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(KitPalette.dim)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Capsule().fill(Color(white: 0.13).opacity(0.96)))
        .overlay(Capsule().stroke(Color.white.opacity(0.12)))
        .padding(6)
        .fixedSize()
        .environment(\.colorScheme, .dark)
    }
}

// MARK: - A native menu of path actions

/// An NSMenu item that runs a closure: the diff header's right-click menu is built in Swift from
/// the file it names, for a page that only says which file was clicked.
public final class ClosureMenuItem: NSMenuItem {
    private let handler: () -> Void

    public init(_ title: String, _ handler: @escaping () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(run), keyEquivalent: "")
        target = self
    }

    @available(*, unavailable)
    required init(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    @objc private func run() {
        handler()
    }
}
