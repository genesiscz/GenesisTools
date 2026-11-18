import AppKit
import XCTest
@testable import GenesisToolsHost
@testable import GenesisToolsRecorder
@testable import GenesisToolsWidget

final class AppMenuBarTests: XCTestCase {
    @MainActor
    func testInstalledPartsAndSharedRecorderMenu() throws {
        let recorder = RecorderMenu()
        var routed: [[String]] = []
        let menu = AppMenuBar.makeMenu(
            installed: ["hub", "features", "widget", "recorder", "meetings", "markdown", "clicky"],
            recorderMenu: { recorder.makeMenu() }, launch: { routed.append($0) })
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
