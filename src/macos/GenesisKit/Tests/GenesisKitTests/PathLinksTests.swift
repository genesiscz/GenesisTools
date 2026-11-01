import AppKit
import SwiftUI
import XCTest
@testable import GenesisKitBase
@testable import GenesisKit

/// A file link clicked in rendered markdown (Paths/PathLinks.swift): how a link's URL becomes a path and a line,
/// what a click does under each `fileLinkClick` setting, and the menu a right-click or "Ask each time" shows. The
/// system is a spy, so nothing opens and no Launch Services lookup runs.
@MainActor
final class PathLinksTests: XCTestCase {
    private let note = "/Users/alice/notes/2026-11-01-Plan.md"
    private let source = "/Users/alice/code/App.swift"
    private let folder = "/Users/alice/notes"
    private let app = "/Applications/Demo.app"

    /// The URL a widget card's link carries: what SwiftUI's markdown parser builds from `[x](<destination>)`.
    private func parsedLink(_ destination: String) throws -> URL {
        let text = try AttributedString(markdown: "[x](\(destination))")
        return try XCTUnwrap(text.runs.compactMap(\.link).first, "no link parsed from \(destination)")
    }

    private func target(_ destination: String) throws -> PathLinkTarget {
        PathLink.target(for: try parsedLink(destination))
    }

    /// Lines `first` to `last` (one line without `last`).
    private func lines(_ first: Int, _ last: Int? = nil) -> MarkdownLineRange? {
        MarkdownLineRange(first: first, last: last ?? first)
    }

    // MARK: Parsing

    func testAPlainAbsolutePathAndAFileURLAreBothFileTargets() throws {
        XCTAssertEqual(try target(note), .path(note, lines: nil))
        XCTAssertEqual(try target("file://" + note), .path(note, lines: nil))
        XCTAssertEqual(try target("~/notes/Plan.md"), .path("~/notes/Plan.md", lines: nil))
    }

    func testALineSuffixOrALineFragmentBecomesTheLineHint() throws {
        XCTAssertEqual(try target(source + ":12"), .path(source, lines: lines(12)))
        XCTAssertEqual(try target(source + ":12:5"), .path(source, lines: lines(12)), "line and column: the line")
        XCTAssertEqual(try target("file://" + source + "#L10-L20"), .path(source, lines: lines(10, 20)), "both ends of a range")
        XCTAssertEqual(try target(note + "#L40-L60"), .path(note, lines: lines(40, 60)))
        XCTAssertEqual(try target(source + "#L7"), .path(source, lines: lines(7)))
        XCTAssertEqual(try target(source + "#10-20"), .path(source, lines: lines(10, 20)))
        XCTAssertEqual(try target(note + "#intro"), .path(note, lines: nil), "a heading anchor is no line")
        XCTAssertEqual(try target(note + "#L0"), .path(note, lines: nil), "no line 0")
        XCTAssertEqual(try target("/Users/alice/a:b.md"), .path("/Users/alice/a:b.md", lines: nil), "a colon in a name")
    }

    func testPercentEncodedSpacesAndNonASCIILettersAreDecoded() throws {
        XCTAssertEqual(try target("/Users/alice/%C4%8CEZ/Team%20notes/a%20b.md:12"),
                       .path("/Users/alice/ČEZ/Team notes/a b.md", lines: lines(12)))
        XCTAssertEqual(try target("/Users/alice/ČEZ/n.md"), .path("/Users/alice/ČEZ/n.md", lines: nil),
                       "a raw Č, as an agent writes it")
        XCTAssertEqual(try target("</Users/alice/Team notes/a b.md>"), .path("/Users/alice/Team notes/a b.md", lines: nil),
                       "an angle-bracketed destination with spaces")
    }

    /// A file open loses `#L40` in Launch Services, so a note's lines travel in the URL Genesis Markdown reads
    /// (`genesis-md://open?path=…&range=…`, Genesis's `AppURLRouter`).
    func testANoteWithLinesOpensThroughTheGenesisMarkdownLinkThatCarriesThem() throws {
        let path = "/Users/alice/ČEZ/Team notes/a b.md"
        let link = try XCTUnwrap(PathOpener.genesisMarkdownURL(for: path, lines: lines(40, 60)))
        let components = try XCTUnwrap(URLComponents(url: link, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.scheme, "genesis-md")
        XCTAssertEqual(components.host, "open")
        XCTAssertEqual(components.queryItems?.first { $0.name == "path" }?.value, path, "the path survives Č and spaces")
        XCTAssertEqual(MarkdownLineRange.fromQuery(components.queryItems ?? []), lines(40, 60), "both ends reach the viewer")
        XCTAssertEqual(PathOpener.genesisMarkdownURL(for: note, lines: lines(3))?.query, "path=\(note)&range=3")
        XCTAssertNil(PathOpener.genesisMarkdownURL(for: note, lines: nil), "no lines: the file itself opens")
    }

    func testWebLinksAndAppSchemesAreLeftToTheSystem() throws {
        for destination in ["https://example.org/a.md", "http://example.org", "cursor://file/Users/alice/a.swift:3",
                            "genesis-md://open?path=/Users/alice/a.md", "mailto:alice@example.com", "#top"] {
            let url = try parsedLink(destination)
            XCTAssertEqual(PathLink.target(for: url), .other(url), destination)
        }
    }

    func testTheFileLinksOfATextAreListedOnceInOrder() {
        let text = """
        Read [the plan](\(note)) and [App.swift](\(source):12), not [the site](https://example.org).
        Again: [the plan](\(note)) and [**the** `notes`](\(folder)).
        """
        XCTAssertEqual(PathLink.pathLinks(inMarkdown: text), [
            PathLinkRef(label: "the plan", path: note, lines: nil),
            PathLinkRef(label: "App.swift", path: source, lines: lines(12)),
            PathLinkRef(label: "the notes", path: folder, lines: nil),
        ], "a styled label is one link with its whole text")
        XCTAssertEqual(PathLink.pathLinks(inMarkdown: "[ ](\(folder))"), [PathLinkRef(label: "notes", path: folder, lines: nil)],
                       "a blank label reads as the file name")
        XCTAssertEqual(PathLink.pathLinks(inMarkdown: "No links, only [a site](https://example.org)."), [])
    }

    func testARightClickOrAControlClickAsksForTheMenu() {
        XCTAssertTrue(PathLink.isMenuClick(type: .rightMouseUp, modifiers: []))
        XCTAssertTrue(PathLink.isMenuClick(type: .rightMouseDown, modifiers: []))
        XCTAssertTrue(PathLink.isMenuClick(type: .leftMouseUp, modifiers: [.control]))
        XCTAssertTrue(PathLink.isMenuClick(type: nil, modifiers: [.control]), "no event: the keys held now")
        XCTAssertFalse(PathLink.isMenuClick(type: .leftMouseUp, modifiers: [.command]))
    }

    func testTheStoredSettingReadsWithItsDefault() {
        XCTAssertEqual(FileLinkClick(preference: nil), .genesisMarkdown)
        XCTAssertEqual(FileLinkClick(preference: "default-app"), .defaultApp)
        XCTAssertEqual(FileLinkClick(preference: "ask"), .ask)
        XCTAssertEqual(FileLinkClick(preference: "a later value"), .genesisMarkdown)
    }

    func testTheWidgetPreferencesCarryTheSetting() throws {
        let json = #"""
        {"excludedKeys":[],"projects":[],"sessions":[],"showChanges":true,"placement":"both","side":"right",
         "quietSeconds":15,"voiceProvider":"xai","voiceLanguage":"","fileLinkClick":"ask"}
        """#
        let preferences = try JSONDecoder().decode(WidgetPreferences.self, from: Data(json.utf8))
        XCTAssertEqual(FileLinkClick(preference: preferences.fileLinkClick), .ask)
    }

    // MARK: Choice per setting

    private func step(_ path: String, _ kind: PathItemKind, lines: MarkdownLineRange? = nil, click: FileLinkClick,
                      menu: Bool = false, installed: Bool = true) -> PathLinkStep {
        PathLink.step(url: PathLink.fileURL(path), path: path, kind: kind, lines: lines, click: click, menu: menu,
                      genesisMarkdownInstalled: installed)
    }

    func testANoteOpensInGenesisMarkdownOnlyWhenItIsInstalledAndChosen() {
        let url = URL(fileURLWithPath: note)
        XCTAssertEqual(step(note, .file, click: .genesisMarkdown), .genesisMarkdown(url, lines: nil))
        XCTAssertEqual(step(note, .file, lines: lines(40, 60), click: .genesisMarkdown), .genesisMarkdown(url, lines: lines(40, 60)),
                       "the note opens at its lines, both ends")
        XCTAssertEqual(step(note, .file, lines: lines(4), click: .genesisMarkdown, installed: false), .defaultApp(url, line: 4))
        XCTAssertEqual(step(note, .file, lines: lines(4), click: .defaultApp), .defaultApp(url, line: 4))
        XCTAssertEqual(step("/Users/alice/notes/Old.MARKDOWN", .file, click: .genesisMarkdown),
                       .genesisMarkdown(URL(fileURLWithPath: "/Users/alice/notes/Old.MARKDOWN"), lines: nil))
    }

    func testAnyOtherFileOpensInItsDefaultAppWithItsLine() {
        XCTAssertEqual(step(source, .file, lines: lines(12), click: .genesisMarkdown), .defaultApp(URL(fileURLWithPath: source), line: 12))
        XCTAssertEqual(step(source, .file, lines: lines(12, 20), click: .defaultApp), .defaultApp(URL(fileURLWithPath: source), line: 12),
                       "an editor takes the first line of a range")
    }

    func testAFolderOpensInFinderAndAPackageIsOnlyRevealed() {
        for click in [FileLinkClick.genesisMarkdown, .defaultApp] {
            XCTAssertEqual(step(folder, .folder, click: click), .folderInFinder(URL(fileURLWithPath: folder)))
            XCTAssertEqual(step(app, .package, click: click), .revealInFinder(URL(fileURLWithPath: app)))
        }
    }

    func testAskEachTimeAndAMenuClickShowTheMenuForAnyKind() {
        XCTAssertEqual(step(note, .file, lines: lines(3), click: .ask), .menu(URL(fileURLWithPath: note), kind: .file, lines: lines(3)))
        XCTAssertEqual(step(folder, .folder, click: .ask), .menu(URL(fileURLWithPath: folder), kind: .folder, lines: nil))
        XCTAssertEqual(step(note, .file, click: .genesisMarkdown, menu: true), .menu(URL(fileURLWithPath: note), kind: .file, lines: nil))
        XCTAssertEqual(step(source, .file, lines: lines(9), click: .defaultApp, menu: true),
                       .menu(URL(fileURLWithPath: source), kind: .file, lines: lines(9)))
    }

    func testAMissingFileOrARelativePathIsANoticeEvenOnAMenuClick() {
        for click in FileLinkClick.allCases {
            XCTAssertEqual(step(note, .missing, click: click), .missing(note))
            XCTAssertEqual(step(note, .missing, click: click, menu: true), .missing(note))
            XCTAssertEqual(step("notes/Plan.md", .file, click: click), .missing("notes/Plan.md"),
                           "a relative path has no folder to resolve it against")
        }
        XCTAssertEqual(step("~/notes/Gone.md", .missing, click: .genesisMarkdown),
                       .missing(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("notes/Gone.md").path),
                       "the notice names the expanded path")
    }

    // MARK: The handler, with a spy for the system

    private func handler(_ spy: SpyLinks, click: FileLinkClick = .genesisMarkdown, menuClick: Bool = false) -> PathLinkHandler {
        PathLinkHandler(click: { click }, system: spy, menuClick: { menuClick })
    }

    private func spy() -> SpyLinks {
        let spy = SpyLinks()
        spy.kinds = [note: .file, source: .file, folder: .folder, app: .package]
        return spy
    }

    func testAWebLinkGoesToTheSystemAndTouchesNothing() {
        let spy = spy()
        let result = handler(spy).open(URL(string: "https://example.org/a.md")!)
        XCTAssertEqual(String(describing: result), String(describing: OpenURLAction.Result.systemAction))
        XCTAssertEqual(spy.calls, [])
    }

    func testAClickOnAPlainPathNoteOpensGenesisMarkdownInsteadOfTheSystemAlert() throws {
        let spy = spy()
        let result = handler(spy).open(try parsedLink(note))
        XCTAssertEqual(String(describing: result), String(describing: OpenURLAction.Result.handled))
        XCTAssertEqual(spy.calls, ["genesisMarkdown \(note)"])
    }

    /// The default click on `[Plan.md](/…/Plan.md#L40-L60)` lands Genesis Markdown on lines 40 to 60, as the same
    /// link to a `.swift` file lands Cursor on line 40.
    func testTheLinesOfANoteLinkReachGenesisMarkdown() throws {
        let spy = spy()
        _ = handler(spy).open(try parsedLink(note + "#L40-L60"))
        _ = handler(spy).open(try parsedLink(note + ":7"))
        _ = handler(spy).open(try parsedLink("file://" + note + "#L12"))
        XCTAssertEqual(spy.calls, ["genesisMarkdown \(note):40-60", "genesisMarkdown \(note):7", "genesisMarkdown \(note):12"])
    }

    func testTheInstalledActionIsOneValueThatReachesTheHandler() throws {
        let spy = spy()
        let link = handler(spy)
        let action = link.openURLAction
        action(try parsedLink(folder))
        XCTAssertEqual(spy.calls, ["finder \(folder)"])
        // The same closure every time, so a root that renders again does not change its texts' environment. SwiftUI
        // compares a value that is not Equatable by its bytes; a new closure has a new context.
        func bytes(_ action: OpenURLAction) -> Data { withUnsafeBytes(of: action) { Data($0) } }
        XCTAssertEqual(bytes(link.openURLAction), bytes(action))
        XCTAssertNotEqual(bytes(OpenURLAction { link.open($0) }), bytes(action), "the control: a fresh closure differs")
    }

    func testEachSettingDoesItsOwnThing() throws {
        var spy = self.spy()
        _ = handler(spy, click: .defaultApp).open(try parsedLink(note + ":4"))
        XCTAssertEqual(spy.calls, ["defaultApp \(note):4"])

        spy = self.spy()
        spy.genesisMarkdownInstalled = false
        _ = handler(spy).open(try parsedLink(note))
        XCTAssertEqual(spy.calls, ["defaultApp \(note)"], "no Genesis Markdown: the default app")

        spy = self.spy()
        _ = handler(spy).open(try parsedLink(folder))
        XCTAssertEqual(spy.calls, ["finder \(folder)"])

        spy = self.spy()
        _ = handler(spy).open(try parsedLink("/Users/alice/notes/Gone.md"))
        XCTAssertEqual(spy.calls, ["missing /Users/alice/notes/Gone.md"])

        spy = self.spy()
        _ = handler(spy, click: .ask).open(try parsedLink(source + "#L12"))
        XCTAssertEqual(spy.calls, ["menu"])
        XCTAssertEqual(PathMenuEntry.outline(try XCTUnwrap(spy.menus.first)), [
            "Open in Demo Editor", "Open in Cursor at Line 12", "-", "Reveal in Finder", "Copy Path",
        ])
    }

    func testAMenuClickShowsTheMenuWhateverTheSettingAndItsItemsRunTheirVerb() throws {
        let spy = spy()
        _ = handler(spy, click: .genesisMarkdown, menuClick: true).open(try parsedLink(note + ":3"))
        let entries = try XCTUnwrap(spy.menus.first)
        XCTAssertEqual(PathMenuEntry.outline(entries), [
            "Open in Genesis Markdown at Line 3", "Open in Demo Editor", "Open in Cursor at Line 3", "-", "Reveal in Finder", "Copy Path",
        ])
        for entry in entries {
            if case .item(let item) = entry { item.run() }
        }
        XCTAssertEqual(spy.calls, [
            "menu", "genesisMarkdown \(note):3", "defaultApp \(note):3", "cursor \(note):3", "reveal \(note)", "copy \(note)",
        ])

        let range = handler(spy).menuEntries(url: URL(fileURLWithPath: note), kind: .file, lines: lines(40, 60))
        XCTAssertEqual(PathMenuEntry.outline(range), [
            "Open in Genesis Markdown at Lines 40-60", "Open in Demo Editor", "Open in Cursor at Line 40", "-", "Reveal in Finder",
            "Copy Path",
        ], "Genesis Markdown marks the whole range; an editor goes to its first line")
        if case .item(let first) = range[0] { first.run() }
        XCTAssertEqual(spy.calls.last, "genesisMarkdown \(note):40-60")
    }

    func testTheMenuLeavesOutWhatThisMacCannotDo() {
        let spy = spy()
        spy.cursorInstalled = false
        spy.app = DefaultApp(url: URL(fileURLWithPath: "/Applications/Genesis Markdown.app"), name: "Genesis Markdown",
                             bundleIdentifier: PathOpener.genesisMarkdownBundleID, schemes: [])
        let link = handler(spy)
        XCTAssertEqual(PathMenuEntry.outline(link.menuEntries(url: URL(fileURLWithPath: note), kind: .file, lines: nil)), [
            "Open in Genesis Markdown", "-", "Reveal in Finder", "Copy Path",
        ], "Genesis Markdown as the default app is listed once")

        spy.app = nil
        spy.genesisMarkdownInstalled = false
        XCTAssertEqual(PathMenuEntry.outline(link.menuEntries(url: URL(fileURLWithPath: source), kind: .file, lines: lines(2))), [
            "Reveal in Finder", "Copy Path",
        ])
        spy.cursorInstalled = true
        XCTAssertEqual(PathMenuEntry.outline(link.menuEntries(url: URL(fileURLWithPath: folder), kind: .folder, lines: nil)), [
            "Open in Finder", "Open in Cursor", "-", "Reveal in Finder", "Copy Path",
        ])
        XCTAssertEqual(PathMenuEntry.outline(link.menuEntries(url: URL(fileURLWithPath: app), kind: .package, lines: nil)), [
            "Reveal in Finder", "Copy Path",
        ])
    }

    /// The real path from a click to the handler: a widget card's markdown under `.pathLinks`, in a window that is
    /// never shown (alpha 0, below the desktop), clicked on its link with synthesized events.
    func testAClickOnALinkInAWidgetCardReachesTheHandler() throws {
        let spy = spy()
        let view = WidgetMarkdown(text: "[Plan](\(note)) and more text after it")
            .frame(width: 320, height: 40, alignment: .topLeading)
            .pathLinks(handler(spy))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 40), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.alphaValue = 0
        window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: view)
        window.contentView = host
        window.orderFrontRegardless()
        defer { window.orderOut(nil) }
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))

        func click(x: CGFloat) throws {
            // Window coordinates count from the bottom; the text's first line is at the top.
            let point = NSPoint(x: x, y: 40 - 7)
            for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                let event = try XCTUnwrap(NSEvent.mouseEvent(
                    with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                    windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
                    pressure: type == .leftMouseDown ? 1 : 0))
                window.sendEvent(event)
                RunLoop.main.run(until: Date().addingTimeInterval(0.15))
            }
        }

        try click(x: 150)
        XCTAssertEqual(spy.calls, [], "a click on the plain text after the link opens nothing")
        try click(x: 12)
        XCTAssertEqual(spy.calls, ["genesisMarkdown \(note)"], "a click on \"Plan\" went past the handler")

        // A right-click asks the view for its menu; the card's text answers with the link's verbs. Built, never shown.
        let right = try XCTUnwrap(NSEvent.mouseEvent(
            with: .rightMouseDown, location: NSPoint(x: 12, y: 40 - 7), modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
            eventNumber: 0, clickCount: 1, pressure: 1))
        let titles = host.menu(for: right)?.items.map(\.title).filter { !$0.isEmpty } ?? []
        XCTAssertEqual(titles, ["Open in Genesis Markdown", "Open in Demo Editor", "Open in Cursor", "Reveal in Finder", "Copy Path"])
    }

    func testARightClickOnATextListsEachFileLinkItHolds() {
        let spy = spy()
        let link = handler(spy)
        let one = [PathLinkRef(label: "the plan", path: note, lines: nil)]
        XCTAssertEqual(PathMenuEntry.outline(link.contextEntries(one)), [
            "Open in Genesis Markdown", "Open in Demo Editor", "Open in Cursor", "-", "Reveal in Finder", "Copy Path",
        ])

        let two = one + [PathLinkRef(label: "Gone.md", path: "/Users/alice/notes/Gone.md", lines: nil)]
        let entries = link.contextEntries(two)
        XCTAssertEqual(PathMenuEntry.outline(entries), ["the plan >", "Gone.md >"])
        guard case let .submenu(_, _, _, gone) = entries[1] else { return XCTFail("no submenu for the missing note") }
        XCTAssertEqual(PathMenuEntry.outline(gone), ["Not on Disk", "Copy Path"])
        if case .item(let missing) = gone[0] { missing.run() }
        XCTAssertEqual(spy.calls, ["missing /Users/alice/notes/Gone.md"])
    }
}

/// Records every verb and answers every lookup from its fields.
private final class SpyLinks: PathLinkSystem {
    var kinds: [String: PathItemKind] = [:]
    var genesisMarkdownInstalled = true
    var cursorInstalled = true
    var app: DefaultApp? = DefaultApp(url: URL(fileURLWithPath: "/Applications/Demo Editor.app"), name: "Demo Editor",
                                      bundleIdentifier: "com.example.editor", schemes: [])
    var calls: [String] = []
    var menus: [[PathMenuEntry]] = []

    private func at(_ path: String, _ line: Int?) -> String { path + (line.map { ":\($0)" } ?? "") }

    func kind(of url: URL) -> PathItemKind { kinds[url.path] ?? .missing }
    func defaultApp(for url: URL) -> DefaultApp? { app }
    func openFolderInFinder(_ url: URL) { calls.append("finder \(url.path)") }
    func revealInFinder(_ url: URL) { calls.append("reveal \(url.path)") }
    func openFile(_ url: URL) { calls.append("openFile \(url.path)") }
    func editFile(_ url: URL, line: Int?) { calls.append("cursor \(at(url.path, line))") }
    func reportMissing(_ path: String) { calls.append("missing \(path)") }
    func openInGenesisMarkdown(_ url: URL, lines: MarkdownLineRange?) {
        calls.append("genesisMarkdown \(url.path)" + (lines.map { ":\($0.queryValue)" } ?? ""))
    }
    func openInDefaultApp(_ url: URL, line: Int?) { calls.append("defaultApp \(at(url.path, line))") }
    func copyPath(_ path: String) { calls.append("copy \(path)") }
    func showMenu(_ entries: [PathMenuEntry]) {
        calls.append("menu")
        menus.append(entries)
    }
}
