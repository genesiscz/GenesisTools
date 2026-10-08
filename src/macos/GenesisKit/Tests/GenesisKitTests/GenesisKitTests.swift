import AppKit
import SwiftUI
import XCTest
@testable import GenesisKit

final class CmuxTreeTests: XCTestCase {
    private let json = """
    profile: cmux tree 12ms
    {"fetchedAt":"2026-09-30T00:00:00Z","available":true,"windows":[{"id":"W1","ref":"window:1","index":0,"key":true,
    "workspaces":[{"id":"workspace:1","name":"work","panes":[
    {"id":"pane:1","title":"pane:1","active":true,"cwd":"/tmp","frame":{"x":0,"y":28,"width":800,"height":600},
     "container":{"width":1600,"height":1200},"selectedSurfaceId":"surface:2","surfaces":[
      {"id":"surface:1","title":"shell","type":"terminal","index":0,"selected":false,"active":false,"sessionId":null,"provider":null,"sessionHint":null},
      {"id":"surface:2","title":"fix the cart","type":"terminal","index":1,"selected":true,"active":true,"sessionId":"0A1B2C3D-4E5F","provider":"claude"}]},
    {"id":"pane:2","surfaces":[{"id":"surface:3","sessionHint":"deadbeef"}]}]}]}],"totalMs":12}
    """

    func testDecodesBothAppsFieldsAfterAPreamble() throws {
        let tree = try CmuxTree.decode(Data(json.utf8))
        XCTAssertTrue(tree.available)
        XCTAssertEqual(tree.windows.first?.label, "window:1")
        let pane = try XCTUnwrap(tree.windows.first?.workspaces.first?.panes.first)
        XCTAssertEqual(pane.frame, CmuxTree.Frame(x: 0, y: 28, width: 800, height: 600))
        XCTAssertEqual(pane.selectedSurfaceId, "surface:2")
        XCTAssertEqual(pane.surfaces.last?.provider, "claude")
        let sparse = try XCTUnwrap(tree.windows.first?.workspaces.first?.panes.last)
        XCTAssertNil(sparse.frame, "an older tools prints no frame")
        XCTAssertEqual(sparse.surfaces.first?.type, "terminal")
    }

    func testFindsASessionByIdOrHint() throws {
        let tree = try CmuxTree.decode(Data(json.utf8))
        XCTAssertEqual(tree.surface(of: "0a1b2c3d-4e5f")?.surface.id, "surface:2")
        XCTAssertEqual(tree.surface(of: "DEADBEEF-0000")?.surface.id, "surface:3")
        XCTAssertNil(tree.surface(of: "11111111-2222"))
        XCTAssertTrue(tree.hostsSession("0A1B2C3D-4E5F"))
        XCTAssertFalse(tree.hostsSession("11111111"))
    }

    func testAnUnreachableCmuxDecodesWithItsError() throws {
        let tree = try CmuxTree.decode(Data(#"{"available":false,"error":"cmux is not running","windows":[]}"#.utf8))
        XCTAssertFalse(tree.available)
        XCTAssertEqual(tree.error, "cmux is not running")
    }

    func testTargetsNameTheirOpenSessionFlags() {
        XCTAssertNil(CmuxTarget.newWorkspace(window: nil).openSessionArgs)
        XCTAssertEqual(CmuxTarget.newWorkspace(window: "window:1").openSessionArgs, ["--window", "window:1"])
        XCTAssertEqual(CmuxTarget.newPane(workspace: "workspace:1").openSessionArgs, ["--workspace", "workspace:1"])
        XCTAssertEqual(CmuxTarget.newTab(workspace: "w", pane: "p").openSessionArgs, ["--workspace", "w", "--pane", "p"])
        XCTAssertEqual(CmuxTarget.surface(workspace: "w", surface: "s").openSessionArgs, ["--workspace", "w", "--surface", "s"])
    }

    func testLastPanePrefersThePaneThenTheTab() {
        XCTAssertEqual(CmuxTarget.lastPane(workspace: "w", pane: "p", surface: "s"), .newTab(workspace: "w", pane: "p"))
        XCTAssertEqual(CmuxTarget.lastPane(workspace: "w", pane: "", surface: "s"), .surface(workspace: "w", surface: "s"))
        XCTAssertNil(CmuxTarget.lastPane(workspace: nil, pane: "p", surface: "s"))
    }

    /// The layout scales the panes to the width it is given, never the other way round: a fixed
    /// drawing width made the hub's sidebar wider than its panel.
    func testTheLayoutFitsThePanesIntoTheGivenWidth() {
        let frames = [CmuxTree.Frame(x: 240, y: 28, width: 885, height: 629), CmuxTree.Frame(x: 1125, y: 28, width: 930, height: 629)]
        let narrow = CmuxLayoutView.fit(frames, width: 260)
        XCTAssertEqual((2055 - 240) * narrow.scale, 260, accuracy: 0.5)
        XCTAssertEqual(narrow.height, 629 * narrow.scale, accuracy: 0.5)
        XCTAssertEqual(CmuxLayoutView.fit([], width: 0).height, 40, "an empty or unmeasured workspace keeps a minimum height")
    }

    func testRefsDropEmptyOnesAndKeepTheNumber() {
        let refs = CmuxSessionPanel.refs(window: "window:1", workspace: "", pane: "pane:37", surface: "surface")
        XCTAssertEqual(refs.map(\.label), ["window", "pane", "tab"])
        XCTAssertEqual(refs.map(\.value), ["1", "37", "surface"])
    }
}

@MainActor
final class MenuButtonTests: XCTestCase {
    /// AppKit sends the item's selector to its target. `perform:` resolved to NSObject's
    /// `performSelector:`, so every pick did nothing (Genesis's copy still had it until 2026-09-30).
    func testAPickThroughAppKitRunsTheItemsClosure() {
        _ = NSApplication.shared
        var picked: [String] = []
        let menu = MenuButtonPresenter.menu([
            .action("Minimal") { picked.append("minimal") },
            .divider,
            .action("Verbose", checked: true) { picked.append("verbose") },
            .submenu("More", [.note("Nothing here")]),
        ])
        XCTAssertEqual(menu.items.map(\.title), ["Minimal", "", "Verbose", "More"])
        XCTAssertEqual(menu.items[2].state, .on)
        menu.performActionForItem(at: 2)
        XCTAssertEqual(picked, ["verbose"])
    }
}

final class PathOpenerTests: XCTestCase {
    func testTheTargetTableOpensFoldersInFinderAndFilesInTheEditor() {
        let url = URL(fileURLWithPath: "/x")
        XCTAssertEqual(PathOpener.target(for: url, intent: .primary, kind: .folder), .folderInFinder(url))
        XCTAssertEqual(PathOpener.target(for: url, intent: .primary, kind: .file, line: 3), .editFile(url, line: 3))
        XCTAssertEqual(PathOpener.target(for: url, intent: .finder, kind: .package), .revealInFinder(url))
        XCTAssertEqual(PathOpener.target(for: url, intent: .open, kind: .missing), .missing("/x"))
    }

    func testTheCopyToastPreviewIsOneShortLine() {
        XCTAssertEqual(CopyToast.preview("one\ntwo"), "2 lines")
        XCTAssertEqual(CopyToast.preview(String(repeating: "a", count: 100), limit: 21).count, 21)
    }

    func testAHomePathShowsWithATilde() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        XCTAssertEqual(PathLabel.display(home + "/Projects/x"), "~/Projects/x")
        XCTAssertEqual(PathLabel.display("/tmp/x"), "/tmp/x")
        XCTAssertEqual(PathLabel.display(home), "~")
        XCTAssertEqual(PathLabel.display(home + "x/y"), home + "x/y", "a sibling of the home folder keeps its path")
    }
}

@MainActor
final class SpinningArcTests: XCTestCase {
    func testPathMatchesCircleStrokeWithoutAnInsetAndResizes() throws {
        let view = SpinningArc.ArcView(frame: CGRect(x: 0, y: 0, width: 9, height: 9))
        view.configure(color: NSColor.blue.cgColor, lineWidth: 2, trim: 0.12...0.78, period: 1.65, spinning: false)
        view.layout()
        let arc = try XCTUnwrap(view.layer?.sublayers?.first as? CAShapeLayer)
        XCTAssertEqual(try XCTUnwrap(arc.path).boundingBoxOfPath, Circle().path(in: view.bounds).boundingRect)
        XCTAssertEqual(arc.strokeStart, 0.12)
        XCTAssertEqual(arc.strokeEnd, 0.78)
        XCTAssertEqual(arc.lineCap, .round)
        view.setFrameSize(CGSize(width: 20, height: 30))
        view.layout()
        XCTAssertEqual(try XCTUnwrap(arc.path).boundingBoxOfPath, CGRect(x: 0, y: 5, width: 20, height: 20))
    }

    func testSpinAttachesStopsAndReattachesWithoutChangingTrim() throws {
        _ = NSApplication.shared
        let window = NSPanel(contentRect: CGRect(x: 0, y: 0, width: 40, height: 40),
                             styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        let view = SpinningArc.ArcView(frame: CGRect(x: 0, y: 0, width: 20, height: 20))
        view.configure(color: NSColor.blue.cgColor, lineWidth: 2, trim: 0.12...0.78, period: 1.65, spinning: true)
        let arc = try XCTUnwrap(view.layer?.sublayers?.first as? CAShapeLayer)
        XCTAssertNil(arc.animation(forKey: "genesis.spin"))
        window.contentView = view
        let spin = try XCTUnwrap(arc.animation(forKey: "genesis.spin") as? CABasicAnimation)
        XCTAssertEqual(spin.duration, 1.65)
        XCTAssertEqual(try XCTUnwrap(spin.toValue as? Double), -2 * .pi)
        XCTAssertEqual(spin.repeatCount, .infinity)
        view.removeFromSuperview()
        XCTAssertNil(arc.animation(forKey: "genesis.spin"))
        window.contentView = view
        XCTAssertNotNil(arc.animation(forKey: "genesis.spin"))
        view.configure(color: NSColor.blue.cgColor, lineWidth: 2, trim: 0.12...0.78, period: 1.65, spinning: false)
        XCTAssertNil(arc.animation(forKey: "genesis.spin"))
        XCTAssertEqual(arc.strokeStart, 0.12)
        XCTAssertEqual(arc.strokeEnd, 0.78)
    }
}
