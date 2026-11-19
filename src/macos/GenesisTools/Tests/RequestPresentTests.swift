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
        let request = try Self.request()
        let model = RequestWindowContent.build(request)
        XCTAssertEqual(model.title, request.title)
        XCTAssertEqual(model.purpose, request.reason)
        XCTAssertEqual(model.allowTitle, "Acknowledge")
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
