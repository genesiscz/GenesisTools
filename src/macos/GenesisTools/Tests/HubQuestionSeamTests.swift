import XCTest
@testable import GenesisTools

/// The JSON `tools question inbox` prints, as captured from the real CLI against a scratch store
/// (every field the TS side writes, nulls included), and the argv the hub sends back. One wrong
/// field name or type fails the whole decode, so these pin the seam from the Swift side.
final class HubQuestionSeamTests: XCTestCase {
    /// `tools question inbox --json`: a posted decision with every extra, and a pending form.
    private let inboxJSON = """
    {"sessions":[{"sessionId":"00000000-0000-4000-8000-000000000001","provider":null,"title":null,"project":"repo",
    "cwd":"/tmp/gt/repo","branch":null,"account":null,"lastAt":"2026-09-24T21:52:47.675Z","waiting":2,"items":[
    {"kind":"decision","id":"d_1_00000000-0000-4000-8000-000000000001","number":1,"title":"Cache","prompt":"Pick a cache",
    "choices":[{"id":"a","label":"keep it"},{"id":"b","label":"drop it"},{"id":"c","label":"both"}],"recommended":"a",
    "blocking":true,"status":"waiting","option":null,"answer":null,"source":"store","at":"2026-09-24T21:43:25.504Z",
    "proposal":"keep","reasoning":"cheap","confidence":"high","excerpt":"line1\\nline2\\n",
    "refs":[{"path":"/tmp/gt/repo/a.txt","line":1}],"draft":null,"delivery":null},
    {"kind":"form","id":"ask_1","source":"cli","questions":[{"itemId":"q1","prompt":"Ship it?",
    "choices":[{"id":"yes","label":"yes"},{"id":"no","label":"no"}],"multiple":false,"freeText":true,"required":true}],
    "status":"waiting","at":"2026-09-24T21:52:47.675Z"}]}],
    "scanned":{"sessions":73,"fromCache":72,"read":1,"failed":0},"elapsedMs":356}
    """

    /// `tools question inbox --session <id> --json`: an answer that stayed queued carries its delivery.
    private let sessionJSON = """
    {"sessionId":"00000000-0000-4000-8000-000000000001","decisions":[
    {"kind":"decision","id":"d_2_00000000-0000-4000-8000-000000000001","number":2,"title":null,"prompt":"Second one",
    "choices":[{"id":"a","label":"first"},{"id":"b","label":"second"}],"recommended":null,"blocking":false,
    "status":"answered","option":"a","answer":null,"source":"store","at":"2026-09-24T21:43:25.505Z","proposal":null,
    "reasoning":null,"confidence":null,"excerpt":null,"refs":[],"draft":null,
    "delivery":{"route":"queued","target":"no cmux pane runs this session","at":"2026-09-24T21:46:01.366Z"}}]}
    """

    func testInboxWithEveryDecisionFieldAndAFormDecodes() throws {
        let envelope = try JSONDecoder().decode(InboxEnvelope.self, from: Data(inboxJSON.utf8))
        let session = try XCTUnwrap(envelope.sessions.first)
        XCTAssertEqual(session.projectName, "repo")
        XCTAssertEqual(session.items.map(\.kind), ["decision", "form"])
        let decision = session.items[0]
        XCTAssertEqual(decision.refs?.first?.line, 1)
        XCTAssertNotNil(decision.date, "the TS ISO timestamp with milliseconds parses")
        XCTAssertEqual(session.items[1].questions?.first?.choices.map(\.id), ["yes", "no"])
    }

    func testSessionDecisionsDecodeIntoPaneCardsWithTheirDelivery() throws {
        let envelope = try JSONDecoder().decode(SessionDecisionsEnvelope.self, from: Data(sessionJSON.utf8))
        let item = try XCTUnwrap(envelope.decisions.first)
        XCTAssertEqual(item.delivery?.isQueued, true)
        XCTAssertEqual(item.number, 2)
        XCTAssertEqual(item.status, "answered")
        XCTAssertFalse(item.isOpen)
        XCTAssertEqual(item.option, "a")
        XCTAssertTrue(item.delivery?.line.hasPrefix("queued") == true)
    }

    /// A row's unsent pick and note come from the store (`draftOption`, `draft`), so the pane, the
    /// Inbox and /qa show the same marks; the card writes them back with `inbox draft`, never `answer`.
    func testDraftFieldsDecodeAndCountAsDrafted() throws {
        let json = #"{"sessionId":"s","decisions":[{"kind":"decision","id":"d_3_s","number":3,"title":null,"prompt":"Keep?","choices":[{"id":"a","label":"keep","rationale":"cheap","recommended":true},{"id":"b","label":"drop","rationale":null,"recommended":false}],"recommended":"a","blocking":false,"status":"drafted","option":null,"answer":null,"source":"store","at":"2026-09-24T21:43:25.505Z","context":"The cache is warm.","notes":null,"proposal":null,"reasoning":null,"confidence":null,"excerpt":null,"refs":[],"draftOption":"ab","draft":"note","delivery":null}]}"#
        let item = try XCTUnwrap(JSONDecoder().decode(SessionDecisionsEnvelope.self, from: Data(json.utf8)).decisions.first)
        XCTAssertEqual(item.draftOption, "ab")
        XCTAssertEqual(item.draft, "note")
        XCTAssertEqual(item.context, "The cache is warm.")
        XCTAssertEqual(item.choices?.first?.rationale, "cheap")
        XCTAssertEqual(item.choices?.first?.recommended, true)
        let session = InboxSession(
            sessionId: "s", provider: "claude", title: nil, project: nil, cwd: nil, branch: nil, account: nil,
            lastAt: "", waiting: 1, drafted: 1, queued: nil, reply: nil, items: [item]
        )
        XCTAssertEqual(session.draftedItems.count, 1)
        XCTAssertTrue(item.findFields.contains { $0.key == "context" && $0.markdown })
    }

    /// The prompt hook marks an answer sent and records `route: "prompt"`; it is no longer queued.
    func testPromptDeliveryIsSentNotQueued() throws {
        let json = #"{"route":"prompt","at":"2026-09-24T21:46:01.366Z"}"#
        let record = try JSONDecoder().decode(InboxDeliveryRecord.self, from: Data(json.utf8))
        XCTAssertFalse(record.isQueued)
        XCTAssertTrue(record.line.hasPrefix("sent "))
        XCTAssertTrue(record.line.hasSuffix("with the session's next prompt"))
    }

    /// What `inbox answer` prints: a delivery, a dry run (decision or form), or `{ error }` with exit 1.
    func testAnswerOutputsDecode() throws {
        let outputs = [
            #"{"session":"s","text":"DECISION 1: b) drop it","channel":"dry-run","delivered":false}"#,
            #"{"session":"s","text":"form ask_1","channel":"dry-run","delivered":false,"detail":"would answer q1"}"#,
            #"{"session":"s","text":"DECISION 1: b) note","channel":"codex","delivered":true,"detail":"w1"}"#,
            #"{"session":"s","text":"DECISION 2: a) first","channel":"queued","delivered":false,"detail":"no cmux pane runs this session"}"#,
            #"{"error":"DECISION 9 is not waiting in session s"}"#,
        ]
        let decoded = try outputs.map { try JSONDecoder().decode(InboxDelivery.self, from: Data($0.utf8)) }
        XCTAssertEqual(decoded.map(\.channel), ["dry-run", "dry-run", "codex", "queued", nil])
        XCTAssertTrue(decoded[3].isQueued)
        XCTAssertTrue(decoded[4].isError)
        XCTAssertEqual(decoded[4].summary, "DECISION 9 is not waiting in session s")
    }
}
