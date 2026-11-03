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

    func testASavedSessionAnalysisReopensThatSession() {
        let selection = HubUsagePlace(section: .session, session: HubUsageSessionRef(id: "s-1", harness: "codex")).selection
        XCTAssertEqual(HubPlace(mode: "usage", selection: selection, tab: nil).arguments,
                       ["--mode", "usage", "--usage-session", "s-1", "--usage-harness", "codex"])
        XCTAssertEqual(HubUsagePlace(selection: selection)?.session, HubUsageSessionRef(id: "s-1", harness: "codex"))
        XCTAssertEqual(HubUsagePlace(selection: "session:s-2")?.session, HubUsageSessionRef(id: "s-2", harness: nil))
        XCTAssertEqual(HubUsagePlace(section: .limits, session: HubUsageSessionRef(id: "s-1", harness: nil)).selection, "limits")
        XCTAssertNil(HubUsagePlace(selection: "nope"))
        XCTAssertEqual(HubRequest(["--usage-session", "s-1", "--usage-harness", "codex"]).usageHarness, "codex")
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

    // MARK: - Loads that land after their parameters changed

    @MainActor
    private static func scratchPreferences() throws -> UsagePreferences {
        let name = "hub-usage-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        return UsagePreferences(defaults: defaults, notificationNamespace: name, broadcasts: false, observeExternalChanges: false)
    }

    private static func value(after flag: String, in argv: [String]) -> String? {
        argv.firstIndex(of: flag).flatMap { argv.indices.contains($0 + 1) ? argv[$0 + 1] : nil }
    }

    private static func seriesJSON(since: String) -> String {
        """
        {"schema":"usage.limits.series@1","generatedAt":"2026-11-03T10:00:00.000Z",
         "window":{"from":"2026-11-02T10:00:00.000Z","to":"2026-11-03T10:00:00.000Z","tz":"UTC","label":"since \(since)"},
         "selector":{"accounts":[]},"warnings":[],"data":{"agg":"raw","stepMs":0,"series":[],"coverage":[],"events":[]}}
        """
    }

    private static func reportJSON(session: String) -> String {
        """
        {"schema":"ai.sessions.report@1","session":{"provider":"claude","sessionId":"\(session)","filePath":null},
         "report":{"overview":{"first":null,"last":null,"durationMinutes":null,"calls":0,"models":[],"compactions":0},
           "tokens":{"input":0,"cacheRead":0,"cacheWrite":0,"output":0},"cost":{"totalUsd":0,"mainUsd":0,"subagentUsd":0},
           "quotaWeight":null,"models":[],"cache":null,"losses":[],"topCalls":[],"gaps":[]}}
        """
    }

    private static let limitsJSON = """
    {"schema":"usage.limits@1","generatedAt":"2026-11-03T10:00:00.000Z","selector":{"accounts":[]},"warnings":[],
     "data":{"accounts":[{"provider":"anthropic-sub","accountId":"acc_work","accountName":"work","label":"max",
       "limits":[{"key":"seven_day","label":"Weekly","kind":"weekly","percentUsed":62,"severity":"ok"}]},
       {"provider":"openai-sub","accountId":"acc_side","accountName":"side","label":"plus",
       "limits":[{"key":"secondary","label":"Weekly","kind":"weekly","percentUsed":10,"severity":"ok"}]}]}}
    """

    @MainActor
    private func wait(_ timeout: TimeInterval = 3, until condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
    }

    @MainActor
    func testARangeChangeWhileTheOldRangeLoadsShowsOnlyTheNewRange() async throws {
        let preferences = try Self.scratchPreferences()
        let model = HubUsageModel(preferences: preferences, client: UsageClient { argv in
            guard argv.contains("series"), let since = Self.value(after: "--since", in: argv) else { return Data("{}".utf8) }
            // The old range answers last.
            if since == "24h" { try await Task.sleep(nanoseconds: 300_000_000) }
            return Data(Self.seriesJSON(since: since).utf8)
        })
        model.activate()
        preferences.settings.range = .sixHours
        model.rangeChanged()

        try await wait { model.series?.window?.label == "since 6h" }
        try await Task.sleep(nanoseconds: 500_000_000)
        XCTAssertEqual(model.series?.window?.label, "since 6h")
        XCTAssertFalse(model.loading.contains(.series))
    }

    @MainActor
    func testOpeningAnotherSessionWhileOneLoadsShowsTheOtherSession() async throws {
        let model = HubUsageModel(preferences: try Self.scratchPreferences(), client: UsageClient { argv in
            guard argv.contains("report") else { return Data("{}".utf8) }
            if argv.contains("s-old") { try await Task.sleep(nanoseconds: 300_000_000) }
            return Data(Self.reportJSON(session: argv.contains("s-old") ? "s-old" : "s-new").utf8)
        })
        model.openSession("s-old")
        model.openSession("s-new")

        try await wait { model.report?.session.sessionId == "s-new" }
        try await Task.sleep(nanoseconds: 500_000_000)
        XCTAssertEqual(model.report?.session.sessionId, "s-new")
    }

    @MainActor
    func testAnAccountLinkSelectsRowsTheTableAlreadyHas() async throws {
        let model = HubUsageModel(preferences: try Self.scratchPreferences(), client: UsageClient { argv in
            Data((argv.contains("--cached") ? Self.limitsJSON : "{}").utf8)
        })
        model.activate()
        try await wait { model.table.rows.count == 2 }

        model.selectAccounts(named: ["side"])
        XCTAssertEqual(model.selectedAccounts.count, 1)
        XCTAssertEqual(model.table.rows.first { $0.id == model.selectedAccounts.first }?.account.accountName, "side")
        XCTAssertTrue(model.pendingAccounts.isEmpty)
    }

    @MainActor
    func testTheAllAccountsLinkDropsAnEarlierSelectionAndASectionLinkKeepsIt() async throws {
        let model = HubUsageModel(preferences: try Self.scratchPreferences(), client: UsageClient { argv in
            Data((argv.contains("--cached") ? Self.limitsJSON : "{}").utf8)
        })
        model.activate()
        try await wait { model.table.rows.count == 2 }
        model.selectAccounts(named: ["side"])
        model.section = .spend

        // A section alone (a saved place reopening) keeps what the reader picked.
        model.open(HubRequest(["--mode", "usage", "--usage-section", "limits"]))
        XCTAssertEqual(model.section, .limits)
        XCTAssertEqual(model.selectedAccounts.count, 1)

        // The widget's alert with no account: every account, and no earlier link's name waits to apply later.
        model.selectAccounts(named: ["nobody"])
        XCTAssertEqual(model.pendingAccounts, ["nobody"])
        model.section = .spend
        let request = HubRequest(["--mode", "usage", "--usage-section", "limits", "--usage-all-accounts"])
        XCTAssertTrue(request.problems.isEmpty)
        model.open(request)
        XCTAssertEqual(model.section, .limits)
        XCTAssertTrue(model.selectedAccounts.isEmpty)
        XCTAssertTrue(model.pendingAccounts.isEmpty)
        XCTAssertEqual(HubRequest(["--usage-all-accounts"]).launchMode, .usage)
    }

    /// How many times a door ran, from the client's own thread.
    private final class Reads: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        var value: Int { lock.withLock { count } }
        func add() { lock.withLock { count += 1 } }
    }

    @MainActor
    func testComingBackToTheWindowReadsAgainOnlyWhatIsStaleAndOnlyWhileUsageIsOpen() async throws {
        let reads = Reads()
        let model = HubUsageModel(preferences: try Self.scratchPreferences(), client: UsageClient { argv in
            guard argv.contains("--cached") else { return Data("{}".utf8) }
            reads.add()
            return Data(Self.limitsJSON.utf8)
        })
        model.activate()
        try await wait { model.table.rows.count == 2 && !model.sectionLoading }
        let first = reads.value

        // Back within two minutes: the limits are fresh and are not read again.
        model.windowReturned(at: Date())
        try await wait { !model.sectionLoading }
        XCTAssertEqual(reads.value, first)

        // Back hours later: the open section reads again.
        model.windowReturned(at: Date().addingTimeInterval(3 * 3600))
        try await wait { reads.value > first && !model.sectionLoading }
        let second = reads.value

        // Another mode is open: nothing reads.
        model.deactivate()
        model.windowReturned(at: Date().addingTimeInterval(6 * 3600))
        try await wait { !model.sectionLoading }
        XCTAssertEqual(reads.value, second)
    }

    @MainActor
    func testANameTwoProvidersShareSelectsNothingAndTheProviderOrIdPicksOne() async throws {
        let json = """
        {"schema":"usage.limits@1","generatedAt":"2026-11-03T10:00:00.000Z","selector":{"accounts":[]},"warnings":[],
         "data":{"accounts":[{"provider":"anthropic-sub","accountId":"acc_a","accountName":"work","label":"max","limits":[]},
           {"provider":"openai-sub","accountId":"acc_o","accountName":"work","label":"plus","limits":[]}]}}
        """
        let model = HubUsageModel(preferences: try Self.scratchPreferences(), client: UsageClient { argv in
            Data((argv.contains("--cached") ? json : "{}").utf8)
        })
        model.activate()
        try await wait { model.table.rows.count == 2 }

        model.selectAccounts(named: ["work"])
        XCTAssertTrue(model.selectedAccounts.isEmpty)

        model.selectAccounts(named: ["openai-sub/Work"])
        XCTAssertEqual(model.table.rows.first { $0.id == model.selectedAccounts.first }?.account.accountId, "acc_o")

        model.selectAccounts(named: ["acc_a"])
        XCTAssertEqual(model.table.rows.first { $0.id == model.selectedAccounts.first }?.account.accountId, "acc_a")
    }

    @MainActor
    func testARangeChangedInAnotherModeReadsTheNewRangeWhenUsageOpensAgain() async throws {
        let preferences = try Self.scratchPreferences()
        let model = HubUsageModel(preferences: preferences, client: UsageClient { argv in
            guard argv.contains("series"), let since = Self.value(after: "--since", in: argv) else { return Data("{}".utf8) }
            return Data(Self.seriesJSON(since: since).utf8)
        })
        model.activate()
        try await wait { model.series?.window?.label == "since 24h" }
        model.deactivate()

        preferences.settings.range = .sixHours
        model.activate()

        try await wait { model.series?.window?.label == "since 6h" }
        XCTAssertEqual(model.series?.window?.label, "since 6h")
    }

    @MainActor
    func testTheDriftEfficiencyLoadsGivesTheLimitsTableItsVerdict() async throws {
        let drift = """
        {"schema":"usage.limits.drift@1","generatedAt":"2026-11-03T10:00:00.000Z","selector":{"accounts":[]},"warnings":[],
         "data":{"rows":[{"account":{"provider":"anthropic-sub","accountId":"acc_work","accountName":"work"},
           "kind":"weekly","model":"all","weeks":[],"baseline":null,"verdict":"limit cut?"}]}}
        """
        let model = HubUsageModel(preferences: try Self.scratchPreferences(), client: UsageClient { argv in
            if argv.contains("drift") { return Data(drift.utf8) }
            return Data((argv.contains("--cached") ? Self.limitsJSON : "{}").utf8)
        })
        model.activate()
        try await wait { model.table.rows.count == 2 }
        XCTAssertNil(model.table.rows.first { $0.account.accountId == "acc_work" }?.verdict)

        model.section = .efficiency
        try await wait { model.table.rows.first { $0.account.accountId == "acc_work" }?.verdict != nil }
        XCTAssertEqual(model.table.rows.first { $0.account.accountId == "acc_work" }?.verdict, "limit cut?")
    }

    @MainActor
    func testADigestDayChangedWhileTheOldDayLoadsShowsTheNewDay() async throws {
        let store = HubUsageDigestStore(client: UsageClient { argv in
            guard argv.contains("digest"), let day = Self.value(after: "--day", in: argv) else {
                return Data(Self.seriesJSON(since: "6h").utf8)
            }
            if day == "2026-03-01" { try await Task.sleep(nanoseconds: 300_000_000) }
            return Data("""
            {"schema":"usage.digest@1","generatedAt":"x","selector":{"accounts":[]},"warnings":[],
             "data":{"period":"day","days":["\(day)"],"windows":[],"alerts":null,"spend":null,"outlook":[],"workers":null}}
            """.utf8)
        })
        store.loadIfStale(day: "2026-03-01")
        store.loadIfStale(day: "2026-03-02")

        try await wait { store.digest?.data.days == ["2026-03-02"] }
        try await Task.sleep(nanoseconds: 500_000_000)
        XCTAssertEqual(store.digest?.data.days, ["2026-03-02"])
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

    func testTheAccountFilterKeepsRowsWithEveryWordInTheirNameProviderOrPlan() {
        let work = UsageAccountKey(provider: "openai-sub", accountId: "acc_work", accountName: "work")
        XCTAssertTrue(UsageListView.matches(work, plan: nil, filter: "  "))
        XCTAssertTrue(UsageListView.matches(work, plan: "Pro", filter: "WORK openai pro"))
        XCTAssertFalse(UsageListView.matches(work, plan: nil, filter: "work anthropic"))
    }

    func testSpendBarsKeepTwoProjectsWithOneShortNameApartAndARealOtherOutOfTheOverflow() throws {
        let json = """
        {"by":["project"],"grain":"day","tz":"UTC","total":{"costUsd":10,"tokens":0,"unpriced":0},"heatmap":null,"groups":[
          {"key":{"project":"/work/client/api"},"costUsd":4,"tokens":0,"unpriced":0,"points":[{"t":"2026-03-01","costUsd":4,"tokens":0}]},
          {"key":{"project":"/personal/api"},"costUsd":3,"tokens":0,"unpriced":0,"points":[{"t":"2026-03-01","costUsd":3,"tokens":0}]},
          {"key":{"project":"other"},"costUsd":2,"tokens":0,"unpriced":0,"points":[{"t":"2026-03-01","costUsd":2,"tokens":0}]},
          {"key":{"project":"/work/tail"},"costUsd":1,"tokens":0,"unpriced":0,"points":[{"t":"2026-03-01","costUsd":1,"tokens":0}]}]}
        """
        let pivot = try JSONDecoder().decode(UsagePivotData.self, from: Data(json.utf8))
        let bars = UsageSpendBar.bars(pivot, keep: 3)
        XCTAssertEqual(bars.count, 4)
        XCTAssertEqual(Set(bars.map(\.groupId)).count, 4)
        XCTAssertEqual(Set(bars.map(\.group)).count, 4)
        XCTAssertEqual(bars.first { $0.groupId == UsageSpendBar.overflowId }?.usd, 1)
        XCTAssertEqual(bars.first { $0.group == "other" }?.groupId, UsageSpendBar.overflowId)
        XCTAssertEqual(bars.map(\.usd).reduce(0, +), 10)
    }
}
