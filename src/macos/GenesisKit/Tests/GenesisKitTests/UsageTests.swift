import CoreGraphics
import XCTest
@testable import GenesisKit

/// The usage doors' contract on the Swift side: each envelope decodes from the shape the CLI prints (invented accounts),
/// and the lane values and geometry the Usage window draws from.
final class UsageTests: XCTestCase {
    private func decode<T: Decodable & Sendable>(_ json: String, as type: T.Type, door: UsageDoor) throws -> UsageEnvelope<T> {
        try UsageClient.decodeEnvelope(Data(json.utf8), as: type, door: door)
    }

    static let seriesJSON = """
    {"schema":"usage.limits.series@1","generatedAt":"2026-11-03T10:00:00.000Z",
     "window":{"from":"2026-11-02T10:00:00.000Z","to":"2026-11-03T10:00:00.000Z","tz":"Europe/Prague","label":"since 24h"},
     "selector":{"accounts":[]},"warnings":[{"code":"x","message":"A note"}],
     "data":{"agg":"raw","stepMs":0,
       "series":[
         {"provider":"anthropic-sub","accountId":"acc_work","accountName":"work","key":"five_hour","kind":"session",
          "scopeModel":null,"label":"Session (5h)","periodMs":18000000,
          "availability":[{"from":"2026-11-02T10:00:00.000Z","to":"2026-11-02T20:00:00.000Z","state":"absent"}],
          "availableNow":"limited",
          "points":[{"t":"2026-11-03T08:00:00.000Z","v":10,"severity":"ok"},{"t":"2026-11-03T09:00:00.000Z","v":40,"severity":"ok"},
                    {"t":"2026-11-03T09:30:00.000Z","v":80,"severity":"warning"}],
          "resets":["2026-11-03T08:00:00.000Z"],
          "current":{"utilization":80,"resetsAt":"2026-11-03T13:00:00.011935+00:00","severity":"warning","fetchedAt":"2026-11-03T10:00:00.000Z"},
          "forecast":{"bucket":"five_hour","kind":"session","label":"5h","utilization":80,"resetsAt":"2026-11-03T13:00:00.000Z",
            "lastSampleAt":"2026-11-03T09:30:00.000Z","samples":3,"ratePctPerHour":10,"basis":"active","exhaustAt":"2026-11-03T12:00:00.000Z",
            "minutesToExhaust":120,"beforeReset":true,"projectedAtReset":110,"resetSinceSample":false,"stale":false,
            "paceBand":{"lowPctPerHour":5,"highPctPerHour":20},"safePctPerHour":6.67}},
         {"provider":"openai-sub","accountId":"acc_side","accountName":"work","key":"primary","kind":"weekly","scopeModel":null,
          "label":"Weekly","periodMs":604800000,"availability":[],"availableNow":"limited",
          "bins":[{"t":"2026-11-03T00:00:00.000Z","open":1,"close":3,"min":1,"max":9,"severity":null}],
          "resets":[],"current":null,"forecast":null}],
       "coverage":[{"provider":"anthropic-sub","accountId":"acc_work","accountName":"work",
         "runs":[{"from":"2026-11-03T08:00:00.000Z","to":"2026-11-03T09:00:00.000Z","outcome":"ok","source":"poll","polls":12}]}],
       "events":[{"id":1,"ts":"2026-11-03T09:10:00.000Z","provider":"anthropic-sub","accountId":"acc_work","accountName":"work",
         "source":"proxy","kind":"rate-limited","retryAfterMs":120000,"model":null,"detail":null,"day":null,"count":3}]}}
    """

    func testSeriesEnvelopeDecodesPointsBinsAndForecast() throws {
        let envelope = try decode(Self.seriesJSON, as: UsageSeriesData.self, door: .series(.day, step: "raw", agg: "raw"))
        XCTAssertEqual(envelope.verb, "usage.limits.series")
        XCTAssertEqual(envelope.warnings.map(\.message), ["A note"])
        XCTAssertEqual(envelope.data.series.count, 2)
        XCTAssertEqual(envelope.data.series[0].forecast?.paceBand, UsagePaceBand(lowPctPerHour: 5, highPctPerHour: 20))
        XCTAssertEqual(envelope.data.series[1].bins?.first?.max, 9)
        // Two providers each with an account called "work" stay apart.
        XCTAssertNotEqual(envelope.data.series[0].account.id, envelope.data.series[1].account.id)
    }

    func testWrongSchemaIsRefused() {
        XCTAssertThrowsError(try decode(Self.seriesJSON, as: UsageSeriesData.self, door: .health(.day)))
    }

    func testMicrosecondInstantsParse() {
        XCTAssertNotNil(UsageTime.date("2026-11-04T19:00:00.011935+00:00"))
        XCTAssertNotNil(UsageTime.date("2026-11-04T19:00:00Z"))
        XCTAssertNil(UsageTime.date("not a date"))
    }

    func testLaneBuilderKeepsAbsentSpansEventsAndForecast() throws {
        let data = try decode(Self.seriesJSON, as: UsageSeriesData.self, door: .series(.day, step: "raw", agg: "raw")).data
        let accounts = UsageLaneBuilder.build(series: data, settings: UsageSettings())
        XCTAssertEqual(accounts.count, 2)
        let lane = try XCTUnwrap(accounts.first?.lanes.first)
        XCTAssertEqual(lane.title, "5h")
        XCTAssertEqual(lane.samples.map(\.value), [10, 40, 80])
        XCTAssertEqual(lane.absent.count, 1)
        XCTAssertEqual(lane.events.map(\.text), ["Proxy request rate limited ×3 for 2m"])
        XCTAssertTrue(accounts[0].coverageRecorded)
        XCTAssertFalse(accounts[1].coverageRecorded)
        let forecast = try XCTUnwrap(lane.forecast)
        // From 80 %: the fast pace (20 %/h) reaches 100 % in an hour, the slow one (5 %/h) in four, past the reset.
        let span = try XCTUnwrap(forecast.outSpan)
        XCTAssertEqual(span.from, UsageTime.date("2026-11-03T11:00:00.000Z"))
        XCTAssertNil(span.to)
    }

    func testStepLineHoldsEachValueUntilTheNextReading() {
        let start = Date(timeIntervalSince1970: 0)
        let geometry = UsageLaneGeometry(domain: start...start.addingTimeInterval(100), size: CGSize(width: 100, height: 100))
        let samples = [UsageLaneSample(date: start, value: 0), UsageLaneSample(date: start.addingTimeInterval(50), value: 50)]
        let step = geometry.line(samples, shape: .step, extendTo: start.addingTimeInterval(100))
        XCTAssertEqual(step, [CGPoint(x: 0, y: 100), CGPoint(x: 50, y: 100), CGPoint(x: 50, y: 50), CGPoint(x: 100, y: 50)])
        let linear = geometry.line(samples, shape: .linear, extendTo: nil)
        XCTAssertEqual(linear, [CGPoint(x: 0, y: 100), CGPoint(x: 50, y: 50)])
    }

    func testConeSpansTheSlowAndFastPace() throws {
        let start = Date(timeIntervalSince1970: 0)
        let geometry = UsageLaneGeometry(domain: start...start.addingTimeInterval(4 * 3600), size: CGSize(width: 400, height: 100))
        let forecast = UsageLaneForecast(start: start, value: 20, ratePerHour: 10, lowPerHour: 5, highPerHour: 20,
                                         safePerHour: 8, resetAt: nil, exhaustAt: nil, beforeReset: false)
        let cone = try XCTUnwrap(geometry.cone(forecast, until: start.addingTimeInterval(2 * 3600)))
        XCTAssertEqual(cone, [CGPoint(x: 0, y: 80), CGPoint(x: 200, y: 70), CGPoint(x: 200, y: 40)])
        XCTAssertNil(geometry.cone(UsageLaneForecast(start: start, value: 20, ratePerHour: 10, lowPerHour: nil, highPerHour: nil,
                                                     safePerHour: nil, resetAt: nil, exhaustAt: nil, beforeReset: false),
                                   until: start.addingTimeInterval(3600)))
    }

    func testTableShowsNoLimitForAnAbsentWindowAndTheBindingForecast() throws {
        let limits = try decode("""
        {"schema":"usage.limits@1","generatedAt":"2026-11-03T10:00:00.000Z","selector":{"accounts":[]},"warnings":[],
         "data":{"accounts":[{"provider":"anthropic-sub","accountId":"acc_work","accountName":"work","label":"max",
           "limits":[{"key":"seven_day","label":"Weekly (all)","kind":"weekly","percentUsed":62,"severity":"ok","resetsAt":"2026-11-05T10:00:00.000Z"},
                     {"key":"seven_day_fable","label":"Weekly (Fable)","kind":"scoped","percentUsed":21,"scopeModel":"Fable"}],
           "absentLimits":[{"key":"five_hour","kind":"session"}]}]}}
        """, as: UsageLimitsData.self, door: .limits).data
        let series = try decode(Self.seriesJSON, as: UsageSeriesData.self, door: .series(.day, step: "raw", agg: "raw")).data
        let table = UsageTableBuilder.build(limits: limits, series: series, now: UsageTime.date("2026-11-03T10:00:00.000Z")!)
        XCTAssertEqual(table.columns.map(\.title), ["5h", "Week", "Fable"])
        let row = try XCTUnwrap(table.rows.first)
        XCTAssertEqual(row.cells["session"]?.absent, true)
        XCTAssertEqual(row.cells["weekly"]?.percent, 62)
        XCTAssertEqual(row.ratePerHour, 10)
        let now = try XCTUnwrap(UsageTime.date("2026-11-03T10:00:00.000Z"))
        XCTAssertEqual(row.limitText, UsageFormat.clock(UsageTime.date("2026-11-03T12:00:00.000Z"), now: now))
        XCTAssertTrue(row.limitBeforeReset)
    }

    func testLimitTextNamesAnAccountThatLastsPastItsReset() throws {
        let lasts = try JSONDecoder().decode(UsageLimitForecast.self, from: Data("""
        {"utilization":20,"ratePctPerHour":1.5,"beforeReset":false}
        """.utf8))
        XCTAssertEqual(UsageTableBuilder.limitText(lasts, now: Date()), "past reset")
        let idle = try JSONDecoder().decode(UsageLimitForecast.self, from: Data("""
        {"utilization":20,"beforeReset":false}
        """.utf8))
        XCTAssertNil(UsageTableBuilder.limitText(idle, now: Date()))
    }

    func testSettingsReadMissingAndUnknownValuesAsDefaults() {
        var changed = UsageSettings()
        changed.range = .week
        changed.cone = false
        XCTAssertEqual(UsageSettings.decoded(changed.encoded()), changed)
        let partial = UsageSettings.decoded(#"{"range":"30d","lineShape":"zigzag"}"#)
        XCTAssertEqual(partial.range, .month)
        XCTAssertEqual(partial.lineShape, .step)
        XCTAssertEqual(UsageSettings.decoded("not json"), UsageSettings())
        XCTAssertEqual(UsageResolution.auto.door(.day).agg, "raw")
        XCTAssertEqual(UsageResolution.auto.door(.month).agg, "minmax")
    }

    func testSpendAndAnalysisEnvelopesDecode() throws {
        let pivot = try decode("""
        {"schema":"usage.spend.pivot@1","generatedAt":"x","selector":{"accounts":[]},"warnings":[],
         "data":{"by":["provider"],"grain":"hour","tz":"UTC","total":{"costUsd":3,"tokens":10,"unpriced":0},
           "groups":[{"key":{"provider":"anthropic-sub"},"costUsd":3,"tokens":10,"unpriced":0,"points":[{"t":"2026-11-03T06","costUsd":3,"tokens":10}]}],
           "heatmap":{"cells":[[0,1]],"weeks":1}}}
        """, as: UsagePivotData.self, door: .pivot(.week, by: "provider")).data
        XCTAssertEqual(pivot.groups.first?.label(pivot.by), "anthropic-sub")
        let digest = try decode("""
        {"schema":"usage.digest@1","generatedAt":"x","selector":{"accounts":[]},"warnings":[],
         "data":{"period":"day","days":["2026-11-02"],"windows":[],"alerts":{"total":1,"byRule":{"threshold":1},"budget":0},
           "spend":{"totalUsd":12,"byProvider":[{"provider":"anthropic-sub","usd":12}],"byModel":[{"model":"m","usd":12}],
             "topSessions":[],"unpriced":0},"outlook":[],"workers":null}}
        """, as: UsageDigestData.self, door: .digest(week: false)).data
        XCTAssertEqual(digest.spend?.byProvider.first?.name, "anthropic-sub")
        XCTAssertEqual(digest.spend?.byModel.first?.name, "m")
    }

    func testDoorsAskTheReadOnlyVerbs() {
        XCTAssertEqual(UsageDoor.limits.argv, ["ai", "usage", "limits", "--cached", "--json"])
        XCTAssertEqual(UsageDoor.sessionReport(id: "s1", harness: "codex").argv,
                       ["ai", "sessions", "report", "s1", "--provider", "codex", "--json"])
        XCTAssertEqual(UsageDoor.digest(week: true).argv.suffix(2), ["--week", "--json"])
        XCTAssertEqual(UsageDoor.digest(week: false, date: "2026-11-02").argv.suffix(3), ["--day", "2026-11-02", "--json"])
    }

    func testBudgetWritesNameTheTargetExactly() throws {
        XCTAssertEqual(UsageBudgetCommand.setWindow(accountId: "acc_work", kind: "weekly", reservePct: 10, dailyPct: 2.5).argv,
                       ["ai", "usage", "budgets", "set", "--account", "acc_work", "--kind", "weekly", "--reserve", "10", "--daily", "2.5"])
        XCTAssertEqual(UsageBudgetCommand.removeSpend(provider: nil).argv, ["ai", "usage", "budgets", "rm", "--spend"])
        let budgets = try decode("""
        {"schema":"usage.budgets@1","generatedAt":"x","selector":{"accounts":[]},"warnings":[],
         "data":{"budgets":{"global":{},"providers":{}},"spend":[{"scope":"global","dailyUsd":50,"todayUsd":12,"ratio":0.24}],
          "windows":[{"provider":"anthropic-sub","accountId":"acc_work","accountName":"work","kind":"weekly","key":"seven_day","label":"Weekly",
           "utilization":40,"resetsAt":null,"budget":{"reservePct":10},"pace":{"reservePct":10,"allowancePct":8,"burnedTodayPct":2,
           "paceRatio":0.25,"headroomPct":50,"status":"ok"}}]}}
        """, as: UsageBudgetsData.self, door: .budgets).data
        XCTAssertEqual(budgets.windows.first?.pace.allowancePct, 8)
        XCTAssertEqual(budgets.spend.first?.ratio, 0.24)
    }

    func testCountdownAndTokens() {
        XCTAssertEqual(UsageFormat.duration(92 * 60), "1h 32m")
        XCTAssertEqual(UsageFormat.duration(52 * 3600), "2d 4h")
        XCTAssertEqual(UsageFormat.tokens(6_748_754_532), "6.7B")
        XCTAssertEqual(UsageFormat.usd(1500.76), "$1,501")
        XCTAssertEqual(UsageFormat.project("-Users-someone-Projects-Repo"), "Repo")
    }
}
