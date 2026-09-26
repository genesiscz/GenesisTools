import XCTest
@testable import GenesisTools

/// The Activity mode's pure rules: the range presets, the `tools hub timeline` arguments a page is
/// asked with, the client-side filters, the day and hour grouping, the detail envelopes per kind
/// (src/hub/lib/timeline-detail.ts) and the mode switch's per-segment tooltips.
final class HubTimelineTests: XCTestCase {
    private let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Prague") ?? .current
        return calendar
    }()

    private func date(_ iso: String) -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: iso) ?? .distantPast
    }

    private func event(_ id: String, kind: String, at: String, project: String? = "app", mine: Bool? = nil, needsMe: Bool? = nil, title: String = "t") throws -> TimelineEvent {
        let json = """
        { "id": "\(id)", "kind": "\(kind)", "at": "\(at)", "title": "\(title)", "detail": "d", "project": \(project.map { "\"\($0)\"" } ?? "null"), "repo": null,
          "mine": \(mine.map(String.init) ?? "null"), "needsMe": \(needsMe.map(String.init) ?? "null") }
        """
        return try JSONDecoder().decode(TimelineEvent.self, from: Data(json.utf8))
    }

    // MARK: Ranges

    func testRangePresetsCoverWholeLocalDays() {
        let now = date("2026-03-02T14:00:00Z")
        let today = calendar.startOfDay(for: now)
        let none = TimelineRange.today.interval(now: now, lastVisit: nil, customFrom: now, customTo: now, calendar: calendar)
        XCTAssertEqual(none.start, today)
        XCTAssertEqual(none.end, now)

        let yesterday = TimelineRange.yesterday.interval(now: now, lastVisit: nil, customFrom: now, customTo: now, calendar: calendar)
        XCTAssertEqual(yesterday.start, calendar.date(byAdding: .day, value: -1, to: today))
        XCTAssertLessThan(yesterday.end, today)
        XCTAssertGreaterThan(yesterday.end, today.addingTimeInterval(-1))

        let week = TimelineRange.last7.interval(now: now, lastVisit: nil, customFrom: now, customTo: now, calendar: calendar)
        XCTAssertEqual(calendar.dateComponents([.day], from: week.start, to: today).day, 6, "seven days including today")

        let hour = TimelineRange.lastHour.interval(now: now, lastVisit: nil, customFrom: now, customTo: now, calendar: calendar)
        XCTAssertEqual(hour.duration, 3600)

        // Just after midnight "today" is nearly empty; the rolling day still holds yesterday evening.
        let justAfterMidnight = date("2026-03-02T23:49:00Z")
        let day = TimelineRange.last24h.interval(now: justAfterMidnight, lastVisit: nil, customFrom: now, customTo: now, calendar: calendar)
        XCTAssertEqual(day.duration, 86_400)
        XCTAssertEqual(day.end, justAfterMidnight)
        XCTAssertEqual(TimelineRange.fallback, .last24h)
        XCTAssertEqual(TimelineRange.allCases.prefix(3), [.lastHour, .last24h, .today])
    }

    func testSinceLastVisitFallsBackToTheLast24HoursWithoutAnEarlierVisit() {
        let now = date("2026-03-02T14:00:00Z")
        let visited = date("2026-02-27T09:30:00Z")
        let known = TimelineRange.sinceLastVisit.interval(now: now, lastVisit: visited, customFrom: now, customTo: now, calendar: calendar)
        XCTAssertEqual(known.start, visited)
        let unknown = TimelineRange.sinceLastVisit.interval(now: now, lastVisit: nil, customFrom: now, customTo: now, calendar: calendar)
        XCTAssertEqual(unknown.start, now.addingTimeInterval(-86_400))
        let future = TimelineRange.sinceLastVisit.interval(now: now, lastVisit: now.addingTimeInterval(60), customFrom: now, customTo: now, calendar: calendar)
        XCTAssertEqual(future.start, now.addingTimeInterval(-86_400), "a clock that went backwards is not a range")
        XCTAssertEqual(TimelineRange.sinceLastVisit.title, "Since last visit")
    }

    @MainActor
    func testAFreshStoreShowsEveryKindOverTheLast24HoursAndASavedChoiceStays() {
        HubDefaults.isolate()
        for key in ["hub.timeline.hidden", "hub.timeline.range"] {
            HubDefaults.store.removeObject(forKey: key)
        }
        let fresh = HubTimelineModel()
        XCTAssertTrue(fresh.hidden.isEmpty, "every kind is shown until the user hides one")
        XCTAssertEqual(fresh.range, .last24h)

        HubDefaults.store.set(["commit"], forKey: "hub.timeline.hidden")
        HubDefaults.store.set(TimelineRange.today.rawValue, forKey: "hub.timeline.range")
        let saved = HubTimelineModel()
        XCTAssertEqual(saved.hidden, ["commit"])
        XCTAssertEqual(saved.range, .today)
        for key in ["hub.timeline.hidden", "hub.timeline.range"] {
            HubDefaults.store.removeObject(forKey: key)
        }
    }

    func testCustomRangeIsWholeDaysInEitherOrderAndNeverInTheFuture() {
        let now = date("2026-03-02T14:00:00Z")
        let from = date("2026-02-20T16:00:00Z")
        let to = date("2026-02-24T08:00:00Z")
        let forward = TimelineRange.custom.interval(now: now, lastVisit: nil, customFrom: from, customTo: to, calendar: calendar)
        let backward = TimelineRange.custom.interval(now: now, lastVisit: nil, customFrom: to, customTo: from, calendar: calendar)
        XCTAssertEqual(forward, backward)
        XCTAssertEqual(forward.start, calendar.startOfDay(for: from))
        XCTAssertEqual(calendar.component(.hour, from: forward.end), 23)
        let open = TimelineRange.custom.interval(now: now, lastVisit: nil, customFrom: from, customTo: now.addingTimeInterval(86_400 * 3), calendar: calendar)
        XCTAssertEqual(open.end, now)
    }

    func testTheMidnightHourHasAnIdOfItsOwnBesideItsDay() throws {
        // Prague local: 01:04 and 00:30 on 2 March, 23:10 on 1 March.
        let events = try [
            event("late", kind: "session.turn", at: "2026-03-02T00:04:00Z"),
            event("midnight", kind: "commit", at: "2026-03-01T23:30:00Z"),
            event("before", kind: "push", at: "2026-03-01T22:10:00Z"),
        ]
        let days = TimelineDay.group(events, calendar: calendar)
        XCTAssertEqual(days.map { $0.hours.map { $0.events.map(\.id) } }, [[["late"], ["midnight"]], [["before"]]])

        let midnight = days[0].hours[1]
        XCTAssertEqual(midnight.hour, days[0].day, "the 00:00 group starts at its day's own start")
        // One lazy list holds the day sections and their hour groups: a shared id drew the 00:00 header blank.
        let ids = days.map(\.id) + days.flatMap { $0.hours.map(\.id) }
        XCTAssertEqual(Set(ids).count, ids.count, "ids: \(ids)")
    }

    // MARK: Open in the diff

    func testLaunchFlagsCarryATimelineOpenAndTextSettings() {
        let request = HubRequest(["--mode", "timeline", "--timeline-open", "thread:c1", "--timeline-action", "diff",
                                  "--set", "hub.timeline.range=last30", "--set", "review.prThreads.open=true"])
        XCTAssertEqual(request.timelineOpen, "thread:c1")
        XCTAssertEqual(request.timelineAction, "diff")
        XCTAssertEqual(request.textSettings, ["hub.timeline.range": "last30"])
        XCTAssertEqual(request.settings, ["review.prThreads.open": true])
        XCTAssertEqual(TimelineRange(rawValue: "last30"), .last30, "the value a snapshot passes is a range's raw value")
    }

    func testPaletteAndFindTakeTheirTextOnlyWhenOneFollows() {
        let bare = HubRequest(["--palette", "--snapshot", "/tmp/x.png"])
        XCTAssertEqual(bare.palette, "")
        XCTAssertEqual(bare.snapshotPath, "/tmp/x.png", "the next flag is not the palette's text")
        XCTAssertTrue(bare.isScripted)
        let texts = HubRequest(["--palette", "gt pr 424", "--find", "needle"])
        XCTAssertEqual(texts.palette, "gt pr 424")
        XCTAssertEqual(texts.find, "needle")
        XCTAssertEqual(HubRequest(["--find"]).find, "")
    }

    private func pr(number: Int) throws -> HubPR {
        let json = """
        {"repo":"app","repoRoot":null,"origin":{"kind":"github","host":"h","web":"https://github.com/acme/app"},
         "number":\(number),"title":"t","state":"OPEN","draft":false,"author":"alice","headBranch":"feature/widgets","baseBranch":"develop",
         "url":"https://github.com/acme/app/pull/\(number)","labels":[],"reviewers":[],"headSha":null,"crossRepository":false,"headRepo":null}
        """
        return try JSONDecoder().decode(HubPR.self, from: Data(json.utf8))
    }

    /// One click: the reveal waits while the list, the head fetch or the review of its PR is not in,
    /// and a different PR picked meanwhile drops it.
    @MainActor
    func testARevealWaitsForItsOwnPRAndAnotherPickDropsIt() throws {
        HubDefaults.isolate()
        let model = PRsModel()
        let ref = try XCTUnwrap(HubPRRef("acme/app#7"))
        model.request(ref, reveal: PRReveal(ref: ref, path: "src/parse.ts", threadID: "T1"))
        XCTAssertEqual(model.pendingReveal, PRReveal(ref: ref, path: "src/parse.ts", threadID: "T1"), "no list and no review yet: it waits")

        model.select(try pr(number: 7))
        XCTAssertNotNil(model.pendingReveal, "its PR, but no review built yet")
        model.select(try pr(number: 8))
        XCTAssertNil(model.pendingReveal, "another PR picked: the reveal is dropped")
    }

    @MainActor
    func testTheThreadCardIsFocusedOnlyOnceThePageHoldsIt() {
        let card = RenderedComment(id: PRThreadRendering.cardID(thread: "T1"), fileId: "src/parse.ts", side: .additions, startLine: 12, endLine: 12,
                                   body: "b", author: "@bob", when: "", state: "open", remote: true, kind: "thread")
        XCTAssertEqual(card.id, "live:T1")
        XCTAssertNil(ReviewModel.cardToFocus("live:T1", rendered: false, cards: [card]), "the diff is not drawn yet")
        XCTAssertNil(ReviewModel.cardToFocus("live:T1", rendered: true, cards: []), "the threads are not in yet")
        XCTAssertEqual(ReviewModel.cardToFocus("live:T1", rendered: true, cards: [card]), "live:T1")
        XCTAssertNil(ReviewModel.cardToFocus(nil, rendered: true, cards: [card]))
    }

    // MARK: CLI arguments

    func testPageArgumentsCarryTheRangeCursorAndFilters() {
        let interval = DateInterval(start: date("2026-03-02T00:00:00Z"), end: date("2026-03-02T14:00:00Z"))
        let live = HubTimelineModel.arguments(interval: interval, before: nil, limit: 200, author: .all, needsMe: false, fresh: false)
        XCTAssertEqual(live, ["hub", "timeline", "--json", "--since", "2026-03-02T00:00:00.000Z", "--until", "2026-03-02T14:00:00.000Z", "--limit", "200"])

        let older = HubTimelineModel.arguments(interval: interval, before: "2026-03-02T10:00:00.000Z", limit: 200, author: .me, needsMe: true, fresh: true)
        XCTAssertEqual(older.suffix(6), ["--before", "2026-03-02T10:00:00.000Z", "--author", "me", "--needs-me", "--fresh"])
        XCTAssertFalse(older.contains("--kinds"), "hidden kinds stay a client-side switch, so toggling one never reloads")
    }

    // MARK: Filters and grouping

    @MainActor
    func testShownAppliesKindsProjectFilterAndFindText() throws {
        HubDefaults.isolate()
        for key in ["hub.timeline.hidden", "hub.timeline.project", "hub.timeline.range", "hub.timeline.author", "hub.timeline.needsMe"] {
            HubDefaults.store.removeObject(forKey: key)
        }
        let model = HubTimelineModel()
        let envelope = try JSONDecoder().decode(TimelineEnvelope.self, from: Data(sampleFeed.utf8))
        XCTAssertEqual(envelope.hasMore, true)
        XCTAssertEqual(envelope.nextBefore, "2026-03-02T10:00:00.000Z")
        XCTAssertEqual(envelope.truncated, ["app commits"])
        let events = envelope.events
        XCTAssertEqual(events.map(\.timelineKind), [.session, .decision, .ci, .thread, .commit, .push])

        // Every label a row shows is searchable, lowercased.
        XCTAssertTrue(events[4].searchText.contains("feat: parser"))
        XCTAssertTrue(events[4].searchText.contains("aaaaaaaa"))
        XCTAssertTrue(events[3].searchText.contains("acme/app#7"))
        XCTAssertTrue(events[3].searchText.contains("review comments"))
        XCTAssertTrue(events[1].waitsForMe)
        XCTAssertTrue(events[2].isMine)
        XCTAssertFalse(events[3].isMine)
        XCTAssertEqual(events[5].fromSha, String(repeating: "0", count: 40))
        XCTAssertEqual(events[3].threadId, "t1")
        XCTAssertEqual(events[3].line, 12)

        let days = TimelineDay.group(events, calendar: calendar)
        XCTAssertEqual(days.count, 1)
        // 12:30Z and 12:15Z share one local hour (Prague), the other four rows stand alone.
        XCTAssertEqual(days[0].hours.map { $0.events.count }, [1, 2, 1, 1, 1])
        XCTAssertEqual(days[0].title(now: date("2026-03-02T15:00:00Z"), calendar: calendar), "Today")
        XCTAssertEqual(days[0].title(now: date("2026-03-03T15:00:00Z"), calendar: calendar), "Yesterday")
        XCTAssertEqual(TimelineDay.group([], calendar: calendar).count, 0)

        // Detail kinds: both session rows load the one `session` detail.
        XCTAssertEqual(TimelineKind.sessionStart.detailKind, "session")
        XCTAssertEqual(TimelineKind.session.detailKind, "session")
        XCTAssertEqual(TimelineKind.ci.detailKind, "ci")

        let args = model.detailArguments(for: events[3], fresh: false)
        XCTAssertEqual(Array(args.prefix(8)), ["hub", "timeline", "detail", "--json", "--kind", "thread", "--id", "thread:c-today"])
        let prIndex = try XCTUnwrap(args.firstIndex(of: "--pr"))
        XCTAssertEqual(args[prIndex + 1], "https://github.com/acme/app/pull/7")
        let pushArgs = model.detailArguments(for: events[5], fresh: true, file: nil)
        let fromIndex = try XCTUnwrap(pushArgs.firstIndex(of: "--from"))
        XCTAssertEqual(pushArgs[fromIndex + 1], String(repeating: "0", count: 40))
        XCTAssertEqual(pushArgs.last, "--fresh")
        let sessionArgs = model.detailArguments(for: events[0], fresh: false)
        let sessionIndex = try XCTUnwrap(sessionArgs.firstIndex(of: "--session"))
        XCTAssertEqual(sessionArgs[sessionIndex + 1], "s-alpha")
        XCTAssertFalse(sessionArgs.contains("--pr"))
    }

    // MARK: Detail envelopes

    func testDetailEnvelopesDecodeByKind() throws {
        let session = """
        { "kind": "session", "sessionId": "s-alpha", "provider": "claude", "filePath": "/tmp/s.jsonl", "since": "2026-03-02T00:00:00.000Z", "until": "2026-03-02T14:00:00.000Z",
          "turns": 5, "prompts": [{ "index": 2, "at": "2026-03-02T10:00:00.000Z", "text": "Fix the parser cache please" }], "promptsTotal": 2,
          "lastReply": { "at": "2026-03-02T10:32:00.000Z", "text": "Shipped." }, "files": [{ "path": "/tmp/app/parse.ts", "via": "edit", "edits": 3, "agents": 0 }], "filesTotal": 1,
          "subagents": [{ "id": "agent-1", "name": "fixer", "description": "fix the cache", "agentType": "general-purpose", "state": "done", "lastAt": "2026-03-02T10:20:00.000Z" }],
          "tokens": { "calls": 0, "input": 0, "cacheRead": 0, "output": 0 }, "costUsd": null, "warnings": [], "cached": false, "elapsedMs": 12 }
        """
        guard case .session(let detail) = try TimelineDetail.decode(Data(session.utf8)) else { return XCTFail("not a session") }
        XCTAssertEqual(detail.prompts.first?.text, "Fix the parser cache please")
        XCTAssertNil(detail.costUsd)
        XCTAssertEqual(detail.subagents.first?.name, "fixer")
        // ⌘F over an open row: the pane's texts under the keys its FindTexts use; a closed row adds nothing.
        XCTAssertEqual(TimelineDetailFind.fields(.session(detail)).map(\.key), ["prompt.2", "reply", "file./tmp/app/parse.ts", "agent.agent-1"])
        XCTAssertEqual(TimelineDetailFind.fields(.session(detail)).last?.text, "fixer: fix the cache")
        let row = try JSONDecoder().decode(TimelineEnvelope.self, from: Data(sampleFeed.utf8)).events[0]
        XCTAssertEqual(TimelineRowView.searchable(row, detail: nil).fields.map(\.key), ["project", "title", "detail"])
        XCTAssertEqual(TimelineRowView.searchable(row, detail: .session(detail)).fields.count, 7)
        // A push row does not draw its branch (the title names it), so it does not list it either.
        let pushRow = try JSONDecoder().decode(TimelineEnvelope.self, from: Data(sampleFeed.utf8)).events[5]
        XCTAssertEqual(pushRow.branch, "feat/parser")
        XCTAssertFalse(TimelineRowView.searchable(pushRow, detail: nil).fields.map(\.key).contains("branch"))
        // A compact list (a narrow window) draws no branch on any row, so none is listed either.
        let withBranch = """
        { "since": "2026-03-02T00:00:00.000Z", "until": "2026-03-02T14:00:00.000Z", "before": null, "limit": 200, "repos": [], "counts": {},
          "warnings": [], "elapsedMs": 1, "cached": false, "hasMore": false, "nextBefore": null, "truncated": [],
          "events": [ { "id": "turn:s-beta", "kind": "session.turn", "at": "2026-03-02T13:00:00.000Z", "title": "parser work", "detail": "last turn",
            "project": "app", "repo": "/tmp/gt/app", "sessionId": "s-beta", "provider": "claude", "cwd": "/tmp/gt/app", "mine": true, "branch": "feat/parser" } ] }
        """
        let branchRow = try XCTUnwrap(JSONDecoder().decode(TimelineEnvelope.self, from: Data(withBranch.utf8)).events.first)
        XCTAssertEqual(TimelineRowView.searchable(branchRow, detail: nil).fields.map(\.key), ["project", "title", "detail", "branch"])
        XCTAssertEqual(TimelineRowView.searchable(branchRow, detail: nil, compact: true).fields.map(\.key), ["project", "title", "detail"])

        let commit = """
        { "kind": "commit", "sha": "\(String(repeating: "a", count: 40))", "shortSha": "aaaaaaaa", "subject": "feat: parser", "body": "", "author": "Alice", "email": "alice@example.com",
          "at": "2026-03-02T10:00:00.000Z", "files": [{ "path": "parse.ts", "status": "A", "added": 2, "removed": 0, "binary": false }], "branches": ["main"], "branchesTruncated": false,
          "prs": [{ "ref": "acme/app#7", "url": "https://github.com/acme/app/pull/7", "title": "Parser rewrite", "state": "OPEN" }],
          "diff": { "path": "parse.ts", "text": "+export const a = 1;", "truncated": false }, "cached": true, "elapsedMs": 1 }
        """
        guard case .commit(let commitDetail) = try TimelineDetail.decode(Data(commit.utf8)) else { return XCTFail("not a commit") }
        XCTAssertEqual(commitDetail.files.first?.status, "A")
        XCTAssertEqual(commitDetail.diff?.text, "+export const a = 1;")
        XCTAssertEqual(HubPRRef(commitDetail.prs[0].ref)?.number, 7)

        let push = """
        { "kind": "push", "branch": "feat/parser", "from": "\(String(repeating: "0", count: 40))", "to": "\(String(repeating: "b", count: 40))", "newBranch": true,
          "commits": [{ "sha": "\(String(repeating: "b", count: 40))", "shortSha": "bbbbbbbb", "subject": "fix: cache", "at": "2026-03-02T11:00:00.000Z", "author": "Alice" }],
          "truncated": false, "remote": { "kind": "github", "web": "https://github.com/acme/app" }, "pr": null, "cached": false, "elapsedMs": 3 }
        """
        guard case .push(let pushDetail) = try TimelineDetail.decode(Data(push.utf8)) else { return XCTFail("not a push") }
        XCTAssertTrue(pushDetail.newBranch)
        XCTAssertNil(pushDetail.pr)

        let pr = """
        { "kind": "pr", "pr": { "ref": "acme/app#7", "url": "https://github.com/acme/app/pull/7", "title": "Parser rewrite", "state": "OPEN", "draft": false, "author": "alice",
            "headBranch": "feat/parser", "baseBranch": "main", "additions": 10, "deletions": 3, "changedFiles": 2, "mergeable": "mergeable", "reviewDecision": "APPROVED", "approvals": 1,
            "ci": "failed", "checks": [{ "name": "CI / test", "status": "failed", "url": "https://github.com/acme/app/actions/runs/1" }], "webUrls": null, "localWorktree": null, "repoRoot": "/tmp/gt/app" },
          "threads": { "total": 2, "open": 1, "newSince": [{ "id": "c-today", "threadId": "t1", "path": "parse.ts", "line": 2, "author": "bob", "title": "Guard the empty input", "at": "2026-03-02T12:30:00.000Z", "resolved": false }] },
          "warnings": [], "cached": false, "elapsedMs": 900 }
        """
        guard case .pr(let prDetail) = try TimelineDetail.decode(Data(pr.utf8)) else { return XCTFail("not a pr") }
        XCTAssertEqual(prDetail.pr.checks.first?.status, "failed")
        XCTAssertEqual(prDetail.threads.newSince.first?.title, "Guard the empty input")

        let thread = """
        { "kind": "thread", "pr": { "ref": "acme/app#7", "url": "https://github.com/acme/app/pull/7", "title": "Parser rewrite", "state": "OPEN" }, "viewer": "alice", "fetched": "cache",
          "thread": { "id": "t1", "path": "parse.ts", "side": "additions", "line": 2, "outdated": false, "resolved": false, "resolvable": true,
            "comments": [{ "id": "c-today", "author": { "name": "Bob", "username": "bob" }, "bodyMarkdown": "**Guard the empty input**", "createdAt": "2026-03-02T12:30:00.000Z", "isDraft": false }] },
          "cached": false, "elapsedMs": 4 }
        """
        guard case .thread(let threadDetail) = try TimelineDetail.decode(Data(thread.utf8)) else { return XCTFail("not a thread") }
        XCTAssertEqual(threadDetail.thread.comments.first?.author.username, "bob")
        XCTAssertEqual(threadDetail.viewer, "alice")

        let decision = """
        { "kind": "decision", "record": { "id": "d_1_s-alpha", "sessionId": "s-alpha", "number": 1, "prompt": "Keep the cache?", "options": ["a) keep it", "b) drop it"], "state": "answered", "option": "a", "updatedTs": "2026-03-02T13:00:00.000Z" }, "cached": false, "elapsedMs": 1 }
        """
        guard case .decision(let decisionDetail) = try TimelineDetail.decode(Data(decision.utf8)) else { return XCTFail("not a decision") }
        XCTAssertEqual(decisionDetail.record.option, "a")

        XCTAssertThrowsError(try TimelineDetail.decode(Data("{ \"error\": \"--repo is required for a commit\", \"kind\": \"commit\", \"id\": \"x\" }".utf8))) { error in
            XCTAssertEqual("\(error)", "--repo is required for a commit")
        }
    }

    // MARK: Mode tooltips

    func testEveryModeSegmentHasItsOwnTooltip() {
        let tooltips = HubMode.allCases.map { $0.tooltip(waiting: 0) }
        XCTAssertEqual(Set(tooltips).count, HubMode.allCases.count, "no two segments say the same thing")
        XCTAssertTrue(HubMode.inbox.tooltip(waiting: 3).contains("(3)"))
        XCTAssertTrue(HubMode.inbox.tooltip(waiting: 0).contains("none"))
        XCTAssertTrue(HubMode.timeline.tooltip(waiting: 0).hasPrefix("Activity"))
        XCTAssertEqual(HubMode.timeline.title, "Activity")
    }

    // MARK: Sample

    private let sampleFeed = """
    {
      "since": "2026-03-02T00:00:00.000Z", "until": "2026-03-02T14:00:00.000Z", "before": null, "limit": 200, "repos": ["/tmp/gt/app"],
      "counts": { "session.start": 0, "session.turn": 1, "commit": 1, "push": 1, "pr": 0, "thread": 1, "decision": 1, "ci": 1 },
      "warnings": [], "elapsedMs": 40, "cached": false, "hasMore": true, "nextBefore": "2026-03-02T10:00:00.000Z", "truncated": ["app commits"],
      "events": [
        { "id": "turn:s-alpha", "kind": "session.turn", "at": "2026-03-02T13:00:00.000Z", "title": "parser work", "detail": "last turn",
          "project": "app", "repo": "/tmp/gt/app", "sessionId": "s-alpha", "provider": "claude", "cwd": "/tmp/gt/app", "mine": true },
        { "id": "decision:d_2", "kind": "decision", "at": "2026-03-02T12:30:00.000Z", "title": "Ship the parser today?", "detail": "#2 waiting",
          "project": "app", "repo": "/tmp/gt/app", "sessionId": "s-alpha", "mine": true, "needsMe": true, "state": "open" },
        { "id": "ci:github.com/acme/app#7:2026-03-02T12:45:00.000Z", "kind": "ci", "at": "2026-03-02T12:15:00.000Z", "title": "Parser rewrite", "detail": "CI failed · acme/app#7",
          "project": "app", "repo": "/tmp/gt/app", "pr": { "ref": "acme/app#7", "number": 7, "url": "https://github.com/acme/app/pull/7" },
          "url": "https://github.com/acme/app/pull/7", "state": "failed", "mine": true, "needsMe": true },
        { "id": "thread:c-today", "kind": "thread", "at": "2026-03-02T11:30:00.000Z", "title": "Guard the empty input", "detail": "src/parse.ts:12 · acme/app#7",
          "project": "app", "repo": "/tmp/gt/app", "author": "bob", "pr": { "ref": "acme/app#7", "number": 7, "url": "https://github.com/acme/app/pull/7" },
          "url": "https://github.com/acme/app/pull/7", "mine": false, "needsMe": true, "threadId": "t1", "path": "src/parse.ts", "line": 12, "state": "open" },
        { "id": "commit:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "kind": "commit", "at": "2026-03-02T10:00:00.000Z", "title": "feat: parser", "detail": "aaaaaaaa",
          "project": "app", "repo": "/tmp/gt/app", "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "author": "Alice", "mine": true },
        { "id": "push:feat/parser:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:1", "kind": "push", "at": "2026-03-02T09:05:00.000Z", "title": "Pushed feat/parser", "detail": "new branch at aaaaaaaa",
          "project": "app", "repo": "/tmp/gt/app", "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "fromSha": "0000000000000000000000000000000000000000", "branch": "feat/parser", "mine": true,
          "pr": { "ref": "acme/app#7", "number": 7, "url": "https://github.com/acme/app/pull/7" }, "url": "https://github.com/acme/app/pull/7" }
      ]
    }
    """
}
