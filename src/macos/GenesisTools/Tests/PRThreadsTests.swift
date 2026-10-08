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
        XCTAssertEqual(PRCommand.threads(.ref("/work/shop#7")),
                       ["hub", "pr", "threads", "--pr", "/work/shop#7", "--json", "--max-cache-age", "30"])
    }

    func testThePublishArgvPerEvent() {
        XCTAssertEqual(PRCommand.publish(target, event: .comment, bodyFile: nil),
                       ["hub", "pr", "publish", "--pr", "https://github.com/acme/shop/pull/7", "--json"])
        XCTAssertEqual(PRCommand.publish(target, event: .approve, bodyFile: "/tmp/s.md"),
                       ["hub", "pr", "publish", "--pr", "https://github.com/acme/shop/pull/7", "--approve", "--body-file", "/tmp/s.md", "--json"])
        XCTAssertEqual(PRCommand.publish(target, event: .requestChanges, bodyFile: nil),
                       ["hub", "pr", "publish", "--pr", "https://github.com/acme/shop/pull/7", "--request-changes", "--json"])
    }

    /// `tools gitlab draft-reply --file --line --now` (now `gitlab pr <iid> comments add`) was refused by that command ("--now can only be used
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
              "url":"https://github.com/acme/shop/pull/7#discussion_r11",
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
        XCTAssertEqual(live.notes.map(\.url), ["https://github.com/acme/shop/pull/7#discussion_r11", nil],
                       "the card's time links to the comment on the host; a draft has no page yet")
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
        let refreshed = PRThreadRendering.refresh([stale, other], with: try payload().threads, files: files)
        XCTAssertEqual(refreshed[0].state, "draft")
        XCTAssertEqual(refreshed[0].side, .deletions)
        XCTAssertEqual(refreshed[0].fileId, "f2")
        XCTAssertEqual(refreshed[0].startLine, 2)
        XCTAssertEqual(PRThreadRendering.refresh([stale, other], with: [], files: files), [other])
        XCTAssertEqual(PRThreadRendering.refresh([stale, other], with: try payload().threads, files: []), [other])
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

    func testSubmissionReceiptReconcilesOnlyConfirmedOwnedProposalIDs() throws {
        let doc = try proposal([
            "provider": "github", "host": "github.com", "project": "acme/shop", "number": 7,
            "drafts": [
                ["id": "d1", "path": "a", "line": 1, "status": "drafted", "providerId": "remote1"],
                ["id": "d2", "path": "a", "line": 2, "status": "drafted", "providerId": "remote2"]
            ],
            "threads": [["threadId": "t1", "path": "a", "line": 1, "replyStatus": "drafted", "providerId": "remote3"]]
        ])
        var other = doc.identity
        other.number += 1
        try doc.reconcileSubmitted(pr: other, ids: ["remote1", "remote3"])
        XCTAssertEqual(doc.drafts.map(\.status), ["drafted", "drafted"])
        try doc.reconcileSubmitted(pr: doc.identity, ids: ["remote1", "remote3"])
        XCTAssertEqual(doc.drafts.map(\.status), ["posted", "drafted"])
        XCTAssertEqual(doc.threads.first?.replyStatus, "posted")
    }

    func testProposalLineDraftRequiresTheReviewedHeadAndPR() throws {
        let doc = try proposal(["provider": "github", "host": "github.com", "project": "acme/shop", "number": 7, "headSha": "reviewed"])
        XCTAssertTrue(doc.permitsDraftSend(displayedHead: "reviewed", pr: doc.identity))
        XCTAssertFalse(doc.permitsDraftSend(displayedHead: "new-head", pr: doc.identity))
        XCTAssertFalse(doc.permitsDraftSend(displayedHead: "", pr: doc.identity))
        XCTAssertFalse(doc.permitsDraftSend(displayedHead: "reviewed", pr: nil))
    }

    func testProposalMovedThreadKeepsAnalysisAtTheLiveAnchor() throws {
        let doc = try proposal(["threads": [[
            "threadId": "T4", "path": "gone.ts", "line": 90, "body": "Original point", "author": "bob",
            "meta": ["verdict": "valid", "proof": "fixture proof"], "suggestedReply": "Edited wording"
        ]]])
        let rows = doc.rendered(for: files, liveThreads: try payload().threads)
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.fileId, "f2")
        XCTAssertEqual(rows.first?.side, .deletions)
        XCTAssertEqual(rows.first?.endLine, 2)
        XCTAssertEqual(rows.first?.body, "Original point")
        XCTAssertEqual(rows.first?.reply, "Edited wording")
        XCTAssertTrue(doc.rendered(for: files, liveThreads: []).isEmpty)
    }

    /// One live thread with the commit its lines belong to.
    private func thread(_ id: String, line: Int, outdated: Bool, commit: String?) throws -> PRThread {
        let sha = commit.map { "\"commitSha\":\"\($0)\"," } ?? ""
        let json = """
        {"id":"\(id)","path":"src/cart.ts","side":"additions","line":\(line),\(sha)"outdated":\(outdated),"resolved":false,"resolvable":true,
         "comments":[{"id":"N\(id)","author":{"name":"Alice","username":"alice"},"bodyMarkdown":"Point","createdAt":"2026-09-20T10:00:00Z","isDraft":false}]}
        """
        return try JSONDecoder().decode(PRThread.self, from: Data(json.utf8))
    }

    func testOnADiffPinnedToACommitOnlyThatCommitsThreadsSitOnLines() throws {
        let onShown = try thread("A", line: 5, outdated: true, commit: "aaa1111")
        let moved = try thread("B", line: 40, outdated: false, commit: "bbb2222")
        // The working-tree scopes keep the old rule.
        XCTAssertFalse(PRThreadRendering.belongs(onShown, shownHead: nil, prHead: "bbb2222"))
        XCTAssertTrue(PRThreadRendering.belongs(moved, shownHead: nil, prHead: "bbb2222"))
        // A proposal's range at aaa1111 after a push to bbb2222: the thread made on aaa1111 is
        // "outdated" for the PR but its lines are the ones on screen; the moved one's are not.
        XCTAssertTrue(PRThreadRendering.belongs(onShown, shownHead: "aaa1111ffff", prHead: "bbb2222"))
        XCTAssertFalse(PRThreadRendering.belongs(moved, shownHead: "aaa1111ffff", prHead: "bbb2222"))
        // The diff shows the PR's head: every current thread belongs.
        XCTAssertTrue(PRThreadRendering.belongs(moved, shownHead: "bbb2222", prHead: "bbb2222"))
        let rendered = PRThreadRendering.rendered([onShown, moved], files: files, shownHead: "aaa1111", prHead: "bbb2222")
        XCTAssertEqual(rendered.map(\.id), ["live:A"])
        XCTAssertEqual(rendered.first?.endLine, 5)
        XCTAssertEqual(DiffScope.range(base: "base000", head: "aaa1111", label: "!7").pinnedHead, "aaa1111")
        XCTAssertNil(DiffScope.range(base: "origin/main", head: "HEAD", label: "x").pinnedHead)
        XCTAssertNil(DiffScope.uncommitted.pinnedHead)
    }

    func testAPushAfterTheProposalKeepsItsCardOnTheProposalsOwnLine() throws {
        let doc = try proposal(["headSha": "aaa1111", "threads": [[
            "threadId": "B", "path": "src/cart.ts", "line": 5, "body": "Original point", "author": "alice",
            "meta": ["verdict": "valid", "proof": "fixture proof"]
        ]]])
        // GitLab moved the thread to the new head's line 40 after a push.
        let live = [try thread("B", line: 40, outdated: false, commit: "bbb2222")]
        let rows = doc.rendered(for: files, liveThreads: live, shownHead: "aaa1111", prHead: "bbb2222")
        XCTAssertEqual(rows.map(\.endLine), [5], "the line the proposal read on this very diff")
        let kept = PRThreadRendering.refresh(rows, with: live, files: files, shownHead: "aaa1111", prHead: "bbb2222", proposalOnShownHead: true)
        XCTAssertEqual(kept.map(\.endLine), [5])
        XCTAssertEqual(kept.first?.live?.notes.first?.id, "NB", "the card keeps the live notes and its Reply")
        // On another commit the proposal's line means nothing: no card.
        XCTAssertTrue(doc.rendered(for: files, liveThreads: live, shownHead: "ccc3333", prHead: "bbb2222").isEmpty)
        XCTAssertTrue(PRThreadRendering.refresh(rows, with: live, files: files, shownHead: "ccc3333", prHead: "bbb2222").isEmpty)
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

    // MARK: threads list

    func testTheListExplainsAnOutdatedThreadByTheCommitOnScreen() throws {
        let onShown = try thread("A", line: 5, outdated: true, commit: "aaa1111")
        let moved = try thread("B", line: 40, outdated: false, commit: "bbb2222")
        let gone = try thread("C", line: 9, outdated: true, commit: "ccc3333")
        XCTAssertEqual(PRThreadPlacement.of(onShown, shownHead: "aaa1111", prHead: "bbb2222"), .onDiff(outdatedOnHost: true),
                       "outdated on the host, but written on the commit the diff shows: current here")
        XCTAssertEqual(PRThreadPlacement.of(moved, shownHead: "aaa1111", prHead: "bbb2222"), .newerHead)
        XCTAssertEqual(PRThreadPlacement.of(gone, shownHead: "aaa1111", prHead: "bbb2222"), .outdated)
        XCTAssertEqual(PRThreadPlacement.of(moved, shownHead: nil, prHead: "bbb2222"), .onDiff(outdatedOnHost: false))
        XCTAssertEqual(PRThreadPlacement.of(onShown, shownHead: nil, prHead: "bbb2222"), .outdated,
                       "the working tree is not the commit it was written on")
    }

    private func thread(_ id: String, path: String, line: Int, startLine: Int? = nil) throws -> PRThread {
        let start = startLine.map { "\"startLine\":\($0)," } ?? ""
        let json = """
        {"id":"\(id)","path":"\(path)","side":"additions","line":\(line),\(start)"outdated":false,"resolved":false,"resolvable":true,
         "comments":[{"id":"N\(id)","author":{"name":"Alice","username":"alice","avatarUrl":"https://example.com/a.png"},
         "bodyMarkdown":"Point","createdAt":"2026-09-20T10:00:00Z","isDraft":false}]}
        """
        return try JSONDecoder().decode(PRThread.self, from: Data(json.utf8))
    }

    func testThreadsGroupByFileInTheDiffsOrderAndByLine() throws {
        let threads = [
            try thread("1", path: "src/b.ts", line: 30),
            try thread("2", path: "src/a.ts", line: 12),
            try thread("3", path: "docs/z.md", line: 1),
            try thread("4", path: "src/b.ts", line: 4, startLine: 2),
        ]
        let groups = PRThreadFileGroup.groups(threads, order: ["src/b.ts": 0, "src/a.ts": 1])
        XCTAssertEqual(groups.map(\.path), ["src/b.ts", "src/a.ts", "docs/z.md"], "diff order first, files outside the diff after")
        XCTAssertEqual(groups[0].threads.map(\.id), ["4", "1"], "by line inside a file")
        XCTAssertEqual(groups[0].name, "b.ts")
        XCTAssertEqual(groups[0].folder, "src")
        XCTAssertEqual(PRThreadFileGroup.lineLabel(groups[0].threads[0]), "L2–4")
        XCTAssertEqual(PRThreadFileGroup.lineLabel(groups[0].threads[1]), "L30")
        XCTAssertEqual(PRThreadFileGroup.wrappable("packages/col/src").replacingOccurrences(of: "\u{200B}", with: ""), "packages/col/src",
                       "the wrap points add no visible text")
    }

    // MARK: references, head files, card clicks

    private let gitlab = ForgeWeb(kind: "gitlab", web: "https://gitlab.example.com/group/shop")
    private let github = ForgeWeb(kind: "github", web: "https://github.com/acme/shop")

    func testCommitIdsLinkToTheHostAsCode() {
        let text = "Jo, `phase2.md` odsud vyhodím, zůstane jen na oracle větvi (44a8c867b4)."
        XCTAssertEqual(PRRefLinker.linkify(text, forge: gitlab),
                       "Jo, `phase2.md` odsud vyhodím, zůstane jen na oracle větvi ([`44a8c867b4`](https://gitlab.example.com/group/shop/-/commit/44a8c867b4)).")
        XCTAssertEqual(PRRefLinker.linkify("see 44a8c867b4ff", forge: github), "see [`44a8c867b4ff`](https://github.com/acme/shop/commit/44a8c867b4ff)")
        for plain in ["deadbeef cafe", "1234567 rows", "a facade", "abc123", "`44a8c867b4` stays code", "https://x.org/44a8c867b4", "[44a8c867b4](https://x.org)", "path/44a8c867b4/file"] {
            XCTAssertEqual(PRRefLinker.linkify(plain, forge: gitlab), plain, "\"\(plain)\" is not a bare commit id")
        }
        let fenced = "```\n44a8c867b4 !12\n```\nafter 44a8c867b4"
        XCTAssertEqual(PRRefLinker.linkify(fenced, forge: gitlab),
                       "```\n44a8c867b4 !12\n```\nafter [`44a8c867b4`](https://gitlab.example.com/group/shop/-/commit/44a8c867b4)",
                       "a fenced block is code")
        XCTAssertEqual(PRRefLinker.linkify("44a8c867b4", forge: nil), "44a8c867b4", "no host, no links")
    }

    func testPRReferencesLinkPerHost() {
        XCTAssertEqual(PRRefLinker.linkify("move them into !7467.", forge: gitlab),
                       "move them into [!7467](https://gitlab.example.com/group/shop/-/merge_requests/7467).")
        XCTAssertEqual(PRRefLinker.linkify("see #12 and !3", forge: gitlab), "see #12 and [!3](https://gitlab.example.com/group/shop/-/merge_requests/3)",
                       "GitLab's #12 is an issue")
        XCTAssertEqual(PRRefLinker.linkify("see #12 and !3", forge: github), "see [#12](https://github.com/acme/shop/pull/12) and !3")
        XCTAssertEqual(PRRefLinker.linkify("in other/tools!8", forge: gitlab),
                       "in [other/tools!8](https://gitlab.example.com/other/tools/-/merge_requests/8)")
        XCTAssertEqual(PRRefLinker.linkify("in owner/repo#9", forge: github), "in [owner/repo#9](https://github.com/owner/repo/pull/9)")
        for plain in ["wow!12", "a#12", "# 12 heading", "`!12`"] {
            XCTAssertEqual(PRRefLinker.linkify(plain, forge: gitlab), plain)
        }
    }

    func testAPRLinkAsksWhereToOpenAndOtherLinksDoNot() throws {
        let mr = try XCTUnwrap(PRRefMenu.target(XCTUnwrap(URL(string: "https://gitlab.example.com/group/shop/-/merge_requests/7460#note_1"))))
        XCTAssertEqual(mr, PRRefMenu.Target(url: "https://gitlab.example.com/group/shop/-/merge_requests/7460", number: 7460, gitlab: true))
        XCTAssertEqual(mr.label, "!7460")
        XCTAssertEqual(try PRRefMenu.target(XCTUnwrap(URL(string: "https://github.com/acme/shop/pull/12")))?.label, "#12")
        XCTAssertNil(try PRRefMenu.target(XCTUnwrap(URL(string: "https://github.com/acme/shop/pull/12/files"))), "a PR's tab is a page")
        XCTAssertNil(try PRRefMenu.target(XCTUnwrap(URL(string: "https://gitlab.example.com/group/shop/-/commit/44a8c867b4"))))
    }

    func testAThreadsFileIsRemovedOrRenamedAtTheHead() {
        let renames = PRHeadPresence.renames("R087\tdocs/old.md\tdocs/new.md\nM\tsrc/a.ts\nR100\tx.ts\ty.ts")
        XCTAssertEqual(renames, ["docs/old.md": "docs/new.md", "x.ts": "y.ts"])
        let decided = PRHeadPresence.decide(paths: ["src/a.ts", "docs/old.md", "refs/phase2.md"], present: ["src/a.ts"], renames: renames)
        XCTAssertEqual(decided, ["src/a.ts": .present, "docs/old.md": .renamed(to: "docs/new.md"), "refs/phase2.md": .removed])
        XCTAssertEqual(PRHeadFiles.key(repo: "/r", head: "h", paths: ["b", "a"]), PRHeadFiles.key(repo: "/r", head: "h", paths: ["a", "b"]),
                       "one answer per set of files, whatever their order")
    }

    @MainActor
    func testHeadFileAnswersDependOnTheDisplayedCommitAndRetryMissingHeads() async {
        XCTAssertNotEqual(PRHeadFiles.key(repo: "/r", head: "head", shown: "old", paths: ["a"]),
                          PRHeadFiles.key(repo: "/r", head: "head", shown: "older", paths: ["a"]))
        let lock = NSLock()
        var reads = 0
        let retry = PRHeadFiles(readGit: { _, _ in
            lock.withLock {
                reads += 1
                return reads == 1 ? nil : "a\n"
            }
        })
        await retry.load(repo: "/r", head: "head", shown: "old", paths: ["a"])?.value
        XCTAssertNil(retry.status(repo: "/r", head: "head", shown: "old", paths: ["a"]))
        await retry.load(repo: "/r", head: "head", shown: "old", paths: ["a"])?.value
        XCTAssertEqual(retry.status(repo: "/r", head: "head", shown: "old", paths: ["a"]), ["a": .present])
        XCTAssertNil(retry.load(repo: "/r", head: "head", shown: "old", paths: ["a"]), "successful answers stay cached")
        XCTAssertEqual(lock.withLock { reads }, 2)

        let renamed = PRHeadFiles(readGit: { _, args in
            args.first == "ls-tree" ? "" : "R100\ta\t\(args[args.count - 2])-name\n"
        })
        await renamed.load(repo: "/r", head: "head", shown: "old", paths: ["a"])?.value
        await renamed.load(repo: "/r", head: "head", shown: "older", paths: ["a"])?.value
        XCTAssertEqual(renamed.status(repo: "/r", head: "head", shown: "old", paths: ["a"]), ["a": .renamed(to: "old-name")])
        XCTAssertEqual(renamed.status(repo: "/r", head: "head", shown: "older", paths: ["a"]), ["a": .renamed(to: "older-name")])
    }

    func testOnlyAPlainSingleClickOnACardJumps() {
        XCTAssertTrue(PRThreadCardClick.jumps(clickCount: 1, laterClick: false, selectedText: false))
        XCTAssertFalse(PRThreadCardClick.jumps(clickCount: 2, laterClick: false, selectedText: false), "a double-click selects a word")
        XCTAssertFalse(PRThreadCardClick.jumps(clickCount: 1, laterClick: true, selectedText: false), "the first click of a double-click")
        XCTAssertFalse(PRThreadCardClick.jumps(clickCount: 1, laterClick: false, selectedText: true), "a drag that selected text")
    }

    func testInlineCodeGetsItsFillAndTheLinkedNoteKeepsItsOwnText() throws {
        let styled = MarkdownContentView.inline("a `code` b", codeBackground: .red)
        let filled = styled.runs.filter { $0.backgroundColor != nil }.map { String(styled[$0.range].characters) }
        XCTAssertEqual(filled, ["code"])
        let note = PRThreadRendering.live(try thread("1", path: "src/a.ts", line: 3), forge: gitlab).notes[0]
        XCTAssertNil(note.display, "nothing to link: the page renders the body")
        XCTAssertEqual(PRThreadRendering.display("fixed in 44a8c867b4", forge: gitlab),
                       "fixed in [`44a8c867b4`](https://gitlab.example.com/group/shop/-/commit/44a8c867b4)")
    }

    func testTheAuthorsPictureReachesTheDiffCard() throws {
        let live = PRThreadRendering.live(try thread("1", path: "src/a.ts", line: 3))
        XCTAssertEqual(live.notes.map(\.avatarUrl), ["https://example.com/a.png"])
        XCTAssertEqual(UserAvatar.tint(for: "alice"), UserAvatar.tint(for: "alice"), "one tint per person, run after run")
    }

    // MARK: code blocks in notes

    func testAFencesLanguageComesFromItsFirstWord() {
        XCTAssertEqual(MarkdownContentView.fenceLanguage("ts"), .typescript)
        XCTAssertEqual(MarkdownContentView.fenceLanguage("TSX"), .typescript)
        XCTAssertEqual(MarkdownContentView.fenceLanguage("tsx title=\"Button.tsx\""), .typescript)
        XCTAssertEqual(MarkdownContentView.fenceLanguage("js"), .javascript)
        XCTAssertEqual(MarkdownContentView.fenceLanguage("json"), .json)
        XCTAssertEqual(MarkdownContentView.fenceLanguage("swift"), .swift)
        XCTAssertEqual(MarkdownContentView.fenceLanguage("bash"), .shell)
        XCTAssertEqual(MarkdownContentView.fenceLanguage("Shell"), .shell)
        XCTAssertEqual(MarkdownContentView.fenceLanguage("yml"), .yaml)
        XCTAssertEqual(MarkdownContentView.fenceLanguage(""), .plain, "an unlabelled fence gets no colour")
        XCTAssertEqual(MarkdownContentView.fenceLanguage("text"), .plain)
    }

    func testATypeScriptBlockIsColouredAndKeepsItsText() {
        let code = "const total = sum(items) // why\nreturn \"done\""
        let styled = MarkdownContentView.highlighted(code, info: "ts")
        XCTAssertEqual(String(styled.characters), code, "colour only: the text and its lines are the same")
        let coloured = styled.runs.filter { $0.foregroundColor != nil }.map { String(styled[$0.range].characters) }
        XCTAssertTrue(coloured.contains("const"), "the keyword is coloured: \(coloured)")
        XCTAssertTrue(coloured.contains("// why"), "the comment is coloured: \(coloured)")
        XCTAssertTrue(coloured.contains("\"done\""), "the string is coloured: \(coloured)")
        XCTAssertTrue(MarkdownContentView.highlighted(code, info: "").runs.allSatisfy { $0.foregroundColor == nil }, "plain stays plain")
    }
}
