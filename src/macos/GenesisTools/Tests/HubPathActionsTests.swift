import AppKit
import XCTest
@testable import GenesisTools

/// Every path and copy control goes through Hub/HubPathActions.swift: a folder opens in Finder (never
/// the folder's default app, which LaunchServices set to QuickTime on one Mac), a file is revealed or
/// opened as its label says, and a missing path is reported instead of reaching a system alert.
final class HubPathActionsTests: XCTestCase {
    /// Records what `PathOpener.perform` asked for; the disk answers `kind(of:)`.
    private final class SpyWorkspace: PathWorkspace {
        var calls: [String] = []

        func kind(of url: URL) -> PathItemKind {
            SystemPathWorkspace().kind(of: url)
        }

        func openFolderInFinder(_ url: URL) { calls.append("finder \(url.path)") }
        func revealInFinder(_ url: URL) { calls.append("reveal \(url.path)") }
        func openFile(_ url: URL) { calls.append("open \(url.path)") }
        func reportMissing(_ path: String) { calls.append("missing \(path)") }
    }

    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("hub-path-actions-\(UUID().uuidString)", isDirectory: true)
            .resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: root.appendingPathComponent("Acme app/Ďábel/ČŘ"), withIntermediateDirectories: true)
        try Data("x".utf8).write(to: root.appendingPathComponent("Acme app/Ďábel/ČŘ/notes #1.md"))
        try FileManager.default.createDirectory(at: root.appendingPathComponent("Tool.app/Contents"), withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    func testAFolderOpensInFinderForEveryOpenIntent() {
        let folder = root.appendingPathComponent("Acme app/Ďábel/ČŘ").path
        let spy = SpyWorkspace()

        XCTAssertEqual(PathOpener.perform(.finder, folder, workspace: spy), .folderInFinder(URL(fileURLWithPath: folder)))
        XCTAssertEqual(PathOpener.perform(.open, folder, workspace: spy), .folderInFinder(URL(fileURLWithPath: folder)))
        XCTAssertEqual(spy.calls, ["finder \(folder)", "finder \(folder)"], "a folder never goes to its default app")
    }

    func testRevealSelectsTheItemInItsFolder() {
        let folder = root.appendingPathComponent("Acme app").path
        let spy = SpyWorkspace()

        XCTAssertEqual(PathOpener.perform(.reveal, folder, workspace: spy), .revealInFinder(URL(fileURLWithPath: folder)))
        XCTAssertEqual(spy.calls, ["reveal \(folder)"])
    }

    func testAFileIsRevealedByFinderAndOpenedByOpen() {
        let file = root.appendingPathComponent("Acme app/Ďábel/ČŘ/notes #1.md").path
        let spy = SpyWorkspace()

        XCTAssertEqual(PathOpener.perform(.finder, file, workspace: spy), .revealInFinder(URL(fileURLWithPath: file)))
        XCTAssertEqual(PathOpener.perform(.open, file, workspace: spy), .openFile(URL(fileURLWithPath: file)))
        XCTAssertEqual(spy.calls, ["reveal \(file)", "open \(file)"])
    }

    func testAPackageIsRevealedNotLaunchedByFinder() {
        let package = root.appendingPathComponent("Tool.app").path
        let spy = SpyWorkspace()

        XCTAssertEqual(PathOpener.perform(.finder, package, workspace: spy), .revealInFinder(URL(fileURLWithPath: package)))
        XCTAssertEqual(spy.calls, ["reveal \(package)"])
    }

    func testAMissingPathIsReportedAndNothingOpens() {
        let missing = root.appendingPathComponent("Acme app/gone/nothing here").path
        let spy = SpyWorkspace()

        for intent in [PathIntent.finder, .reveal, .open] {
            XCTAssertEqual(PathOpener.perform(intent, missing, workspace: spy), .missing(missing))
        }
        XCTAssertEqual(spy.calls, Array(repeating: "missing \(missing)", count: 3))
    }

    func testATildePathExpandsBeforeTheCheck() {
        let spy = SpyWorkspace()
        let home = NSHomeDirectory()

        XCTAssertEqual(PathOpener.perform(.finder, "~", workspace: spy), .folderInFinder(URL(fileURLWithPath: home)))
        XCTAssertEqual(PathOpener.perform(.finder, "~/hub-path-actions-not-there-\(UUID().uuidString)", workspace: spy).isMissing, true)
        XCTAssertEqual(spy.calls.first, "finder \(home)")
        XCTAssertTrue(spy.calls.last?.hasPrefix("missing \(home)/") ?? false, "the report names the expanded path: \(spy.calls)")
    }

    func testFileURLKeepsSpacesHashesAndAccentsAsPathText() {
        let url = PathOpener.fileURL("~/Projects/Acme app/Ďábel/ČŘ/notes #1.md")

        XCTAssertTrue(url.isFileURL)
        XCTAssertEqual(url.path, NSHomeDirectory() + "/Projects/Acme app/Ďábel/ČŘ/notes #1.md")
        XCTAssertEqual(PathOpener.fileURL("/tmp/a/../b/./c").path, "/tmp/b/c")
    }

    func testTargetTableCoversEveryKindAndIntent() {
        let url = URL(fileURLWithPath: "/x")
        XCTAssertEqual(PathOpener.target(for: url, intent: .finder, kind: .folder), .folderInFinder(url))
        XCTAssertEqual(PathOpener.target(for: url, intent: .reveal, kind: .folder), .revealInFinder(url))
        XCTAssertEqual(PathOpener.target(for: url, intent: .open, kind: .folder), .folderInFinder(url))
        XCTAssertEqual(PathOpener.target(for: url, intent: .finder, kind: .file), .revealInFinder(url))
        XCTAssertEqual(PathOpener.target(for: url, intent: .reveal, kind: .file), .revealInFinder(url))
        XCTAssertEqual(PathOpener.target(for: url, intent: .open, kind: .file), .openFile(url))
        XCTAssertEqual(PathOpener.target(for: url, intent: .finder, kind: .package), .revealInFinder(url))
        XCTAssertEqual(PathOpener.target(for: url, intent: .open, kind: .package), .openFile(url))
        XCTAssertEqual(PathOpener.target(for: url, intent: .open, kind: .missing), .missing("/x"))
    }

    // MARK: copy confirmation

    func testCopyPreviewIsOneShortLine() {
        XCTAssertEqual(HubCopyToast.preview("0a1b2c3d-4e5f"), "0a1b2c3d-4e5f")
        XCTAssertEqual(HubCopyToast.preview("  padded\n"), "padded")
        XCTAssertEqual(HubCopyToast.preview("one\ntwo\nthree"), "3 lines")

        let long = "/Users/someone/Projects/Acme/app/src/features/billing/invoices/list/InvoiceListScreen.tsx"
        let preview = HubCopyToast.preview(long, limit: 40)
        XCTAssertEqual(preview.count, 39)
        XCTAssertTrue(preview.hasPrefix("/Users/someone/Proj"))
        XCTAssertTrue(preview.hasSuffix("oiceListScreen.tsx"), "the file name stays readable: \(preview)")
        XCTAssertTrue(preview.contains("…"))
    }

    func testTheToastSitsBesideThePointerInsideTheScreen() {
        let screen = CGRect(x: 0, y: 0, width: 1000, height: 800)
        let size = CGSize(width: 200, height: 30)

        XCTAssertEqual(HubCopyToast.origin(pointer: CGPoint(x: 100, y: 100), size: size, screen: screen), CGPoint(x: 114, y: 110))
        XCTAssertEqual(HubCopyToast.origin(pointer: CGPoint(x: 990, y: 790), size: size, screen: screen), CGPoint(x: 796, y: 766), "clamped at the corner")
    }

    // MARK: session sidebar

    func testTheSessionSidebarCoversTheTranscriptOnlyWhenBothDoNotFit() {
        XCTAssertFalse(SessionSidebarSplit.overlays(width: 1100, sidebar: 301, mainMinWidth: 460))
        XCTAssertFalse(SessionSidebarSplit.overlays(width: 761, sidebar: 301, mainMinWidth: 460))
        XCTAssertTrue(SessionSidebarSplit.overlays(width: 760, sidebar: 301, mainMinWidth: 460))
        XCTAssertTrue(SessionSidebarSplit.overlays(width: 500, sidebar: 301, mainMinWidth: 460))
    }

    func testTheResumeCommandQuotesTheFolderAsOneShellWord() {
        XCTAssertEqual(HubSessionDetailHost.shellQuoted("/Users/someone/Acme app"), "'/Users/someone/Acme app'")
        XCTAssertEqual(HubSessionDetailHost.shellQuoted("/tmp/it's"), "'/tmp/it'\\''s'")
    }

    // MARK: diff header menu

    func testTheHeaderMenuMessageDecodes() {
        guard case .headerMenu(let fileID, let selection)? = DiffRendererEvent(pageMessage: ["type": "header.menu", "fileId": "f1", "selection": "src/a.ts"]) else {
            return XCTFail("header.menu did not decode")
        }
        XCTAssertEqual(fileID, "f1")
        XCTAssertEqual(selection, "src/a.ts")

        guard case .headerMenu(_, let empty)? = DiffRendererEvent(pageMessage: ["type": "header.menu", "fileId": "f1"]) else {
            return XCTFail("header.menu without a selection did not decode")
        }
        XCTAssertEqual(empty, "")
        XCTAssertNil(DiffRendererEvent(pageMessage: ["type": "header.menu"]), "a menu needs its file")
    }
}

private extension PathOpenTarget {
    var isMissing: Bool {
        if case .missing = self {
            return true
        }

        return false
    }
}
