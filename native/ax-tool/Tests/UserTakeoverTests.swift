import AppKit
import XCTest
@testable import SnapshotSupport

final class UserTakeoverTests: XCTestCase {
    private let main = CGRect(x: 0, y: 0, width: 1512, height: 982)
    private let left = CGRect(x: -1920, y: -98, width: 1920, height: 1080)

    func testTheMenuBarCornerOfTheMainDisplayIsATakeover() {
        XCTAssertTrue(userTookOver(pointer: .zero, displays: [main], enabled: true))
        XCTAssertTrue(userTookOver(pointer: CGPoint(x: 3.9, y: 3.9), displays: [main], enabled: true))
    }

    func testJustOutsideTheSquareIsNot() {
        XCTAssertFalse(userTookOver(pointer: CGPoint(x: 4, y: 0), displays: [main], enabled: true))
        XCTAssertFalse(userTookOver(pointer: CGPoint(x: 0, y: 4), displays: [main], enabled: true))
        XCTAssertFalse(userTookOver(pointer: CGPoint(x: 700, y: 400), displays: [main], enabled: true))
    }

    func testASecondaryDisplayToTheLeftDoesNotMoveTheCorner() {
        // The union's top-left is the left display's corner, and the pointer crosses x = 0 freely.
        XCTAssertFalse(userTookOver(pointer: CGPoint(x: -1, y: 1), displays: [left, main], enabled: true))
        XCTAssertFalse(userTookOver(pointer: CGPoint(x: -1920, y: -98), displays: [left, main], enabled: true))
        XCTAssertTrue(userTookOver(pointer: CGPoint(x: 1, y: 1), displays: [left, main], enabled: true))
    }

    func testTheSettingTurnsItOffAndAnUnknownDisplayOrPointerNeverFires() {
        XCTAssertFalse(userTookOver(pointer: .zero, displays: [main], enabled: false))
        XCTAssertFalse(userTookOver(pointer: .zero, displays: [left], enabled: true))
        XCTAssertFalse(userTookOver(pointer: CGPoint(x: CGFloat.nan, y: 0), displays: [main], enabled: true))
    }

    func testOnlyAnExplicitOffValueDisablesTheCheck() {
        XCTAssertTrue(takeoverCornerEnabled([:]))
        XCTAssertTrue(takeoverCornerEnabled(["GENESIS_CONTROL_ABORT_CORNER": "1"]))
        XCTAssertTrue(takeoverCornerEnabled(["GENESIS_CONTROL_ABORT_CORNER": "O"]))
        XCTAssertFalse(takeoverCornerEnabled(["GENESIS_CONTROL_ABORT_CORNER": "0"]))
        XCTAssertFalse(takeoverCornerEnabled(["GENESIS_CONTROL_ABORT_CORNER": " Off "]))
    }

    func testATakeoverBeforeTheFirstEventPostsNothing() {
        var events: [String] = []
        let gate = SyntheticInputGate(tookOver: { true })
        XCTAssertThrowsError(try gate.post { events.append("move") }) { error in
            XCTAssertEqual((error as? UserTakeoverError)?.dispatched, false)
            XCTAssertEqual((error as? UserTakeoverError)?.category, .userTakeover)
        }
        XCTAssertEqual(events, [])
    }

    func testTypingChecksBetweenCharactersAndReleasesTheLastKey() {
        // Port of tscu's test_typing_checks_abort_between_characters_and_releases_the_key.
        var events: [String] = []
        let gate = SyntheticInputGate(tookOver: { !events.isEmpty })
        XCTAssertThrowsError(try {
            for character in "abc" {
                gate.release(try gate.press({ events.append("\(character) down") },
                                           release: { events.append("\(character) up") }))
            }
        }()) { error in
            XCTAssertEqual((error as? UserTakeoverError)?.dispatched, true)
        }
        XCTAssertEqual(events, ["a down", "a up"])
    }

    func testATakeoverWhileAButtonIsHeldReleasesItFirstAndOnlyOnce() throws {
        var events: [String] = []
        var cornered = false
        let gate = SyntheticInputGate(tookOver: { cornered })
        let held = try gate.press({ events.append("down") }, release: { events.append("up") })
        cornered = true
        XCTAssertThrowsError(try gate.post { events.append("move") })
        // The caller's own release after the refusal must not post a second up.
        gate.release(held)
        XCTAssertEqual(events, ["down", "up"])
    }

    func testAReleaseIsNeverChecked() throws {
        var events: [String] = []
        var cornered = false
        let gate = SyntheticInputGate(tookOver: { cornered })
        let held = try gate.press({ events.append("down") }, release: { events.append("up") })
        cornered = true
        gate.release(held)
        gate.deliver { events.append("drag release") }
        XCTAssertEqual(events, ["down", "up", "drag release"])
        XCTAssertEqual(gate.posted, 3)
    }

    func testALongHoldStopsWithinOneSlice() {
        var slept: [TimeInterval] = []
        let gate = SyntheticInputGate(tookOver: { slept.count >= 3 }, sleeper: { slept.append($0) })
        XCTAssertThrowsError(try gate.sleepWatching(10))
        XCTAssertEqual(slept.count, 3)
        XCTAssertTrue(slept.allSatisfy { $0 <= 0.1 })
    }

    func testADragStoppedByATakeoverReleasesTheButtonAndKeepsTheRefusal() throws {
        let factory = try WindowEventFactory(windowID: 456, bounds: CGRect(x: 0, y: 0, width: 500, height: 500))
        var posted: [CGEvent] = []
        XCTAssertThrowsError(try factory.drag(start: CGPoint(x: 10, y: 10),
            points: [CGPoint(x: 20, y: 20), CGPoint(x: 100, y: 100)], stepDelay: 0,
            verify: { point in
                if point.x == 100 { throw UserTakeoverError(dispatched: true) }
            }, post: { posted.append($0) })) { error in
                XCTAssertTrue(error is UserTakeoverError)
            }
        XCTAssertEqual(posted.map(\.type), [.leftMouseDown, .leftMouseDragged, .leftMouseUp])
    }
}
