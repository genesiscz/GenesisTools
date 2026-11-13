import GenesisKit
import XCTest
@testable import GenesisToolsRecorder

/// The capture picker's countdown starts `tools recorder start` as its last second begins and holds that number until
/// the recording records, because the CLI's start and ax-tool's arming took 1.3 to 1.8 s after zero and the first
/// thing done after it was not in the movie. A movie's live entry says "recording" while ax-tool still arms, so the
/// countdown waits for `lastFrameAt`, which a movie sets at its first frame.
final class RecorderHuntCountdownUntilFirstFrameTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    private func entry(startedAfter seconds: TimeInterval, framed: Bool) -> LiveRecording {
        LiveRecording(id: "recorder-\(seconds)", kind: "control-session", title: "Screen recording", pid: 4242,
                      startedAt: start.addingTimeInterval(seconds), state: "recording",
                      lastFrameAt: framed ? start.addingTimeInterval(seconds + 1) : nil)
    }

    func testAnArmingRecordingDoesNotEndTheCountdown() {
        XCTAssertFalse(CaptureCountdown.firstFrameIn([entry(startedAfter: 0.7, framed: false)], since: start))
    }

    func testTheStartedRecordingsFirstFrameEndsTheCountdown() {
        XCTAssertTrue(CaptureCountdown.firstFrameIn([entry(startedAfter: 0.7, framed: true)], since: start))
    }

    func testAnOlderRecordingThatRecordsDoesNotEndTheCountdown() {
        XCTAssertFalse(CaptureCountdown.firstFrameIn([entry(startedAfter: -30, framed: true)], since: start))
        XCTAssertTrue(CaptureCountdown.firstFrameIn(
            [entry(startedAfter: -30, framed: true), entry(startedAfter: 0.7, framed: true)], since: start))
    }

    /// The hold after the last second shows 0, and VoiceOver says the recording is starting, not "in 1 seconds".
    @MainActor
    func testTheHoldAfterTheLastSecondShowsZero() {
        let model = CountdownModel()
        model.remaining = 1
        XCTAssertEqual(model.spoken, "Recording starts in 1 second")
        model.lastSecondEnded()
        XCTAssertEqual(model.remaining, 0)
        XCTAssertEqual(model.spoken, "The recording is starting")
    }

    func testAStartTimeRoundedDownToTheSecondStillCounts() {
        XCTAssertTrue(CaptureCountdown.firstFrameIn([entry(startedAfter: -0.4, framed: true)], since: start))
    }

    /// The TypeScript side writes `lastFrameAt` as an ISO time with milliseconds; the entry decodes it.
    func testTheLiveEntrysFirstFrameTimeDecodes() throws {
        let json = """
        {"version":1,"id":"recorder-1","kind":"control-session","title":"Screen recording","pid":4242,
         "startedAt":"2027-01-15T08:00:00.700Z","state":"recording","lastFrameAt":"2027-01-15T08:00:01.512Z",
         "socket":"/tmp/x.sock"}
        """
        let decoded = try XCTUnwrap(LiveRecordingStore.decode(Data(json.utf8)))
        XCTAssertNotNil(decoded.lastFrameAt)
        XCTAssertTrue(CaptureCountdown.firstFrameIn([decoded], since: decoded.startedAt.addingTimeInterval(-0.5)))
    }
}
