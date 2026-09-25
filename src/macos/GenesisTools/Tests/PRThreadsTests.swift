import XCTest
@testable import GenesisTools

/// The review window's `tools hub pr` side: the argv of every write, the one door to `publish`,
/// and how live threads land on the diff. Nothing here runs `tools` or touches a real PR.
final class PRThreadsTests: XCTestCase {
    private let target = PRTarget.ref("https://github.com/acme/shop/pull/7")

    // MARK: bar

    func testTheBarCountShortensInWholeWordsAndDropsZeroDraftsFirst() {
        let none = PRReviewBar.summaryVariants(threads: 137, open: 48, drafts: 0)
        XCTAssertEqual(none, ["137 threads · 48 open", "48/137 open", "48 open"])
        let some = PRReviewBar.summaryVariants(threads: 137, open: 48, drafts: 2)
        XCTAssertEqual(some.last, "2 drafts", "the narrowest bar still says how many drafts Submit review sends")
        XCTAssertEqual(PRReviewBar.summaryVariants(threads: 3, open: 1, drafts: 1).last, "1 draft")
        for variant in none + some {
            let words = variant.split(whereSeparator: { $0 == " " || $0 == "·" || $0 == "/" })
            XCTAssertFalse(words.contains { word in word.count > 1 && word.last?.isLetter == true && word.first?.isNumber == true },
                           "\"\(variant)\" glues a number to a letter, like 0d")
        }
        XCTAssertEqual(some.map(\.count), some.map(\.count).sorted(by: >), "widest first")
    }

    // MARK: argv

    func testAReplyIsADraftUnlessItIsPublished() {
        XCTAssertEqual(
            PRCommand.reply(target, thread: "PRRT_1", bodyFile: "/tmp/b.md", draft: true),
            ["hub", "pr", "reply", "--pr", "https://github.com/acme/shop/pull/7", "--thread", "PRRT_1", "--body-file", "/tmp/b.md", "--json", "--draft"]
        )
        XCTAssertEqual(
            PRCommand.reply(target, thread: "PRRT_1", bodyFile: "/tmp/b.md", draft: false),
            ["hub", "pr", "reply", "--pr", "https://github.com/acme/shop/pull/7", "--thread", "PRRT_1", "--body-file", "/tmp/b.md", "--json"],
            "a published reply has no --draft"
        )
    }

    func testADraftOnARangeOfTheOldSideCarriesTheStartLineAndTheSide() {
        XCTAssertEqual(
            PRCommand.draftAdd(.repo("/work/shop"), path: "src/cart.ts", line: 14, startLine: 10, side: .deletions, bodyFile: "/tmp/b.md"),
            ["hub", "pr", "draft", "add", "--repo", "/work/shop", "--path", "src/cart.ts", "--line", "14", "--start-line", "10",
             "--side", "deletions", "--body-file", "/tmp/b.md", "--json"]
        )
        let single = PRCommand.draftAdd(target, path: "src/cart.ts", line: 14, startLine: 14, side: .additions, bodyFile: "/tmp/b.md")
        XCTAssertFalse(single.contains("--start-line"), "a one-line comment has no start line")
        XCTAssertEqual(Array(single.suffix(5)), ["--side", "additions", "--body-file", "/tmp/b.md", "--json"])
    }

    func testDraftEditsResolveAndUnresolve() {
        XCTAssertEqual(PRCommand.draftUpdate(target, draftId: "PRRC_9", bodyFile: "/tmp/b.md"),
                       ["hub", "pr", "draft", "update", "PRRC_9", "--pr", "https://github.com/acme/shop/pull/7", "--body-file", "/tmp/b.md", "--json"])
        XCTAssertEqual(PRCommand.draftDelete(target, draftId: "PRRC_9"),
                       ["hub", "pr", "draft", "delete", "PRRC_9", "--pr", "https://github.com/acme/shop/pull/7", "--json"])
        XCTAssertEqual(PRCommand.resolve(target, thread: "PRRT_1", resolved: true),
                       ["hub", "pr", "resolve", "PRRT_1", "--pr", "https://github.com/acme/shop/pull/7", "--json"])
        XCTAssertEqual(PRCommand.resolve(target, thread: "PRRT_1", resolved: false).last, "--unresolve")
        XCTAssertEqual(PRCommand.threads(.ref("/work/shop#7"), noCache: true),
                       ["hub", "pr", "threads", "--pr", "/work/shop#7", "--json", "--no-cache"])
    }

    func testThePublishArgvPerEvent() {
        XCTAssertEqual(PRCommand.publish(target, event: .comment, bodyFile: nil),
                       ["hub", "pr", "publish", "--pr", "https://github.com/acme/shop/pull/7", "--json"])
        XCTAssertEqual(PRCommand.publish(target, event: .approve, bodyFile: "/tmp/s.md"),
                       ["hub", "pr", "publish", "--pr", "https://github.com/acme/shop/pull/7", "--approve", "--body-file", "/tmp/s.md", "--json"])
        XCTAssertEqual(PRCommand.publish(target, event: .requestChanges, bodyFile: nil),
                       ["hub", "pr", "publish", "--pr", "https://github.com/acme/shop/pull/7", "--request-changes", "--json"])
    }

    /// `tools gitlab draft-reply --file --line --now` is refused by that command ("--now can only be used
    /// with --discussion"), and it has no old side: posting a new comment on an MR always failed. Both
    /// hosts now take `hub pr comment`, with the side and the range of `draft add`.
    func testANewCommentPublishedAtOnceGoesThroughHubPRCommentOnBothHosts() {
        let gitlab = PRTarget.ref("https://gitlab.example.com/group/shop/-/merge_requests/12")
        XCTAssertEqual(
            PRCommand.comment(gitlab, path: "src/cart.ts", line: 3, startLine: 1, side: .deletions, bodyFile: "/tmp/b.md"),
            ["hub", "pr", "comment", "--pr", "https://gitlab.example.com/group/shop/-/merge_requests/12",
             "--path", "src/cart.ts", "--line", "3", "--start-line", "1", "--side", "deletions", "--body-file", "/tmp/b.md", "--json"]
        )
        XCTAssertEqual(
            Array(PRCommand.comment(target, path: "src/cart.ts", line: 3, startLine: nil, side: .additions, bodyFile: "/tmp/b.md").prefix(3)),
            ["hub", "pr", "comment"]
        )
        XCTAssertEqual(PRIdentity(provider: "gitlab", host: "gitlab.example.com", project: "group/shop", number: 12).label, "!12")
    }

    /// src/hub/lib/pr/window-argv.json holds the argv this file builds, and src/hub/lib/pr/pr.test.ts
    /// runs each one through the real CLI: a flag or verb Swift sends and commander refuses fails there.
    func testEveryArgvTheWindowBuildsIsTheOneTheCLITestParses() throws {
        let src = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: src.appendingPathComponent("hub/lib/pr/window-argv.json"))
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let fixture = try XCTUnwrap(object["argv"] as? [String: [String]])
        let repo = PRTarget.repo("/work/shop")
        let body = "/tmp/b.md"
        let built: [String: [String]] = [
            "threads": PRCommand.threads(repo),
            "threadsNoCache": PRCommand.threads(repo, noCache: true),
            "replyDraft": PRCommand.reply(repo, thread: "PRRT_1", bodyFile: body, draft: true),
            "replyNow": PRCommand.reply(repo, thread: "PRRT_1", bodyFile: body, draft: false),
            "draftAdd": PRCommand.draftAdd(repo, path: "src/cart.ts", line: 14, startLine: 10, side: .deletions, bodyFile: body),
            "comment": PRCommand.comment(repo, path: "src/cart.ts", line: 14, startLine: 10, side: .deletions, bodyFile: body),
            "draftUpdate": PRCommand.draftUpdate(repo, draftId: "PRRC_9", bodyFile: body),
            "draftDelete": PRCommand.draftDelete(repo, draftId: "PRRC_9"),
            "resolve": PRCommand.resolve(repo, thread: "PRRT_1", resolved: true),
            "unresolve": PRCommand.resolve(repo, thread: "PRRT_1", resolved: false),
            "publishComment": PRCommand.publish(repo, event: .comment, bodyFile: nil),
            "publishApprove": PRCommand.publish(repo, event: .approve, bodyFile: body),
            "publishRequestChanges": PRCommand.publish(repo, event: .requestChanges, bodyFile: nil),
            "fixPlan": PRCommand.fix(repo, repo: "/work/shop", threads: ["PRRT_1", "PRRT_2"], dryRun: true),
            "fixNewAgent": PRCommand.fix(repo, repo: "/work/shop", threads: ["PRRT_1"], send: false),
            "fixCheckPlan": PRCommand.fixCheck(.ref("/work/shop#42"), repo: "/work/shop",
                                               checkURL: "https://github.com/o/r/actions/runs/1/job/2", name: "ci", dryRun: true),
            "fixCheckNewAgent": PRCommand.fixCheck(.ref("/work/shop#42"), repo: "/work/shop",
                                                   checkURL: "https://github.com/o/r/actions/runs/1/job/2", name: "ci",
                                                   session: "aaaaaaaa-0000-4000-8000-000000000001", send: false),
        ]
        XCTAssertEqual(Set(built.keys), Set(fixture.keys), "every verb the window builds is in the fixture, and nothing else")
        for (name, argv) in built {
            XCTAssertEqual(argv, fixture[name], name)
        }
    }

    func testNoBuilderButPublishNamesThePublishVerb() {
        let others: [[String]] = [
            PRCommand.threads(target),
            PRCommand.reply(target, thread: "t", bodyFile: "f", draft: true),
            PRCommand.reply(target, thread: "t", bodyFile: "f", draft: false),
            PRCommand.draftAdd(target, path: "p", line: 2, startLine: 1, side: .additions, bodyFile: "f"),
            PRCommand.draftUpdate(target, draftId: "d", bodyFile: "f"),
            PRCommand.draftDelete(target, draftId: "d"),
            PRCommand.resolve(target, thread: "t", resolved: true),
            PRCommand.resolve(target, thread: "t", resolved: false),
            PRCommand.comment(target, path: "p", line: 1, startLine: nil, side: .additions, bodyFile: "f"),
            PRCommand.fix(target, repo: "/w", threads: ["t"]),
            PRCommand.fixCheck(target, repo: "/w", checkURL: "u", name: "ci"),
        ]
        for argv in others {
            XCTAssertFalse(argv.contains("publish"), "\(argv) must not publish the pending review")
        }
    }

    /// The only caller of `PRCommand.publish` is `PRThreadsStore.submitReview`, and the only caller of
    /// that is the Submit review form, after its confirmation alert.
    func testOnlyTheSubmitActionReachesPublish() throws {
        let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Sources")
        var publishCalls: [String] = []
        var submitCalls: [String] = []
        var literals: [String] = []
        let files = FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil)
        while let file = files?.nextObject() as? URL {
            guard file.pathExtension == "swift" else { continue }
            let text = try String(contentsOf: file, encoding: .utf8)
            for (index, line) in text.components(separatedBy: "\n").enumerated() {
                let place = "\(file.lastPathComponent):\(index + 1)"
                if line.contains("PRCommand.publish(") { publishCalls.append(place) }
                if line.contains(".submitReview(") { submitCalls.append(place) }
                if line.contains("\"publish\"") { literals.append(place) }
            }
        }
        XCTAssertEqual(publishCalls.count, 1, "PRCommand.publish is built in one place: \(publishCalls)")
        XCTAssertTrue(publishCalls.first?.hasPrefix("PRThreads.swift:") ?? false, "\(publishCalls)")
        XCTAssertEqual(submitCalls.count, 1, "submitReview has one caller: \(submitCalls)")
        XCTAssertTrue(submitCalls.first?.hasPrefix("PRThreadsPanel.swift:") ?? false, "\(submitCalls)")
        XCTAssertEqual(literals.count, 1, "the verb is spelled once, in PRCommand.publish: \(literals)")

        let panel = try String(contentsOf: sources.appendingPathComponent("Review/PRThreadsPanel.swift"), encoding: .utf8)
        let submit = try XCTUnwrap(panel.range(of: "store.submitReview("))
        let confirm = try XCTUnwrap(panel.range(of: "if confirm(event: event, summary: summary)", options: .backwards, range: panel.startIndex..<submit.lowerBound))
        XCTAssertLessThan(panel.distance(from: confirm.upperBound, to: submit.lowerBound), 80, "submitReview runs only inside the confirmation's if")
    }

    func testAForkPRBarLinksItsSourceBranchInTheFork() throws {
        func info(_ extra: String) throws -> PRInfo {
            let json = """
            {"provider":"github","host":"github.com","project":"acme/shop","number":7,"url":"https://github.com/acme/shop/pull/7",
             "title":"Cart totals","sourceBranch":"feat/cart","targetBranch":"main"\(extra)}
            """
            return try JSONDecoder().decode(PRInfo.self, from: Data(json.utf8))
        }

        let fork = try info(#","crossRepository":true,"headRepo":"dave/shop-fork""#)
        XCTAssertEqual(fork.sourceBranchURL?.absoluteString, "https://github.com/dave/shop-fork/tree/feat/cart")
        XCTAssertEqual(fork.compareURL?.absoluteString, "https://github.com/acme/shop/compare/main...dave:feat/cart")

        let unnamed = try info(#","crossRepository":true,"headRepo":null"#)
        XCTAssertNil(unnamed.sourceBranchURL, "a fork the host did not name gets no guessed page")
        XCTAssertNil(unnamed.compareURL)

        let same = try info("")
        XCTAssertEqual(same.sourceBranchURL?.absoluteString, "https://github.com/acme/shop/tree/feat/cart")
        XCTAssertEqual(same.compareURL?.absoluteString, "https://github.com/acme/shop/compare/main...feat/cart")
    }

    // MARK: threads on the diff

    private let files = [
        DiffFile(id: "f1", path: "src/cart.ts", status: .modified, additions: 3, deletions: 1),
        DiffFile(id: "f2", path: "src/new-name.ts", oldPath: "src/old-name.ts", status: .renamed, additions: 1, deletions: 1),
    ]

    private func payload() throws -> PRThreadsPayload {
        let json = """
        {"pr":{"provider":"github","host":"github.com","project":"acme/shop","number":7,"url":"https://github.com/acme/shop/pull/7",
               "webUrl":"https://github.com/acme/shop/pull/7","title":"Cart totals","state":"OPEN","draft":false,"author":"alice",
               "sourceBranch":"feat/cart","targetBranch":"main","headSha":"b","baseSha":"a","repoPath":null},
         "threads":[
          {"id":"T1","path":"src/cart.ts","side":"additions","line":12,"startLine":10,"outdated":false,"resolved":false,"resolvable":true,
           "diffHunk":"@@","comments":[
             {"id":"C1","author":{"name":"Alice","username":"alice","avatarUrl":"https://example.com/a.png","role":"MEMBER"},
              "bodyMarkdown":"Why `total`?","createdAt":"2026-09-20T10:00:00Z","isDraft":false,
              "reactions":[{"emoji":"+1","count":1,"mine":false}]},
             {"id":"C2","author":{"name":"Bob","username":"bob"},"bodyMarkdown":"Renaming it.","createdAt":"2026-09-20T11:00:00Z","isDraft":true}]},
          {"id":"T2","path":"src/cart.ts","side":"deletions","line":4,"outdated":true,"resolved":true,"resolvable":true,
           "comments":[{"id":"C3","author":{"name":"Alice","username":"alice"},"bodyMarkdown":"Old point","createdAt":"2026-09-19T10:00:00Z","isDraft":false}]},
          {"id":"T3","path":"src/other.ts","side":"additions","line":1,"outdated":false,"resolved":false,"resolvable":true,
           "comments":[{"id":"C4","author":{"name":"Alice","username":"alice"},"bodyMarkdown":"Elsewhere","createdAt":"2026-09-19T10:00:00Z","isDraft":false}]},
          {"id":"T4","path":"src/new-name.ts","oldPath":"src/old-name.ts","side":"deletions","line":2,"outdated":false,"resolved":true,"resolvable":true,
           "comments":[{"id":"C5","author":{"name":"Bob","username":"bob"},"bodyMarkdown":"My new thread","createdAt":"2026-09-20T12:00:00Z","isDraft":true}]}
         ],
         "draftCount":2,"viewer":"bob","cached":false,"fetchedAt":"2026-09-20T12:00:01Z"}
        """
        return try JSONDecoder().decode(PRThreadsPayload.self, from: Data(json.utf8))
    }

    func testLiveThreadsLandOnTheirLinesWithEveryComment() throws {
        let data = try payload()
        XCTAssertEqual(data.draftCount, 2)
        XCTAssertEqual(data.pr.identity.label, "#7")
        let now = try XCTUnwrap(HubFormat.date("2026-09-20T13:00:00Z"))
        let rendered = PRThreadRendering.rendered(data.threads, files: files, now: now)

        let open = try XCTUnwrap(rendered.first { $0.id == "live:T1" })
        XCTAssertEqual(open.kind, "thread")
        XCTAssertTrue(open.remote)
        XCTAssertEqual(open.fileId, "f1")
        XCTAssertEqual(open.startLine, 10)
        XCTAssertEqual(open.endLine, 12)
        XCTAssertEqual(open.state, "open")
        XCTAssertEqual(open.author, "@alice")
        XCTAssertEqual(open.body, "Why `total`?")
        XCTAssertTrue(open.when.contains("2 comments"))
        let live = try XCTUnwrap(open.live, "the card gets every note and its buttons")
        XCTAssertEqual(live.notes.map(\.username), ["alice", "bob"])
        XCTAssertEqual(live.notes.map(\.isDraft), [false, true], "my pending reply gets Edit and Delete")
        XCTAssertEqual(live.notes[0].author, "Alice")
        XCTAssertTrue(live.canReply)
        XCTAssertTrue(live.resolvable)
        XCTAssertFalse(live.resolved)

        XCTAssertNil(rendered.first { $0.id == "live:T2" }, "an outdated thread points at an older head: list only")
        XCTAssertNil(rendered.first { $0.id == "live:T3" }, "a file outside the diff has no line to sit on")

        let draft = try XCTUnwrap(rendered.first { $0.id == "live:T4" }, "a renamed file matches by its old path")
        XCTAssertEqual(draft.side, .deletions)
        XCTAssertEqual(draft.state, "draft", "my own new thread reads as a review draft")
        XCTAssertEqual(draft.live?.canReply, false, "a thread that is still my draft has nobody to reply to")
        XCTAssertEqual(draft.live?.resolvable, false)

        XCTAssertNil(open.live?.notes[0].authorUrl, "no forge, no profile link")
        let linked = PRThreadRendering.rendered(data.threads, files: files, forge: data.pr.forge, now: now)
        XCTAssertEqual(linked.first { $0.id == "live:T1" }?.live?.notes.map(\.authorUrl),
                       ["https://github.com/alice", "https://github.com/bob"], "each author links to their profile")

        XCTAssertNil(PRThreadRendering.rendered(data.threads, files: files, skip: ["T1"]).first { $0.id == "live:T1" },
                     "a thread the proposal already shows is not shown twice")
    }

    func testTheLiveResolvedStateWinsOverTheProposalsCopy() throws {
        let stale = RenderedComment(id: "thread:T4", fileId: "f2", side: .additions, startLine: 2, endLine: 2, body: "x",
                                    author: "@bob", when: "", state: "open", remote: true, kind: "thread")
        let other = RenderedComment(id: "draft:01", fileId: "f1", side: .additions, startLine: 1, endLine: 1, body: "y",
                                    author: "claude", when: "", state: "proposed", remote: false, kind: "draft")
        let refreshed = PRThreadRendering.refresh([stale, other], with: try payload().threads)
        XCTAssertEqual(refreshed[0].state, "resolved")
        XCTAssertEqual(refreshed[0].live?.notes.first?.id, "C5", "the proposal's card gets the live notes and buttons")
        XCTAssertEqual(refreshed[1], other, "a draft card is left alone")
    }

    /// The page's message, exactly as `renderLiveThread` posts it, down to the argv Swift runs.
    private func argv(_ message: [String: Any]) -> [String]? {
        ThreadActionInput(message: message).flatMap { PRCommand.threadAction($0, target: target, bodyFile: "/tmp/b.md") }
    }

    func testEveryCardButtonMessageBecomesItsArgv() {
        let pr = ["--pr", "https://github.com/acme/shop/pull/7"]
        XCTAssertEqual(argv(["type": "thread.action", "id": "live:PRRT_1", "action": "reply", "draft": true, "body": "Fixing it."]),
                       ["hub", "pr", "reply"] + pr + ["--thread", "PRRT_1", "--body-file", "/tmp/b.md", "--json", "--draft"])
        XCTAssertEqual(argv(["type": "thread.action", "id": "live:PRRT_1", "action": "reply", "draft": false, "body": "Fixing it."]),
                       ["hub", "pr", "reply"] + pr + ["--thread", "PRRT_1", "--body-file", "/tmp/b.md", "--json"])
        XCTAssertEqual(argv(["type": "thread.action", "id": "thread:PRRT_2", "action": "resolve"]),
                       ["hub", "pr", "resolve", "PRRT_2"] + pr + ["--json"], "a proposal's thread card resolves the same thread")
        XCTAssertEqual(argv(["type": "thread.action", "id": "live:PRRT_2", "action": "unresolve"]),
                       ["hub", "pr", "resolve", "PRRT_2"] + pr + ["--json", "--unresolve"])
        XCTAssertEqual(argv(["type": "thread.action", "id": "live:PRRT_1", "action": "note.update", "noteId": "PRRC_9", "body": "New text"]),
                       ["hub", "pr", "draft", "update", "PRRC_9"] + pr + ["--body-file", "/tmp/b.md", "--json"])
        XCTAssertEqual(argv(["type": "thread.action", "id": "live:PRRT_1", "action": "note.delete", "noteId": "PRRC_9"]),
                       ["hub", "pr", "draft", "delete", "PRRC_9"] + pr + ["--json"])

        XCTAssertNil(argv(["type": "thread.action", "id": "live:PRRT_1", "action": "note.delete"]), "a delete names its note")
        XCTAssertNil(argv(["type": "thread.action", "id": "c_12ab", "action": "resolve"]), "a local comment is no PR thread")
        XCTAssertNil(argv(["type": "thread.action", "id": "live:PRRT_1", "action": "publish"]), "a card cannot submit the review")
        XCTAssertNil(argv(["type": "comment.action", "id": "live:PRRT_1", "action": "resolve"]), "only thread.action messages count")
    }

    func testSwiftAsksBeforeAPostOrADeleteAndNothingElse() {
        XCTAssertEqual(ThreadActionInput(id: "live:t", action: .reply, draft: false).confirmation, .post)
        XCTAssertNil(ThreadActionInput(id: "live:t", action: .reply, draft: true).confirmation, "a draft only I see needs no question")
        XCTAssertEqual(ThreadActionInput(id: "live:t", action: .noteDelete, noteID: "n").confirmation, .deleteDraft)
        XCTAssertNil(ThreadActionInput(id: "live:t", action: .resolve).confirmation)
        XCTAssertNil(ThreadActionInput(id: "live:t", action: .noteUpdate, noteID: "n").confirmation)
    }

    func testAThreadCardButtonNamesItsThreadForBothCardKinds() {
        XCTAssertEqual(ThreadActionInput(id: "live:PRRT_1", action: .reply).threadID, "PRRT_1")
        XCTAssertEqual(ThreadActionInput(id: "thread:disc-9", action: .resolve).threadID, "disc-9")
        XCTAssertNil(ThreadActionInput(id: "c_12ab", action: .resolve).threadID, "a local comment is no PR thread")
        XCTAssertEqual(ThreadActionInput.Action(rawValue: "note.update"), .noteUpdate)
        XCTAssertNil(ThreadActionInput.Action(rawValue: "publish"), "the page has no way to ask for publish")
    }

    func testAFailedVerbPrintsItsErrorAndCode() throws {
        let failure = try JSONDecoder().decode(PRCLIError.self, from: Data(#"{"error":"not a draft","code":"not-a-draft"}"#.utf8))
        XCTAssertEqual(failure.code, "not-a-draft")
        XCTAssertEqual("\(failure)", "not a draft")
    }

    // MARK: proposal → target

    private func proposal(_ object: [String: Any]) throws -> ProposalDocument {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("pr-proposal-\(UUID().uuidString).json")
        try JSONSerialization.data(withJSONObject: object).write(to: url)
        return try ProposalDocument(url: url)
    }

    func testAProposalNamesItsPRByURLElseByItsWorktreeAndNumber() throws {
        XCTAssertEqual(try proposal(["url": "https://github.com/acme/shop/pull/7", "number": 7, "repoPath": "/work/shop"]).prTarget,
                       .ref("https://github.com/acme/shop/pull/7"))
        XCTAssertEqual(try proposal(["number": 7, "repoPath": "/work/review-shop"]).prTarget, .ref("/work/review-shop#7"),
                       "a detached review worktree names the PR by number")
        XCTAssertNil(try proposal(["number": 7]).prTarget)
        let identity = try proposal(["provider": "gitlab", "host": "gitlab.example.com", "project": "group/shop", "number": 12]).identity
        XCTAssertEqual(identity, PRIdentity(provider: "gitlab", host: "gitlab.example.com", project: "group/shop", number: 12))
    }
}
