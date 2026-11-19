import AppKit
import Darwin
import XCTest
@testable import GenesisToolsHost
@testable import GenesisToolsRecorder
@testable import GenesisToolsWidget

final class AppMenuBarTests: XCTestCase {
    func testLegacyMenuCommandsDoNotBecomeWindowIntents() {
        for action in ["recordScreen", "recordScreenWithAudio", "quit"] {
            let request = RecorderRequest.parse(["--menu-command", action])
            XCTAssertNil(request.edit)
            XCTAssertFalse(request.picker)
            XCTAssertFalse(request.library)
        }
        let request = RecorderRequest.parse(["--picker", "--no-focus"])
        XCTAssertTrue(request.picker)
        XCTAssertFalse(request.focus)
    }

    func testRecorderMenuEndpointIsScopedToItsHomeAndPID() throws {
        let first = URL(fileURLWithPath: "/tmp/recorder-home-a/recorder.lock")
        let second = URL(fileURLWithPath: "/tmp/recorder-home-b/recorder.lock")
        let key = RecorderMenuIPC.addressKey(for: first)
        let endpoint = try XCTUnwrap(RecorderMenuIPC.socketPath(key: key, pid: 123))
        XCTAssertEqual(RecorderMenuIPC.socketPath(key: RecorderMenuIPC.addressKey(for: first), pid: 123), endpoint)
        XCTAssertNotEqual(RecorderMenuIPC.socketPath(key: RecorderMenuIPC.addressKey(for: second), pid: 123), endpoint)
        XCTAssertNotEqual(RecorderMenuIPC.socketPath(key: key, pid: 124), endpoint)
    }

    @MainActor
    func testRecorderMenuSocketAuthenticatesAndDispatches() async throws {
        let lock = URL(fileURLWithPath: "/tmp/\(UUID().uuidString)/recorder.lock")
        let key = RecorderMenuIPC.addressKey(for: lock)
        let received = expectation(description: "The listener dispatched the command")
        let listener = try XCTUnwrap(RecorderMenuIPC.listen(key: key) { action in
            XCTAssertEqual(action, .recordScreenWithAudio)
            received.fulfill()
        })
        defer { listener.cancel() }

        let result = await Task.detached {
            RecorderMenuIPC.deliver(.recordScreenWithAudio, to: getpid(), key: key)
        }.value
        XCTAssertEqual(result, .delivered)
        await fulfillment(of: [received], timeout: 2)
    }

    func testRecorderMenuTransportRejectsAnUnconnectedOrUnexpectedPeer() throws {
        var sockets: [Int32] = [-1, -1]
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &sockets), 0)
        defer { for socket in sockets where socket >= 0 { close(socket) } }
        XCTAssertFalse(RecorderMenuIPC.authenticatedPeer(sockets[0], expectedPID: getpid() + 1))

        let unconnected = socket(AF_UNIX, SOCK_STREAM, 0)
        defer { if unconnected >= 0 { close(unconnected) } }
        XCTAssertGreaterThanOrEqual(unconnected, 0)
        XCTAssertFalse(RecorderMenuIPC.authenticatedPeer(unconnected))
    }

    @MainActor
    func testInstalledPartsAndSharedRecorderMenu() throws {
        _ = NSApplication.shared
        let recorder = RecorderMenu()
        var routed: [[String]] = []
        let menu = AppMenuBar.makeMenu(
            installed: ["hub", "features", "widget", "recorder", "meetings", "markdown", "clicky"],
            recorderMenu: makeRecorderAppSubmenu, launch: { routed.append($0) })
        XCTAssertEqual(menu.items.filter { !$0.isSeparatorItem }.map(\.title),
                       ["Open Hub", "Settings…", "Permissions…", "Meetings", "Work", "Recorder", "Clicky", "Markdown", "Features"])
        let submenu = try XCTUnwrap(menu.item(withTitle: "Recorder")?.submenu)
        XCTAssertEqual(submenu.items.map(\.title), recorder.makeMenu().items.map(\.title))
        XCTAssertNotNil(submenu.item(withTitle: "Capture Picker…"))
        XCTAssertNotNil(submenu.item(withTitle: "Recordings Library…"))
        XCTAssertNotNil(submenu.item(withTitle: "Recent")?.submenu)
        XCTAssertNotNil(submenu.item(withTitle: "Draw the Cursor in the Editor"))
        menu.performActionForItem(at: menu.indexOfItem(withTitle: "Work"))
        XCTAssertEqual(routed, [["--hub", "--mode", "work"]])
    }

    @MainActor
    func testMissingPartsHaveNoRows() {
        let menu = AppMenuBar.makeMenu(installed: ["widget", "features"], recorderMenu: {
            XCTFail("An uninstalled recorder must not build a menu")
            return NSMenu()
        }, launch: { _ in })
        XCTAssertEqual(menu.items.filter { !$0.isSeparatorItem }.map(\.title), ["Settings…", "Permissions…", "Features"])
    }

    @MainActor
    func testVisibilityRemovesTheInstalledItemAndCanRestoreIt() throws {
        let suite = UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var installs = 0
        var removals = 0
        let bar = AppMenuBar {
            installs += 1
            return { removals += 1 }
        }
        XCTAssertTrue(MenuBarSettings.separateRecorder(in: defaults))
        bar.update(shown: MenuBarSettings.showsApp(in: defaults))
        defaults.set(false, forKey: MenuBarSettings.appKey)
        bar.update(shown: MenuBarSettings.showsApp(in: defaults))
        bar.update(shown: MenuBarSettings.showsApp(in: defaults))
        defaults.set(true, forKey: MenuBarSettings.appKey)
        bar.update(shown: MenuBarSettings.showsApp(in: defaults))
        XCTAssertEqual(installs, 2)
        XCTAssertEqual(removals, 1)
    }
}
