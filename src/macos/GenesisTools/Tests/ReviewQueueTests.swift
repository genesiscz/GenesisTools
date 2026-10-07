import XCTest
@testable import GenesisTools

/// The review window's comments for an agent: queued until a session's pane really got them, one card
/// per PR thread for my reply to it, the reply still attached after an edit, and the commit menu.
final class ReviewQueueTests: XCTestCase {
    private let file = DiffFile(id: "f", path: "col-mobile/jest.config.js", status: .modified, additions: 1, deletions: 1,
                                oldContents: "a\nb\nc\n", newContents: "a\nB\nc\n")

    private func store() -> (ReviewCommentStore, URL) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("queue-\(UUID())")
        return (ReviewCommentStore(repo: directory, directory: directory), directory)
    }

    @MainActor
    func testASnapshotRunNeverWritesTheCommentFileButANormalRunDoes() async throws {
        let (store, directory) = store()
        defer {
            ReviewCommentStore.readOnly = false
            try? FileManager.default.removeItem(at: directory)
        }
        let target = directory.appendingPathComponent("comments.json")
        ReviewCommentStore.readOnly = true
        XCTAssertNotNil(store.add(CommentInput(editingID: nil, fileID: "f", side: .additions, startLine: 2, endLine: 2, body: "Snap"), files: [file]))
        XCTAssertEqual(store.comments.count, 1, "the run still sees its own change")
        try await Task.sleep(nanoseconds: 400_000_000)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path), "a snapshot wrote the user's comments")

        // The negative control: the same change in a normal run reaches the file.
        ReviewCommentStore.readOnly = false
        XCTAssertNotNil(store.add(CommentInput(editingID: nil, fileID: "f", side: .additions, startLine: 3, endLine: 3, body: "Real"), files: [file]))
        var waited = 0
        while !FileManager.default.fileExists(atPath: target.path), waited < 40 {
            try await Task.sleep(nanoseconds: 50_000_000)
            waited += 1
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: target.path))
    }

    // MARK: queued vs sent

    func testWithoutAPaneThatGotItAQueuedCommentNeverReadsSent() {
        XCTAssertEqual(AgentDelivery.outcome(target: nil, error: nil), .queued, "no session: written, nobody told")
        let target = AgentTarget(sessionId: "abc-123", provider: "claude", name: "Fix the jest pattern")
        XCTAssertEqual(AgentDelivery.outcome(target: target, error: "cmux: no pane"), .queued, "a failed send is not a send")
        XCTAssertEqual(AgentDelivery.outcome(target: target, error: nil), .sent(to: "Fix the jest pattern"))
        XCTAssertEqual(AgentDelivery.notice(.queued, count: 1, host: "cmux", error: nil), "Queued 1 comment, not sent.")
        XCTAssertTrue(AgentDelivery.notice(.queued, count: 2, host: "cmux", error: "no pane").contains("not sent"))
        XCTAssertEqual(AgentDelivery.notice(.sent(to: "Fix"), count: 2, host: "cmux", error: nil), "Sent 2 comments to Fix.")
        XCTAssertFalse(AgentTarget.validID("abc; rm x"), "only an id the terminal host can be handed")
    }

    @MainActor
    func testTheStoreQueuesThenDeliversAndKeepsThePRWaysOpen() async throws {
        let (store, directory) = store()
        defer { try? FileManager.default.removeItem(at: directory) }
        let comment = try XCTUnwrap(store.add(CommentInput(editingID: nil, fileID: "f", side: .additions, startLine: 2, endLine: 2, body: "Revert"), files: [file]))
        store.markQueued([comment.id])
        XCTAssertEqual(store.comments.first?.state, .queued)
        XCTAssertNil(store.comments.first?.deliveredTo)
        XCTAssertEqual(store.rendered(for: [file]).first?.state, "queued")

        let at = Date(timeIntervalSince1970: 1_790_000_000)
        store.markDelivered([comment.id], to: "Fix the jest pattern", at: at)
        XCTAssertEqual(store.comments.first?.state, .sent)
        XCTAssertEqual(store.comments.first?.deliveredTo, "Fix the jest pattern")
        XCTAssertEqual(store.rendered(for: [file]).first?.deliveredTo, "Fix the jest pattern")
        // A sent comment can still go to the PR: the gate only refuses a posted one.
        XCTAssertNil(SuggestionSendGate.refusal(kind: "local", state: "sent", toPR: true, inFlight: false, busy: nil))
        XCTAssertNil(SuggestionSendGate.refusal(kind: "local", state: "queued", toPR: true, inFlight: false, busy: nil))

        store.mark(comment.id, .draft, remoteID: "d1")
        store.markDelivered([comment.id], to: "Again")
        XCTAssertEqual(store.comments.first?.state, .draft, "a PR draft stays a PR draft when an agent also gets it")
        await store.flush()
    }

    func testAnOldSentWithoutASessionIsQueuedAndItsFooterBecomesItsThread() {
        let old = ReviewComment(id: "c_1", path: "a", side: .additions, startLine: 51, endLine: 53,
                                body: "Vrátím to.\n\n(A reply to PR thread 28bdd247 on !7457.)", createdAt: Date(), updatedAt: Date(),
                                state: .sent, anchor: [], before: [], after: [])
        let migrated = old.migrated()
        XCTAssertEqual(migrated.state, .queued)
        XCTAssertEqual(migrated.thread, "28bdd247")
        XCTAssertEqual(migrated.body, "Vrátím to.", "the footer is not shown to the reader")
        XCTAssertEqual(migrated.migrated(), migrated, "running it twice changes nothing")
        var delivered = old
        delivered.deliveredTo = "Fix"
        XCTAssertEqual(delivered.migrated().state, .sent)
    }

    // MARK: one card per thread

    private func thread(_ id: String, reply: String? = "Suggested") -> RenderedComment {
        RenderedComment(id: id, fileId: "f", side: .additions, startLine: 51, endLine: 51, body: "Why?", author: "@a", when: "",
                        state: "open", remote: true, kind: "thread", reply: reply)
    }

    private func local(_ id: String, thread: String?) -> RenderedComment {
        RenderedComment(id: id, fileId: "f", side: .additions, startLine: 51, endLine: 53, body: "Mine", author: "You", when: "now",
                        state: "queued", remote: false, thread: thread)
    }

    func testMyReplySitsInsideItsThreadOnceInPlaceOfTheSuggestion() {
        let out = ReviewThreadReplies.attach([local("c_1", thread: "28bdd247"), thread("thread:28bdd24746bf"), local("c_2", thread: nil)])
        XCTAssertEqual(out.map(\.id), ["thread:28bdd24746bf", "c_2"], "the reply has no card of its own; a plain comment keeps its")
        let card = out[0]
        XCTAssertEqual(card.localReply?.id, "c_1")
        XCTAssertEqual(card.localReply?.state, "queued")
        XCTAssertNil(card.reply, "the suggestion became my reply: it is not shown twice")

        let live = ReviewThreadReplies.attach([thread("live:abcdef12"), local("c_3", thread: "abcdef")])
        XCTAssertEqual(live.map(\.id), ["live:abcdef12"])
        XCTAssertEqual(live.first?.localReply?.id, "c_3")

        let orphan = ReviewThreadReplies.attach([local("c_4", thread: "ffff0000")])
        XCTAssertEqual(orphan.map(\.id), ["c_4"], "a reply whose thread is not on the diff keeps its own card")
        XCTAssertEqual(ReviewThreadReplies.attach([thread("thread:x")]).first?.reply, "Suggested", "no reply: the suggestion stays")
    }

    @MainActor
    func testAnEditKeepsTheReplyInItsThreadAcrossASaveAndAReload() async throws {
        let (store, directory) = store()
        defer { try? FileManager.default.removeItem(at: directory) }
        let comment = try XCTUnwrap(store.add(CommentInput(editingID: nil, fileID: "f", side: .additions, startLine: 1, endLine: 3, body: "First"), files: [file]))
        store.link(comment.id, thread: "28bdd24746bf")
        store.markQueued([comment.id])
        store.edit(id: comment.id, body: "Reworded")
        await store.flush()

        let reloaded = ReviewCommentStore(repo: directory, directory: directory)
        let rendered = reloaded.rendered(for: [file])
        XCTAssertEqual(rendered.first?.thread, "28bdd24746bf")
        let attached = ReviewThreadReplies.attach(rendered + [thread("thread:28bdd24746bf")])
        XCTAssertEqual(attached.map(\.id), ["thread:28bdd24746bf"])
        XCTAssertEqual(attached.first?.localReply?.body, "Reworded")
        XCTAssertEqual(attached.first?.localReply?.state, "queued", "an edit does not change where it went")

        // The diff now shows another version of the file (the window was on the PR's head when the reply
        // was written, on an older push now): its lines are outdated here, and it still sits in its thread.
        var older = file
        older.newContents = "x\ny\nz\n"
        XCTAssertTrue(reloaded.reanchor(files: [older]))
        XCTAssertEqual(reloaded.comments.first?.outdated, true)
        let onOlder = ReviewThreadReplies.attach(reloaded.rendered(for: [older]) + [thread("thread:28bdd24746bf")])
        XCTAssertEqual(onOlder.first?.localReply?.id, comment.id, "an outdated reply did not vanish from its thread")
        let plain = try XCTUnwrap(reloaded.add(CommentInput(editingID: nil, fileID: "f", side: .additions, startLine: 1, endLine: 1, body: "Plain"), files: [file]))
        _ = reloaded.reanchor(files: [older])
        XCTAssertFalse(reloaded.rendered(for: [older]).contains { $0.id == plain.id }, "a plain outdated comment still hides")
        await reloaded.flush()
    }

    @MainActor
    func testAMigratedCommentWritesItsThreadWithTheNextEdit() async throws {
        let (first, directory) = store()
        defer { try? FileManager.default.removeItem(at: directory) }
        let comment = try XCTUnwrap(first.add(CommentInput(editingID: nil, fileID: "f", side: .additions, startLine: 1, endLine: 1,
                                                         body: "Old\n\n(A reply to PR thread 28bdd247 on !7457.)"), files: [file]))
        first.mark(comment.id, .sent)
        await first.flush()

        let second = ReviewCommentStore(repo: directory, directory: directory)
        XCTAssertEqual(second.comments.first?.thread, "28bdd247")
        second.edit(id: comment.id, body: "New")
        await second.flush()
        let third = ReviewCommentStore(repo: directory, directory: directory)
        let raw = try JSONDecoder.iso.decode([ReviewComment].self, from: Data(contentsOf: directory.appendingPathComponent("comments.json")))
        XCTAssertEqual(raw.first?.thread, "28bdd247", "the file holds the thread, not only the comment in memory")
        XCTAssertEqual(raw.first?.state, .queued)
        XCTAssertEqual(third.comments.first?.body, "New")
    }

    // MARK: commit menu

    func testACommitLinkOffersTheHostAndTheReviewOnlyWhenTheCommitIsHere() throws {
        XCTAssertEqual(try CommitMenu.sha(XCTUnwrap(URL(string: "https://gitlab.example.com/g/shop/-/commit/44a8c867b4"))), "44a8c867b4")
        XCTAssertEqual(try CommitMenu.sha(XCTUnwrap(URL(string: "https://github.com/acme/shop/commit/44a8c867b4ff"))), "44a8c867b4ff")
        XCTAssertNil(try CommitMenu.sha(XCTUnwrap(URL(string: "https://github.com/acme/shop/pull/12"))))

        let here = CommitMenu.items(short: "44a8c867b4", gitlab: true, missing: nil)
        XCTAssertEqual(here.map(\.action), [.host, .thisReview, .newWindow])
        XCTAssertEqual(here.map(\.enabled), [true, true, true])
        XCTAssertEqual(here.first?.title, "Open 44a8c867b4 on GitLab")

        let gone = CommitMenu.items(short: "44a8c867b4", gitlab: false, missing: "44a8c867b4 is not in shop, and origin did not give it.")
        XCTAssertEqual(gone.map(\.enabled), [true, false, false], "the host page always works; the review needs the commit here")
        XCTAssertEqual(gone.first?.title, "Open 44a8c867b4 on GitHub")
        XCTAssertTrue(gone[1].tooltip?.contains("origin did not give it") == true, "a disabled entry says why")
        XCTAssertEqual(try PRRefMenu.target(XCTUnwrap(URL(string: "https://gitlab.example.com/g/shop/-/commit/44a8c867b4"))), nil,
                       "a commit link is not a PR link")
    }

    // MARK: the send list

    private func item(_ id: String, thread: String? = nil) -> AgentSendItem {
        AgentSendItem(id: id, path: "col-mobile/jest.config.js", startLine: 51, endLine: 53, thread: thread, body: "Text", state: "queued")
    }

    func testTheSendTakesTheTickedCommentsInListOrder() {
        let items = [item("a"), item("b"), item("c")]
        XCTAssertEqual(AgentSendPlan.ids(items, unticked: []), ["a", "b", "c"], "every listed comment is ticked at first")
        XCTAssertEqual(AgentSendPlan.ids(items, unticked: ["b"]), ["a", "c"])
        XCTAssertEqual(AgentSendPlan.sendTitle(2), "Send 2")
        XCTAssertEqual(AgentSendPlan.sendTitle(0), "Send")
        XCTAssertEqual(AgentSendPlan.pruned(["b", "gone"], to: items), ["b"], "a comment that left the list leaves the unticked set")
        XCTAssertEqual(item("r", thread: "28bdd24746bf").place, "Reply to thread 28bdd247 · jest.config.js:L51–53")
        XCTAssertEqual(item("p").place, "jest.config.js:L51–53")
    }

    @MainActor
    func testRemoveFromTheSendKeepsTheCommentLocalUntilQueuedAgain() async throws {
        let (store, directory) = store()
        defer { try? FileManager.default.removeItem(at: directory) }
        let a = try XCTUnwrap(store.add(CommentInput(editingID: nil, fileID: "f", side: .additions, startLine: 1, endLine: 1, body: "A"), files: [file]))
        let b = try XCTUnwrap(store.add(CommentInput(editingID: nil, fileID: "f", side: .additions, startLine: 2, endLine: 2, body: "B"), files: [file]))
        store.markQueued([a.id, b.id])
        XCTAssertEqual(store.agentPending.map(\.id), [a.id, b.id])

        store.holdFromAgent([a.id])
        XCTAssertEqual(store.agentPending.map(\.id), [b.id], "out of this send and the next")
        XCTAssertEqual(store.comments.first { $0.id == a.id }?.state, .local, "it stays mine, local, not deleted")
        XCTAssertEqual(store.rendered(for: [file]).first { $0.id == a.id }?.state, "local")

        store.markQueued([a.id])
        XCTAssertEqual(store.agentPending.map(\.id), [a.id, b.id], "Queue to agent on its card takes it back")
        store.holdFromAgent([b.id])
        store.markDelivered([a.id], to: "Fix")
        XCTAssertTrue(store.agentPending.isEmpty, "a sent one and a held one are both out")
        await store.flush()
        let reloaded = ReviewCommentStore(repo: directory, directory: directory)
        XCTAssertEqual(reloaded.comments.first { $0.id == b.id }?.heldFromAgent, true, "the hold is saved")
        XCTAssertNil(reloaded.comments.first { $0.id == a.id }?.heldFromAgent)
    }

    // MARK: folding

    func testFoldsToggleAndAFoldedThreadShowsItsFirstLine() {
        XCTAssertEqual(PRThreadFolds.toggled(["a"], "b"), ["a", "b"])
        XCTAssertEqual(PRThreadFolds.toggled(["a", "b"], "a"), ["b"])
        XCTAssertNotEqual(PRThreadFolds.threadsKey("https://x/1"), PRThreadFolds.threadsKey("https://x/2"), "kept per PR")
        XCTAssertEqual(PRThreadFold.firstLine("\n**Tohle** by chtělo `vysvětlení`\nmore"), "Tohle by chtělo vysvětlení")
        XCTAssertEqual(PRThreadFold.firstLine("```\ncode\n```\nafter"), "code")
    }
}

private extension JSONDecoder {
    static var iso: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
