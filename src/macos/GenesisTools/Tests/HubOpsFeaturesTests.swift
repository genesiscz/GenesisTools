import XCTest
@testable import GenesisTools

/// The operations features decode what their `tools` doors print and keep their small pure rules:
/// the agent process pane (`tools hub procs --json`, src/hub/lib/procs/), the prompt library
/// (`tools hub prompts … --json`, src/hub/lib/prompts.ts), PR readiness (`tools hub pr readiness
/// --json`, src/hub/lib/pr-readiness.ts) and the worktree move-aside (`tools hub worktrees move-aside
/// --json`, src/hub/lib/worktrees.ts). Every key and type is the CLI's; the values are invented.
final class HubOpsFeaturesTests: XCTestCase {
    // MARK: Agent processes

    private let procsJSON = """
    {"groups":[
      {"id":"orphan:320","kind":"orphan","rootPid":320,"provider":"claude","label":"claude tool shell",
       "command":"/bin/zsh -c source /Users/alice/.claude/shell-snapshots/s.sh","cwd":null,"startedAt":"2026-09-20T18:00:00.000Z",
       "ageMs":518400000,"parent":{"pid":1,"label":"launchd","alive":false},"wrapperPid":null,"parentAgentPid":null,
       "orphan":true,"orphanReason":"its parent is gone (PPID 1)","launchdLabel":null,"idle":false,"idleReason":null,
       "session":{"provider":"claude","sessionId":"33333333-3333-4333-8333-333333333333","title":null,"lastActivityAt":null,"match":"shell"},
       "own":false,"totals":{"cpu":0,"rssKb":5400,"energy":null,"processes":3},
       "processes":[{"pid":320,"ppid":1,"depth":0,"kind":"shell","label":"claude tool shell","command":"/bin/zsh -c …","cpu":0,"rssKb":32,
                     "energy":null,"startedAt":"2026-09-20T18:00:00.000Z","state":"Ss"}]},
      {"id":"agent:210","kind":"agent","rootPid":210,"provider":"claude","label":"claude","command":"/Users/alice/.bun/bin/claude",
       "cwd":"/Users/alice/Projects/shop","startedAt":"2026-09-26T16:00:00.000Z","ageMs":7200000,
       "parent":{"pid":202,"label":"zsh","alive":true},"wrapperPid":201,"parentAgentPid":null,"orphan":false,"orphanReason":null,
       "launchdLabel":null,"idle":false,"idleReason":null,
       "session":{"provider":"claude","sessionId":"11111111-1111-4111-8111-111111111111","title":"cart totals","lastActivityAt":1790430000000,"match":"argv"},
       "own":true,"totals":{"cpu":10.5,"rssKb":1373000,"energy":5.0,"processes":7},"processes":[]}
    ],
    "totals":{"groups":2,"orphans":1,"idle":0,"processes":10,"cpu":10.5,"rssKb":1378400},
    "energy":true,"takenAt":"2026-09-26T18:00:00.000Z","elapsedMs":102,"warnings":[]}
    """

    func testProcsReportDecodesAndKnowsWhatCanBeStopped() throws {
        let report = try JSONDecoder().decode(ProcsReport.self, from: Data(procsJSON.utf8))
        XCTAssertEqual(report.groups.count, 2)
        let orphan = report.groups[0]
        XCTAssertTrue(orphan.orphan)
        XCTAssertTrue(orphan.stoppable)
        XCTAssertEqual(orphan.title, "claude tool shell", "no session title: the label")
        XCTAssertEqual(orphan.session?.match, "shell")
        let own = report.groups[1]
        XCTAssertFalse(own.stoppable, "the tree running the asking process is never offered a stop")
        XCTAssertEqual(own.title, "cart totals")
        XCTAssertEqual(own.totals.energy, 5.0)
        XCTAssertEqual(ProcsFormat.summary(report), "2 trees · 10 processes · 10.5 % CPU · \(ProcsFormat.memory(1_378_400)) · 1 orphan")
    }

    func testProcAgesReadLikeTheCLI() {
        XCTAssertEqual(ProcsFormat.age(42 * 60_000), "42m")
        XCTAssertEqual(ProcsFormat.age(5 * 3_600_000 + 10 * 60_000), "5h 10m")
        XCTAssertEqual(ProcsFormat.age(6 * 86_400_000 + 3_600_000), "6d 1h")
        XCTAssertEqual(ProcsFormat.age(nil), "—")
    }

    func testStopOutcomeDecodes() throws {
        let json = """
        {"pid":300,"label":"cursor-agent","pids":[300,301],"stopped":false,"signal":"KILL","survivors":[301],"reason":"still running after SIGKILL: 301"}
        """
        let outcome = try JSONDecoder().decode(ProcStopOutcome.self, from: Data(json.utf8))
        XCTAssertEqual(outcome.survivors, [301])
        XCTAssertEqual(outcome.signal, "KILL")
    }

    // MARK: Prompt library

    func testPromptTemplateMatchesTheCLIRules() {
        let text = "Fix {{pr}} on {{ branch }}, then {{pr}} and {{file.path}}"
        XCTAssertEqual(PromptTemplate.variables(text), ["pr", "branch", "file.path"])
        XCTAssertEqual(PromptTemplate.render("Rebase {{branch}} onto {{base}}", ["branch": "feat/x", "base": ""]), "Rebase feat/x onto {{base}}")
        XCTAssertEqual(PromptTemplate.varArgs(["pr", "branch", "file"], ["pr": " 42 ", "branch": "feat/x", "file": "", "extra": "y"]),
                       ["--var=pr=42", "--var=branch=feat/x"])
    }

    func testPromptJSONDecodes() throws {
        let list = """
        [{"name":"fix-review","text":"Fix PR {{pr}}","description":null,"uses":3,"lastUsedAt":"2026-09-26T18:30:00.000Z",
          "createdAt":"2026-09-26T10:00:00.000Z","variables":["pr"]}]
        """
        let prompts = try JSONDecoder().decode([HubPrompt].self, from: Data(list.utf8))
        XCTAssertEqual(prompts.first?.variables, ["pr"])
        XCTAssertEqual(prompts.first?.uses, 3)

        let sent = """
        {"name":"plan","session":"44444444-4444-4444-8444-444444444444","text":"a\\nb","typed":"Read /tmp/x.md and do what it says",
         "mode":"file","file":"/tmp/x.md","vars":{"branch":"feat/cart"},"filled":["branch"],"sent":true,"dryRun":false}
        """
        let result = try JSONDecoder().decode(PromptSendResult.self, from: Data(sent.utf8))
        XCTAssertEqual(result.mode, "file")
        XCTAssertEqual(result.filled, ["branch"])

        let failure = #"{"error":"\"explain-file\" needs --var file=…","code":"missing-vars","missing":["file"]}"#
        let error = try JSONDecoder().decode(PromptCLIError.self, from: Data(failure.utf8))
        XCTAssertEqual(error.missing, ["file"])
    }

    // MARK: PR readiness

    private func decodePR(state: String, headSha: String?, number: Int = 12) throws -> HubPR {
        let sha = headSha.map { "\"\($0)\"" } ?? "null"
        let json = """
        {"repo":"shop","repoRoot":"/tmp/scratch/shop","origin":{"kind":"github","host":"github.com","web":"https://github.com/acme/shop"},
         "number":\(number),"title":"t","state":"\(state)","draft":false,"author":"alice","headBranch":"feat/cart","baseBranch":"main",
         "url":"https://github.com/acme/shop/pull/\(number)","labels":[],"reviewers":[],"headSha":\(sha)}
        """
        return try JSONDecoder().decode(HubPR.self, from: Data(json.utf8))
    }

    private let readinessJSON = """
    [{"input":"https://github.com/acme/shop/pull/12@aaaa","readiness":{"url":"https://github.com/acme/shop/pull/12","provider":"github",
      "number":12,"title":"t","headSha":"aaaa","state":"open","draft":false,"ci":"success","unresolved":3,
      "unresolvedBy":[{"author":"bot-b","count":2},{"author":"bot-a","count":1}],"outdatedUnresolved":1,
      "lastReviewAt":"2026-09-26T17:00:00Z","lastReviewBy":"bot-b","lastPushAt":"2026-09-26T16:00:00Z","reviewedHead":true,
      "staleReviewers":["bot-a"],"reviewDecision":null,"mergeable":"mergeable","verdict":"blocked",
      "reasons":["3 unresolved threads (bot-b ×2, bot-a ×1)","CI is still running"],
      "summary":"blocked: 3 unresolved threads (bot-b ×2, bot-a ×1) (+1 more)","fetchedAt":"2026-09-26T18:00:00.000Z","cached":true},
      "error":null},
     {"input":"/tmp/scratch/shop#9","readiness":null,"error":"no such PR"}]
    """

    func testReadinessDecodesAndItsTooltipCarriesEveryReason() throws {
        let outcomes = try JSONDecoder().decode([PRReadinessOutcome].self, from: Data(readinessJSON.utf8))
        XCTAssertEqual(outcomes.count, 2)
        XCTAssertNil(outcomes[1].readiness)
        let readiness = try XCTUnwrap(outcomes[0].readiness)
        XCTAssertEqual(readiness.tooltip, """
        blocked: 3 unresolved threads (bot-b ×2, bot-a ×1) (+1 more)
        also: CI is still running
        re-review due from bot-a
        1 outdated thread still unresolved (not blocking)
        """)
        XCTAssertEqual(PRReadinessBadge.look(readiness).2, "3 open")
    }

    func testReadinessAsksForOpenPRsOnlyWithTheirKnownHead() throws {
        let prs = [try decodePR(state: "OPEN", headSha: "aaaa"), try decodePR(state: "MERGED", headSha: "bbbb", number: 13),
                   try decodePR(state: "OPEN", headSha: nil, number: 14)]
        XCTAssertEqual(PRReadinessQuery.inputs(prs), [
            "https://github.com/acme/shop/pull/12@aaaa",
            "https://github.com/acme/shop/pull/14",
        ])
    }

    // MARK: Worktree move-aside

    func testCleanupRowsCarryTheDirtyCountAndTheCommitAge() throws {
        let json = """
        {"path":"/tmp/scratch/wt-a","repoRoot":"/tmp/scratch/main","repo":"main","branch":"feat/a","head":"aaaa","verdict":"MERGED",
         "how":"ancestor","base":"main","ignored":[],"removable":false,"blockers":[{"kind":"recent","text":"Last activity 2 days ago, newer than the 7-day threshold"}],
         "lastActivityAt":1790286118790.9,"lastCommitAt":1790286118000,"changedCount":2,"untrackedCount":1}
        """
        let row = try JSONDecoder().decode(CleanupRow.self, from: Data(json.utf8))
        XCTAssertEqual(row.dirtyCount, 3)
        XCTAssertEqual(row.lastCommit, Date(timeIntervalSince1970: 1_790_286_118))
        XCTAssertEqual(row.blockers.first?.kind, "recent")
    }

    func testMoveAsideOutcomesAndTheListArguments() throws {
        let json = """
        [{"path":"/tmp/scratch/wt-a","moved":true,"to":"/private/tmp/20260926-agents-removals/hub-worktrees/main/wt-a",
          "restore":"git -C '/tmp/scratch/main' worktree move '/private/tmp/20260926-agents-removals/hub-worktrees/main/wt-a' '/tmp/scratch/wt-a'",
          "reasons":[],"branch":"feat/a"},
         {"path":"/tmp/scratch/wt-b","moved":false,"to":null,"restore":null,"reasons":["The branch is not merged into main"],"branch":"feat/b"}]
        """
        let outcomes = try JSONDecoder().decode([MoveAsideOutcome].self, from: Data(json.utf8))
        XCTAssertEqual(WorktreeCleanup.restoreScript(outcomes),
                       "git -C '/tmp/scratch/main' worktree move '/private/tmp/20260926-agents-removals/hub-worktrees/main/wt-a' '/tmp/scratch/wt-a'")
        XCTAssertEqual(WorktreeCleanup.listArgs(repos: ["/r"], olderThanDays: 0), ["hub", "worktrees", "list", "/r", "--json"])
        XCTAssertEqual(WorktreeCleanup.listArgs(repos: ["/r"], olderThanDays: 7), ["hub", "worktrees", "list", "/r", "--older-than", "7", "--json"])
    }
}
