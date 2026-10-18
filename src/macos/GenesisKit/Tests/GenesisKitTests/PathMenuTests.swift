import AppKit
import XCTest
@testable import GenesisKitBase
@testable import GenesisKit

/// The generic path menu (Paths/PathMenu.swift): which verbs a file or a folder offers for a configured
/// list and a host's handlers, in which order, with which dividers. No LaunchServices: the environment
/// is passed in.
@MainActor
final class PathMenuTests: XCTestCase {
    private let folder = URL(fileURLWithPath: "/Users/alice/notes", isDirectory: true)
    private let file = URL(fileURLWithPath: "/Users/alice/notes/plan.md")

    private func environment(app: String? = "Preview", obsidian: Bool = true, hostTerminal: Bool = false) -> PathMenuEnvironment {
        PathMenuEnvironment(defaultAppName: { _ in app }, obsidianInstalled: obsidian, hostTerminal: hostTerminal)
    }

    private var everyHandler: PathMenuHandlers {
        PathMenuHandlers(
            showInSidebar: {}, navigateInSidebar: {}, searchInFolder: {}, newFile: {}, newFolder: {},
            changed: { _ in }, guardChange: { _ in nil }
        )
    }

    private func outline(_ url: URL, _ kind: PathKind, _ actions: [PathAction], _ handlers: PathMenuHandlers, _ env: PathMenuEnvironment) -> [String] {
        PathMenuEntry.outline(PathMenu.entries(for: url, kind: kind, actions: actions, handlers: handlers, environment: env))
    }

    func testAFolderOffersTheDefaultsInOrderWithADividerBetweenGroups() {
        XCTAssertEqual(outline(folder, .folder, PathAction.folderDefaults, everyHandler, environment()), [
            "Show in Sidebar", "Navigate in Sidebar", "Search in Folder…", "-",
            "New File…", "New Folder…", "-",
            "Open in Finder", "Open in Cursor", "Open in Terminal", "-",
            "Copy Path",
        ])
    }

    func testAHostWithoutSidebarOrCreationGetsOnlyTheVerbsAnyAppCanDo() {
        XCTAssertEqual(outline(folder, .folder, PathAction.folderDefaults, PathMenuHandlers(), environment()), [
            "Open in Finder", "Open in Cursor", "Open in Terminal", "-", "Copy Path",
        ])
    }

    func testAFileOffersItsAppObsidianAndTheChangesWhenTheHostHearsThem() {
        XCTAssertEqual(outline(file, .file, PathAction.fileDefaults, everyHandler, environment()), [
            "Show in Sidebar", "-",
            "Open in Preview", "Open in Obsidian", "Show in Finder", "Open in Cursor", "-",
            "Copy Path", "-",
            "Rename…", "Duplicate", "-",
            "Move to Trash",
        ])
        // No default app, no Obsidian, no `changed`: those verbs are left out, not shown dead.
        XCTAssertEqual(outline(file, .file, PathAction.fileDefaults, PathMenuHandlers(showInSidebar: {}), environment(app: nil, obsidian: false)), [
            "Show in Sidebar", "-", "Show in Finder", "Open in Cursor", "-", "Copy Path",
        ])
    }

    func testTheListOrderWinsAndAFolderNeverOffersTheFileOnlyVerbs() {
        let actions: [PathAction] = [.copyPath, .trash, .openInDefaultApp, .openInObsidian, .openInFinder]
        XCTAssertEqual(outline(folder, .folder, actions, everyHandler, environment()), [
            "Copy Path", "-", "Move to Trash", "-", "Open in Finder",
        ])
        let entries = PathMenu.entries(for: file, kind: .file, actions: [.trash], handlers: everyHandler, environment: environment())
        guard case .item(let trash)? = entries.first else { return XCTFail("no trash item") }
        XCTAssertTrue(trash.destructive)
        XCTAssertEqual(trash.action, .trash)
    }

    func testTheTerminalVerbNamesTheHostsTerminal() {
        XCTAssertEqual(outline(folder, .folder, [.openInTerminal], PathMenuHandlers(), environment(hostTerminal: true)), ["Open in a New cmux Workspace"])
        XCTAssertEqual(outline(folder, .folder, [.openInTerminal], PathMenuHandlers(), environment(hostTerminal: false)), ["Open in Terminal"])
    }

    func testAHostVerbRunsItsHandler() {
        var ran: [String] = []
        let handlers = PathMenuHandlers(showInSidebar: { ran.append("show") }, searchInFolder: { ran.append("search") })
        let entries = PathMenu.entries(for: folder, kind: .folder, actions: [.searchInFolder, .showInSidebar], handlers: handlers, environment: environment())
        for case .item(let item) in entries {
            item.run()
        }
        XCTAssertEqual(ran, ["search", "show"])
    }

    func testOpenInCursorOpensTheWholeFolderAndAFileInsideIt() {
        XCTAssertEqual(PathOpener.cursorWorkspacePaths(for: folder.path, kind: .folder), ["/Users/alice/notes"])
        XCTAssertEqual(PathOpener.cursorWorkspacePaths(for: file.path, kind: .file), ["/Users/alice/notes", "/Users/alice/notes/plan.md"])
    }

    func testObsidianOpensTheNoteByItsAbsolutePath() {
        XCTAssertEqual(
            PathOpener.obsidianURL(for: "/Users/alice/notes/plan one.md")?.absoluteString,
            "obsidian://open?path=/Users/alice/notes/plan%20one.md"
        )
    }

    /// `PathActionsMenu(path:line:)` keeps the list the hub's rows have always shown.
    func testTheFixedListForAPathWithNoHostIsUnchanged() {
        XCTAssertEqual(PathMenuEntry.outline(PathMenu.legacyEntries(path: "/Users/alice/x", line: nil, hostTerminal: false)), [
            "Open in Finder", "Reveal in Finder", "Open in Cursor", "-", "Copy path", "Copy ~ path",
        ])
        XCTAssertEqual(PathMenuEntry.outline(PathMenu.legacyEntries(path: "/Users/alice/x", line: 3, hostTerminal: true)), [
            "Open in Finder", "Reveal in Finder", "Open in Cursor", "Open in a new cmux workspace", "-", "Copy path", "Copy ~ path",
        ])
    }

    func testTheAppKitMenuHasTheItemsTheDividersAndTheSubmenus() {
        let entries: [PathMenuEntry] = [
            .item(PathMenuItem(id: "a", title: "Show in Sidebar", systemImage: "sidebar.left") {}),
            .divider(id: "d"),
            .submenu(id: "s", title: "notes", systemImage: "folder", entries: [.item(PathMenuItem(id: "b", title: "Copy Path") {})]),
        ]
        let menu = PathMenu.nsMenu(entries)
        XCTAssertEqual(menu.items.map(\.title), ["Show in Sidebar", "", "notes"])
        XCTAssertTrue(menu.items[1].isSeparatorItem)
        XCTAssertNotNil(menu.items[0].image)
        XCTAssertEqual(menu.items[2].submenu?.items.map(\.title), ["Copy Path"])
        XCTAssertFalse(PathMenu.popUp([]), "an empty menu does not open")
    }
}

/// New File… / New Folder… and the names they accept (Files/FileActions.swift), in a temporary folder.
final class FileTreeCreationTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("create-\(UUID().uuidString)").standardizedFileURL
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    func testAFileAndAFolderAreCreatedEmpty() throws {
        let note = try FileOperations.create(.file, named: " plan.md ", in: folder)
        XCTAssertEqual(note.lastPathComponent, "plan.md")
        XCTAssertEqual(try Data(contentsOf: note), Data())
        let sub = try FileOperations.create(.folder, named: "drafts", in: folder)
        XCTAssertEqual(PathKind.of(sub), .folder)
        XCTAssertEqual(PathKind.of(note), .file)
    }

    func testATakenNameIsRefusedWithAReasonAndCreatingNeverReplaces() throws {
        try "keep me".write(to: folder.appendingPathComponent("plan.md"), atomically: true, encoding: .utf8)
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("drafts"), withIntermediateDirectories: false)

        let problem = try XCTUnwrap(FileOperations.problem(creating: "plan.md", in: folder))
        XCTAssertTrue(problem.contains("\"plan.md\" already exists"), problem)
        XCTAssertNotNil(FileOperations.problem(creating: "drafts", in: folder))
        XCTAssertNil(FileOperations.problem(creating: "other.md", in: folder))

        XCTAssertThrowsError(try FileOperations.create(.file, named: "plan.md", in: folder))
        XCTAssertThrowsError(try FileOperations.create(.folder, named: "drafts", in: folder))
        XCTAssertEqual(try String(contentsOf: folder.appendingPathComponent("plan.md"), encoding: .utf8), "keep me")
    }

    func testABadNameIsRefusedBeforeTheDiskIsTouched() {
        XCTAssertEqual(FileOperations.problem(creating: "  ", in: folder), "A name cannot be empty.")
        XCTAssertEqual(FileOperations.problem(creating: "a/b.md", in: folder), "A name cannot contain / or :.")
        XCTAssertEqual(FileOperations.problem(creating: "..", in: folder), "That name is reserved.")
    }

    func testTheSuggestionIsAFreeUntitledName() throws {
        XCTAssertEqual(FileOperations.freeName(FileOperations.defaultName(for: .file), in: folder), "Untitled.md")
        try Data().write(to: folder.appendingPathComponent("Untitled.md"))
        try Data().write(to: folder.appendingPathComponent("Untitled 2.md"))
        XCTAssertEqual(FileOperations.freeName("Untitled.md", in: folder), "Untitled 3.md")
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("Untitled Folder"), withIntermediateDirectories: false)
        XCTAssertEqual(FileOperations.freeName(FileOperations.defaultName(for: .folder), in: folder), "Untitled Folder 2")
    }

    func testRowSizesFollowTheTextSize() {
        XCTAssertEqual(FileTreeMetrics.scaled(toText: 9.5), .compact)
        let double = FileTreeMetrics.scaled(toText: 19)
        XCTAssertEqual(double.icon, FileTreeMetrics.compact.icon * 2, accuracy: 0.001)
        XCTAssertEqual(double.indent, FileTreeMetrics.compact.indent * 2, accuracy: 0.001)
        XCTAssertEqual(double.verticalPadding, FileTreeMetrics.compact.verticalPadding * 2, accuracy: 0.001)
    }

    func testAPulsePlaysOnlySoonAfterItWasAskedFor() {
        let pulse = FileTreePulse(id: "/r/a.md", token: 1, at: Date(timeIntervalSince1970: 100))
        XCTAssertTrue(pulse.isFresh(now: Date(timeIntervalSince1970: 101)))
        XCTAssertFalse(pulse.isFresh(now: Date(timeIntervalSince1970: 100 + FileTreePulse.lifetime + 0.1)))
    }
}
