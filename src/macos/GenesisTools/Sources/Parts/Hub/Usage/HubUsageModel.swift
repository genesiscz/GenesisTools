import Foundation
import SwiftUI

/// The parts of the Usage mode (proposals 1, 10, 12, 13, 14, 17, 19 and 2): the limits with their burn lanes, spend over
/// time, who ate the bar, what one point buys, the plans' value, the workers and the proxy, the avoidable spend, and
/// one session's analysis.
enum HubUsageSection: String, CaseIterable, Identifiable {
    case limits, spend, waste, attribution, efficiency, plans, agents, session

    var id: String { rawValue }

    var title: String {
        switch self {
        case .limits: return "Limits"
        case .spend: return "Spend"
        case .waste: return "Waste"
        case .attribution: return "Attribution"
        case .efficiency: return "Efficiency"
        case .plans: return "Plans"
        case .agents: return "Agents"
        case .session: return "Session analysis"
        }
    }

    var symbol: String {
        switch self {
        case .limits: return "gauge.with.dots.needle.67percent"
        case .spend: return "chart.bar.xaxis"
        case .waste: return "flame"
        case .attribution: return "chart.pie"
        case .efficiency: return "scalemass"
        case .plans: return "creditcard"
        case .agents: return "person.2.wave.2"
        case .session: return "waveform.path.ecg.rectangle"
        }
    }

    var detail: String {
        switch self {
        case .limits: return "Every account's windows, burn lanes, forecasts, spikes and poll coverage"
        case .spend: return "Dollars over time, stacked by provider, account, model, project or harness"
        case .waste: return "Avoidable spend: cache rebuilds after an idle gap, a compaction or a model change"
        case .attribution: return "Who ate each window since its reset: projects and sessions"
        case .efficiency: return "What one point of a window buys per week, and whether a limit moved"
        case .plans: return "Each subscription's billing cycle: list-price spend against the plan's price"
        case .agents: return "Headless workers by backend, model and outcome, and what the ai-proxy served"
        case .session: return "One session's cost, models, costliest calls and cache losses"
        }
    }

    /// The doors a section reads. The Limits section reads the most: the table, the lanes and their markers.
    func doors(_ settings: UsageSettings) -> [HubUsageDoorKey] {
        switch self {
        case .limits: return [.limits, .series, .health, .spikes, .alerts, .advise]
        case .spend: return [.pivot]
        case .waste: return [.waste]
        case .attribution: return [.attribution]
        case .efficiency: return [.drift]
        case .plans: return [.plans]
        case .agents: return [.workers, .proxy]
        case .session: return [.report]
        }
    }
}

/// One loaded door, by name, so a section's state is a dictionary and not fifteen optionals of different types.
enum HubUsageDoorKey: String, CaseIterable {
    case limits, series, health, spikes, alerts, advise, pivot, waste, attribution, drift, plans, workers, proxy, report
}

/// A session the analysis screen shows: its id and, when known, the harness that wrote it.
struct HubUsageSessionRef: Equatable {
    let id: String
    let harness: String?
}

/// The Usage mode's state. Every number comes from `tools ai usage … --json` and `tools ai-spend … --json` (through the
/// hub server where it has the door), never from SQLite or a transcript. A section loads when it opens and again at
/// most every two minutes, or on Refresh; nothing polls while the mode is closed.
@MainActor
final class HubUsageModel: ObservableObject {
    static let maxAge: TimeInterval = 120

    @Published var section: HubUsageSection = .limits {
        didSet { if oldValue != section { loadIfStale() } }
    }
    /// Accounts whose lanes show; empty shows every account.
    @Published var selectedAccounts: [String] = []
    @Published var analysisSession: HubUsageSessionRef? {
        didSet { if oldValue != analysisSession { loaded[.report] = nil } }
    }
    /// The spike whose sessions the Limits section lists.
    @Published var selectedSpike: UsageLaneSpike?
    /// Accounts a link named (`--usage-account <id or name>`), selected once the table knows their ids.
    var pendingAccounts: [String] = []

    @Published private(set) var limits: UsageEnvelope<UsageLimitsData>?
    @Published private(set) var series: UsageEnvelope<UsageSeriesData>?
    @Published private(set) var health: UsageEnvelope<UsageHealthData>?
    @Published private(set) var spikes: UsageEnvelope<UsageSpikesData>?
    @Published private(set) var alerts: UsageEnvelope<UsageAlertsData>?
    @Published private(set) var advise: UsageEnvelope<UsageAdviseData>?
    @Published private(set) var pivot: UsageEnvelope<UsagePivotData>?
    @Published private(set) var waste: UsageEnvelope<UsageWasteData>?
    @Published private(set) var attribution: UsageEnvelope<UsageAttributionData>?
    @Published private(set) var drift: UsageEnvelope<UsageDriftData>?
    @Published private(set) var plans: UsageEnvelope<UsagePlansData>?
    @Published private(set) var workers: UsageWorkersReport?
    @Published private(set) var proxy: UsageEnvelope<UsageProxyData>?
    @Published private(set) var report: UsageSessionReportEnvelope?

    /// The table and the lanes, built off the main thread after each Limits load.
    @Published private(set) var table: (columns: [UsageTableColumn], rows: [UsageTableRow]) = ([], [])
    @Published private(set) var lanes: [UsageAccountLanes] = []
    /// The instant the lanes and countdowns were built for; "now" on the chart.
    @Published private(set) var builtAt = Date()

    @Published private(set) var loading: Set<HubUsageDoorKey> = []
    @Published private(set) var errors: [HubUsageDoorKey: String] = [:]
    private var loaded: [HubUsageDoorKey: Date] = [:]
    private(set) var active = false

    let preferences: UsagePreferences
    private let client: UsageClient

    init(preferences: UsagePreferences = .shared, client: UsageClient = HubUsageModel.hubClient) {
        self.preferences = preferences
        self.client = client
    }

    /// The hub's runner: the resident server when it has the door, else a `tools` process.
    nonisolated static let hubClient = UsageClient { argv in
        try await Task.detached(priority: .userInitiated) { try ToolsCLIRunner.run(argv) }.value
    }

    var settings: UsageSettings { preferences.settings }

    func activate() {
        active = true
        loadIfStale()
    }

    func deactivate() { active = false }

    func loadIfStale() {
        let now = Date()
        let stale = section.doors(settings).filter { key in
            !loading.contains(key) && (loaded[key].map { now.timeIntervalSince($0) >= Self.maxAge } ?? true)
        }
        load(stale)
    }

    /// Reads the open section's doors again, and drops what the other sections hold so they read fresh when opened.
    func reload() {
        loaded = [:]
        load(section.doors(settings))
    }

    /// The range or the resolution changed: the range-bound doors read again.
    func rangeChanged() {
        for key in [HubUsageDoorKey.series, .health, .spikes, .pivot, .waste] { loaded[key] = nil }
        loadIfStale()
    }

    func select(account id: String, additive: Bool) {
        if additive {
            if let index = selectedAccounts.firstIndex(of: id) { selectedAccounts.remove(at: index) } else { selectedAccounts.append(id) }
        } else {
            selectedAccounts = selectedAccounts == [id] ? [] : [id]
        }
    }

    func openSession(_ id: String, harness: String? = nil) {
        analysisSession = HubUsageSessionRef(id: id, harness: harness)
        section = .session
        loadIfStale()
    }

    /// The lanes the chart shows: the selected accounts, or every account.
    var shownLanes: [UsageAccountLanes] {
        selectedAccounts.isEmpty ? lanes : lanes.filter { selectedAccounts.contains($0.account.id) }
    }

    var domain: ClosedRange<Date> {
        let range = settings.range.seconds
        let start = builtAt.addingTimeInterval(-range)
        return start...UsageAccountLanes.domainEnd(lanes, now: builtAt, range: range, projection: settings.projection)
    }

    /// Every warning the open section's doors printed, once each.
    var warnings: [UsageWarning] {
        let all: [[UsageWarning]] = section.doors(settings).map { key in
            switch key {
            case .limits: return limits?.warnings ?? []
            case .series: return series?.warnings ?? []
            case .health: return health?.warnings ?? []
            case .spikes: return spikes?.warnings ?? []
            case .alerts: return alerts?.warnings ?? []
            case .advise: return advise?.warnings ?? []
            case .pivot: return pivot?.warnings ?? []
            case .waste: return waste?.warnings ?? []
            case .attribution: return attribution?.warnings ?? []
            case .drift: return drift?.warnings ?? []
            case .plans: return plans?.warnings ?? []
            case .proxy: return proxy?.warnings ?? []
            case .workers, .report: return []
            }
        }
        var seen = Set<String>()
        return all.flatMap { $0 }.filter { seen.insert($0.code + $0.message).inserted }
    }

    var sectionErrors: [String] { section.doors(settings).compactMap { errors[$0] } }
    var sectionLoading: Bool { section.doors(settings).contains(where: loading.contains) }

    private func load(_ keys: [HubUsageDoorKey]) {
        guard !keys.isEmpty else { return }
        let settings = settings
        let session = analysisSession
        loading.formUnion(keys)
        let done = HubSnapshotLoads.begin("usage")
        let span = HubPerf.begin("usage.load", keys.map(\.rawValue).joined(separator: ","), awaits: true)
        Task {
            await withTaskGroup(of: Void.self) { group in
                for key in keys {
                    group.addTask { await self.fetch(key, settings: settings, session: session) }
                }
            }
            if keys.contains(where: [.limits, .series, .health, .spikes].contains) { await rebuild() }
            span.end()
            done()
        }
    }

    private func fetch(_ key: HubUsageDoorKey, settings: UsageSettings, session: HubUsageSessionRef?) async {
        let range = settings.range
        let resolution = settings.resolution.door(range)
        do {
            switch key {
            case .limits: limits = try await client.envelope(.limits, as: UsageLimitsData.self)
            case .series:
                series = try await client.envelope(.series(range, step: resolution.step, agg: resolution.agg), as: UsageSeriesData.self)
            case .health: health = try await client.envelope(.health(range), as: UsageHealthData.self)
            case .spikes: spikes = try await client.envelope(.spikes(range), as: UsageSpikesData.self)
            case .alerts: alerts = try await client.envelope(.alerts, as: UsageAlertsData.self)
            case .advise: advise = try await client.envelope(.advise, as: UsageAdviseData.self)
            case .pivot: pivot = try await client.envelope(.pivot(range, by: settings.spendStack.rawValue), as: UsagePivotData.self)
            case .waste: waste = try await client.envelope(.waste(range), as: UsageWasteData.self)
            case .attribution: attribution = try await client.envelope(.attribution, as: UsageAttributionData.self)
            case .drift: drift = try await client.envelope(.drift, as: UsageDriftData.self)
            case .plans: plans = try await client.envelope(.plans, as: UsagePlansData.self)
            case .proxy: proxy = try await client.envelope(.proxy, as: UsageProxyData.self)
            case .workers: workers = try await client.plain(.workers, as: UsageWorkersReport.self)
            case .report:
                guard let session else { report = nil; break }
                report = try await client.plain(.sessionReport(id: session.id, harness: session.harness), as: UsageSessionReportEnvelope.self)
            }
            errors[key] = nil
            loaded[key] = Date()
        } catch {
            errors[key] = "\(Self.command(key, settings: settings, session: session)) failed: \(error.localizedDescription)"
            HubPerf.log("usage.\(key.rawValue) failed: \(error)")
        }
        loading.remove(key)
    }

    /// The command a failed door ran, so the error names what to try in a terminal.
    static func command(_ key: HubUsageDoorKey, settings: UsageSettings, session: HubUsageSessionRef?) -> String {
        let range = settings.range
        let resolution = settings.resolution.door(range)
        let door: UsageDoor
        switch key {
        case .limits: door = .limits
        case .series: door = .series(range, step: resolution.step, agg: resolution.agg)
        case .health: door = .health(range)
        case .spikes: door = .spikes(range)
        case .alerts: door = .alerts
        case .advise: door = .advise
        case .pivot: door = .pivot(range, by: settings.spendStack.rawValue)
        case .waste: door = .waste(range)
        case .attribution: door = .attribution
        case .drift: door = .drift
        case .plans: door = .plans
        case .proxy: door = .proxy
        case .workers: door = .workers
        case .report: door = .sessionReport(id: session?.id ?? "<id>", harness: session?.harness)
        }
        return "tools " + door.argv.joined(separator: " ")
    }

    /// The table and the lanes from the loaded doors, built off the main thread.
    private func rebuild() async {
        let settings = settings
        let limits = limits?.data
        let series = series?.data
        let health = health?.data
        let spikes = spikes?.data.spikes ?? []
        let drift = drift?.data
        let now = Date()
        let built = await Task.detached(priority: .userInitiated) { () -> ([UsageTableColumn], [UsageTableRow], [UsageAccountLanes]) in
            let table = limits.map { UsageTableBuilder.build(limits: $0, series: series, health: health, drift: drift, now: now) }
            let lanes = series.map { UsageLaneBuilder.build(series: $0, spikes: spikes, settings: settings) } ?? []
            return (table?.columns ?? [], table?.rows ?? [], lanes)
        }.value
        table = (built.0, built.1)
        lanes = built.2
        builtAt = now
        if !pendingAccounts.isEmpty {
            let wanted = Set(pendingAccounts)
            let ids = built.1.filter { wanted.contains($0.account.accountId) || wanted.contains($0.account.accountName) }.map(\.id)
            if !ids.isEmpty {
                selectedAccounts = ids
                pendingAccounts = []
            }
        }
    }

    /// Acknowledges an alert (`tools ai usage alerts ack <id>`), then reads the alerts again.
    func acknowledge(_ alert: UsageAlert) {
        let client = client
        Task {
            do {
                _ = try await client.fetch(["ai", "usage", "alerts", "ack", String(alert.id)])
                errors[.alerts] = nil
            } catch {
                errors[.alerts] = "tools ai usage alerts ack \(alert.id) failed: \(error.localizedDescription)"
            }
            loaded[.alerts] = nil
            load([.alerts])
        }
    }

    /// A lane setting changed (scoped windows, a hidden absent window): the lanes rebuild from what is loaded.
    func settingsChanged() {
        Task { await rebuild() }
    }
}
