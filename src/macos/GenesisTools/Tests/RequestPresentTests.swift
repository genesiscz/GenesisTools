import Foundation
import XCTest
@testable import GenesisToolsHost

@MainActor
final class RequestPresentTests: XCTestCase {
    static var fixtureURL: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../utils/genesis-tools/service/__fixtures__/wire.json").standardizedFileURL
    }
    static func request() throws -> RequestPresentParams {
        let rows = try JSONSerialization.jsonObject(with: Data(contentsOf: fixtureURL)) as? [[String: Any]] ?? []
        let row = try XCTUnwrap(rows.first { $0["method"] as? String == "request.present" })
        let params = try XCTUnwrap(row["params"], "request.present: the fixture has no params")
        return try JSONDecoder().decode(RequestPresentParams.self, from: JSONSerialization.data(withJSONObject: params))
    }
    func testAllGeneratedWireFixturesDecode() throws {
        let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: Self.fixtureURL)) as? [[String: Any]])
        XCTAssertGreaterThan(rows.count, 20)
        for row in rows {
            let method = try XCTUnwrap(row["method"] as? String)
            let params = try JSONSerialization.data(withJSONObject: XCTUnwrap(row["params"], "\(method): the fixture has no params"), options: [.fragmentsAllowed])
            let result = try JSONSerialization.data(withJSONObject: XCTUnwrap(row["result"], "\(method): the fixture has no result"), options: [.fragmentsAllowed])
            XCTAssertNoThrow(try GenesisToolsRPC.validateFixture(method: method, params: params, result: result), method)
        }
    }
    func testGeneratedLiteralRejectsTheOppositeBoolean() throws {
        let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: Self.fixtureURL)) as? [[String: Any]])
        let row = try XCTUnwrap(rows.first { $0["method"] as? String == "config.set" })
        let params = try JSONSerialization.data(withJSONObject: XCTUnwrap(row["params"], "config.set: the fixture has no params"))
        XCTAssertThrowsError(try GenesisToolsRPC.validateFixture(method: "config.set", params: params, result: Data("{\"changed\":false}".utf8)))
    }

    func testRequiredNullableReasonSurvivesSwiftEncoding() throws {
        let result = RequestPresentResult(id: "fixture", status: .value0, reason: nil)
        let data = try JSONEncoder().encode(result)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertTrue(object["reason"] is NSNull, "required nullable fields must encode an explicit null")
        XCTAssertThrowsError(try JSONDecoder().decode(RequestPresentResult.self, from: Data("{\"id\":\"fixture\",\"status\":\"done\"}".utf8)))
    }

    func testNoticeWordsAndAnswersUseTheSharedApprovalModel() throws {
        // A caller from before the declared fields sends text only, and gets the plain notice it always got.
        var request = try Self.request()
        request.fields = nil
        request.actions = nil
        request.buttons = nil
        request.rows = nil
        let model = RequestWindowContent.build(request)
        XCTAssertEqual(model.title, request.title)
        XCTAssertEqual(model.purpose, request.reason)
        XCTAssertEqual(model.allowTitle, "Acknowledge")
        XCTAssertEqual(model.denyTitle, "Not now", "a notice runs nothing, so it is put off, never denied")
        XCTAssertEqual(model.footnote, RequestWindowContent.plainNoticeFootnote)
        XCTAssertTrue(model.facts.isEmpty)
        XCTAssertEqual(model.details.map(\.value), [request.id], "the request id folds under Details")
        XCTAssertTrue(model.links.isEmpty)
        XCTAssertNil(model.verifier)
        XCTAssertEqual(model.deadlineLabel, "Stops waiting in ")
        var allows = 0
        model.onAllow = { _ in allows += 1 }
        model.allow(); model.allow(); model.deny()
        XCTAssertEqual(allows, 1)
    }

    func testGeneratedNullArmTakesOnlyNull() throws {
        XCTAssertNoThrow(try JSONDecoder().decode(GenesisToolsNull.self, from: Data("null".utf8)))
        for other in ["1", "\"text\"", "false", "{}", "[]"] {
            XCTAssertThrowsError(try JSONDecoder().decode(GenesisToolsNull.self, from: Data(other.utf8)), other)
        }
        XCTAssertEqual(String(decoding: try JSONEncoder().encode(GenesisToolsNull()), as: UTF8.self), "null")
    }

    // MARK: - The presenter's queue, deadlines and answers, with a fake panel and a hand-moved clock

    func testRequestsShowOneAtATimeAndEachAnswerResolvesOnce() throws {
        let harness = try PresenterHarness()
        harness.enqueue("a")
        harness.enqueue("b")
        XCTAssertEqual(harness.panel.shown.map(\.title), ["a"], "the second waits behind the first")
        harness.panel.shown[0].allow()
        harness.panel.shown[0].allow()
        harness.panel.shown[0].deny()
        XCTAssertEqual(harness.results.map(\.id), ["a"], "one answer per request")
        XCTAssertEqual(harness.results.first?.status, .value0)
        XCTAssertEqual(harness.panel.shown.map(\.title), ["a", "b"])
        harness.panel.shown[1].denyNote = "not now"
        harness.panel.shown[1].deny()
        XCTAssertEqual(harness.results.map(\.status), [.value0, .value2])
        XCTAssertEqual(harness.results.last?.reason, "not now")
        XCTAssertEqual(harness.panel.closes, 2)
        XCTAssertEqual(harness.idles, 1, "idle only once the queue is empty")
    }

    func testTimeoutEndsTheOpenRequestAndAnOldTimeoutNeverClosesTheNext() throws {
        let harness = try PresenterHarness()
        harness.enqueue("a", seconds: 10)
        harness.enqueue("b", seconds: 100)
        harness.clock.advance(by: 1)
        harness.panel.shown[0].allow()
        harness.clock.advance(by: 20)
        XCTAssertEqual(harness.results.map(\.id), ["a"], "a's cancelled timeout must not end b")
        harness.clock.advance(by: 80)
        XCTAssertEqual(harness.results.map(\.id), ["a", "b"])
        XCTAssertEqual(harness.results.last?.status, .value4)
        harness.panel.shown[1].allow()
        XCTAssertEqual(harness.results.count, 2, "a click after the timeout answers nothing")
        XCTAssertEqual(harness.idles, 1)
    }

    func testQueueTimeCountsAgainstTheDeadline() throws {
        let harness = try PresenterHarness()
        let start = harness.clock.current
        harness.enqueue("a", seconds: 100)
        harness.enqueue("b", seconds: 60)
        harness.enqueue("c", seconds: 5)
        harness.clock.advance(by: 30)
        harness.panel.shown[0].allow()
        XCTAssertEqual(harness.panel.shown.map(\.title), ["a", "b"])
        XCTAssertEqual(harness.panel.shown[1].deadline, start.addingTimeInterval(60), "b shows the time its caller has left")
        harness.clock.advance(by: 29)
        XCTAssertEqual(harness.results.map(\.id), ["a"])
        harness.clock.advance(by: 1)
        XCTAssertEqual(harness.results.map(\.id), ["a", "b", "c"], "b ends when its caller stops waiting, not 60 s after it showed")
        XCTAssertEqual(harness.results.map(\.status), [.value0, .value4, .value4])
        XCTAssertEqual(harness.panel.shown.count, 2, "c expired in the queue and never showed")
        harness.enqueue("d", seconds: 10)
        harness.enqueue("e", seconds: 10)
        harness.clock.advance(by: 10)
        harness.panel.shown[2].allow()
        XCTAssertEqual(harness.results.map(\.id), ["a", "b", "c", "d", "e"])
        XCTAssertEqual(harness.panel.shown.count, 3, "e expired while d stayed open")
        XCTAssertEqual(harness.idles, 2)
    }

    func testAFullQueueAnswersAtOnce() throws {
        let harness = try PresenterHarness(capacity: 2)
        for id in ["a", "b", "c", "d"] { harness.enqueue(id) }
        XCTAssertEqual(harness.results.map(\.id), ["d"])
        XCTAssertEqual(harness.results.first?.status, .value5)
        for index in 0..<3 { harness.panel.shown[index].allow() }
        XCTAssertEqual(harness.results.map(\.id), ["d", "a", "b", "c"])
        XCTAssertEqual(harness.busies, 3, "a refused request does not count as busy")
    }

    // MARK: Declared rows, extra buttons and answer words (D443)

    /// Answers each fake call by hand: the test decides when `tools` returns and when a player exits.
    private final class FakeActions {
        var runs: [[String]] = []
        var replies: [@MainActor (Int32, String, String) -> Void] = []
        var exits: [Int32: @MainActor () -> Void] = [:]
        var stopped: [Int32] = []
        var opened: [URL] = []

        var context: RequestActionContext {
            RequestActionContext(
                tools: { argv, done in self.runs.append(argv); self.replies.append(done) },
                whenExits: { pid, done in self.exits[pid] = done },
                stop: { pid in self.stopped.append(pid) },
                open: { url in self.opened.append(url) })
        }
    }

    private static func declared(actions: String = "") throws -> RequestPresentParams {
        let json = """
        {"kind":"notice","id":"voice-sample:fixture","title":"Confirm a voice sample of Alice Example",
         "reason":"An agent asks whether only Alice Example speaks here.","createdAt":"2026-11-24T21:00:00.000Z",
         "fields":[{"label":"Meeting","value":"Planning","help":"2026-01-12_10-00-planning"},{"label":"Time","value":"01:15 to 01:30"}],
         "actions":[\(actions.isEmpty ? #"{"kind":"play-meeting","label":"Play clip","meeting":"2026-01-12_10-00-planning","fromSec":75.4,"toSec":89.2},{"kind":"open-link","label":"Open page","url":"https://example.com/x"}"# : actions)],
         "buttons":{"confirm":"Confirm sample","decline":"Not now"}}
        """
        return try JSONDecoder().decode(RequestPresentParams.self, from: Data(json.utf8))
    }

    func testTheCallerDeclaresRowsButtonsAndAnswerWords() throws {
        let fake = FakeActions()
        let params = try Self.declared()
        let actions = RequestActions.buttons(for: params, context: fake.context)
        let model = RequestWindowContent.build(params, actions: actions)
        XCTAssertEqual(model.purpose, params.reason, "the body keeps only what the decision means")
        XCTAssertEqual(model.facts.map(\.label), ["Meeting", "Time"])
        XCTAssertEqual(model.facts.map(\.value), ["Planning", "01:15 to 01:30"])
        XCTAssertEqual(model.facts.first?.help, "2026-01-12_10-00-planning")
        XCTAssertEqual(model.details.map(\.value), ["voice-sample:fixture"])
        XCTAssertEqual(model.allowTitle, "Confirm sample")
        XCTAssertEqual(model.denyTitle, "Not now")
        XCTAssertEqual(model.links.map(\.title), ["Play clip", "Open page"])
        XCTAssertEqual(
            model.footnote,
            "Play clip only plays the clip. Open page only opens the page. Confirm sample and Not now answer the request; the window itself saves and runs nothing else.")
        XCTAssertTrue(fake.runs.isEmpty, "building the window runs nothing")
    }

    func testPlayClipPlaysTheCLICutTogglesToStopAndStopsWithTheWindow() throws {
        let fake = FakeActions()
        let params = try Self.declared(actions: #"{"kind":"play-meeting","label":"Play clip","meeting":"2026-01-12_10-00-planning","fromSec":75.4,"toSec":89.2}"#)
        let play = try XCTUnwrap(RequestActions.buttons(for: params, context: fake.context).first as? PlayMeetingButton)
        var changes = 0
        play.changed = { changes += 1 }

        play.link.action()
        XCTAssertEqual(fake.runs, [["meetings", "play", "2026-01-12_10-00-planning", "--at", "75", "--to", "90", "--json"]])
        play.link.action()
        XCTAssertEqual(fake.runs.count, 1, "a click while the player starts starts no second one")
        fake.replies.removeFirst()(0, #"{"pid":4242,"player":"afplay"}"#, "")
        XCTAssertEqual(play.link.title, "Stop")
        play.link.action()
        XCTAssertEqual(fake.stopped, [4242])
        XCTAssertEqual(play.link.title, "Play clip")

        // The clip ends by itself: the button turns back to Play.
        play.link.action()
        fake.replies.removeFirst()(0, #"{"pid":4343}"#, "")
        XCTAssertEqual(play.link.title, "Stop")
        fake.exits[4343]?()
        XCTAssertEqual(play.link.title, "Play clip")

        // The window closes while the clip plays: the player stops with it.
        play.link.action()
        fake.replies.removeFirst()(0, #"{"pid":4444}"#, "")
        play.close()
        XCTAssertEqual(fake.stopped, [4242, 4444])
        XCTAssertGreaterThan(changes, 0)

        // A play the CLI refuses: one plain sentence, the CLI's words for Details, and a dimmed button.
        let failing = try XCTUnwrap(RequestActions.buttons(for: params, context: fake.context).first)
        failing.link.action()
        fake.replies.removeFirst()(1, "", "error: ffmpeg is missing")
        XCTAssertEqual(failing.problem, RequestActionProblem(sentence: "The clip could not play.", detail: "error: ffmpeg is missing"))
        XCTAssertFalse(failing.link.enabled)
        XCTAssertEqual(failing.link.help, "The clip could not play.")
    }

    func testARangeWithNoSoundShowsADimmedPlayBeforeAnyClick() throws {
        let fake = FakeActions()
        let params = try Self.declared(actions: #"{"kind":"play-meeting","label":"Play clip","meeting":"m","fromSec":1,"toSec":2,"track":"mic-raw"}"#)
        let play = try XCTUnwrap(RequestActions.buttons(for: params, context: fake.context).first)
        play.prepare()
        XCTAssertEqual(fake.runs, [["meetings", "play", "m", "--at", "1", "--to", "2", "--track", "mic-raw", "--json", "--no-start"]],
                       "the check plans the same play and starts no player")
        let refusal = #"{"error":{"code":-32000,"data":{"code":"no-transcript-source"},"message":"[no-transcript-source] m has no source with a transcript. Link one: tools meetings link m 'wisprflow:<id>'"}}"#
        fake.replies.removeFirst()(1, "", refusal + "\n✗ [no-transcript-source] m has no source with a transcript.\n")
        XCTAssertEqual(play.problem?.sentence, "This meeting has no sound to play yet.")
        XCTAssertEqual(play.problem?.detail, "[no-transcript-source] m has no source with a transcript. Link one: tools meetings link m 'wisprflow:<id>'")
        XCTAssertFalse(play.link.enabled)
        XCTAssertEqual(play.link.help, "This meeting has no sound to play yet.")
        play.link.action()
        XCTAssertEqual(fake.runs.count, 1, "a dimmed Play runs nothing")
        XCTAssertEqual(PlayMeetingButton.problem(status: 1, stderr: "✗ boom\n").detail, "boom", "the CLI glyph never reaches Details")
        // The CLI's own JSON line names the code only as the message's lead when it wraps the refusal.
        let wrapped = #"{"error":{"code":-32000,"message":"[no-transcript-source] m has no source with a transcript."}}"#
        XCTAssertEqual(PlayMeetingButton.problem(status: 1, stderr: wrapped).sentence, "This meeting has no sound to play yet.")
    }

    func testOpenLinkOpensOnlyAWebPage() throws {
        let fake = FakeActions()
        let params = try Self.declared(actions: #"{"kind":"open-link","label":"Open page","url":"https://example.com/x"},{"kind":"open-link","label":"Local file","url":"file:///etc/hosts"}"#)
        let buttons = RequestActions.buttons(for: params, context: fake.context)
        XCTAssertEqual(buttons.map(\.link.title), ["Open page"], "a file URL never becomes a button")
        buttons.first?.link.action()
        XCTAssertEqual(fake.opened, [URL(string: "https://example.com/x")!])
    }

    func testAPresentedRequestShowsItsButtonsAndStopsThemWhenAnswered() throws {
        let fake = FakeActions()
        let panel = FakeRequestPanel()
        let clock = ManualClock()
        let presenter = RequestPresenter(panel: panel, clock: clock.clock, activate: {}, actionContext: fake.context)
        let params = try Self.declared(actions: #"{"kind":"play-meeting","label":"Play clip","meeting":"m","fromSec":1,"toSec":2}"#)
        var results: [RequestPresentResult] = []
        presenter.enqueue(params) { results.append($0) }
        let model = try XCTUnwrap(panel.shown.last)
        XCTAssertEqual(model.links.map(\.title), ["Play clip"])
        XCTAssertEqual(fake.runs.last?.last, "--no-start", "the window checks the play when it opens")
        fake.replies.removeFirst()(0, "{}", "")
        model.links.first?.action()
        fake.replies.removeFirst()(0, #"{"pid":5151}"#, "")
        XCTAssertEqual(model.links.map(\.title), ["Stop"], "the window shows the button's new words")
        XCTAssertTrue(results.isEmpty, "a play answers nothing")
        model.allow()
        XCTAssertEqual(results.map(\.status), [.value0])
        XCTAssertEqual(fake.stopped, [5151], "the answer stops the clip")
    }

    func testAPlayThatCannotRunPutsItsSentenceUnderTheRowsAndItsDetailUnderDetails() throws {
        let fake = FakeActions()
        let panel = FakeRequestPanel()
        let clock = ManualClock()
        let presenter = RequestPresenter(panel: panel, clock: clock.clock, activate: {}, actionContext: fake.context)
        let params = try Self.declared(actions: #"{"kind":"play-meeting","label":"Play clip","meeting":"m","fromSec":1,"toSec":2}"#)
        presenter.enqueue(params) { _ in }
        let model = try XCTUnwrap(panel.shown.last)
        fake.replies.removeFirst()(1, "", #"{"error":{"data":{"code":"no-transcript-source"},"message":"m has no source with a transcript."}}"#)
        XCTAssertEqual(model.summary, "This meeting has no sound to play yet.")
        XCTAssertEqual(model.details.map(\.label), ["Request", "Play clip"])
        XCTAssertEqual(model.details.last?.value, "m has no source with a transcript.")
        XCTAssertEqual(model.links.first?.enabled, false)
    }

    // MARK: Rows ticked on their own (relayed answers, one window for several)

    private static func relayed() throws -> RequestPresentParams {
        let json = """
        {"kind":"notice","id":"relayed:fixture","title":"Confirm 2 answers you gave in chat",
         "reason":"An agent relayed these answers from your chat.","createdAt":"2026-11-24T21:00:00.000Z",
         "buttons":{"confirm":"Confirm as mine","decline":"Not now"},
         "rows":[
          {"id":"m1:i3","title":"Q1 · Alice Example","quote":"that was Alice","detail":"Planning · 00:10",
           "action":{"kind":"play-meeting","label":"Play clip","meeting":"m1","fromSec":10,"toSec":14}},
          {"id":"m2:i7","title":"Q2 · Bob Example","quote":"Bob, yes",
           "action":{"kind":"play-meeting","label":"Play clip","meeting":"m2","fromSec":20,"toSec":25}}]}
        """
        return try JSONDecoder().decode(RequestPresentParams.self, from: Data(json.utf8))
    }

    func testRelayedRowsAreTickedOnTheirOwnAndConfirmAnswersOnlyTheTickedOnes() throws {
        let fake = FakeActions()
        let panel = FakeRequestPanel()
        let clock = ManualClock()
        let presenter = RequestPresenter(panel: panel, clock: clock.clock, activate: {}, actionContext: fake.context)
        var results: [RequestPresentResult] = []
        presenter.enqueue(try Self.relayed()) { results.append($0) }
        let model = try XCTUnwrap(panel.shown.last)
        XCTAssertEqual(model.checks.map(\.id), ["m1:i3", "m2:i7"])
        XCTAssertEqual(model.checks.map(\.quote), ["that was Alice", "Bob, yes"])
        XCTAssertEqual(model.selected, ["m1:i3", "m2:i7"], "every row starts ticked")
        XCTAssertTrue(model.selectable)
        XCTAssertEqual(model.checks.compactMap(\.link?.title), ["Play clip", "Play clip"])
        XCTAssertEqual(fake.runs.filter { $0.last == "--no-start" }.count, 2, "each row checks its own clip")
        XCTAssertTrue(model.footnote.contains("Confirm as mine answers for the ticked rows"))
        fake.replies.removeFirst()(0, "{}", "")
        fake.replies.removeFirst()(0, "{}", "")

        // The second row plays its own range, and its button turns to Stop.
        model.checks[1].link?.action()
        XCTAssertEqual(fake.runs.last, ["meetings", "play", "m2", "--at", "20", "--to", "25", "--json"])
        fake.replies.removeFirst()(0, #"{"pid":6161}"#, "")
        XCTAssertEqual(model.checks.map { $0.link?.title }, ["Play clip", "Stop"])

        model.setSelected(id: "m1:i3", false)
        model.allow()
        XCTAssertEqual(results.map(\.status), [.value0])
        XCTAssertEqual(results.first?.picked, ["m2:i7"], "only the ticked row is confirmed")
        XCTAssertEqual(fake.stopped, [6161], "the answer stops the row's clip")
    }
}

@MainActor
private final class FakeRequestPanel: RequestPanel {
    var shown: [ApprovalDialogModel] = []
    var closes = 0
    func present(_ model: ApprovalDialogModel, reminders: Bool) { shown.append(model) }
    func close() { closes += 1 }
}

@MainActor
private final class ManualClock {
    var current = Date(timeIntervalSinceReferenceDate: 1_000_000)
    private var timers: [(at: Date, work: @MainActor () -> Void, id: Int)] = []
    private var cancelled: Set<Int> = []
    private var nextID = 0

    var clock: RequestClock {
        RequestClock(now: { MainActor.assumeIsolated { self.current } }, after: { seconds, work in
            MainActor.assumeIsolated {
                self.nextID += 1
                let id = self.nextID
                self.timers.append((self.current.addingTimeInterval(seconds), work, id))
                return { MainActor.assumeIsolated { _ = self.cancelled.insert(id) } }
            }
        })
    }

    func advance(by seconds: TimeInterval) {
        current = current.addingTimeInterval(seconds)
        while let index = timers.firstIndex(where: { $0.at <= current }) {
            let timer = timers.remove(at: index)
            if !cancelled.contains(timer.id) { timer.work() }
        }
    }
}

@MainActor
private final class PresenterHarness {
    let panel = FakeRequestPanel()
    let clock = ManualClock()
    let presenter: RequestPresenter
    var results: [RequestPresentResult] = []
    var idles = 0
    var busies = 0
    private let template: RequestPresentParams

    init(capacity: Int? = nil) throws {
        template = try RequestPresentTests.request()
        presenter = RequestPresenter(panel: panel, clock: clock.clock, capacity: capacity, activate: {})
        presenter.onIdle = { [unowned self] in idles += 1 }
        presenter.onBusy = { [unowned self] in busies += 1 }
    }

    func enqueue(_ id: String, seconds: Double = 120) {
        var params = template
        params.id = id
        params.title = id
        params.deadlineSeconds = seconds
        presenter.enqueue(params) { [unowned self] in results.append($0) }
    }
}
