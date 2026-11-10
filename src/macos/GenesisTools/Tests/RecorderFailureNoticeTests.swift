import GenesisKit
import XCTest
@testable import GenesisToolsRecorder

/// The recorder's failure notice: a start that stopped at once becomes a report with the real error as its headline,
/// what ran, the recording folder and the log's place, and the notice offers Try again with the same arguments.
@MainActor
final class RecorderFailureNoticeTests: XCTestCase {
    private var suiteName = ""
    private var defaults: UserDefaults!

    override func setUp() async throws {
        suiteName = "genesistools.tests.recorder-failure-notice.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suiteName)
        RecorderNotice.outlets = .live
    }

    static let output = """
    [recorder-video] video recording starting
        id: "video-1"
        folder: "/Users/alice/.genesis-tools/recordings/library/video-1"
        fps: 60
    WARN: [recorder-camera] the camera did not start
        error: {
          "type": "RpcError",
          "message": "the camera needs GenesisTools.app's recorder face connected to the recorder service as its host",
          "stack":
              RpcError: the camera needs GenesisTools.app's recorder face
                  at camera.start (/Users/alice/GenesisTools/src/recorder/lib/host.ts:234:19)
          "code": 1019
        }
    error: The camera was asked for, but it did not start: the camera needs GenesisTools.app's recorder face connected to the recorder service as its host
    failed, nothing was recorded: The camera was asked for, but it did not start
    """

    /// The defect: the note's title was "The recording stopped at once (exit 1): {." (the indented `error: {` field).
    func testTheProblemLineIsNeverAnIndentedField() {
        XCTAssertEqual(ToolsRunner.problem(in: Self.output),
                       "The camera was asked for, but it did not start: the camera needs GenesisTools.app's recorder face connected to the recorder service as its host")
    }

    func testAStartThatStoppedAtOnceReadsAsItsErrorWithWhatRanAndWhere() {
        let failure = ToolsRunner.EarlyFailure(argv: ["recorder", "start", "--window", "101344", "--camera"], status: 1,
                                               output: Self.output, logFile: "/Users/alice/.genesis-tools/logs/recorder-start.log",
                                               logLine: 812)
        // Noon UTC: 1970-01-01 in every zone from UTC-11 to UTC+11, so the day log's name does not depend on the Mac's zone.
        let report = RecorderNotice.startReport(failure, time: Date(timeIntervalSince1970: 43_200), app: nil, home: "/Users/alice")
        XCTAssertEqual(report.title, "Recording failed")
        XCTAssertEqual(report.headline,
                       "The camera was asked for, but it did not start: the camera needs GenesisTools.app's recorder face connected to the recorder service as its host.")
        XCTAssertEqual(report.summary, "Recording a window stopped at once (exit 1).")
        XCTAssertEqual(report.nextStep, "Nothing was recorded. Try again, or copy the context for an agent to look into it.")
        XCTAssertEqual(report.action, "Start a recording")
        XCTAssertEqual(report.command, "tools recorder start --window 101344 --camera")
        XCTAssertEqual(report.exitStatus, 1)
        XCTAssertEqual(report.folder, "/Users/alice/.genesis-tools/recordings/library/video-1")
        XCTAssertEqual(report.logFile, "/Users/alice/.genesis-tools/logs/recorder-start.log")
        XCTAssertEqual(report.logLine, 812)
        XCTAssertEqual(report.dayLog, "/Users/alice/.genesis-tools/logs/1970-01-01.log")
        XCTAssertEqual(report.log, Self.output)
        XCTAssertEqual(report.area, "recorder", "the bug form's Affected tool")
        XCTAssertEqual(report.expected, "The recording starts, and its controls and the red menu bar item appear.")
    }

    /// The shared log is never rotated, so its line is counted in chunks: the answer is the same for every chunk size,
    /// across chunk edges, at the start, and past the end of a file that is shorter than the offset.
    func testTheLogLineIsCountedInChunksWithTheSameAnswer() throws {
        let log = FileManager.default.temporaryDirectory.appendingPathComponent("recorder-start-\(UUID().uuidString).log")
        defer { try? FileManager.default.removeItem(at: log) }
        let text = (1...40).map { "run \($0) output line" }.joined(separator: "\n") + "\n"
        try Data(text.utf8).write(to: log)
        let offset = UInt64(text.utf8.count)
        for chunk in [1, 3, 7, 64 * 1024] {
            XCTAssertEqual(ToolsRunner.line(of: log, at: 0, chunk: chunk), 1)
            XCTAssertEqual(ToolsRunner.line(of: log, at: offset, chunk: chunk), 41, "chunk \(chunk)")
            XCTAssertEqual(ToolsRunner.line(of: log, at: offset + 500, chunk: chunk), 41, "past the end, chunk \(chunk)")
        }
        let thirdLine = UInt64("run 1 output line\nrun 2 output line\n".utf8.count)
        XCTAssertEqual(ToolsRunner.line(of: log, at: thirdLine, chunk: 5), 3)
    }

    func testAStartWithNoOutputSaysWhereTheLogIs() {
        let failure = ToolsRunner.EarlyFailure(argv: ["recorder", "start", "--display", "1"], status: 2, output: "  \n",
                                               logFile: "/tmp/x.log", logLine: nil)
        let report = RecorderNotice.startReport(failure, time: Date(), app: nil, home: "/Users/alice")
        XCTAssertEqual(report.headline, "The recording stopped at once.")
        XCTAssertEqual(report.summary, "Recording the screen stopped at once (exit 2).")
        XCTAssertEqual(report.nextStep, "Try again, or copy the context for an agent to look into it.")
        XCTAssertFalse(report.hasLog)
    }

    func testTheNoticeGetsTheReportAndARetryAndTheAlertGetsTheText() {
        var shown: [FailureReport] = []
        var alerts: [String] = []
        var retried = 0
        RecorderNotice.outlets.notice = { report, retry in
            shown.append(report)
            retry?()
        }
        RecorderNotice.outlets.alert = { text, more in alerts.append("\(text) | \(more ?? "-")") }
        let failure = ToolsRunner.EarlyFailure(argv: ["recorder", "start"], status: 1, output: Self.output, logFile: "/tmp/x.log",
                                               logLine: 1)
        RecorderNotice.startFailed(failure, defaults: defaults) { retried += 1 }
        XCTAssertEqual(shown.count, 1)
        XCTAssertEqual(retried, 1, "the notice's Try again runs the same start")

        defaults.set("alert", forKey: RecorderFailureStyle.key)
        RecorderNotice.startFailed(failure, defaults: defaults) { retried += 1 }
        XCTAssertEqual(alerts.count, 1)
        XCTAssertTrue(alerts[0].hasPrefix("The camera was asked for, but it did not start"))
    }

    func testTheNoticeSettingsDefaultToOpenUnderTheItemAndNeverClosing() {
        XCTAssertEqual(RecorderFailureStyle.noticeOptions(defaults),
                       FailureNoticeOptions(detailsOpen: true, placement: .belowAnchor, autoClose: nil))
        defaults.set("folded", forKey: RecorderFailureDetails.key)
        defaults.set("center", forKey: RecorderFailureStyle.placementKey)
        defaults.set("1m", forKey: RecorderFailureAutoClose.key)
        XCTAssertEqual(RecorderFailureStyle.noticeOptions(defaults),
                       FailureNoticeOptions(detailsOpen: false, placement: .center, autoClose: 60))
        defaults.set("sideways", forKey: RecorderFailureStyle.placementKey)
        XCTAssertEqual(RecorderFailureStyle.noticeOptions(defaults).placement, .belowAnchor)
        XCTAssertEqual(RecorderFailureDetails.key, "recorder.failures.details")
        XCTAssertEqual(RecorderFailureAutoClose.key, "recorder.failures.autoClose")
        XCTAssertEqual(RecorderFailureStyle.placementKey, "recorder.failures.placement")
    }
}
