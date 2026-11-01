//
//  PathLinks.swift
//  GenesisKit
//
//  A markdown link to a file on this Mac, clicked in rendered text. Agents write a note link as a plain
//  absolute path (`[Plan.md](/Users/alice/notes/Plan.md)`), and SwiftUI's default `openURL` hands that
//  schemeless URL to Launch Services, which answers with Finder's "The application can't be opened. -50"
//  (the widget, 2026-11-01). `PathLink` turns such a link into a path and a line, decides what a click does
//  (`PathLink.step`), and `PathLinkHandler` does it through a `PathLinkSystem` that a test replaces. A web
//  link or an app's own scheme (`https:`, `cursor:`, `genesis-md:`) keeps the system's behavior.
//

import AppKit
import SwiftUI

/// What a link points at, as far as a click goes.
public enum PathLinkTarget: Equatable {
    /// A file or folder: a schemeless path (`/Users/…`, `~/…`, or relative) or a `file:` URL, percent-decoded,
    /// with a `:12`, `:12:5` or `#L10-L20` suffix taken off into `lines` (both ends of a range).
    case path(String, lines: MarkdownLineRange?)
    /// Anything else: a web page, an app's scheme, an in-page anchor, a `file:` URL on another machine. A
    /// network-path link (`//example.org/docs`) is a web page with its scheme left out, so it carries `https:`.
    case other(URL)
}

/// The `fileLinkClick` widget preference: what a click on a file link does.
public enum FileLinkClick: String, CaseIterable, Sendable {
    /// A note (`.md`, `.markdown`) in Genesis Markdown when it is installed; any other file in its default app.
    case genesisMarkdown = "genesis-markdown"
    /// Every file in the app macOS opens it with.
    case defaultApp = "default-app"
    /// A menu at the click with every way to open it.
    case ask

    /// The stored value; nil or an unknown value reads as the default.
    public init(preference: String?) {
        self = preference.flatMap(FileLinkClick.init(rawValue:)) ?? .genesisMarkdown
    }
}

/// The one thing a click on a file link does. Decided from the link, what is on disk and the setting, so a
/// test pins it without opening anything.
public enum PathLinkStep: Equatable {
    /// Genesis Markdown, scrolled to `lines` with them marked when the link names some.
    case genesisMarkdown(URL, lines: MarkdownLineRange?)
    /// The default app, at `line` when it is an editor with a line scheme (`DefaultApp.open`).
    case defaultApp(URL, line: Int?)
    case folderInFinder(URL)
    /// A package (an `.app`) is selected in its folder, never launched by a link.
    case revealInFinder(URL)
    /// The menu of every way to open it (`PathLinkHandler.menuEntries`).
    case menu(URL, kind: PathItemKind, lines: MarkdownLineRange?)
    /// Nothing is there, or the link is a relative path with no folder to resolve it against.
    case missing(String)
}

/// A file link found in a markdown text, for the right-click menu of the text that shows it.
public struct PathLinkRef: Hashable {
    /// The link's text ("Plan.md"); the file name when the text is empty.
    public let label: String
    public let path: String
    public let lines: MarkdownLineRange?

    public init(label: String, path: String, lines: MarkdownLineRange?) {
        self.label = label
        self.path = path
        self.lines = lines
    }
}

public enum PathLink {
    public static func target(for url: URL) -> PathLinkTarget {
        let scheme = url.scheme?.lowercased()
        guard scheme == nil || scheme == "file" else { return .other(url) }

        // A host names another machine, and `URL.path` drops it: read as a path, `//example.org/docs` was the local
        // `/docs`. Without a scheme it is a web link (`//localhost:3000/` too); a `file:` URL is on this Mac only as
        // `file:///…` or `file://localhost/…`.
        if let host = url.host(percentEncoded: false), !host.isEmpty {
            if scheme == nil {
                return .other(webURL(url))
            }
            if host.lowercased() != "localhost" {
                return .other(url)
            }
        }

        // `URL.path` is percent-decoded: `%C4%8CEZ/a%20b.md` reads `ČEZ/a b.md`.
        let raw = url.path
        guard !raw.isEmpty else { return .other(url) }

        // A fragment (`#L10-L20`, `#L7`, `#10-20`) keeps both ends; `#intro` is a heading, no lines.
        let split = splitLine(raw)
        let suffix = split.line.flatMap { MarkdownLineRange(first: $0, last: $0) }
        return .path(split.path, lines: MarkdownLineRange.parse(url.fragment) ?? suffix)
    }

    /// A network-path link with the scheme a browser would give it here, where no page supplies one.
    private static func webURL(_ url: URL) -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        components.scheme = "https"
        return components.url ?? url
    }

    /// `/a/b.md:12` and `/a/b.md:12:5` (line and column): the path and line 12. A colon followed by anything but
    /// digits is part of the name.
    static func splitLine(_ path: String) -> (path: String, line: Int?) {
        var rest = Substring(path)
        var numbers: [Int] = []
        while numbers.count < 2, let colon = rest.lastIndex(of: ":") {
            let tail = rest[rest.index(after: colon)...]
            guard !tail.isEmpty, tail.allSatisfy({ $0.isASCII && $0.isNumber }), let number = Int(tail) else { break }
            numbers.insert(number, at: 0)
            rest = rest[..<colon]
        }
        guard let line = numbers.first, line > 0, !rest.isEmpty else { return (path, nil) }
        return (String(rest), line)
    }

    /// The file URL of an absolute or `~` path; nil for a relative one, which a text shown outside any folder
    /// cannot resolve.
    public static func fileURL(_ path: String) -> URL? {
        guard path.hasPrefix("/") || path == "~" || path.hasPrefix("~/") else { return nil }
        return PathOpener.fileURL(path)
    }

    public static func isMarkdown(_ url: URL) -> Bool {
        ["md", "markdown"].contains(url.pathExtension.lowercased())
    }

    /// A right-click, or a Control-click, asks for the menu. Without the event, the keys held now decide.
    public static func isMenuClick(type: NSEvent.EventType?, modifiers: NSEvent.ModifierFlags) -> Bool {
        if type == .rightMouseDown || type == .rightMouseUp {
            return true
        }
        return modifiers.contains(.control)
    }

    /// `isMenuClick` for the event AppKit is handling now.
    @MainActor
    public static var isMenuClickNow: Bool {
        let event = NSApp.currentEvent
        return isMenuClick(type: event?.type, modifiers: event?.modifierFlags ?? NSEvent.modifierFlags)
    }

    public static func step(
        url: URL?, path: String, kind: PathItemKind, lines: MarkdownLineRange?, click: FileLinkClick, menu: Bool,
        genesisMarkdownInstalled: Bool
    ) -> PathLinkStep {
        guard let url, kind != .missing else { return .missing(url?.path ?? path) }
        if menu || click == .ask {
            return .menu(url, kind: kind, lines: lines)
        }

        switch kind {
        case .folder:
            return .folderInFinder(url)
        case .package:
            return .revealInFinder(url)
        case .file, .missing:
            if click == .genesisMarkdown, genesisMarkdownInstalled, isMarkdown(url) {
                return .genesisMarkdown(url, lines: lines)
            }
            // An editor takes one line, the first of a range.
            return .defaultApp(url, line: lines?.first)
        }
    }

    /// "at Line 40" or "at Lines 40-60", for a menu item that opens there; empty without lines.
    static func atLines(_ lines: MarkdownLineRange?) -> String {
        guard let lines else { return "" }
        return lines.first == lines.last ? " at Line \(lines.first)" : " at Lines \(lines.first)-\(lines.last)"
    }

    private final class Found: NSObject {
        let links: [PathLinkRef]
        init(_ links: [PathLinkRef]) { self.links = links }
    }

    nonisolated(unsafe) private static let cache: NSCache<NSString, Found> = {
        let cache = NSCache<NSString, Found>()
        cache.countLimit = 256
        return cache
    }()

    /// The file links in `markdown`, in order, each path and line once. Parsed once per text: a card's body
    /// renders again on every snapshot.
    public static func pathLinks(inMarkdown markdown: String) -> [PathLinkRef] {
        guard markdown.contains("](") || markdown.contains("<") else { return [] }
        if let hit = cache.object(forKey: markdown as NSString) { return hit.links }

        var links: [PathLinkRef] = []
        var seen: Set<String> = []
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        if let attributed = try? AttributedString(markdown: markdown, options: options) {
            for (link, range) in attributed.runs[\.link] {
                guard let link, case let .path(path, lines) = target(for: link),
                      seen.insert(path + ":" + (lines?.queryValue ?? "")).inserted else { continue }
                let text = String(attributed[range].characters).trimmingCharacters(in: .whitespacesAndNewlines)
                links.append(PathLinkRef(label: text.isEmpty ? (path as NSString).lastPathComponent : text, path: path, lines: lines))
            }
        }
        cache.setObject(Found(links), forKey: markdown as NSString)
        return links
    }
}

// MARK: - Doing it

/// What `PathLinkHandler` asks and does. `SystemPathLinks` is the Mac; a test passes a spy, so nothing opens.
public protocol PathLinkSystem: PathWorkspace {
    /// Launch Services knows Genesis Markdown's bundle id (`PathOpener.genesisMarkdownApp`).
    var genesisMarkdownInstalled: Bool { get }
    /// Some app takes `cursor://` links.
    var cursorInstalled: Bool { get }
    /// The app macOS opens the file with; nil when none does, or when it is this app.
    func defaultApp(for url: URL) -> DefaultApp?
    /// The note in Genesis Markdown, scrolled to `lines` with them marked when there are some.
    func openInGenesisMarkdown(_ url: URL, lines: MarkdownLineRange?)
    func openInDefaultApp(_ url: URL, line: Int?)
    func copyPath(_ path: String)
    /// Shows `entries` as a menu at the pointer.
    func showMenu(_ entries: [PathMenuEntry])
}

public struct SystemPathLinks: PathLinkSystem {
    private let workspace = SystemPathWorkspace()
    private let missing: (@MainActor (String) -> Void)?

    /// `missing` tells the user that a link's file is not on disk, in the host's own note (the widget's note under
    /// its header: announced, held on hover, for the note duration setting). Without it, a `CopyToast` at the
    /// pointer says it.
    public init(missing: (@MainActor (String) -> Void)? = nil) {
        self.missing = missing
    }

    public func kind(of url: URL) -> PathItemKind { workspace.kind(of: url) }
    public func openFolderInFinder(_ url: URL) { workspace.openFolderInFinder(url) }
    public func revealInFinder(_ url: URL) { workspace.revealInFinder(url) }
    public func openFile(_ url: URL) { workspace.openFile(url) }
    public func editFile(_ url: URL, line: Int?) { workspace.editFile(url, line: line) }

    /// From a click or a menu item, so on the main thread.
    public func reportMissing(_ path: String) {
        guard let missing else { return workspace.reportMissing(path) }
        MainActor.assumeIsolated { missing(path) }
    }

    public var genesisMarkdownInstalled: Bool { PathOpener.genesisMarkdownApp() != nil }

    public var cursorInstalled: Bool {
        guard let probe = URL(string: "cursor://file/") else { return false }
        return NSWorkspace.shared.urlForApplication(toOpen: probe) != nil
    }

    public func defaultApp(for url: URL) -> DefaultApp? {
        guard let app = DefaultApp.forFile(url), app.bundleIdentifier != Bundle.main.bundleIdentifier else { return nil }
        return app
    }

    public func openInGenesisMarkdown(_ url: URL, lines: MarkdownLineRange?) { PathOpener.genesisMarkdown(url.path, lines: lines) }

    public func openInDefaultApp(_ url: URL, line: Int?) {
        if let app = DefaultApp.forFile(url) {
            app.open(url, line: line)
        } else {
            workspace.openFile(url)
        }
    }

    public func copyPath(_ path: String) { Clipboard.copy(path, what: "path") }

    /// After the click that asked for it has finished: a menu opened inside the link's mouse-up handler would run
    /// its tracking loop inside SwiftUI's.
    public func showMenu(_ entries: [PathMenuEntry]) {
        DispatchQueue.main.async {
            MainActor.assumeIsolated { _ = PathMenu.popUp(entries) }
        }
    }
}

public extension PathOpener {
    /// `genesis-md://open?path=<absolute path>&range=40-60`: the note at those lines, the shape the `genesis open` CLI
    /// and Genesis's own launcher send. nil without lines, since a plain file open says the same.
    static func genesisMarkdownURL(for path: String, lines: MarkdownLineRange?) -> URL? {
        guard let lines else { return nil }
        var components = URLComponents()
        components.scheme = "genesis-md"
        components.host = "open"
        components.queryItems = [
            URLQueryItem(name: "path", value: fileURL(path).path),
            URLQueryItem(name: "range", value: lines.queryValue),
        ]
        return components.url
    }

    /// "Open in Genesis Markdown" at `lines`: the `genesis-md:` link when there are some, else the file itself.
    static func genesisMarkdown(_ path: String, lines: MarkdownLineRange?) {
        genesisMarkdown(path, opening: genesisMarkdownURL(for: path, lines: lines) ?? fileURL(path))
    }
}

/// Every link a text below `.pathLinks(_:)` draws comes here first. A file link does what `click` says (read at
/// each click, so a settings change applies at once) or, on a right-click or Control-click, shows its menu; any
/// other link goes to the system as before.
///
/// A class, made once per window or model and kept: the environment values `.pathLinks(_:)` sets are this object
/// and its one `openURLAction`, so a root that renders again hands its texts the same values and none of them
/// updates for it. A new closure on every render would never compare equal.
public final class PathLinkHandler {
    public let click: @MainActor () -> FileLinkClick
    public let system: any PathLinkSystem
    /// The click that opened the link asks for the menu (`PathLink.isMenuClick`).
    public let menuClick: @MainActor () -> Bool

    public init(
        click: @escaping @MainActor () -> FileLinkClick,
        system: any PathLinkSystem = SystemPathLinks(),
        menuClick: @escaping @MainActor () -> Bool = { PathLink.isMenuClickNow }
    ) {
        self.click = click
        self.system = system
        self.menuClick = menuClick
    }

    /// The `openURL` action `.pathLinks(_:)` installs. It holds the handler weakly: the environment may keep it
    /// after the handler's owner has gone, and then a link goes to the system.
    public private(set) lazy var openURLAction = OpenURLAction { [weak self] url in
        MainActor.assumeIsolated { self?.open(url) ?? .systemAction }
    }

    /// For `OpenURLAction`: `.handled` for a file link, `.systemAction` for anything else, with the `https:` a
    /// network-path link lacks (schemeless, Launch Services answers it with the -50 alert). A `file:` URL on another
    /// machine is never given to the system (Foundation drops the host and opens the local file at the same path),
    /// and it gets the missing-file notice.
    @MainActor
    public func open(_ url: URL) -> OpenURLAction.Result {
        switch PathLink.target(for: url) {
        case let .other(destination) where destination.isFileURL:
            system.reportMissing(destination.absoluteString)
            return .handled
        case let .other(destination):
            return destination == url ? .systemAction : .systemAction(destination)
        case let .path(path, lines):
            perform(path: path, lines: lines, menu: menuClick())
            return .handled
        }
    }

    @MainActor
    @discardableResult
    public func perform(path: String, lines: MarkdownLineRange?, menu: Bool) -> PathLinkStep {
        let url = PathLink.fileURL(path)
        let kind = url.map(system.kind(of:)) ?? .missing
        let step = PathLink.step(
            url: url, path: path, kind: kind, lines: lines, click: click(), menu: menu,
            genesisMarkdownInstalled: system.genesisMarkdownInstalled)
        GenesisKit.log("pathLink \(path)\(lines.map { ":\($0.queryValue)" } ?? "") -> \(step)")
        switch step {
        case let .genesisMarkdown(url, lines): system.openInGenesisMarkdown(url, lines: lines)
        case let .defaultApp(url, line): system.openInDefaultApp(url, line: line)
        case .folderInFinder(let url): system.openFolderInFinder(url)
        case .revealInFinder(let url): system.revealInFinder(url)
        case let .menu(url, kind, lines): system.showMenu(menuEntries(url: url, kind: kind, lines: lines))
        case .missing(let path): system.reportMissing(path)
        }
        return step
    }

    /// Every way to open one file or folder: Genesis Markdown for a note when it is installed (at the link's lines),
    /// the default app by name, Cursor at the first line when it is installed, then Reveal in Finder and Copy Path.
    @MainActor
    public func menuEntries(url: URL, kind: PathItemKind, lines: MarkdownLineRange?) -> [PathMenuEntry] {
        let line = lines?.first
        let system = system
        var open: [PathMenuItem] = []
        switch kind {
        case .folder:
            open.append(PathMenuItem(id: "finder", title: "Open in Finder", systemImage: "folder") { system.openFolderInFinder(url) })
            if system.cursorInstalled {
                open.append(PathMenuItem(id: "cursor", title: "Open in Cursor", systemImage: "chevron.left.forwardslash.chevron.right") {
                    system.editFile(url, line: nil)
                })
            }
        case .file:
            let markdown = system.genesisMarkdownInstalled && PathLink.isMarkdown(url)
            if markdown {
                let title = "Open in Genesis Markdown" + PathLink.atLines(lines)
                open.append(PathMenuItem(id: "genesis-markdown", title: title, systemImage: "doc.richtext") {
                    system.openInGenesisMarkdown(url, lines: lines)
                })
            }
            if let app = system.defaultApp(for: url), !(markdown && app.bundleIdentifier == PathOpener.genesisMarkdownBundleID) {
                open.append(PathMenuItem(id: "default-app", title: "Open in \(app.name)", systemImage: "arrow.up.forward.app") {
                    system.openInDefaultApp(url, line: line)
                })
            }
            if system.cursorInstalled {
                let title = line.map { "Open in Cursor at Line \($0)" } ?? "Open in Cursor"
                open.append(PathMenuItem(id: "cursor", title: title, systemImage: "chevron.left.forwardslash.chevron.right") {
                    system.editFile(url, line: line)
                })
            }
        case .package, .missing:
            break
        }

        var entries = open.map(PathMenuEntry.item)
        if !entries.isEmpty {
            entries.append(.divider(id: "divider-finder"))
        }
        entries.append(.item(PathMenuItem(id: "reveal", title: "Reveal in Finder", systemImage: "folder") { system.revealInFinder(url) }))
        entries.append(.item(PathMenuItem(id: "copy", title: "Copy Path", systemImage: "doc.on.doc") { system.copyPath(url.path) }))
        return entries
    }

    /// The right-click menu of a text that holds `links`: one link's verbs directly, or a submenu per link.
    @MainActor
    public func contextEntries(_ links: [PathLinkRef]) -> [PathMenuEntry] {
        if links.count == 1, let link = links.first {
            return entries(for: link)
        }

        return links.enumerated().map { index, link in
            .submenu(id: "link-\(index)", title: link.label, systemImage: "doc", entries: entries(for: link))
        }
    }

    @MainActor
    private func entries(for link: PathLinkRef) -> [PathMenuEntry] {
        let system = system
        guard let url = PathLink.fileURL(link.path), case let kind = system.kind(of: url), kind != .missing else {
            let shown = PathLink.fileURL(link.path)?.path ?? link.path
            return [
                .item(PathMenuItem(id: "missing", title: "Not on Disk", systemImage: "exclamationmark.triangle") { system.reportMissing(shown) }),
                .item(PathMenuItem(id: "copy", title: "Copy Path", systemImage: "doc.on.doc") { system.copyPath(shown) }),
            ]
        }
        return menuEntries(url: url, kind: kind, lines: link.lines)
    }
}

// MARK: - SwiftUI

private struct PathLinkHandlerKey: EnvironmentKey {
    static let defaultValue: PathLinkHandler? = nil
}

public extension EnvironmentValues {
    /// Set by `.pathLinks(_:)`; `.pathLinkMenu(markdown:)` reads it.
    var pathLinkHandler: PathLinkHandler? {
        get { self[PathLinkHandlerKey.self] }
        set { self[PathLinkHandlerKey.self] = newValue }
    }
}

public extension View {
    /// Routes every link a `Text` inside draws through `handler`: file links open by the handler's setting, other
    /// links as before. Set it once at a window's root, with a handler the root keeps (`PathLinkHandler`).
    @MainActor
    func pathLinks(_ handler: PathLinkHandler) -> some View {
        environment(\.openURL, handler.openURLAction)
            .environment(\.pathLinkHandler, handler)
    }

    /// A right-click (or Control-click) on this text lists the ways to open each file link in `markdown`. SwiftUI
    /// tells no view which link of a `Text` is under the pointer, so the menu belongs to the whole text. A text
    /// without file links, or outside `.pathLinks(_:)`, keeps its own menu.
    func pathLinkMenu(markdown: String) -> some View {
        modifier(PathLinkMenu(markdown: markdown))
    }

    /// A right-click (or Control-click) on this view lists the ways to open `link`: for a file a view names itself,
    /// not through markdown (a decision's cited code). Outside `.pathLinks(_:)` the view keeps its own menu.
    func pathLinkMenu(_ link: PathLinkRef) -> some View {
        modifier(PathRefMenu(link: link))
    }
}

private struct PathRefMenu: ViewModifier {
    let link: PathLinkRef
    @Environment(\.pathLinkHandler) private var handler

    func body(content: Content) -> some View {
        if let handler {
            content.contextMenu {
                PathLinkMenuItems(handler: handler, links: [link])
            }
        } else {
            content
        }
    }
}

private struct PathLinkMenu: ViewModifier {
    let markdown: String
    @Environment(\.pathLinkHandler) private var handler

    func body(content: Content) -> some View {
        if let handler, case let links = PathLink.pathLinks(inMarkdown: markdown), !links.isEmpty {
            content.contextMenu {
                PathLinkMenuItems(handler: handler, links: links)
            }
        } else {
            content
        }
    }
}

/// Built when the menu opens: each link's kind is read from disk then.
private struct PathLinkMenuItems: View {
    let handler: PathLinkHandler
    let links: [PathLinkRef]

    var body: some View {
        PathMenuEntriesView(entries: handler.contextEntries(links))
    }
}
