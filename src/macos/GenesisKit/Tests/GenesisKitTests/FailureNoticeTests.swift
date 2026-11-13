import AppKit
import Foundation
import SwiftUI
import Vision
import XCTest
@testable import GenesisKit

/// The failure notice's logic: the headline taken from a command's raw output, the log read as events, and the two
/// markdown texts (the details the notice draws, the context an agent gets).
final class FailureNoticeTests: XCTestCase {
    @MainActor
    func testTheRawTabKeepsTheRemoteStackWithoutPrintedOutput() {
        var report = FailureReport(title: "Recorder", headline: "The request failed.", log: "",
                                   stack: "Error: failed\n    at originalThrow (recorder.ts:4:2)")
        let model = FailureNoticeModel(report: report, detailsOpen: true, retry: nil, dismiss: {})
        XCTAssertTrue(model.rawMarkdown.contains("at originalThrow"))
        XCTAssertTrue(model.detailsOpen)
        report.stack = "Error: later detail\n    at updatedStack (recorder.ts:8:2)"
        model.report = report
        XCTAssertTrue(model.rawMarkdown.contains("at updatedStack"))
        XCTAssertFalse(model.rawMarkdown.contains("at originalThrow"))
    }
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

    @MainActor
    func testStacksAreCachedForTheDisclosureAndStackOnlyFailuresHaveDetails() {
        let stack = "Error: refused\n    at origin (/fixture/source.ts:12:3)"
        let report = FailureReport(headline: "Refused", stack: stack)
        XCTAssertTrue(report.hasLog)
        let model = FailureNoticeModel(report: report, detailsOpen: true, retry: nil, dismiss: {})
        XCTAssertTrue(model.detailsOpen)
        XCTAssertFalse(model.stackOpen)
        XCTAssertEqual(model.stackText, stack)
        model.report = FailureReport(headline: "The camera failed.", log: Self.cameraFailure)
        XCTAssertTrue(model.stackText?.contains("startRecordingCamera") == true)
        model.report = FailureReport(headline: "No stack", log: "error: refused")
        XCTAssertNil(model.stackText)
    }

    @MainActor
    func testDetailsOfferAFoldableStackTrace() throws {
        let report = FailureReport(headline: "The camera failed.", log: Self.cameraFailure)
        let model = FailureNoticeModel(report: report, detailsOpen: true, retry: nil, dismiss: {})
        let view = FailureNoticeView(model: model)
            .frame(width: 620, height: 700).background(Color(white: 0.1))
        let host = NSHostingView(rootView: view)
        host.frame = CGRect(x: 0, y: 0, width: 620, height: 700)
        host.layoutSubtreeIfNeeded()
        let image = try XCTUnwrap(HostedShot.bitmap(host)?.cgImage)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
        XCTAssertTrue(text.contains("Stack trace"), text)
        XCTAssertFalse(text.contains("startRecordingCamera"), "the full stack starts folded")
    }

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

    private func cameraReport(environment: FailureEnvironment?) -> FailureReport {
        var zone = Calendar(identifier: .gregorian)
        zone.timeZone = TimeZone(identifier: "Europe/Prague")!
        let time = zone.date(from: DateComponents(year: 2026, month: 11, day: 9, hour: 12, minute: 50, second: 46))!
        return FailureReport(
            title: "Recording failed",
            headline: "The camera did not start.",
            summary: "Recording a window stopped at once (exit 1).",
            action: "Start a recording",
            command: "tools recorder start --window 101344 --camera",
            exitStatus: 1,
            folder: "/Users/alice/.genesis-tools/recordings/library/video-1",
            logFile: "/Users/alice/.genesis-tools/logs/recorder-start.log",
            logLine: 812,
            dayLog: "/Users/alice/.genesis-tools/logs/2026-11-09.log",
            log: Self.cameraFailure,
            time: time,
            app: FailureAppFacts(name: "GenesisTools", version: "1.4", branch: "feat/x", commit: "d9695acca14929f8", dirty: true,
                                 checkout: "/Users/alice/Projects/GenesisTools"),
            expected: "The recording starts.",
            area: "recorder",
            environment: environment)
    }

    /// The bug form's fields as `tools genesis-tools env --json` reads them from .github/ISSUE_TEMPLATE/bug_report.yml.
    static let environmentJSON = #"""
    {"markdown":"- **Bun:** 1.3.13","issue":{"path":"/x/bug_report.yml","fields":[
      {"id":"checks","label":"Before you submit","type":"checkboxes","render":null},
      {"id":"what-happened","label":"What happened","type":"textarea","render":null},
      {"id":"steps","label":"Steps to reproduce","type":"textarea","render":null},
      {"id":"expected","label":"Expected","type":"textarea","render":null},
      {"id":"actual","label":"Actual (error + log)","type":"textarea","render":"shell"},
      {"id":"area","label":"Affected tool","type":"dropdown","render":null},
      {"id":"impact","label":"Impact","type":"dropdown","render":null},
      {"id":"commit","label":"GenesisTools commit and its age","type":"input","render":null},
      {"id":"app-build","label":"App build","type":"textarea","render":"shell"},
      {"id":"bun","label":"Bun version","type":"input","render":null},
      {"id":"privacy","label":"Privacy","type":"checkboxes","render":null}],
     "values":{"commit":"d9695acca149+dirty, 3 h old","app-build":"commit d9695acca149\nbuilt 2026-11-09 10:32 CET","bun":"1.3.13"}}}
    """#

    func testTheIssueBodyFollowsTheBugFormsSectionsInItsOrder() throws {
        let environment = try XCTUnwrap(FailureEnvironment.parse(json: Self.environmentJSON))
        let body = cameraReport(environment: environment).issueBody(timeZone: TimeZone(identifier: "Europe/Prague")!)
        let headings = body.split(separator: "\n").filter { $0.hasPrefix("### ") }.map(String.init)
        XCTAssertEqual(headings, ["### What happened", "### Steps to reproduce", "### Expected", "### Actual (error + log)",
                                  "### Affected tool", "### Impact", "### GenesisTools commit and its age", "### App build",
                                  "### Bun version"], "the form's order and names; its checkboxes are the poster's to tick")
        XCTAssertTrue(body.contains("### What happened\n\nRecording a window stopped at once (exit 1). The camera did not start.\n"))
        XCTAssertTrue(body.contains("1. Start a recording: `tools recorder start --window 101344 --camera`"))
        XCTAssertTrue(body.contains("### Expected\n\nThe recording starts.\n"))
        XCTAssertTrue(body.contains("### Actual (error + log)\n\n```shell\nerror: The camera did not start.\n"))
        XCTAssertTrue(body.contains("log: /Users/alice/.genesis-tools/logs/recorder-start.log (from line 812)"))
        XCTAssertTrue(body.contains("time: 2026-11-09 12:50:46 CET"))
        XCTAssertTrue(body.contains(Self.cameraFailure + "\n```"), "the whole output, stack included, in the shell block")
        XCTAssertTrue(body.contains("### Affected tool\n\nrecorder\n"))
        XCTAssertTrue(body.contains("### GenesisTools commit and its age\n\nd9695acca149+dirty, 3 h old\n"))
        XCTAssertTrue(body.contains("### App build\n\n```shell\ncommit d9695acca149\nbuilt 2026-11-09 10:32 CET\n```"))
        XCTAssertTrue(body.contains("### Bun version\n\n1.3.13"))
    }

    func testWithoutTheFormTheBodyHasTheFiveSectionsAndTheAppsOwnFacts() {
        let body = cameraReport(environment: nil).issueBody(timeZone: TimeZone(identifier: "Europe/Prague")!)
        let headings = body.split(separator: "\n").filter { $0.hasPrefix("### ") }.map(String.init)
        XCTAssertEqual(headings, ["### What happened", "### Steps to reproduce", "### Expected", "### Actual (error + log)",
                                  "### Environment"])
        XCTAssertTrue(body.contains("- **App:** GenesisTools 1.4, feat/x @ d9695acca149 (uncommitted changes), checkout `/Users/alice/Projects/GenesisTools`"))
    }

    func testTheAgentContextIsTheIssueBodyUnderAHeadingWithTheRecordingFolder() throws {
        let environment = try XCTUnwrap(FailureEnvironment.parse(json: Self.environmentJSON))
        let report = cameraReport(environment: environment)
        let zone = TimeZone(identifier: "Europe/Prague")!
        let context = report.agentContext(timeZone: zone)
        XCTAssertTrue(context.hasPrefix("## GenesisTools failure: The camera did not start.\n"))
        XCTAssertTrue(context.contains(report.issueBody(timeZone: zone)))
        XCTAssertTrue(context.contains("folder: /Users/alice/.genesis-tools/recordings/library/video-1"))
        XCTAssertTrue(context.contains("- **Bun:** 1.3.13"), "the environment's own bullets too")
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

    func testAFittedPanelThatGrowsPastTheBottomMovesBackOntoTheScreen() {
        let visible = CGRect(x: 0, y: 40, width: 1440, height: 835)
        let grown = CGRect(x: 600, y: -200, width: 620, height: 600)
        XCTAssertEqual(FailureNoticePanel.keptOnScreen(grown, visible: visible), CGRect(x: 600, y: 48, width: 620, height: 600),
                       "the details opened below the bottom edge: the panel moves up to the margin")
        let inside = CGRect(x: 600, y: 200, width: 620, height: 400)
        XCTAssertEqual(FailureNoticePanel.keptOnScreen(inside, visible: visible), inside, "a panel on screen keeps its place")
        let tall = CGRect(x: 600, y: -500, width: 620, height: 1200)
        XCTAssertEqual(FailureNoticePanel.keptOnScreen(tall, visible: visible).maxY, visible.maxY,
                       "a panel taller than the screen keeps its top edge on screen")
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

/// "Draft an issue": the title it starts from, the `tools github issues post` call, its answer, and the window's states.
@MainActor
final class IssueDraftTests: XCTestCase {
    private struct FakePoster: IssuePosting {
        var result: Result<IssuePostResult, IssuePostError>
        var browser: String? = "Brave Browser"
        func post(_ draft: IssueDraft) async -> Result<IssuePostResult, IssuePostError> { result }
        func browserName(for url: String) async -> String? { browser }
    }

    func testTheTitleIsTheFailureCutAtAWordBoundary() {
        let report = FailureReport(title: "Recording failed", headline: "The camera did not start.")
        XCTAssertEqual(IssueDraft.defaultTitle(for: report), "Recording failed: The camera did not start")
        let long = FailureReport(title: "Recording failed", headline: String(repeating: "word ", count: 60))
        let title = IssueDraft.defaultTitle(for: long)
        XCTAssertLessThanOrEqual(title.count, 121)
        XCTAssertTrue(title.hasSuffix("…"))
        XCTAssertFalse(title.dropLast().hasSuffix(" "))
    }

    func testThePostRunsTheGitHubCommandWithTheBodyFile() {
        let draft = IssueDraft(repo: "shop/storefront", title: "T", body: "B", redact: true, labels: ["bug"])
        XCTAssertEqual(ToolsIssuePoster.arguments(draft, bodyFile: "/tmp/body.md", dryRun: false),
                       ["issue", "post", "--repo", "shop/storefront", "--title", "T", "--body-file", "/tmp/body.md",
                        "--json", "--redact", "--label", "bug"])
        let plain = IssueDraft(repo: "shop/storefront", title: "T", body: "B", redact: false)
        XCTAssertEqual(ToolsIssuePoster.arguments(plain, bodyFile: "/tmp/b.md", dryRun: true).suffix(2), ["--json", "--dry-run"])
    }

    func testTheCommandsAnswerIsReadBack() {
        let posted = ToolsIssuePoster.parse(exitCode: 0, stdout: #"{"posted":true,"number":42,"url":"https://github.com/shop/storefront/issues/42","title":"T","body":"B","replaced":{"paths":2,"emails":1,"markers":0}}"#, stderr: "")
        XCTAssertEqual(try posted.get(), IssuePostResult(posted: true, number: 42, url: "https://github.com/shop/storefront/issues/42",
                                                         replaced: 3))
        let dry = ToolsIssuePoster.parse(exitCode: 0, stdout: #"{"posted":false,"number":null,"url":null,"replaced":{}}"#, stderr: "")
        XCTAssertEqual(try dry.get(), IssuePostResult(posted: false, number: nil, url: nil, replaced: 0))
        let failed = ToolsIssuePoster.parse(exitCode: 1, stdout: "", stderr: "noise\nError: Not Found\n")
        XCTAssertEqual(failed, .failure(IssuePostError(message: "Not Found")))
        XCTAssertEqual(ToolsIssuePoster.browserName(fromJSON: #"{"defaultBrowser":{"name":"GenesisTools"},"defaultBrowserEffective":{"name":"Brave Browser"}}"#),
                       "Brave Browser")
        XCTAssertNil(ToolsIssuePoster.browserName(fromJSON: #"{"defaultBrowserEffective":null}"#))
    }

    /// `ISSUE_DRAFT_SHOTS=<folder>` writes the draft window in each state as a PNG (no window comes to the front).
    func testDrawsTheDraftWindowInEachStateWhenAskedForShots() throws {
        guard let folder = ProcessInfo.processInfo.environment["ISSUE_DRAFT_SHOTS"] else {
            throw XCTSkip("ISSUE_DRAFT_SHOTS is not set")
        }
        let report = FailureReport(title: "Recording failed", headline: "The camera was asked for, but it did not start.",
                                   summary: "Recording a window stopped at once (exit 1).", action: "Start a recording",
                                   command: "tools recorder start --window 101344 --camera", exitStatus: 1,
                                   folder: "/Users/alice/.genesis-tools/recordings/library/video-1",
                                   logFile: "/Users/alice/.genesis-tools/logs/recorder-start.log", logLine: 812,
                                   dayLog: "/Users/alice/.genesis-tools/logs/2026-11-09.log",
                                   log: FailureNoticeTests.cameraFailure,
                                   app: FailureAppFacts(name: "GenesisTools", version: "1.0", branch: "feat/x", commit: "d9695acca14929f8"),
                                   expected: "The recording starts, and its controls and the red menu bar item appear.",
                                   area: "recorder", environment: FailureEnvironment.parse(json: FailureNoticeTests.environmentJSON))
        let opened = IssueDraft.failure(report, repo: "genesiscz/GenesisTools")
        var edited = opened
        edited.title = "Recorder: the camera does not start from the menu bar"
        edited.body = edited.body.replacingOccurrences(of: "/Users/alice", with: "~")
        let ok = IssuePostResult(posted: true, number: 812, url: "https://github.com/genesiscz/GenesisTools/issues/812", replaced: 14)
        let poster = FakePoster(result: .success(ok))
        let states: [(String, IssueDraft, IssueDraftModel.State)] = [
            ("empty", IssueDraft(repo: "genesiscz/GenesisTools", title: "", body: ""), .editing),
            ("opened", opened, .editing),
            ("edited", edited, .editing),
            ("posting", edited, .posting),
            ("posted", edited, .posted(ok)),
            ("error", edited, .failed("Resource not accessible by integration (HTTP 403): the token cannot open issues in genesiscz/GenesisTools")),
        ]
        for (name, draft, state) in states {
            let model = IssueDraftModel(draft: draft, poster: poster, state: state, browserName: "Brave Browser")
            let view = IssueDraftView(model: model, close: {}).background(Color(white: 0.16)).environment(\.colorScheme, .dark)
            try HostedShot.write(view, size: CGSize(width: 880, height: 620), settle: 0.6,
                                 to: URL(fileURLWithPath: folder).appendingPathComponent("issue-draft-\(name).png"))
        }
    }

    func testPostingGoesThroughPostingToPostedOrToTheErrorAndBack() async {
        let ok = IssuePostResult(posted: true, number: 7, url: "https://github.com/shop/storefront/issues/7", replaced: 0)
        let model = IssueDraftModel(draft: IssueDraft(repo: "shop/storefront", title: "T", body: "B"),
                                    poster: FakePoster(result: .success(ok)))
        XCTAssertEqual(model.state, .editing)
        await model.post()
        XCTAssertEqual(model.state, .posted(ok))
        XCTAssertEqual(model.browserName, "Brave Browser")

        let failing = IssueDraftModel(draft: IssueDraft(repo: "shop/storefront", title: "T", body: "B"),
                                      poster: FakePoster(result: .failure(IssuePostError(message: "Not Found"))))
        await failing.post()
        XCTAssertEqual(failing.state, .failed("Not Found"))
        XCTAssertEqual(failing.draft.body, "B", "a failed post keeps what the person wrote")

        let empty = IssueDraftModel(draft: IssueDraft(repo: "shop/storefront", title: "  ", body: "B"),
                                    poster: FakePoster(result: .success(ok)))
        XCTAssertFalse(empty.canPost)
    }

    private final class CountingPoster: IssuePosting, @unchecked Sendable {
        let result: Result<IssuePostResult, IssuePostError>
        private(set) var posts = 0
        init(result: Result<IssuePostResult, IssuePostError>) { self.result = result }
        func post(_ draft: IssueDraft) async -> Result<IssuePostResult, IssuePostError> {
            posts += 1
            return result
        }
        func browserName(for url: String) async -> String? { nil }
    }

    func testAPostedDraftIsNeverPostedASecondTime() async {
        let ok = IssuePostResult(posted: true, number: 7, url: "https://github.com/shop/storefront/issues/7", replaced: 0)
        let poster = CountingPoster(result: .success(ok))
        let model = IssueDraftModel(draft: IssueDraft(repo: "shop/storefront", title: "T", body: "B"), poster: poster)
        await model.post()
        XCTAssertFalse(model.canPost, "a posted draft is done")
        await model.post()
        XCTAssertEqual(poster.posts, 1, "a second post() after success must not open a second issue")
        XCTAssertEqual(model.state, .posted(ok))

        let failing = CountingPoster(result: .failure(IssuePostError(message: "Not Found")))
        let retry = IssueDraftModel(draft: IssueDraft(repo: "shop/storefront", title: "T", body: "B"), poster: failing)
        await retry.post()
        XCTAssertTrue(retry.canPost, "a failed post can be tried again")
        await retry.post()
        XCTAssertEqual(failing.posts, 2)
    }

}

/// A failed `tools` call as a report (`FailureReport.toolsCall`), the call ledger, the details' log and the inline view.
final class FailureInlineTests: XCTestCase {

    private static func call(_ argv: [String], via: String?, exit: Int32? = nil, stderr: String? = nil, seconds: Double = 31.2)
        -> ToolsCallLedger.Call {
        let started = Date(timeIntervalSince1970: 1_800_000_000)
        return ToolsCallLedger.Call(traceId: "297f7e79", argv: argv, started: started, via: via, exit: exit, stderr: stderr,
                                    ended: started.addingTimeInterval(seconds))
    }

    private static let tailArgv = ["ai", "sessions", "tail", "a1523c66-0000-4000-8000-000000000000", "--json", "--limit", "12"]

    func testATimeoutSaysWhatDidNotLoadWhatRanAndThatTheMacMayBeBusy() {
        let report = FailureReport.toolsCall(ToolsBridgeError.timeout(seconds: 30), outcome: "The transcript did not load",
                                             action: "Open the session's transcript",
                                             call: Self.call(Self.tailArgv, via: "server-timeout", exit: -1), area: "hub",
                                             home: "/Users/alice")
        XCTAssertEqual(report.headline, "The transcript did not load: the tools call did not answer in 30 s.")
        XCTAssertEqual(report.summary, "`ai sessions tail` did not answer in 30 s (the hub server held it the whole time).")
        XCTAssertEqual(report.command, "tools ai sessions tail a1523c66-0000-4000-8000-000000000000 --json --limit 12")
        XCTAssertNil(report.exitStatus, "a killed call has no exit status worth showing")
        XCTAssertTrue(report.nextStep?.contains("busy") == true)
        XCTAssertTrue(report.dayLog?.hasPrefix("/Users/alice/.genesis-tools/logs/") == true)
        XCTAssertTrue(report.agentContext().contains("trace: t=297f7e79 (via server-timeout)"))
    }

    func testAFailedExitTakesItsHeadlineFromStderrAndKeepsTheStatus() {
        let stderr = "[ai-sessions] reading the session\nerror: the session file is gone\n"
        let report = FailureReport.toolsCall(
            ToolsBridgeError.refused("tools ai sessions tail: the session file is gone"), outcome: "The transcript did not load",
            action: "Open the session's transcript", call: Self.call(Self.tailArgv, via: "process", exit: 1, stderr: stderr, seconds: 0.4))
        XCTAssertEqual(report.headline, "The transcript did not load: the session file is gone.")
        XCTAssertEqual(report.summary, "`ai sessions tail` ended with exit 1.")
        XCTAssertEqual(report.exitStatus, 1)
    }

    func testAMissingBinaryNamesTheInstallStepAndAKilledRunnerCallIsATimeout() {
        let missing = FailureReport.toolsCall(ToolsBridgeError.binaryNotFound("/nonexistent"), outcome: "The agents did not load",
                                              action: "List the agents", argv: ["hub", "agents", "--json"])
        XCTAssertEqual(missing.headline, "The agents did not load: the tools command is not installed where the app looks for it.")
        XCTAssertEqual(missing.summary, "No tools command at /nonexistent.")
        XCTAssertTrue(missing.nextStep?.contains("./install.sh") == true)

        struct RunnerError: Error {}
        let killed = FailureReport.toolsCall(RunnerError(), outcome: "The activity did not load", action: "Read the activity feed",
                                             call: Self.call(["hub", "timeline", "--json"], via: "process-timeout", exit: -1, seconds: 60))
        XCTAssertEqual(killed.headline, "The activity did not load: the tools call did not answer in 60 s.")
    }

    func testAClauseLowersASentenceStartButNeverAName() {
        XCTAssertEqual(ToolsCallCause.lowered("The session file is gone."), "the session file is gone")
        XCTAssertEqual(ToolsCallCause.lowered("GitHub answered 502"), "GitHub answered 502")
        XCTAssertEqual(ToolsCallCause.lowered("PR 12 is closed"), "PR 12 is closed")
    }

    func testTheLogHoldsTheTraceAndTheCallsOfTheMinuteBeforeAcrossMidnight() {
        let utc = TimeZone(identifier: "UTC")!
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = utc
        let to = calendar.date(from: DateComponents(year: 2026, month: 11, day: 10, hour: 0, minute: 0, second: 20))!
        let text = """
        [23:58:40.000] mark call t=aaaaaaaa via=server pid=1 ms=5 exit=0 out=1B start=23:58:39.995 argv=too old
        [23:59:30.000] mark call t=bbbbbbbb via=server pid=1 ms=900 exit=0 out=1B start=23:59:29.100 argv=hub agents
        [23:59:31.000] hub.sessions.list 12.0ms
        [00:00:18.000] mark tools.ai.sessions.tail TIMEOUT after 30s (the hub server did not answer; no process started)
        [00:00:18.100] mark call t=297f7e79 via=server-timeout pid=1 ms=31207 exit=-1 out=0B start=23:59:46.893 argv=ai sessions tail
        [00:05:00.000] mark call t=cccccccc via=server pid=1 ms=5 exit=0 out=1B start=00:04:59.995 argv=too new
        """
        let log = ToolsCallLog.select(text, traceId: "297f7e79", from: to.addingTimeInterval(-91), to: to, timeZone: utc)
        XCTAssertEqual(log.lines.count, 2, log.lines.joined(separator: "\n"))
        XCTAssertTrue(log.lines[0].contains("t=bbbbbbbb"), "a call that ended in the minute before, across midnight")
        XCTAssertTrue(log.lines[1].contains("t=297f7e79"))
        XCTAssertEqual(log.traceLine, 5, "the trace's own call line, 1-based")
    }

    func testAddingTheCallLogReadsTheFileAndPointsOpenLogAtTheCallsLine() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("failure-log-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let stamp = DateFormatter()
        stamp.dateFormat = "HH:mm:ss.SSS"
        stamp.locale = Locale(identifier: "en_US_POSIX")
        let now = Date()
        let lines = (0..<40).map { "[\(stamp.string(from: now.addingTimeInterval(-600))) ] filler \($0)" } + [
            "[\(stamp.string(from: now.addingTimeInterval(-20)))] mark call t=11111111 via=server pid=1 ms=4000 exit=0 out=1B start=x argv=hub prs",
            "[\(stamp.string(from: now))] mark call t=297f7e79 via=server-timeout pid=1 ms=31207 exit=-1 out=0B start=x argv=ai sessions tail",
        ]
        let file = folder.appendingPathComponent("app-perf.log")
        try (lines.joined(separator: "\n") + "\n").write(to: file, atomically: true, encoding: .utf8)
        var call = Self.call(Self.tailArgv, via: "server-timeout", exit: -1)
        call.started = now.addingTimeInterval(-31)
        call.ended = now
        let report = await FailureReport.toolsCall(ToolsBridgeError.timeout(seconds: 30), outcome: "The transcript did not load",
                                                   action: "Open the session's transcript", call: call, time: now)
            .addingCallLog(perfLog: file)
        XCTAssertEqual(report.logFile, file.path)
        XCTAssertEqual(report.logLine, 42)
        XCTAssertTrue(report.log.hasPrefix("error: The transcript did not load"))
        XCTAssertTrue(report.log.contains("t=11111111"), "the slow call 20 s before is in the details")
        XCTAssertFalse(report.log.contains("filler"))
    }

    func testTheLedgerNamesTheCallThatFailedEvenWhenTheBinaryIsMissing() async {
        let ledger = ToolsCallLedger()
        let bridge = ToolsBridge(binaryPath: "/nonexistent/tools", server: nil)
        do {
            _ = try await ledger.record { try await bridge.run(subcommand: "ai", args: ["sessions", "tail", "x", "--json"]) }
            XCTFail("a missing binary throws")
        } catch {
            XCTAssertEqual(error as? ToolsBridgeError, .binaryNotFound("/nonexistent/tools"))
        }
        XCTAssertEqual(ledger.failed?.argv, ["ai", "sessions", "tail", "x", "--json"])
        XCTAssertEqual(ledger.failed?.traceId.count, 8)
        let outside = ToolsCallLedger()
        _ = try? await bridge.run(subcommand: "ai", args: ["usage"])
        XCTAssertTrue(outside.calls.isEmpty, "a call outside `record` is not noted")
    }

    func testFailureIsPreparedAndPersistedBeforeDetailsAndReusesItsSnapshotAfterRestart() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("failure-capture-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let began = expectation(description: "triage starts at the error, without Details")
        let probe = FailureCaptureProbe()
        FailureCapture.enable(directory: directory, environment: {
            let number = probe.next()
            began.fulfill()
            return FailureEnvironment(markdown: "snapshot \(number)")
        }, enrich: { $0 })
        defer { FailureCapture.disable() }
        let report = FailureReport.unexpected("fixture error", outcome: "The fixture did not load", action: "Read fixture",
                                              time: Date(timeIntervalSince1970: 1000), home: directory.path)
        let fix = await NoticeFix.details(report)
        await MainActor.run { fix.preparation?() } // the notice appears; no Details action is pressed
        var redraw = report
        redraw.time = Date(timeIntervalSince1970: 1001)
        let redrawnFix = await NoticeFix.details(redraw)
        XCTAssertEqual(fix.id, redrawnFix.id, "a parent redraw retains the visible notice's first prepared report")
        await fulfillment(of: [began], timeout: 2)
        let prepared = await FailureCapture.prepared(report)
        XCTAssertTrue(prepared.environment?.markdown.hasSuffix("snapshot 1") == true)
        XCTAssertEqual(probe.count, 1)

        let reopened = FailureCaptureStore(directory: directory, environment: {
            XCTFail("Details must reuse the event snapshot, including after a restart")
            return nil
        }, enrich: { $0 })
        let reopenedRecord = await reopened.read(report)
        let stored = try XCTUnwrap(reopenedRecord)
        XCTAssertEqual(stored.version, 1)
        XCTAssertEqual(stored.report.time, report.time)
        XCTAssertEqual(FailureCaptureStore.key(stored.report), FailureCaptureStore.key(report))
        XCTAssertNotNil(stored.contextCapturedAt)
        let reread = await reopened.prepared(report)
        XCTAssertTrue(reread.environment?.markdown.hasSuffix("snapshot 1") == true)
        let bytes = try Data(contentsOf: reopened.file(for: report))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        XCTAssertEqual(object["version"] as? Int, 1)
        XCTAssertNotNil(object["contextCapturedAt"])
    }

    func testLaterFailuresGetFreshContextAndOldArchivesKeepTheirOriginalEventTime() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("failure-capture-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let probe = FailureCaptureProbe()
        let store = FailureCaptureStore(directory: directory, environment: {
            FailureEnvironment(markdown: "snapshot \(probe.next())")
        }, enrich: { $0 })
        let first = FailureReport(headline: "First", time: Date(timeIntervalSince1970: 1000))
        let second = FailureReport(headline: "First", time: Date(timeIntervalSince1970: 2000))
        let a = await store.prepared(first)
        let b = await store.prepared(second)
        XCTAssertTrue(a.environment?.markdown.hasSuffix("snapshot 1") == true)
        XCTAssertTrue(b.environment?.markdown.hasSuffix("snapshot 2") == true)

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let old = FailureReport(headline: "Older failure", time: Date(timeIntervalSince1970: 500))
        let oldObject = try JSONSerialization.jsonObject(with: encoder.encode(old))
        let oldFile = store.file(for: old)
        try JSONSerialization.data(withJSONObject: ["report": oldObject]).write(to: oldFile)
        let oldArchive = await store.read(old)
        let oldRecord = try XCTUnwrap(oldArchive)
        XCTAssertEqual(oldRecord.version, 1)
        XCTAssertEqual(oldRecord.recordedAt, old.time)
        XCTAssertNil(oldRecord.contextCapturedAt)
        let prepared = await store.prepared(old)
        XCTAssertEqual(prepared.time, old.time)
        let currentArchive = await store.read(old)
        let current = try XCTUnwrap(currentArchive)
        XCTAssertGreaterThan(try XCTUnwrap(current.contextCapturedAt), old.time)
    }

    func testCallsWithoutALedgerReachFailureCaptureButTriageFailuresCannotRecurse() {
        let probe = FailureCaptureProbe()
        ToolsCallTrace.observeFailures { _ in _ = probe.next() }
        defer { ToolsCallTrace.observeFailures(nil) }
        ToolsCallTrace.record(traceId: "fixture-1", via: "process", argv: ["fixture", "read"], started: Date(),
                              exit: 1, outBytes: 0, stderr: "failed")
        XCTAssertEqual(probe.count, 1)
        for command in ["triage", "env"] {
            ToolsCallTrace.record(traceId: "fixture-2", via: "process", argv: ["genesis-tools", command], started: Date(),
                                  exit: 1, outBytes: 0, stderr: "failed")
        }
        XCTAssertEqual(probe.count, 1)
    }

    func testPersistedFailureDoesNotRepeatACredentialFromItsCall() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("failure-capture-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FailureCaptureStore(directory: directory, environment: { nil }, enrich: { $0 })
        let call = ToolsCallLedger.Call(traceId: "fixture-secret", argv: ["fixture", "--token", "invented-secret"],
                                        started: Date(), via: "process", exit: 1, stderr: "rejected invented-secret")
        let report = FailureReport(headline: "rejected invented-secret", log: "rejected invented-secret", call: call)
        _ = await store.prepared(report)
        let text = try String(contentsOf: store.file(for: report), encoding: .utf8)
        XCTAssertFalse(text.contains("invented-secret"))
        XCTAssertTrue(text.contains("***"))
    }

    // MARK: - The inline view

    @MainActor
    func testTheInlineFailureShowsTheHeadlineWhatRanAndItsThreeActions() throws {
        let report = FailureReport.toolsCall(ToolsBridgeError.timeout(seconds: 30), outcome: "The transcript did not load",
                                             action: "Open the session's transcript", call: Self.call(Self.tailArgv, via: "server-timeout"))
        let reporter = FailureReporter()
        for form in [FailureInline.Form.pane, .compact] {
            let view = FailureInline(report, form: form, reporter: reporter, retry: {})
                .frame(width: 560, height: form == .pane ? 320 : 90)
                .background(Color(white: 0.1))
                .environment(\.colorScheme, .dark)
            let host = NSHostingView(rootView: view)
            host.frame = CGRect(x: 0, y: 0, width: 560, height: form == .pane ? 320 : 90)
            host.layoutSubtreeIfNeeded()
            let image = try XCTUnwrap(HostedShot.bitmap(host)?.cgImage)
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = false
            try VNImageRequestHandler(cgImage: image).perform([request])
            let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
            for word in ["transcript did not load", "Try again", "Details", "Report a bug"] {
                XCTAssertTrue(text.contains(word), "\(form): \(word) in \(text)")
            }
            XCTAssertFalse(text.contains("exceeded"), "never the raw error words")
        }
    }

    /// `FAILURE_INLINE_SHOTS=<folder>` writes the failure window a Details press opens on a timed-out transcript read,
    /// with its log of the calls of the minute before (made-up lines), as a PNG.
    @MainActor
    func testWritesTheFailureWindowOfATimedOutCall() async throws {
        guard let folder = ProcessInfo.processInfo.environment["FAILURE_INLINE_SHOTS"] else {
            throw XCTSkip("FAILURE_INLINE_SHOTS is not set")
        }
        let stamp = DateFormatter()
        stamp.dateFormat = "HH:mm:ss.SSS"
        stamp.locale = Locale(identifier: "en_US_POSIX")
        let now = Date()
        func at(_ seconds: Double) -> String { stamp.string(from: now.addingTimeInterval(seconds)) }
        let lines = [
            "[\(at(-52))] mark call t=4b1d0a17 via=server pid=4242 ms=212 exit=0 out=18211B start=\(at(-52.2)) argv=hub agents --json",
            "[\(at(-40))] mark call t=9c3e55f0 via=server pid=4242 ms=11840 exit=0 out=242922B start=\(at(-51.8)) argv=ai usage sessions --json --hours 72",
            "[\(at(-12))] mark call t=0e7710aa via=process pid=4242 ms=8190 exit=0 out=5120B start=\(at(-20.2)) argv=hub pr threads acme/storefront#4182 --json",
            "[\(at(0))] mark call t=297f7e79 via=server-timeout pid=4242 ms=31207 exit=-1 out=0B start=\(at(-31.2)) argv=ai sessions tail 5ca1ab1e --json --limit 12",
        ]
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("failure-shot-\(UUID().uuidString).log")
        try (lines.joined(separator: "\n") + "\n").write(to: file, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: file) }
        var call = Self.call(["ai", "sessions", "tail", "5ca1ab1e", "--json", "--limit", "12"], via: "server-timeout", exit: -1)
        call.started = now.addingTimeInterval(-31.2)
        call.ended = now
        var report = await FailureReport.toolsCall(ToolsBridgeError.timeout(seconds: 30), outcome: "The transcript did not load",
                                                   action: "Open the session's transcript", call: call, title: "Transcript did not load",
                                                   area: "hub", time: now, home: "/Users/alice")
            .addingCallLog(perfLog: file)
        report.logFile = "/Users/alice/.genesis-tools/logs/app-perf.log"
        let model = FailureNoticeModel(report: report, detailsOpen: true, detailsCap: 300, retry: {}, dismiss: {})
        model.draftIssue = {}
        let view = FailureNoticeView(model: model).background(Color(white: 0.16)).environment(\.colorScheme, .dark)
        try HostedShot.write(view, size: CGSize(width: 620, height: 560), settle: 0.6,
                             to: URL(fileURLWithPath: folder).appendingPathComponent("failure-window-timeout.png"))
    }

    @MainActor
    func testWithoutAnIssueTargetTheReportButtonIsGoneAndDetailsGoesToTheReporter() {
        let reporter = FailureReporter()
        reporter.issueTarget = { nil }
        var opened: [String] = []
        reporter.onOpen = { what, _ in opened.append(what) }
        reporter.reportBug(FailureReport(headline: "x"))
        XCTAssertEqual(opened, ["issue"])
        XCTAssertNil(reporter.issueTarget())
    }
}

private final class FailureCaptureProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    var count: Int { lock.withLock { value } }
    func next() -> Int { lock.withLock { value += 1; return value } }
}

/// What an issue and an agent get beyond the log: the issue title the thrower named, the Impact checkboxes, the stack,
/// and every home path as `~`.
final class FailureIssueTests: XCTestCase {
    private let stack = """
    RpcError: I14 lasts 00:50, longer than the 30 s a Moment plays.
        at unplayable (/Users/alice/GenesisTools/src/meetings/lib/service/moment-handlers.ts:134:12)
        at clipMomentCall (/Users/alice/GenesisTools/src/meetings/lib/service/moment-handlers.ts:125:19)
    """

    private func moment(issue: FailureIssue?) -> FailureReport {
        FailureReport(title: "A Meetings read failed", headline: "I14 lasts 00:50, longer than the 30 s a Moment plays.",
                      command: "meetings service moment.clip {\"meeting\":\"m1\"}", log: "The Meetings service refused it",
                      area: "meetings", stack: stack, issue: issue)
    }

    func testTheIssueTitleIsTheToolInBracketsAndTheThrowersTitle() {
        XCTAssertEqual(IssueDraft.defaultTitle(for: moment(issue: FailureIssue(tool: "meetings", title: "A Moment does not play (too-long)"))),
                       "[meetings] A Moment does not play (too-long)")
        XCTAssertEqual(IssueDraft.defaultTitle(for: moment(issue: nil)),
                       "[meetings] I14 lasts 00:50, longer than the 30 s a Moment plays", "no title: the headline, the area as the tool")
    }

    func testTheIssueOfAnErrorReplyNeedsATool() {
        XCTAssertEqual(FailureIssue(json: ["tool": "meetings", "title": " A title "]), FailureIssue(tool: "meetings", title: "A title"))
        XCTAssertEqual(FailureIssue(json: ["tool": "meetings", "title": ""]), FailureIssue(tool: "meetings"))
        XCTAssertNil(FailureIssue(json: ["title": "x"]))
        XCTAssertNil(FailureIssue(json: nil))
    }

    func testImpactIsAChecklistToTick() throws {
        let environment = try XCTUnwrap(FailureEnvironment.parse(json: FailureNoticeTests.environmentJSON))
        var report = moment(issue: nil)
        report.environment = environment
        XCTAssertTrue(report.issueBody().contains("""
        ### Impact

        - [ ] Blocks my work completely
        - [ ] Frequent failure or major degradation
        - [ ] Occasional failure
        - [ ] Cosmetic
        """))
    }

    func testTheStackIsFoldedInTheSummaryAndWholeInTheRawLogTheIssueAndTheContext() {
        let report = moment(issue: nil)
        XCTAssertTrue(report.detailsMarkdown().hasPrefix("### Stack\n\nStack: 2 frames, from `unplayable` at `src/meetings/lib/service/moment-handlers.ts:134:12`"))
        let raw = report.rawText()
        XCTAssertTrue(raw.contains("command: meetings service moment.clip {\"meeting\":\"m1\"}"))
        XCTAssertTrue(raw.contains("stack:\nRpcError: I14 lasts"))
        XCTAssertTrue(raw.contains("at clipMomentCall ("))
        XCTAssertTrue(report.issueBody().contains("at clipMomentCall ("))
        XCTAssertTrue(report.agentContext().contains("- **Command:** `meetings service moment.clip {\"meeting\":\"m1\"}`"))
    }

    func testEveryHomePathInTheReportTextIsShortened() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let report = FailureReport(headline: "It failed.", dayLog: home + "/.genesis-tools/logs/2026-11-11.log", log: "read \(home)/a.txt")
        for text in [report.rawText(), report.agentContext(), report.issueBody()] {
            XCTAssertFalse(text.contains(home + "/"), text)
            XCTAssertTrue(text.contains("day log: ~/.genesis-tools/logs/2026-11-11.log"), text)
        }
    }

    func testShortenHomeCoversMacLinuxAndWindows() {
        XCTAssertEqual(PathDisplay.shortenHome(in: "at f (/Users/alice/src/a.ts:3:9) and /Users/alice", home: "/Users/alice"),
                       "at f (~/src/a.ts:3:9) and ~")
        XCTAssertEqual(PathDisplay.shortenHome(in: "open /home/alice/notes.md", home: "/home/alice"), "open ~/notes.md")
        XCTAssertEqual(PathDisplay.shortenHome(in: "read /root/.bashrc", home: "/root"), "read ~/.bashrc")
        XCTAssertEqual(PathDisplay.shortenHome(in: #"at C:\Users\alice\src\a.ts"#, home: #"C:\Users\alice"#), #"at ~\src\a.ts"#)
        XCTAssertEqual(PathDisplay.shortenHome(in: "at d:/users/Alice/src/a.ts", home: #"C:\Users\alice"#), "at ~/src/a.ts")
        XCTAssertEqual(PathDisplay.shortenHome(in: "/Users/alice2/a /data/Users/alice/b /Users/bob/c", home: "/Users/alice"),
                       "/Users/alice2/a /data/Users/alice/b /Users/bob/c")
    }
}
