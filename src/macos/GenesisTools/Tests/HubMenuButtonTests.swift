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
            MenuButtonTarget.shared.perform(item)
        }
        XCTAssertEqual(picked, ["split", "unified", "reload"], "each item runs its own closure")
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
