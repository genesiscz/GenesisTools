import AppKit
import SwiftUI

// What every path and copy control in GenesisTools.app does, in one place: a folder opens in
// Finder, an item is revealed in its folder, a file opens in its own app, Cursor and cmux open a
// folder or a file, and a copy puts text on the pasteboard and confirms it (`HubCopyToast`). Views
// never call NSWorkspace or NSPasteboard for these themselves.

// MARK: - Opening paths

/// What is on disk at a path, as far as opening it goes.
enum PathItemKind: Equatable {
    case missing
    case folder
    /// A directory macOS shows as one item (an `.app`, an `.xcodeproj`): Finder "opens" it by launching it.
    case package
    case file
}

/// What a path control asks for; its label says which one.
enum PathIntent: String {
    /// "Open in Finder" / "Show in Finder": a folder opens in a Finder window, a file or a package is
    /// revealed in its folder.
    case finder
    /// "Reveal in Finder": Finder shows the parent folder with the item selected.
    case reveal
    /// "Open": a file opens in the app macOS picks for it, a folder opens in Finder.
    case open
}

/// The one thing a path control does. Decided from the path and what is there, so a test pins it
/// with a spy instead of launching Finder.
enum PathOpenTarget: Equatable {
    case folderInFinder(URL)
    case revealInFinder(URL)
    case openFile(URL)
    /// Nothing is at the path (tilde expanded).
    case missing(String)
}

/// The side effects of `PathOpener.perform`.
protocol PathWorkspace {
    func kind(of url: URL) -> PathItemKind
    func openFolderInFinder(_ url: URL)
    func revealInFinder(_ url: URL)
    func openFile(_ url: URL)
    func reportMissing(_ path: String)
}

struct SystemPathWorkspace: PathWorkspace {
    func kind(of url: URL) -> PathItemKind {
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
    func openFolderInFinder(_ url: URL) {
        guard let finder = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.finder") else {
            HubPerf.log("path.open no Finder app, revealing \(url.path) instead")
            revealInFinder(url)
            return
        }

        NSWorkspace.shared.open([url], withApplicationAt: finder, configuration: NSWorkspace.OpenConfiguration()) { _, error in
            if let error {
                HubPerf.log("path.open Finder failed for \(url.path): \(error.localizedDescription)")
                HubCopyToast.post(title: "Finder did not open it", detail: PathLabel.display(url.path), style: .problem)
            }
        }
    }

    func revealInFinder(_ url: URL) {
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    func openFile(_ url: URL) {
        NSWorkspace.shared.open(url, configuration: NSWorkspace.OpenConfiguration()) { _, error in
            if let error {
                HubPerf.log("path.open failed for \(url.path): \(error.localizedDescription)")
                HubCopyToast.post(title: "No app opened it", detail: PathLabel.display(url.path), style: .problem)
            }
        }
    }

    func reportMissing(_ path: String) {
        HubCopyToast.post(title: "Not on disk", detail: PathLabel.display(path), style: .problem)
    }
}

enum PathOpener {
    /// A file URL for a path as a person or a transcript wrote it: `~` expanded, `..` and `.` resolved.
    /// Never `URL(string:)`: a path with a space, `#` or a non-ASCII letter is not a URL string.
    static func fileURL(_ path: String) -> URL {
        URL(fileURLWithPath: (path as NSString).expandingTildeInPath).standardizedFileURL
    }

    static func target(for url: URL, intent: PathIntent, kind: PathItemKind) -> PathOpenTarget {
        switch (kind, intent) {
        case (.missing, _): return .missing(url.path)
        case (.folder, .finder), (.folder, .open): return .folderInFinder(url)
        case (.file, .open), (.package, .open): return .openFile(url)
        case (_, .reveal), (.file, .finder), (.package, .finder): return .revealInFinder(url)
        }
    }

    /// Does what `intent` says for `path`, and returns what it did.
    @discardableResult
    static func perform(_ intent: PathIntent, _ path: String, workspace: PathWorkspace = SystemPathWorkspace()) -> PathOpenTarget {
        let url = fileURL(path)
        let target = target(for: url, intent: intent, kind: workspace.kind(of: url))
        HubPerf.log("path.\(intent.rawValue) \(url.path) -> \(target)")
        switch target {
        case .folderInFinder(let url): workspace.openFolderInFinder(url)
        case .revealInFinder(let url): workspace.revealInFinder(url)
        case .openFile(let url): workspace.openFile(url)
        case .missing(let path): workspace.reportMissing(path)
        }
        return target
    }

    /// "Open in Finder": a folder in a Finder window, a file selected in its folder.
    static func finder(_ path: String) {
        perform(.finder, path)
    }

    /// "Reveal in Finder": selected in its parent folder.
    static func reveal(_ path: String) {
        perform(.reveal, path)
    }

    /// "Open": a file in its default app, a folder in Finder.
    static func open(_ path: String) {
        perform(.open, path)
    }

    /// `cursor -g path:line` when a line is known, else the folder or file.
    static func cursor(_ path: String, line: Int? = nil) {
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
            HubPerf.log("path.cursor failed for \(path): \(error.localizedDescription)")
            HubCopyToast.post(title: "Cursor did not start", detail: error.localizedDescription, style: .problem)
        }
    }

    /// Off the main thread: the terminal host's CLI runs synchronously, up to its 60 s timeout.
    static func cmux(_ path: String) {
        let path = fileURL(path).path
        Task.detached(priority: .userInitiated) {
            let error = AgentLauncher.openInTerminal(name: (path as NSString).lastPathComponent, cwd: path, command: ["zsh"])
            if let error {
                await MainActor.run { HubPerf.log("cmux open \(path) failed: \(error)") }
            }
        }
    }

    /// Kept for the many call sites that copy a path or an id: the same as `Clipboard.copy`.
    static func copy(_ text: String, what: String? = nil) {
        Clipboard.copy(text, what: what)
    }
}

// MARK: - Copying

/// The one way a control copies text: the pasteboard, then the `HubCopyToast` confirmation.
enum Clipboard {
    /// `what` names the value in the confirmation ("Copied path"); nil says "Copied".
    static func copy(_ text: String, what: String? = nil) {
        guard !text.isEmpty else {
            HubPerf.log("copy \(what ?? "text"): nothing to copy")
            HubCopyToast.post(title: "Nothing to copy", detail: what.map { "No \($0)" } ?? "", style: .problem)
            return
        }

        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        HubPerf.log("copy \(what ?? "text") \(text.count) chars")
        // A path under the home folder shows as "~/…": shorter, and the part that says which one stays.
        HubCopyToast.post(title: what.map { "Copied \($0)" } ?? "Copied", detail: HubCopyToast.preview(PathLabel.display(text)), style: .copied)
    }
}

/// A small capsule beside the pointer that confirms a copy ("Copied path" and the start of the
/// value), or says why a path did not open. It fades after about 1.2 s. A borderless panel that
/// takes no click and never becomes key, so it shows over any window, popover or web view and
/// nothing under it changes. Not a notification banner, and never a sound.
enum HubCopyToast {
    enum Style {
        case copied
        case problem
    }

    /// Callable from any thread; the panel is shown on the main thread.
    static func post(title: String, detail: String, style: Style) {
        if Thread.isMainThread {
            MainActor.assumeIsolated { HubCopyToastPanel.shared.show(title: title, detail: detail, style: style) }
        } else {
            DispatchQueue.main.async {
                MainActor.assumeIsolated { HubCopyToastPanel.shared.show(title: title, detail: detail, style: style) }
            }
        }
    }

    /// One short line of what was copied: a multi-line text as its line count, a long line with
    /// its middle cut (a path keeps its start and its file name).
    static func preview(_ text: String, limit: Int = 56) -> String {
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
    static func origin(pointer: CGPoint, size: CGSize, screen: CGRect) -> CGPoint {
        var origin = CGPoint(x: pointer.x + 14, y: pointer.y + 10)
        origin.x = min(max(origin.x, screen.minX + 4), screen.maxX - size.width - 4)
        origin.y = min(max(origin.y, screen.minY + 4), screen.maxY - size.height - 4)
        return origin
    }
}

@MainActor
private final class HubCopyToastPanel {
    static let shared = HubCopyToastPanel()

    private let panel: NSPanel
    private let host: NSHostingView<HubCopyToastView>
    private var generation = 0

    private init() {
        host = NSHostingView(rootView: HubCopyToastView(title: "", detail: "", style: .copied))
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

    func show(title: String, detail: String, style: HubCopyToast.Style) {
        generation += 1
        let current = generation
        host.rootView = HubCopyToastView(title: title, detail: detail, style: style)
        let size = host.fittingSize
        let pointer = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(pointer) } ?? NSScreen.main
        let origin = HubCopyToast.origin(pointer: pointer, size: size, screen: screen?.visibleFrame ?? CGRect(origin: .zero, size: size))
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

struct HubCopyToastView: View {
    let title: String
    let detail: String
    let style: HubCopyToast.Style

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: style == .copied ? "checkmark" : "exclamationmark.circle")
                .font(.system(size: 10, weight: .bold))
                .foregroundColor(style == .copied ? ReviewPalette.added : ReviewPalette.modified)
            Text(verbatim: title)
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundColor(Color.white.opacity(0.92))
            if !detail.isEmpty {
                Text(verbatim: detail)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(ReviewPalette.dim)
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
final class ClosureMenuItem: NSMenuItem {
    private let handler: () -> Void

    init(_ title: String, _ handler: @escaping () -> Void) {
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
