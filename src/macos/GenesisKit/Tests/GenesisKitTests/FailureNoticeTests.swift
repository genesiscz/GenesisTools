import AppKit
import Foundation
import SwiftUI
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

    // MARK: - Headline

    /// The defect: the notice's title read "The recording stopped at once (exit 1): {." because the first line that
    /// started with "error:" after trimming was the indented field `    error: {` of a WARN entry.
    func testRemoteEvidenceSurvivesTheCompatibleReportAdapter() {
        let stack = "RpcError: refused\n    at first (service.ts:1:2)\n    at second (caller.ts:3:4)"
        let report = FailureReport(headline: "Refused", command: "tools meetings decide", stack: stack,
                                   issue: FailureIssue(tool: "meetings", title: "Decision failed"))
        XCTAssertTrue(report.hasLog)
        XCTAssertTrue(report.detailsMarkdown().contains(stack))
        XCTAssertTrue(report.rawText().contains(stack))
        XCTAssertTrue(report.agentContext().contains(stack))
        XCTAssertTrue(report.agentContext().contains("tool: meetings (issue: Decision failed)"))
        XCTAssertTrue(report.agentContext().contains("command: tools meetings decide"))
    }

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

    /// The defect: a second "Draft an issue" replaced a window whose post was in flight (its link or error was lost,
    /// and a second copy could be posted) and dropped an edited draft without a word.
    func testAWindowWithAPostInFlightOrAnEditedDraftIsNeverReplaced() {
        let ok = IssuePostResult(posted: true, number: 7, url: "https://github.com/shop/storefront/issues/7", replaced: 0)
        let draft = IssueDraft(repo: "shop/storefront", title: "T", body: "B")
        let poster = FakePoster(result: .success(ok))

        XCTAssertFalse(IssueDraftModel(draft: draft, poster: poster).holdsWork, "an untouched draft can be replaced")
        XCTAssertTrue(IssueDraftModel(draft: draft, poster: poster, state: .posting).holdsWork)
        XCTAssertFalse(IssueDraftModel(draft: draft, poster: poster, state: .posted(ok)).holdsWork)

        let edited = IssueDraftModel(draft: draft, poster: poster)
        edited.draft.body = "B, with the private path removed"
        XCTAssertTrue(edited.holdsWork)
        let failed = IssueDraftModel(draft: draft, poster: poster, state: .failed("Not Found"))
        XCTAssertFalse(failed.holdsWork)
        failed.draft.title = "T2"
        XCTAssertTrue(failed.holdsWork)
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
