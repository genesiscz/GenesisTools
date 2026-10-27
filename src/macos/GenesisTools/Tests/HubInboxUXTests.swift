import XCTest
@testable import GenesisToolsHost
@testable import GenesisToolsHub

/// The hub's decision surfaces as the user reads them (UX audit 2026-10-27): the Decisions pane's words, and the Inbox
/// card's words, keys and states.
final class HubInboxUXTests: XCTestCase {
    /// P4: the Decisions pane's caption follows the Decision click setting, and its empty text says what is empty.
    func testTheDecisionsPaneSaysWhatAClickDoesAndWhatIsEmpty() {
        XCTAssertEqual(DecisionsView.caption(stages: true).text, "A click stages an option · Send delivers")
        XCTAssertEqual(DecisionsView.caption(stages: false).text, "A click sends the option at once",
                       "it said \"stages\" while clicks sent")
        XCTAssertEqual(DecisionsView.emptyText(filter: "answered", hasAny: true), "No answered decisions in this session.",
                       "it said \"Nothing here.\"")
        XCTAssertEqual(DecisionsView.emptyText(filter: "open", hasAny: true), "No open decisions in this session.")
        XCTAssertEqual(DecisionsView.emptyText(filter: "all", hasAny: false), "No decisions recorded for this session.")
    }
}
