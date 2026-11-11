import XCTest
@testable import GenesisKit

/// The floating controls and the menu bar show a movie recording's recorded time, which its socket sends with every
/// state: arming, pauses and a rollover's gap are left out, and a restart starts it at 0 again. A recorder that sends
/// no time (the meeting recorder) keeps the time since its entry appeared.
final class RecorderHuntLiveControlsMovieTimeTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_000)

    private func entry(state: String = "recording") -> LiveRecording {
        LiveRecording(id: "r", kind: "control-session", title: "t", pid: 1, startedAt: start, state: state)
    }

    func testRecordedTimeGrowsOnlyWhileRecording() {
        var recording = entry(state: "paused")
        recording.recordedMs = 5000
        recording.recordedAt = start.addingTimeInterval(10)
        XCTAssertEqual(recording.elapsedMs(now: start.addingTimeInterval(13)), 5000, accuracy: 1)

        recording.state = "recording"
        XCTAssertEqual(recording.elapsedMs(now: start.addingTimeInterval(13)), 8000, accuracy: 1)

        recording.recordedRunning = false
        XCTAssertEqual(recording.elapsedMs(now: start.addingTimeInterval(13)), 5000, accuracy: 1,
                       "a segment that arms adds nothing")
    }

    func testEachStateNotificationReanchorsTheClock() {
        var overlay = LiveRecordingOverlay()
        let base = entry()
        let at = { (seconds: Double) in self.start.addingTimeInterval(seconds) }

        overlay.applyStatus(["state": "recording", "elapsedMs": 0, "elapsedRunning": false], now: at(0))
        XCTAssertEqual(overlay.merged(into: base).elapsedMs(now: at(1.5)), 0, accuracy: 1, "arming")

        overlay.applyStatus(["state": "recording", "elapsedMs": 0, "elapsedRunning": true], now: at(1.5))
        XCTAssertEqual(overlay.merged(into: base).elapsedMs(now: at(3.5)), 2000, accuracy: 1)

        overlay.applyStatus(["state": "paused", "elapsedMs": 2000, "elapsedRunning": false], now: at(3.5))
        overlay.applyStatus(["state": "paused"], now: at(3.6))
        XCTAssertEqual(overlay.merged(into: base).elapsedMs(now: at(7.5)), 2000, accuracy: 1,
                       "a paused 4 s is not in the movie, and a control answer without a time keeps it")
        XCTAssertEqual(LiveRecordingsStatusItem.detail(overlay.merged(into: base), now: at(7.5)),
                       "Control session · 0:02 · paused", "the menu bar shows the same time")

        overlay.applyStatus(["state": "recording", "elapsedMs": 2000, "elapsedRunning": false], now: at(7.5))
        overlay.applyStatus(["state": "recording", "elapsedMs": 2000, "elapsedRunning": true], now: at(8))
        XCTAssertEqual(overlay.merged(into: base).elapsedMs(now: at(9)), 3000, accuracy: 1)

        overlay.applyStatus(["state": "recording", "elapsedMs": 0, "elapsedRunning": false], now: at(9))
        XCTAssertEqual(overlay.merged(into: base).elapsedMs(now: at(9.5)), 0, accuracy: 1, "a restart starts at 0")

        overlay.applyStatus(["state": "stopping", "elapsedMs": 0, "elapsedRunning": false], now: at(9.5))
        XCTAssertEqual(overlay.merged(into: base).elapsedMs(now: at(20)), 0, accuracy: 1)
    }

    func testATimeWithoutTheRunningFlagGrowsWhileRecording() {
        var overlay = LiveRecordingOverlay()
        overlay.applyStatus(["state": "recording", "elapsedMs": 1000], now: start)
        XCTAssertEqual(overlay.merged(into: entry()).elapsedMs(now: start.addingTimeInterval(2)), 3000, accuracy: 1)
    }

    func testARecorderThatSendsNoTimeKeepsTheTimeSinceItsEntryAppeared() {
        var overlay = LiveRecordingOverlay()
        overlay.applyStatus(["state": "paused", "frames": 3], now: start)
        let meeting = overlay.merged(into: entry())
        XCTAssertNil(meeting.recordedMs)
        XCTAssertEqual(meeting.elapsedMs(now: start.addingTimeInterval(7.5)), 7500, accuracy: 1)
    }
}
