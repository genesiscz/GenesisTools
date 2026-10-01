import AppKit
import XCTest
@testable import GenesisTools

/// `MenuButton` draws its label in SwiftUI and builds the AppKit menu only at the click: the menu must
/// carry every title, check mark, disabled state, divider and submenu the SwiftUI `Menu` had.
@MainActor
final class HubMenuButtonTests: XCTestCase {
    func testTheMenuCarriesTitlesStatesDividersAndSubmenus() {
        var picked: [String] = []
        let menu = MenuButtonPresenter.menu([
            .action("Split", checked: true) { picked.append("split") },
            .action("Unified") { picked.append("unified") },
            .divider,
            .action("Reload", enabled: false) { picked.append("reload") },
            .submenu("Committed", [.note("No commits ahead of the base")]),
        ])

        XCTAssertEqual(menu.items.map(\.title), ["Split", "Unified", "", "Reload", "Committed"])
        XCTAssertEqual(menu.items.map(\.state), [.on, .off, .off, .off, .off])
        XCTAssertTrue(menu.items[2].isSeparatorItem)
        XCTAssertFalse(menu.items[3].isEnabled)
        XCTAssertFalse(menu.autoenablesItems, "a disabled item stays disabled even with a target")
        let note = menu.items[4].submenu?.items.first
        XCTAssertEqual(note?.title, "No commits ahead of the base")
        XCTAssertEqual(note?.isEnabled, false)

        for item in menu.items where item.action != nil {
            MenuButtonTarget.shared.runItem(item)
        }
        XCTAssertEqual(picked, ["split", "unified", "reload"], "each item runs its own closure")
    }

    /// A pick goes through AppKit, which sends the item's selector to its target. The selector used to be
    /// `perform:`, which `#selector(MenuButtonTarget.perform(_:))` resolved to NSObject's
    /// `performSelector:`: AppKit passed the menu item as the selector, raised "unrecognized selector",
    /// logged it and went on, so every pick in every `MenuButton` did nothing (Martin, 2026-09-30: "the
    /// Verbose and all other picker items are literally not doing anything"). A direct Swift call, as in
    /// the test above, still reached the right method.
    func testAPickThroughAppKitRunsTheItemsClosure() {
        _ = NSApplication.shared
        var picked: [String] = []
        let menu = MenuButtonPresenter.menu([
            .action("Minimal") { picked.append("minimal") },
            .action("Verbose") { picked.append("verbose") },
        ])

        menu.performActionForItem(at: 1)
        XCTAssertEqual(picked, ["verbose"], "the picked item must run its closure")
    }

    func testScopeItemsCheckTheCurrentScopeAndNeedASessionForTurns() {
        let model = ReviewModel(repo: URL(fileURLWithPath: "/work/tools"), options: DiffViewOptions(), renderer: NullRenderer())
        var items = MenuButtonPresenter.menu(ScopeMenu.items(model: model)).items
        XCTAssertEqual(items.map(\.title), [
            DiffScope.lastTurns(1).title, "Last Turns…", "", DiffScope.uncommitted.title, DiffScope.unstaged.title,
            DiffScope.staged.title, "", "Committed", DiffScope.branch.title,
        ])
        XCTAssertEqual(items.first?.title, DiffScope.lastTurns(1).title)
        XCTAssertEqual(items.first?.isEnabled, false, "no session: no turns to show")
        XCTAssertEqual(items.first { $0.title == DiffScope.uncommitted.title }?.state, .on)
        XCTAssertEqual(items.first { $0.title == "Committed" }?.submenu?.items.first?.isEnabled, false)

        let withSession = ReviewModel(repo: URL(fileURLWithPath: "/work/tools"), options: DiffViewOptions(), session: "session-a", renderer: NullRenderer())
        withSession.scope = .staged
        items = MenuButtonPresenter.menu(ScopeMenu.items(model: withSession)).items
        XCTAssertEqual(items.first?.isEnabled, true)
        XCTAssertEqual(items.filter { $0.state == .on }.map(\.title), [DiffScope.staged.title])
    }
}
