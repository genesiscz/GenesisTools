import XCTest
@testable import GenesisTools

/// The hub's daily overlays read `tools hub search|digest|forecast|rules … --json` (src/hub/lib/search.ts,
/// digest.ts, forecast.ts, rules.ts). The samples follow those shapes with invented names and values.
final class HubDailyTests: XCTestCase {
    func testSearchSummaryCountsTheSessionsShownPerProvider() throws {
        // claude found 3 hits in 2 sessions, grok 1, codex failed: the parts must add up to the total.
        let hit = { (provider: String, id: String) in
            "{\"provider\":\"\(provider)\",\"sessionId\":\"\(id)\",\"title\":\"t\",\"project\":null,\"cwd\":\"/w\",\"gitBranch\":null,\"mtime\":\"2026-09-27T10:00:00Z\",\"account\":null,\"matchCount\":1,\"snippets\":[]}"
        }
        let json = """
        {"query":"q","results":[\(hit("claude", "a")),\(hit("claude", "b")),\(hit("grok", "c"))],
         "providers":{"claude":{"hits":3,"ms":1,"error":null},"codex":{"hits":0,"ms":1,"error":"down"},"grok":{"hits":1,"ms":1,"error":null}},
         "elapsedMs":1500}
        """
        let result = try JSONDecoder().decode(HubSearchResult.self, from: Data(json.utf8))

        XCTAssertEqual(result.summary, "3 sessions · claude 2, codex failed, grok 1 · 1.5 s")
    }

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    // MARK: search

    func testSearchArgsPushEveryFilterIntoTheQuery() {
        XCTAssertEqual(
            HubSearchArgs.build(query: "cart bug", providers: ["claude", "codex", "grok"], project: " ", range: .all),
            ["search", "cart bug", "--json", "--limit", "40"]
        )
        XCTAssertEqual(
            HubSearchArgs.build(query: "cart", providers: ["grok", "claude"], project: "shop", range: .today, limit: 10),
            ["search", "cart", "--json", "--limit", "10", "--provider", "claude,grok", "--project", "shop", "--since", "today"]
        )
        XCTAssertEqual(HubSearchRange.week.since, "7 days ago")
    }

    func testSearchResultDecodes() throws {
        let result = try decode(HubSearchResult.self, """
        {"query":"cart","filters":{"providers":["claude","codex"],"project":null,"since":null,"until":null,"limit":30},
         "results":[{"provider":"codex","sessionId":"x1","title":"Fix the cart","project":"shop","cwd":"/work/shop","gitBranch":null,
           "mtime":"2026-03-02T14:59:00.000Z","account":null,"filePath":"/s/x1.jsonl","matchCount":2,"relevance":null,
           "snippets":[{"role":"user","text":"the cart total","line":7,"timestamp":null,"tool":null}]}],
         "providers":{"claude":{"hits":0,"ms":40,"error":"index locked"},"codex":{"hits":1,"ms":12,"error":null}},"elapsedMs":4200}
        """)
        XCTAssertEqual(result.results.first?.id, "codex:x1")
        XCTAssertEqual(result.results.first?.snippets.first?.line, 7)
        XCTAssertEqual(result.providers["claude"]?.error, "index locked")
    }

    // MARK: forecast

    private let forecastJSON = """
    {"generatedAt":"2026-03-02T15:00:00.000Z","source":"/tmp/index.db","elapsedMs":3,"accounts":[
      {"provider":"anthropic-sub","account":"work","warning":"5h runs out at 16:00, before its reset","windows":[
        {"bucket":"five_hour","kind":"session","label":"5h","utilization":70,"resetsAt":"2026-03-02T18:00:00.000Z","lastSampleAt":"2026-03-02T15:00:00.000Z","samples":5,
         "ratePctPerHour":30,"basis":"active","exhaustAt":"2026-03-02T16:00:00.000Z","minutesToExhaust":60,"beforeReset":true,"projectedAtReset":160,"resetSinceSample":false,"stale":false},
        {"bucket":"seven_day","kind":"weekly","label":"Weekly","utilization":30,"resetsAt":"2026-03-06T15:00:00.000Z","lastSampleAt":"2026-03-02T15:00:00.000Z","samples":2,
         "ratePctPerHour":0.42,"basis":"window","exhaustAt":"2026-03-09T15:00:00.000Z","minutesToExhaust":10080,"beforeReset":false,"projectedAtReset":70,"resetSinceSample":false,"stale":false}]},
      {"provider":"anthropic-sub","account":"side","warning":null,"windows":[
        {"bucket":"five_hour","kind":"session","label":"5h","utilization":90,"resetsAt":"2026-03-01T10:00:00.000Z","lastSampleAt":"2026-03-01T08:00:00.000Z","samples":3,
         "ratePctPerHour":null,"basis":null,"exhaustAt":null,"minutesToExhaust":null,"beforeReset":false,"projectedAtReset":null,"resetSinceSample":true,"stale":true}]}]}
    """

    func testForecastHeadlineIsTheWindowThatRunsOutFirst() throws {
        let result = try decode(HubForecastResult.self, forecastJSON)
        let work = try XCTUnwrap(result.accounts.first)
        XCTAssertEqual(work.headline?.bucket, "five_hour")
        let generated = try XCTUnwrap(HubFormat.date("2026-03-02T15:00:00.000Z"))
        XCTAssertEqual(work.headline?.summary(now: generated, clock: { _ in "16:00" }), "70% · out 16:00")
        // Projected from the last sample: an hour past the run-out time it reads as at the limit.
        XCTAssertEqual(work.headline?.summary(now: generated.addingTimeInterval(2 * 3600), clock: { _ in "16:00" }), "70% · at limit")
        XCTAssertEqual(work.windows[1].summary(clock: { _ in "x" }), "30% · lasts")
        XCTAssertTrue(work.windows[1].detail(clock: { _ in "Fri 15:00" }).contains("lasts to the reset (70% then)"))
    }

    /// H12: an old sample reads as an old reading, never as "it hit 100% four days ago".
    func testAStaleWindowSaysHowOldItsNumberIs() throws {
        let side = try XCTUnwrap(decode(HubForecastResult.self, forecastJSON).accounts.last)
        let window = try XCTUnwrap(side.windows.first)
        XCTAssertTrue(window.stale)
        XCTAssertTrue(window.summary().contains("% as of "), window.summary())
        XCTAssertFalse(window.summary().contains(" · "), window.summary())
    }

    func testForecastAccountWithOnlyAPastWindowHasNothingCurrent() throws {
        let side = try XCTUnwrap(decode(HubForecastResult.self, forecastJSON).accounts.last)
        XCTAssertTrue(side.current.isEmpty)
        XCTAssertNil(side.headline)
    }

    // MARK: digest

    func testDigestDecodesAndSummarises() throws {
        let digest = try decode(HubDigest.self, """
        {"date":"2026-03-02","since":"2026-03-01T23:00:00.000Z","until":"2026-03-02T15:00:00.000Z","generatedAt":"2026-03-02T15:00:00.000Z",
         "sessions":[{"sessionId":"s1","provider":"claude","title":"Cart fix","project":"shop","cwd":"/work/shop","branch":"fix/cart","startedAt":null,"lastAt":"2026-03-02T11:00:00Z","commits":1}],
         "commits":[{"sha":"aaa111","subject":"fix: cart total","at":"2026-03-02T10:30:00Z","project":"shop","repo":"/work/shop","author":"Alice","sessionId":"s1"}],
         "files":{"total":2,"added":11,"removed":3,"repos":[{"repo":"/work/shop","project":"shop","files":2,"added":11,"removed":3,"paths":[{"path":"src/cart.ts","added":10,"removed":2}]}]},
         "prs":{"opened":[{"ref":"work/shop#4","title":"Cart fix","url":"https://example.com/4","project":"shop","at":"2026-03-02T11:10:00Z"}],"merged":[]},
         "decisions":{"posted":[{"id":"d1","number":1,"title":"Pick a TTL","state":"open","sessionId":"s1","project":"shop","at":"2026-03-02T08:00:00Z","answer":null}],"answered":[]},
         "ci":{"failed":1,"passed":0},"pushes":1,"warnings":[],"exported":"/vault/Daily/2026-03-02 Agents digest.md"}
        """)
        XCTAssertEqual(digest.summary, "1 session · 1 commit · 2 files (+11 −3) · 1 PR opened, 0 merged · 1 decision posted, 0 answered")
        XCTAssertEqual(digest.exported, "/vault/Daily/2026-03-02 Agents digest.md")
        XCTAssertEqual(digest.files.repos.first?.paths.first?.path, "src/cart.ts")
    }

    func testDigestDayStepsAndNeverPassesToday() throws {
        let today = try XCTUnwrap(HubDigestDay.format.date(from: "2026-03-02"))
        XCTAssertEqual(HubDigestDay.step("2026-03-02", by: -1, today: today), "2026-03-01")
        XCTAssertEqual(HubDigestDay.step("2026-03-01", by: 1, today: today), "2026-03-02")
        XCTAssertEqual(HubDigestDay.step("2026-03-02", by: 1, today: today), "2026-03-02")
        XCTAssertEqual(HubDigestDay.title("2026-03-02", today: today), "Today")
        XCTAssertEqual(HubDigestDay.title("2026-03-01", today: today), "Yesterday")
    }

    // MARK: rules

    func testRuleAddArgsNeedAThresholdWhereTheKindHasOne() {
        XCTAssertNil(HubRuleKind.addArgs(kind: .idle, threshold: "", scope: "", label: ""))
        XCTAssertNil(HubRuleKind.addArgs(kind: .context, threshold: "-5", scope: "", label: ""))
        XCTAssertEqual(
            HubRuleKind.addArgs(kind: .idle, threshold: "30", scope: "shop", label: " Nap "),
            ["rules", "add", "--kind", "idle", "--json", "--minutes", "30", "--project", "shop", "--label", "Nap"]
        )
        XCTAssertEqual(
            HubRuleKind.addArgs(kind: .ciFailed, threshold: "ignored", scope: "shop#4", label: ""),
            ["rules", "add", "--kind", "ciFailed", "--json", "--match", "shop#4"]
        )
        XCTAssertEqual(HubRuleKind.addArgs(kind: .context, threshold: "82.5", scope: "", label: ""), ["rules", "add", "--kind", "context", "--json", "--percent", "82.5"])
    }

    func testRulesListAndTestRunDecode() throws {
        let list = try decode(HubRulesList.self, """
        {"rules":[{"id":"r_1","kind":"idle","enabled":true,"minutes":30},{"id":"r_2","kind":"decision","enabled":false,"project":"shop"}],
         "configPath":"/tmp/hub/config.json (notificationRules)","kinds":[{"kind":"idle","label":"Session idle longer than N minutes"}],
         "labels":{"r_1":"Idle over 30 min","r_2":"New decision in shop"}}
        """)
        XCTAssertEqual(list.rules.map(\.id), ["r_1", "r_2"])
        XCTAssertEqual(list.labels["r_2"], "New decision in shop")
        let run = try decode(HubRulesRun.self, """
        {"ranAt":"2026-03-02T15:00:00.000Z","dryRun":true,"skipped":null,"posted":0,
         "reports":[{"id":"r_1","kind":"idle","label":"Idle over 30 min","enabled":true,"problem":null,"matches":2,"fired":1,"seeded":false,"note":null}],
         "firings":[{"ruleId":"r_1","kind":"idle","key":"claude:s1@1","title":"Idle over 30 min · shop","subtitle":"Cart fix","message":"No activity for 45 min","target":{"sessionId":"s1","provider":"claude"}}]}
        """)
        XCTAssertEqual(run.reports.first?.fired, 1)
        XCTAssertEqual(run.firings.first?.message, "No activity for 45 min")
    }

    /// "gt pr" says the list is loading only while it loads; a finished load with no PR says so.
    func testPalettePRHintFollowsTheLoadState() {
        var context = HubPaletteContext(projects: [HubPaletteProject(name: "GenesisTools", path: "/tmp/fixture/GenesisTools")])
        XCTAssertEqual(HubPaletteEngine.suggestions(for: "gt pr", context: context).first?.subtitle, "Loading the open PRs…")
        context.prsLoaded = true
        XCTAssertEqual(HubPaletteEngine.suggestions(for: "gt pr", context: context).first?.subtitle, "No open PR in these projects")
    }

    /// Two idle sessions of one project can match in every visible field; the list tells them apart by key.
    func testRuleFiringsWithTheSameTextAreDistinctRows() throws {
        let run = try decode(HubRulesRun.self, """
        {"ranAt":"2026-03-02T15:00:00.000Z","dryRun":true,"skipped":null,"posted":0,"reports":[],
         "firings":[{"ruleId":"r_1","kind":"idle","key":"claude:s1@1","title":"Idle over 30 min · shop","subtitle":"Cart fix","message":"No activity for 45 min","target":{}},
                    {"ruleId":"r_1","kind":"idle","key":"claude:s2@1","title":"Idle over 30 min · shop","subtitle":"Cart fix","message":"No activity for 45 min","target":{}}]}
        """)
        XCTAssertEqual(Set(run.firings.map(\.id)).count, 2)
    }
}
