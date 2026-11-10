import AppKit
import Foundation
import SwiftUI
import XCTest
@testable import GenesisToolsMeetings

/// The Wave B Swift review's fixes (WaveB-b-review-fix-swift.md): each test names the finding it pins.
@MainActor
final class MeetingsReviewFixTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suite = ""

    override func setUp() async throws {
        suite = "meetings.reviewfix.tests.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
    }

    // MARK: Finding 1: the row's controls are pressable at rest

    /// Whether each `LiveButton` in a view's body is pressable at rest. A hosted SwiftUI view shows no accessibility
    /// children without an accessibility client, so the test reads the body's structure: a resting row (`.liveRow`)
    /// draws a LiveButton's label alone unless it is `pressable` (GenesisKit `Style/LiveControls.swift`).
    private func liveButtonsPressable(_ value: Any, depth: Int = 0) -> [Bool] {
        guard depth < 24 else { return [] }
        let mirror = Mirror(reflecting: value)
        if String(describing: type(of: value)).hasPrefix("LiveButton<") {
            return [mirror.children.first { $0.label == "pressable" }?.value as? Bool ?? false]
        }
        return mirror.children.flatMap { liveButtonsPressable($0.value, depth: depth + 1) }
    }

    func testARowsPlayControlIsPressableWhileItsRowRests() {
        let player = MomentPlayer(engine: .init(cut: { _ in throw CancellationError() }, plan: { _ in .init(moment: nil, cannot: nil) },
                                                audio: { _ in throw CancellationError() }),
                                  load: { _ in throw CancellationError() }, defaults: defaults)
        let found = liveButtonsPressable(MomentButton(player: player, meeting: "m1", target: .time(309), label: "05:09").body)
        XCTAssertEqual(found, [true], "the one play control presses in a resting row")
    }

    func testASpeakerChipsTimeIsPressableWhileItsBlockRests() {
        let found = liveButtonsPressable(SpeakerChip(speaker: "Speaker 1", startSec: 3, play: { _ in }).body)
        XCTAssertEqual(found, [true], "the block's time plays from a resting block")
    }

    // MARK: Finding 3: a stored 0 is a value when the setting offers it

    func testAStoredZeroIsTheValueWhenTheChoicesOfferIt() {
        let hover = MeetingsPreferences.Panes.hoverDelayMs
        XCTAssertEqual(hover.value(defaults), 300, "unset reads the default")
        defaults.set(0, forKey: hover.key)
        XCTAssertEqual(hover.value(defaults), 0, "0 ms is one of the hover delay's choices")
        defaults.set(150, forKey: hover.key)
        XCTAssertEqual(hover.value(defaults), 150)
        let depth = MeetingsPreferences.Playback.stackDepth
        defaults.set(0, forKey: depth.key)
        XCTAssertEqual(depth.value(defaults), depth.defaultValue, "0 is no choice of the stack depth: the default")
        defaults.set(-2, forKey: depth.key)
        XCTAssertEqual(depth.value(defaults), depth.defaultValue)
        let delay = MeetingsWindowSetting(key: "meetings.test.delaySec", defaultValue: 1.0, choices: [0, 0.5, 1], title: "", detail: "")
        defaults.set(0.0, forKey: delay.key)
        XCTAssertEqual(delay.value(defaults), 0, "a Double choice of 0 reads as 0")
        let speed = MeetingsPreferences.Playback.speed
        defaults.set(0.0, forKey: speed.key)
        XCTAssertEqual(speed.value(defaults), 1, "0 is no speed: the default")
    }
}
