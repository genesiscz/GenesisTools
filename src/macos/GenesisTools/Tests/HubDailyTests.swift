import XCTest
@testable import GenesisTools

/// The hub's daily overlays read `tools hub search|digest|forecast|rules … --json` (src/hub/lib/search.ts,
/// digest.ts, forecast.ts, rules.ts). The samples follow those shapes with invented names and values.
final class HubDailyTests: XCTestCase {
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
        XCTAssertEqual(work.headline?.summary(clock: { _ in "16:00" }), "70% · out 16:00")
        XCTAssertEqual(work.windows[1].summary(clock: { _ in "x" }), "30% · lasts")
        XCTAssertTrue(work.windows[1].detail(clock: { _ in "Fri 15:00" }).contains("lasts to the reset (70% then)"))
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
        XCTAssertEqual(digest.summary, "1 sessions · 1 commits · 2 files (+11 −3) · 1 PRs opened, 0 merged · 1 decisions posted, 0 answered")
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
}
