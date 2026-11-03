import SwiftUI

/// The Usage section of the Today digest (UI3, proposals 5 and 16): the day's usage digest (`tools ai usage digest
/// --day <day> --json`) and the last 6 hours of every window with its forecast cone (`limits series --since 6h`).
/// It loads when the digest opens and again at most every two minutes, as the forecast does.
@MainActor
final class HubUsageDigestStore: ObservableObject {
    static let shared = HubUsageDigestStore()
    static let maxAge: TimeInterval = 120

    @Published private(set) var digest: UsageEnvelope<UsageDigestData>?
    /// Each account's lanes of the last 6 hours, keyed `provider \u{1} account name` (the forecast's own key).
    @Published private(set) var lanes: [String: [UsageLane]] = [:]
    @Published private(set) var builtAt = Date()
    @Published private(set) var error: String?
    private var loadedDay: String?
    private var loadedAt: Date?
    private var loading = false
    private let client: UsageClient

    init(client: UsageClient = HubUsageModel.hubClient) {
        self.client = client
    }

    static func key(provider: String, account: String) -> String { provider + "\u{1}" + account }

    /// The window a forecast row draws its cone for.
    func lane(provider: String, account: String, bucket: String?) -> UsageLane? {
        let lanes = lanes[Self.key(provider: provider, account: account)] ?? []
        return lanes.first { $0.key == bucket } ?? lanes.first
    }

    func loadIfStale(day: String) {
        guard !loading else { return }
        if loadedDay == day, let loadedAt, Date().timeIntervalSince(loadedAt) < Self.maxAge { return }
        load(day: day)
    }

    func load(day: String) {
        loading = true
        let done = HubSnapshotLoads.begin("forecast")
        let span = HubPerf.begin("usage.digest.load", day, awaits: true)
        let client = client
        let settings = UsagePreferences.shared.settings
        Task {
            defer {
                loading = false
                span.end()
                done()
            }
            async let digest = client.envelope(.digest(week: false, date: day), as: UsageDigestData.self)
            async let series = client.envelope(.series(.sixHours, step: "raw", agg: "raw"), as: UsageSeriesData.self)
            do {
                let (digestValue, seriesValue) = try await (digest, series)
                let built = await Task.detached(priority: .userInitiated) {
                    UsageLaneBuilder.build(series: seriesValue.data, settings: settings)
                }.value
                self.digest = digestValue
                lanes = Dictionary(built.map { (Self.key(provider: $0.account.provider, account: $0.account.accountName), $0.lanes) },
                                   uniquingKeysWith: { first, _ in first })
                builtAt = Date()
                error = nil
            } catch {
                self.error = "Usage digest failed: \(error.localizedDescription)"
            }
            loadedDay = day
            loadedAt = Date()
        }
    }
}

/// The last six hours of one window with its forecast cone, beside an account's row in the digest.
struct HubForecastCone: View {
    let lane: UsageLane
    let now: Date

    var body: some View {
        UsageBurnLaneView(
            lane: lane, domain: now.addingTimeInterval(-6 * 3600)...now.addingTimeInterval(3 * 3600),
            settings: Self.settings, now: now, extendTo: now, labelled: false, height: 22)
            .frame(width: 150)
            .instantTooltip(lane.forecast?.label(now: now) ?? "\(lane.title): the last 6 hours, no burn to project")
    }

    /// A mini chart: the cone and the safe pace, no markers.
    private static let settings: UsageSettings = {
        var settings = UsageSettings()
        settings.spikeMarkers = false
        settings.eventMarkers = false
        settings.resetBands = false
        return settings
    }()
}

/// The day's usage in a few lines: spend by provider, the costliest sessions (Analyze opens the session analysis in the
/// Usage mode), the alerts, and the accounts predicted to run out before their reset.
struct HubUsageDigestSummary: View {
    @ObservedObject var store: HubUsageDigestStore
    let analyze: (String, String?) -> Void

    var body: some View {
        if let error = store.error {
            Text(verbatim: error).font(.system(size: 11)).foregroundColor(ReviewPalette.removed)
        } else if let digest = store.digest?.data {
            VStack(alignment: .leading, spacing: 6) {
                if let spend = digest.spend {
                    HStack(spacing: 8) {
                        Text(verbatim: UsageFormat.usd(spend.totalUsd))
                            .font(.system(size: 13, weight: .semibold, design: .monospaced))
                        Text(verbatim: spend.byProvider.map { "\($0.name) \(UsageFormat.usd($0.usd))" }.joined(separator: " · "))
                            .font(.system(size: 11)).foregroundColor(ReviewPalette.dim).lineLimit(1)
                        if spend.unpriced > 0 {
                            Text(verbatim: Plural.count(spend.unpriced, "unpriced event"))
                                .font(.system(size: 11)).foregroundColor(ReviewPalette.modified)
                        }
                    }
                    VStack(spacing: 0) {
                        ForEach(spend.topSessions.prefix(3)) { session in
                            UsageSessionLine(sessionId: session.sessionId, harness: session.agent, project: session.project,
                                             costUsd: session.costUsd, share: nil, detail: session.account?.accountName,
                                             analyze: analyze)
                                .equatable()
                        }
                    }
                }
                if let alerts = digest.alerts, alerts.total > 0 {
                    Text(verbatim: "\(Plural.count(alerts.total, "alert"))" + (alerts.budget > 0 ? ", \(Plural.count(alerts.budget, "budget hit"))" : ""))
                        .font(.system(size: 11.5)).foregroundColor(ReviewPalette.modified)
                }
                ForEach(digest.outlook) { outlook in
                    HStack(spacing: 6) {
                        Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 10)).foregroundColor(ReviewPalette.modified)
                        Text(verbatim: "\(outlook.account.accountName) \(outlook.label) \(UsageFormat.percent(outlook.utilization)): runs out \(UsageFormat.clock(UsageTime.date(outlook.exhaustAt))), resets \(UsageFormat.clock(UsageTime.date(outlook.resetsAt)))")
                            .font(.system(size: 11.5)).foregroundColor(Color.white.opacity(0.85))
                    }
                }
            }
        }
    }
}
