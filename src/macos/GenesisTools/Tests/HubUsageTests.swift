import SwiftUI
import Vision
import XCTest
@testable import GenesisKit
@testable import GenesisToolsHub

/// The Usage mode's request flags and places, the spend bars, and the forecast chip keyed by provider and account.
final class HubUsageTests: XCTestCase {
    func testUsageFlagsOpenTheModeAndNameABadSection() {
        let request = HubRequest(["--usage-section", "spend"])
        XCTAssertEqual(request.launchMode, .usage)
        XCTAssertTrue(request.snapshotLoads.contains("usage"))
        XCTAssertEqual(HubRequest(["--usage-account", "work", "--usage-account", "acc_side"]).usageAccounts, ["work", "acc_side"])
        XCTAssertEqual(HubRequest(["--usage-section", "nope"]).problems.count, 1)
    }

    func testAUsagePlaceReopensItsSection() {
        let place = HubPlace(mode: "usage", selection: "attribution", tab: nil)
        XCTAssertEqual(place.arguments, ["--mode", "usage", "--usage-section", "attribution"])
    }

    /// Two providers each with an account called "work": the session's provider picks its own windows.
    func testTheForecastChipMatchesProviderAndAccount() throws {
        let json = """
        {"generatedAt":"2026-03-02T15:00:00.000Z","source":null,"accounts":[
          {"provider":"anthropic-sub","account":"work","warning":null,"windows":[
            {"bucket":"seven_day","kind":"weekly","label":"Weekly","utilization":61,"resetsAt":"2026-03-06T15:00:00.000Z","lastSampleAt":"2026-03-02T15:00:00.000Z","samples":4,
             "ratePctPerHour":null,"basis":null,"exhaustAt":null,"minutesToExhaust":null,"beforeReset":false,"projectedAtReset":null,"resetSinceSample":false,"stale":false}]},
          {"provider":"openai-sub","account":"work","warning":null,"windows":[
            {"bucket":"primary","kind":"session","label":"5h","utilization":12,"resetsAt":"2026-03-02T18:00:00.000Z","lastSampleAt":"2026-03-02T15:00:00.000Z","samples":4,
             "ratePctPerHour":null,"basis":null,"exhaustAt":null,"minutesToExhaust":null,"beforeReset":false,"projectedAtReset":null,"resetSinceSample":false,"stale":false}]}]}
        """
        let accounts = try JSONDecoder().decode(HubForecastResult.self, from: Data(json.utf8)).accounts
        XCTAssertEqual(HubForecastStore.match(accounts, provider: "openai-sub", name: "work")?.headline?.bucket, "primary")
        XCTAssertEqual(HubForecastStore.match(accounts, provider: "anthropic-sub", name: "work")?.headline?.bucket, "seven_day")
        XCTAssertNil(HubForecastStore.match(accounts, provider: nil, name: "work"), "an ambiguous name answers nothing")
        XCTAssertEqual(Harness(rawValue: "codex")?.plugin, "openai-sub")
    }

    /// The digest's Usage section as it draws: a forecast row with its cone, then the day's spend and outlook, from
    /// canned doors. `USAGE_SNAPSHOT_DIR=<folder>` also writes the picture there.
    @MainActor
    func testTheDigestUsageSectionDrawsTheConeAndTheDaysSpend() async throws {
        let now = try XCTUnwrap(UsageTime.date("2026-03-02T15:00:00.000Z"))
        let digestJSON = """
        {"schema":"usage.digest@1","generatedAt":"2026-03-02T15:00:00.000Z","selector":{"accounts":[]},"warnings":[],
         "data":{"period":"day","days":["2026-03-01"],"windows":[],"alerts":{"total":2,"byRule":{"threshold":2},"budget":0},
           "spend":{"totalUsd":42.5,"byProvider":[{"provider":"anthropic-sub","usd":42.5}],"byModel":[],"unpriced":0,
             "topSessions":[{"agent":"claude","sessionId":"5e55-alpha","project":"-Users-someone-Projects-Shop","account":null,"costUsd":30,"next":null}]},
           "outlook":[{"account":{"provider":"anthropic-sub","accountId":"acc_work","accountName":"work"},"label":"Weekly",
             "utilization":80,"exhaustAt":"2026-03-03T09:00:00.000Z","resetsAt":"2026-03-04T15:00:00.000Z"}]}}
        """
        let seriesJSON = """
        {"schema":"usage.limits.series@1","generatedAt":"2026-03-02T15:00:00.000Z","selector":{"accounts":[]},"warnings":[],
         "data":{"agg":"raw","stepMs":0,"coverage":[],"events":[],"series":[
          {"provider":"anthropic-sub","accountId":"acc_work","accountName":"work","key":"seven_day","kind":"weekly","scopeModel":null,
           "label":"Weekly","periodMs":604800000,"availability":[],"availableNow":"limited",
           "points":[{"t":"2026-03-02T10:00:00.000Z","v":60,"severity":"ok"},{"t":"2026-03-02T14:00:00.000Z","v":78,"severity":"warning"}],
           "resets":[],"current":{"utilization":80,"resetsAt":"2026-03-04T15:00:00.000Z","severity":"warning","fetchedAt":"2026-03-02T15:00:00.000Z"},
           "forecast":{"bucket":"seven_day","kind":"weekly","label":"Weekly","utilization":80,"resetsAt":"2026-03-04T15:00:00.000Z",
             "lastSampleAt":"2026-03-02T14:00:00.000Z","samples":6,"ratePctPerHour":4,"basis":"active","exhaustAt":"2026-03-03T09:00:00.000Z",
             "minutesToExhaust":300,"beforeReset":true,"projectedAtReset":180,"resetSinceSample":false,"stale":false,
             "paceBand":{"lowPctPerHour":2,"highPctPerHour":6},"safePctPerHour":0.4}}]}}
        """
        let store = HubUsageDigestStore(client: UsageClient { argv in
            Data((argv.contains("digest") ? digestJSON : seriesJSON).utf8)
        })
        store.load(day: "2026-03-01")
        for _ in 0..<200 where store.digest == nil { try await Task.sleep(nanoseconds: 10_000_000) }
        let lane = try XCTUnwrap(store.lane(provider: "anthropic-sub", account: "work", bucket: "seven_day"))
        XCTAssertNotNil(lane.forecast?.outSpan)

        let (work, _) = try absentAccounts()
        let view = VStack(alignment: .leading, spacing: 10) {
            HubForecastRow(entry: work, cone: lane, now: now)
            HubUsageDigestSummary(store: store) { _, _ in }
        }
        .frame(width: 640)
        .padding(12)
        .background(Color.black)
        .environment(\.colorScheme, .dark)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.cgImage)
        if let folder = ProcessInfo.processInfo.environment["USAGE_SNAPSHOT_DIR"] {
            let url = URL(fileURLWithPath: folder).appendingPathComponent("hub-digest-usage-section.png")
            let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil))
            CGImageDestinationAddImage(destination, image, nil)
            XCTAssertTrue(CGImageDestinationFinalize(destination))
        }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
        XCTAssertTrue(text.contains("$42.50"), text)
        XCTAssertTrue(text.contains("Shop"), text)
        XCTAssertTrue(text.contains("runs out"), text)
    }

    /// `work` with a 5h window, `personal` without one (the same shape `HubDailyTests` reads).
    private func absentAccounts() throws -> (work: HubForecastAccount, personal: HubForecastAccount) {
        let json = """
        {"generatedAt":"2026-03-02T15:00:00.000Z","source":null,"accounts":[
          {"provider":"anthropic-sub","account":"work","warning":null,"absentWindows":[],"windows":[
            {"bucket":"seven_day","kind":"weekly","label":"Weekly","utilization":80,"resetsAt":"2026-03-04T15:00:00.000Z","lastSampleAt":"2026-03-02T14:00:00.000Z","samples":6,
             "ratePctPerHour":4,"basis":"active","exhaustAt":"2026-03-03T09:00:00.000Z","minutesToExhaust":300,"beforeReset":true,"projectedAtReset":180,"resetSinceSample":false,"stale":false}]},
          {"provider":"anthropic-sub","account":"personal","warning":null,"absentWindows":["five_hour"],"windows":[]}]}
        """
        let accounts = try JSONDecoder().decode(HubForecastResult.self, from: Data(json.utf8)).accounts
        return (try XCTUnwrap(accounts.first { $0.account == "work" }), try XCTUnwrap(accounts.first { $0.account == "personal" }))
    }

    func testSpendBarsKeepTheLargestGroupsAndStackTheRestAsOther() throws {
        let json = """
        {"by":["model"],"grain":"day","tz":"UTC","total":{"costUsd":10,"tokens":0,"unpriced":0},"heatmap":null,"groups":[
          {"key":{"model":"a"},"costUsd":6,"tokens":0,"unpriced":0,"points":[{"t":"2026-03-01","costUsd":6,"tokens":0}]},
          {"key":{"model":"b"},"costUsd":3,"tokens":0,"unpriced":0,"points":[{"t":"2026-03-01","costUsd":3,"tokens":0}]},
          {"key":{"model":"c"},"costUsd":1,"tokens":0,"unpriced":0,"points":[{"t":"2026-03-01","costUsd":1,"tokens":0}]}]}
        """
        let pivot = try JSONDecoder().decode(UsagePivotData.self, from: Data(json.utf8))
        let bars = UsageSpendBar.bars(pivot, keep: 1)
        XCTAssertEqual(bars.map(\.group), ["a", "other"])
        XCTAssertEqual(bars.map(\.usd), [6, 4])
        XCTAssertNotNil(UsageSpendBar.bucketDate("2026-10-27T06", timeZone: "UTC"))
    }
}
