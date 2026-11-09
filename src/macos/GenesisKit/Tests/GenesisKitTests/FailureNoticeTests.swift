import AppKit
import Foundation
import XCTest
@testable import GenesisKit

/// The failure notice's logic: the headline taken from a command's raw output, the log read as events, and the two
/// markdown texts (the details the notice draws, the context an agent gets).
final class FailureNoticeTests: XCTestCase {
    /// A failed `tools recorder start`, as the recorder's start log holds it (2026-11-09, names made up).
    static let cameraFailure = """
    note: a window or app movie has no cursor track, so the editor draws no pointer, clicks or shortcuts; record --display or --region for those
    [recorder-video] the recording asks for the camera
        face: "held"
    [recorder-video] video recording starting
        id: "video-2026-11-09_12-50-46-c540ff72"
        folder: "/Users/alice/.genesis-tools/recordings/library/video-2026-11-09_12-50-46-c540ff72"
        target: {
          "kind": "window",
          "windowIds": [
            101344
          ]
        }
        fps: 60
    [live-recordings] live recording listening
        id: "recorder-6374-cc731feb"
        kind: "control-session"
    recording into /Users/alice/.genesis-tools/recordings/library/video-2026-11-09_12-50-46-c540ff72 (live id recorder-6374-cc731feb)
    WARN: [recorder-camera] the camera did not start
        folder: "/Users/alice/.genesis-tools/recordings/library/video-2026-11-09_12-50-46-c540ff72"
        error: {
          "type": "RpcError",
          "message": "the camera needs GenesisTools.app's recorder face connected to the recorder service as its host",
          "stack":
              RpcError: the camera needs GenesisTools.app's recorder face connected to the recorder service as its host
                  at camera.start (/Users/alice/Projects/GenesisTools/src/recorder/lib/host.ts:234:19)
                  at startRecordingCamera (/Users/alice/Projects/GenesisTools/src/recorder/lib/camera-recorder.ts:57:77)
                  at processTicksAndRejections (native:7:39)
          "code": 1019,
          "name": "RpcError"
        }
    error: The camera was asked for, but it did not start: the camera needs GenesisTools.app's recorder face connected to the recorder service as its host
    [recorder-video] video recording ended
        id: "video-2026-11-09_12-50-46-c540ff72"
        outcome: "failed"
    failed, nothing was recorded: The camera was asked for, but it did not start: the camera needs GenesisTools.app's recorder face connected to the recorder service as its host
    """

    // MARK: - Headline

    /// The defect: the notice's title read "The recording stopped at once (exit 1): {." because the first line that
    /// started with "error:" after trimming was the indented field `    error: {` of a WARN entry.
    func testTheHeadlineIsTheErrorSentenceNeverAnIndentedErrorField() {
        XCTAssertEqual(FailureLog.headline(in: Self.cameraFailure),
                       "The camera was asked for, but it did not start: the camera needs GenesisTools.app's recorder face connected to the recorder service as its host.")
    }

    func testTheHeadlineOfACommanderErrorSkipsTheHelpThatFollows() {
        let dump = """
        error: unknown command 'open'
        (Did you mean opened?)
        Usage: tools recorder [options] [command]

        Commands:
          help [command]             display help for command
        """
        XCTAssertEqual(FailureLog.headline(in: dump), "Unknown command 'open'.")
    }

    func testWithoutAnErrorLineTheHeadlineIsTheLastWarningThenTheLastLine() {
        XCTAssertEqual(FailureLog.headline(in: "[a] started\nWARN: [b] the disk is full\n    free: 0\n[a] ended"),
                       "The disk is full.")
        XCTAssertEqual(FailureLog.headline(in: "recording\nwindow 1 cannot record: it is gone\n"),
                       "Window 1 cannot record: it is gone.")
        XCTAssertEqual(FailureLog.headline(in: "Usage: tools recorder [options] [command]\n\nOptions:\n  -h, --help"),
                       "The command printed its usage instead of running.")
        XCTAssertNil(FailureLog.headline(in: "  \n"))
        XCTAssertNil(FailureLog.headline(in: "    error: {\n      \"a\": 1\n    }"), "an indented field alone names nothing")
    }

    // MARK: - Events

    func testTheLogReadsAsEventsWithLevelScopeAndFields() throws {
        let events = FailureLog.events(in: Self.cameraFailure)
        XCTAssertEqual(events.map(\.level), [.note, .info, .info, .info, .info, .warning, .error, .info, .error])
        XCTAssertEqual(events[1].scope, "recorder-video")
        XCTAssertEqual(events[1].message, "the recording asks for the camera")
        XCTAssertEqual(events[1].fields, [FailureLog.Field(name: "face", value: "\"held\"")])
        XCTAssertEqual(events[2].fields.map(\.name), ["id", "folder", "target", "fps"])
        XCTAssertEqual(events[2].fields[2].value, "{\n  \"kind\": \"window\",\n  \"windowIds\": [\n    101344\n  ]\n}")
        XCTAssertNil(events[4].scope)
        XCTAssertTrue(events[4].message.hasPrefix("recording into "))

        let warning = events[5]
        XCTAssertEqual(warning.scope, "recorder-camera")
        XCTAssertEqual(warning.message, "the camera did not start")
        XCTAssertEqual(warning.stack.count, 4, "the error line and its three frames")
        XCTAssertEqual(warning.stack[1], "at camera.start (/Users/alice/Projects/GenesisTools/src/recorder/lib/host.ts:234:19)")
        let error = try XCTUnwrap(warning.fields.first { $0.name == "error" })
        XCTAssertFalse(error.value.contains("stack"), "the stack is folded out of the JSON")
        XCTAssertTrue(error.value.contains("\"code\": 1019"))
    }

    // MARK: - Markdown

    func testTheDetailsPutTheErrorFirstWithItsJSONPrettyAndTheStackFolded() {
        let details = FailureReport(headline: FailureLog.headline(in: Self.cameraFailure) ?? "", log: Self.cameraFailure,
                                    time: Date(timeIntervalSince1970: 0)).detailsMarkdown()
        let warnings = details.range(of: "### Warnings (1)")
        let steps = details.range(of: "### Steps (9)")
        XCTAssertNotNil(warnings)
        XCTAssertNotNil(steps)
        XCTAssertTrue(details.hasPrefix("### Warnings"), "the headline above the details is the error; it is not repeated")
        XCTAssertLessThan(warnings!.lowerBound, steps!.lowerBound)
        XCTAssertTrue(details.contains("```json\n{\n"), "the error object is a pretty JSON block")
        XCTAssertTrue(details.contains("Stack: 3 frames, from `camera.start` at `src/recorder/lib/host.ts:234:19`"))
        XCTAssertFalse(details.contains("startRecordingCamera"), "only the first frame shows; the raw log has the rest")
        XCTAssertTrue(details.contains("`recorder-video` video recording starting"))
        XCTAssertTrue(details.contains("**target** `{\"kind\":\"window\",\"windowIds\":[101344]}`"),
                      "a step's JSON value is one compact line")
    }

    func testTheAgentContextNamesWhatRanWhereAndTheWholeLog() {
        var zone = Calendar(identifier: .gregorian)
        zone.timeZone = TimeZone(identifier: "Europe/Prague")!
        let time = zone.date(from: DateComponents(year: 2026, month: 11, day: 9, hour: 12, minute: 50, second: 46))!
        let report = FailureReport(
            headline: "The camera did not start.",
            summary: "Recording a window stopped at once (exit 1).",
            action: "Start a recording",
            command: "tools recorder start --window 101344 --camera",
            exitStatus: 1,
            folder: "/Users/alice/.genesis-tools/recordings/library/video-1",
            logFile: "/Users/alice/.genesis-tools/logs/recorder-start.log",
            dayLog: "/Users/alice/.genesis-tools/logs/2026-11-09.log",
            log: Self.cameraFailure,
            time: time,
            app: FailureAppFacts(name: "GenesisTools", version: "1.4", branch: "feat/x", commit: "d9695acca14929f8", dirty: true,
                                 checkout: "/Users/alice/Projects/GenesisTools"))
        let context = report.agentContext(timeZone: TimeZone(identifier: "Europe/Prague")!)
        XCTAssertTrue(context.hasPrefix("## GenesisTools failure: The camera did not start.\n"))
        XCTAssertTrue(context.contains("- **What ran:** Start a recording: `tools recorder start --window 101344 --camera`"))
        XCTAssertTrue(context.contains("- **Exit status:** 1"))
        XCTAssertTrue(context.contains("- **When:** 2026-11-09 12:50:46 CET"))
        XCTAssertTrue(context.contains("- **Recording folder:** `/Users/alice/.genesis-tools/recordings/library/video-1`"))
        XCTAssertTrue(context.contains("- **App:** GenesisTools 1.4, feat/x @ d9695acca149 (uncommitted changes), checkout `/Users/alice/Projects/GenesisTools`"))
        XCTAssertTrue(context.contains("- **This run's log:** `/Users/alice/.genesis-tools/logs/recorder-start.log`"))
        XCTAssertTrue(context.contains("- **Day log:** `/Users/alice/.genesis-tools/logs/2026-11-09.log`"))
        XCTAssertTrue(context.contains("```text\n" + Self.cameraFailure + "\n```"), "the whole output, unfolded, stack included")
    }

    func testTheWindowPlacesItselfInsideTheScreenForEveryPlacement() {
        let visible = CGRect(x: 0, y: 0, width: 1440, height: 875)
        let size = CGSize(width: 620, height: 500)
        let item = CGRect(x: 900, y: 875, width: 30, height: 25)
        XCTAssertEqual(FailureNoticePanel.origin(size: size, anchor: item, visible: visible, placement: .belowAnchor),
                       CGPoint(x: 605, y: 369))
        XCTAssertEqual(FailureNoticePanel.origin(size: size, anchor: nil, visible: visible, placement: .belowAnchor),
                       CGPoint(x: 808, y: 363), "no item on screen: the top right corner")
        XCTAssertEqual(FailureNoticePanel.origin(size: size, anchor: item, visible: visible, placement: .topRight),
                       CGPoint(x: 808, y: 363))
        XCTAssertEqual(FailureNoticePanel.origin(size: size, anchor: item, visible: visible, placement: .center),
                       CGPoint(x: 410, y: 200))
        let tall = CGSize(width: 620, height: 2000)
        XCTAssertEqual(FailureNoticePanel.origin(size: tall, anchor: item, visible: visible, placement: .belowAnchor).y + tall.height,
                       visible.maxY, "a window taller than the screen keeps its title bar on screen")
    }

    @MainActor
    func testEscapeClosesAndCommandCCopiesTheContextUnlessTextIsSelected() throws {
        let window = FailureNoticeWindow(contentRect: CGRect(x: -10000, y: -10000, width: 300, height: 200),
                                         styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        var cancelled = 0
        var copied = 0
        window.onCancel = { cancelled += 1 }
        window.onCopyContext = { copied += 1 }
        window.cancelOperation(nil)
        XCTAssertEqual(cancelled, 1)

        let commandC = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command, timestamp: 0,
                                                       windowNumber: window.windowNumber, context: nil, characters: "c",
                                                       charactersIgnoringModifiers: "c", isARepeat: false, keyCode: 8))
        XCTAssertTrue(window.performKeyEquivalent(with: commandC))
        XCTAssertEqual(copied, 1, "nothing selected: ⌘C copies the context for agents")

        let text = NSTextView(frame: CGRect(x: 0, y: 0, width: 200, height: 40))
        text.string = "selected words"
        window.contentView?.addSubview(text)
        window.makeFirstResponder(text)
        text.setSelectedRange(NSRange(location: 0, length: 8))
        let saved = NSPasteboard.general.string(forType: .string)
        defer {
            NSPasteboard.general.clearContents()
            if let saved { NSPasteboard.general.setString(saved, forType: .string) }
        }
        XCTAssertTrue(window.performKeyEquivalent(with: commandC))
        XCTAssertEqual(copied, 1, "a selection is copied as text, not as the context")
        XCTAssertEqual(NSPasteboard.general.string(forType: .string), "selected")
        window.close()
    }

    func testTheDayLogIsNamedByTheLocalDate() {
        let time = Date(timeIntervalSince1970: 1_762_689_600) // 2025-11-09 12:00 UTC
        XCTAssertEqual(FailureReport.dayLogPath(home: "/Users/alice", time: time, timeZone: TimeZone(identifier: "Europe/Prague")!),
                       "/Users/alice/.genesis-tools/logs/2025-11-09.log")
    }
}
