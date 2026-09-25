import XCTest
@testable import GenesisTools

/// How the review window hands a file set to the web diff: every file, in order, in batches small
/// enough that the first files paint at once and the web view's IPC never holds the whole diff.
final class ReviewDiffTests: XCTestCase {
    private let kb = 1024

    func testNoFilesIsOneEmptyBatchSoThePageStillClearsItsList() {
        XCTAssertEqual(DiffBatchPlan.ranges(sizes: []), [0..<0])
    }

    func testTheBatchesCoverEveryFileInOrderWithNoGap() {
        let sizes = (0..<1_000).map { ($0 % 7 + 1) * 40 * kb }
        let ranges = DiffBatchPlan.ranges(sizes: sizes)
        XCTAssertEqual(ranges.first?.lowerBound, 0)
        XCTAssertEqual(ranges.last?.upperBound, sizes.count)
        for (previous, next) in zip(ranges, ranges.dropFirst()) {
            XCTAssertEqual(previous.upperBound, next.lowerBound)
            XCTAssertFalse(next.isEmpty)
        }
    }

    func testTheFirstBatchIsSmallAndTheRestKeepToTheirLimits() {
        let sizes = Array(repeating: 10 * kb, count: 500)
        let ranges = DiffBatchPlan.ranges(sizes: sizes)
        XCTAssertEqual(ranges.first?.count, DiffBatchPlan.firstFiles)
        for range in ranges.dropFirst() {
            XCTAssertLessThanOrEqual(range.count, DiffBatchPlan.batchFiles)
            XCTAssertLessThanOrEqual(sizes[range].reduce(0, +), DiffBatchPlan.batchBytes)
        }
    }

    func testAFileLargerThanABatchGoesAloneAndIsNeverSplitOrDropped() {
        let sizes = [5 * kb, 900 * kb, 5 * kb, 3 * 1024 * kb, 5 * kb]
        let ranges = DiffBatchPlan.ranges(sizes: sizes)
        XCTAssertEqual(ranges, [0..<1, 1..<3, 3..<4, 4..<5])
    }

    func testASkippedFileCostsOneLineNotItsText() {
        var file = DiffFile(id: "a", path: "a.bin", oldPath: nil, status: .modified, additions: 0, deletions: 0,
                            oldContents: String(repeating: "x", count: 50_000), newContents: nil, skipped: "binary file")
        XCTAssertEqual(DiffBatchPlan.size(file), 64)
        file.skipped = nil
        XCTAssertEqual(DiffBatchPlan.size(file), 50_000)
    }
}

/// The seam between the page (web/diff-viewer/main.ts) and Swift. Every message literal here is copied
/// from a `post({...})` in main.ts, and every JSON key asserted is one main.ts reads. A rename on one
/// side fails here instead of on the first real click.
final class ReviewPageSeamTests: XCTestCase {
    private func event(_ body: [String: Any]) -> DiffRendererEvent? {
        DiffRendererEvent(pageMessage: body)
    }

    private func json<T: Encodable>(_ value: T) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: page -> Swift

    func testEveryPageMessageDecodesAsMainTsPostsIt() {
        // openOnCommandClick
        XCTAssertEqual(event(["type": "open", "fileId": "f1", "line": 12, "side": "deletions"]),
                       .openLine(fileID: "f1", line: 12, side: .deletions))
        // The file header's ⌘-click
        XCTAssertEqual(event(["type": "open", "fileId": "f1", "line": 1, "side": "additions"]),
                       .openLine(fileID: "f1", line: 1, side: .additions))
        // renderComposer's save: a new comment posts `id: current.editingId`, which is null (NSNull over the bridge).
        XCTAssertEqual(event(["type": "comment.add", "id": NSNull(), "fileId": "f2", "side": "deletions",
                              "startLine": 3, "endLine": 5, "body": "Keep the old guard"]),
                       .commentSubmitted(CommentInput(editingID: nil, fileID: "f2", side: .deletions, startLine: 3, endLine: 5,
                                                      body: "Keep the old guard")))
        XCTAssertEqual(event(["type": "comment.edit", "id": "draft:D1", "fileId": "f2", "side": "additions",
                              "startLine": 7, "endLine": 7, "body": "Reworded"]),
                       .commentSubmitted(CommentInput(editingID: "draft:D1", fileID: "f2", side: .additions, startLine: 7, endLine: 7,
                                                      body: "Reworded")))
        XCTAssertEqual(event(["type": "comment.delete", "id": "c_12ab"]), .commentDeleted(id: "c_12ab"))
        // renderDraft / renderReply / sendRow / renderComment
        for action in ["restore", "reject", "agent", "draft", "post", "promote"] {
            XCTAssertEqual(event(["type": "comment.action", "id": "draft:D1", "action": action]),
                           .commentAction(id: "draft:D1", action: action))
        }
        // renderReplyBox, renderNote, the Resolve button
        XCTAssertEqual(event(["type": "thread.action", "id": "live:PRRT_1", "action": "reply", "draft": true, "body": "On it."]),
                       .threadAction(ThreadActionInput(id: "live:PRRT_1", action: .reply, draft: true, body: "On it.")))
        XCTAssertEqual(event(["type": "thread.action", "id": "thread:T4", "action": "note.update", "noteId": "N9", "body": "New"]),
                       .threadAction(ThreadActionInput(id: "thread:T4", action: .noteUpdate, noteID: "N9", body: "New")))
        XCTAssertEqual(event(["type": "thread.action", "id": "live:PRRT_1", "action": "unresolve"]),
                       .threadAction(ThreadActionInput(id: "live:PRRT_1", action: .unresolve)))
        // fixToggle posts the bare thread id (threadIdOf strips live: / thread:)
        XCTAssertEqual(event(["type": "thread.select", "id": "PRRT_1", "selected": true]), .threadSelect(id: "PRRT_1", selected: true))
        XCTAssertEqual(event(["type": "focusFile", "fileId": "f3"]), .focusFile("f3"))
        for key in ["j", "k", "r", "e", "x", "f", "n", "p", "s"] {
            XCTAssertNotNil(event(["type": "key", "key": key]), "main.ts reviewKeys has \(key)")
        }
        XCTAssertEqual(event(["type": "blame.need", "fileId": "f1"]), .blameNeed(fileID: "f1"))
        XCTAssertEqual(event(["type": "blame.open", "index": 2]), .blameOpen(index: 2))
        XCTAssertEqual(event(["type": "link", "url": "https://example.com/pr/7"]), .openURL(URL(string: "https://example.com/pr/7")!))
        XCTAssertEqual(event(["type": "error", "message": "boom"]), .failed("boom"))
    }

    func testMessagesTheRendererOwnsOrThatLackAFieldDecodeToNothing() {
        XCTAssertNil(event(["type": "ready"]))
        XCTAssertNil(event(["type": "rendered", "count": 3, "generation": 1]))
        XCTAssertNil(event(["type": "log", "message": "diff.fold folded a.ts"]))
        XCTAssertNil(event(["type": "link", "url": "javascript:alert(1)"]), "only web pages leave the viewer")
        XCTAssertNil(event(["type": "comment.add", "fileId": "f2", "startLine": 3, "body": "x"]), "no endLine")
        XCTAssertNil(event(["type": "key", "key": "?"]), "? stays on the page")
        XCTAssertNil(event(["type": "thread.select", "id": "PRRT_1", "selected": "yes"]))
    }

    // MARK: Swift -> page

    func testFocusThreadClearsTheMarkWithAnExplicitNull() throws {
        // main.ts `focusThread(target: { id: string | null; reply?: boolean })`; a missing key read as undefined.
        let cleared = try json(BridgeFocusThread(id: nil, reply: false))
        XCTAssertTrue(cleared.keys.contains("id"), "the page needs id: null to clear its mark, not a missing key")
        XCTAssertTrue(cleared["id"] is NSNull)
        XCTAssertEqual(try json(BridgeFocusThread(id: "live:PRRT_1", reply: true))["id"] as? String, "live:PRRT_1")
    }

    func testTheSmallPayloadsUseThePagesKeys() throws {
        // threadDone({ id, ok }), showBlameAt({ fileId, line }), setOptions(Partial<BridgeOptions>)
        XCTAssertEqual(Set(try json(BridgeThreadDone(id: "live:PRRT_1", ok: false)).keys), ["id", "ok"])
        XCTAssertEqual(Set(try json(BridgeBlameAt(fileId: "f1", line: 4)).keys), ["fileId", "line"])
        let options = try json(BridgeOptions(diffStyle: DiffViewOptions.Style.unified.rawValue, wrap: true, fontSize: 14))
        XCTAssertEqual(options["diffStyle"] as? String, "unified", "main.ts diffStyle is \"split\" | \"unified\"")
        XCTAssertEqual(Set(options.keys), ["diffStyle", "wrap", "fontSize"])
        let blame = try json(AgentBlamePayload(sources: [AgentBlameSource(provider: "claude", session: "s1", turn: "t1",
                                                                            ts: "2026-09-24T10:00:00Z", prompt: nil)],
                                               files: ["f1": [[1, 3, 0]]], loaded: ["f1"]))
        XCTAssertEqual(Set(blame.keys), ["sources", "files", "loaded"])
        XCTAssertEqual((blame["files"] as? [String: [[Int]]])?["f1"], [[1, 3, 0]], "[startLine, endLine, sourceIndex] per file id")
    }

    func testARenderedLiveThreadEncodesAsTheCardReadsIt() throws {
        let note = RenderedLiveThread.Note(id: "N1", author: "Alice Example", username: "alice", when: "2 hr. ago",
                                           at: "2026-09-24T08:00:00Z", body: "Why?", isDraft: true, edited: false, authorUrl: nil)
        let comment = RenderedComment(id: "live:PRRT_1", fileId: "f1", side: .deletions, startLine: 4, endLine: 4, body: "Why?",
                                      author: "@alice", when: " · 2 hr. ago", state: "open", remote: true, kind: "thread",
                                      live: RenderedLiveThread(notes: [note], resolved: false, resolvable: true, canReply: true))
        let encoded = try json(comment)
        XCTAssertEqual(encoded["side"] as? String, "deletions", "main.ts Side is \"additions\" | \"deletions\"")
        XCTAssertEqual(encoded["kind"] as? String, "thread")
        XCTAssertEqual(encoded["startLine"] as? Int, 4, "a one-line thread sends startLine == endLine")
        XCTAssertEqual(encoded["endLine"] as? Int, 4)
        XCTAssertNil(encoded["severity"], "absent, and the page falls back to minor")
        let live = try XCTUnwrap(encoded["live"] as? [String: Any])
        XCTAssertEqual(Set(live.keys), ["notes", "resolved", "resolvable", "canReply"])
        let first = try XCTUnwrap((live["notes"] as? [[String: Any]])?.first)
        XCTAssertEqual(first["isDraft"] as? Bool, true)
        XCTAssertEqual(Set(first.keys), ["id", "author", "username", "when", "at", "body", "isDraft", "edited"],
                       "authorUrl is left out when there is none; the page treats it as optional")

        let local = try json(RenderedComment(id: "c_1", fileId: "f1", side: .additions, startLine: 1, endLine: 2, body: "x",
                                             author: "You", when: "now", state: "local", remote: false))
        XCTAssertEqual(local["kind"] as? String, "local", "main.ts kind is \"local\" | \"draft\" | \"thread\"")
    }

    // MARK: ⌘-click on the old side

    func testAnOldSideLineOpensWhereItSitsInTheNewText() {
        let old = "a\nb\nc\nd\n"
        let new = "x\ny\na\nc\nd\n"
        XCTAssertEqual(DiffLineMap.newLine(forOld: 1, old: old, new: new), 3, "two lines were inserted above a")
        XCTAssertEqual(DiffLineMap.newLine(forOld: 2, old: old, new: new), 4, "b was removed: the line now where it was")
        XCTAssertEqual(DiffLineMap.newLine(forOld: 4, old: old, new: new), 5)
        XCTAssertEqual(DiffLineMap.newLine(forOld: 3, old: "a\nb\n", new: "a\nB\n"), 3, "a replaced line maps to its replacement")
        XCTAssertEqual(DiffLineMap.newLine(forOld: 2, old: "a\nb\n", new: "a\nB\n"), 2)
    }

    func testWithoutBothTextsTheLineStaysAsIs() {
        XCTAssertEqual(DiffLineMap.newLine(forOld: 7, old: nil, new: "a\n"), 7)
        XCTAssertEqual(DiffLineMap.newLine(forOld: 7, old: "a\n", new: nil), 7)
        XCTAssertEqual(DiffLineMap.newLine(forOld: 99, old: "a\n", new: "a\n"), 99, "past the old text: nothing to map")
    }

    // MARK: a suggestion goes out once

    func testASentCardRefusesASecondSendAsThePageHidesItsButtons() {
        // main.ts renderDraft: `sent = state === "sent" || "drafted" || "posted"` hides the send row.
        for state in ["sent", "drafted", "posted"] {
            XCTAssertNotNil(SuggestionSendGate.refusal(kind: "draft", state: state, toPR: true, inFlight: false, busy: nil), state)
        }
        for state in ["proposed", "accepted", "edited"] {
            XCTAssertNil(SuggestionSendGate.refusal(kind: "draft", state: state, toPR: true, inFlight: false, busy: nil), state)
        }
        // renderReply: any replyStatus hides the send row.
        XCTAssertNotNil(SuggestionSendGate.refusal(kind: "thread", state: "drafted", toPR: false, inFlight: false, busy: nil))
        XCTAssertNil(SuggestionSendGate.refusal(kind: "thread", state: nil, toPR: true, inFlight: false, busy: nil))
        // renderComment: posted has no button; a pending draft still offers Post.
        XCTAssertNotNil(SuggestionSendGate.refusal(kind: "local", state: "posted", toPR: true, inFlight: false, busy: nil))
        XCTAssertNil(SuggestionSendGate.refusal(kind: "local", state: "draft", toPR: true, inFlight: false, busy: nil))
    }

    func testADoubleClickWhileTheFirstSendRunsIsDropped() {
        XCTAssertNotNil(SuggestionSendGate.refusal(kind: "draft", state: "proposed", toPR: false, inFlight: true, busy: nil),
                        "the agent send of this card is still running")
        XCTAssertNotNil(SuggestionSendGate.refusal(kind: "local", state: "local", toPR: true, inFlight: false, busy: "Drafting…"),
                        "a PR write is running: the second click would draft the comment twice")
        XCTAssertNil(SuggestionSendGate.refusal(kind: "local", state: "local", toPR: false, inFlight: false, busy: "Drafting…"),
                     "a PR write does not hold a send to the agent")
    }
}
