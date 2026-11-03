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

/// A Usage place's selection in the history and in `place.json`: the section, or `session:<id>` (then a space and the
/// harness when known) for one session's analysis, so a restore reopens that session and not an empty Session section.
struct HubUsagePlace: Equatable {
    var section: HubUsageSection
    var session: HubUsageSessionRef?

    static let sessionPrefix = "session:"

    init(section: HubUsageSection, session: HubUsageSessionRef?) {
        self.section = section
        self.session = section == .session ? session : nil
    }

    init?(selection: String) {
        guard selection.hasPrefix(Self.sessionPrefix) else {
            guard let section = HubUsageSection(rawValue: selection) else { return nil }
            self.init(section: section, session: nil)
            return
        }
        let parts = selection.dropFirst(Self.sessionPrefix.count).split(separator: " ", maxSplits: 1).map(String.init)
        guard let id = parts.first, !id.isEmpty else { return nil }
        self.init(section: .session, session: HubUsageSessionRef(id: id, harness: parts.count > 1 ? parts[1] : nil))
    }

    var selection: String {
        guard let session else { return section.rawValue }
        return Self.sessionPrefix + session.id + (session.harness.map { " " + $0 } ?? "")
    }

    /// The `--hub` flags that open this place.
    var arguments: [String] {
        guard let session else { return ["--usage-section", section.rawValue] }
        return ["--usage-session", session.id] + (session.harness.map { ["--usage-harness", $0] } ?? [])
    }
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
        didSet { if oldValue != analysisSession { invalidate([.report]) } }
    }
    /// The spike whose sessions the Limits section lists.
    @Published var selectedSpike: UsageLaneSpike?
    /// Accounts a link named (`--usage-account <id or name>`), selected once the table knows their ids.
    private(set) var pendingAccounts: [String] = []

    @Published private(set) var limits: UsageEnvelope<UsageLimitsData>?
    @Published private(set) var series: UsageEnvelope<UsageSeriesData>?
    @Published private(set) var health: UsageEnvelope<UsageHealthData>?
    @Published private(set) var spikes: UsageEnvelope<UsageSpikesData>?
    @Published private(set) var alerts: UsageEnvelope<UsageAlertsData>?
    @Published private(set) var advise: UsageEnvelope<UsageAdviseData>?
    @Published private(set) var pivot: UsageEnvelope<UsagePivotData>?
    /// The Spend chart's bars, built off the main thread each time the pivot lands (never in the view body).
    @Published private(set) var spendBars: [UsageSpendBar] = []
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
    /// A failed acknowledge, kept apart from `errors` so the alerts read that follows it does not clear it. It clears
    /// when an acknowledge works, or when the alerts read finds that alert no longer open.
    @Published private(set) var ackError: String?
    private var ackFailedAlert: Int?
    private var loaded: [HubUsageDoorKey: Date] = [:]
    /// Each door's newest request. A completion of an older one (the range or the session changed while it ran) is
    /// dropped, so the old answer never lands under the new parameters or marks them fresh.
    private var generations: [HubUsageDoorKey: Int] = [:]
    private(set) var active = false
    /// The preferences the doors were last read or rebuilt for; `activate` compares them with the current ones.
    private var seenSettings: UsageSettings?

    let preferences: UsagePreferences
    private let client: UsageClient

    init(preferences: UsagePreferences = .shared, client: UsageClient = HubUsageModel.hubClient) {
        self.preferences = preferences
        self.client = client
        // Uncovered, unminimized or back from another Space: the open section reads what went stale meanwhile.
        HubVisibility.shared.onChange(self) { model, visible in
            if visible { model.windowReturned() }
        }
    }

    /// The hub's runner: the resident server when it has the door, else a `tools` process.
    nonisolated static let hubClient = UsageClient { argv in
        try await Task.detached(priority: .userInitiated) { try ToolsCLIRunner.run(argv) }.value
    }

    var settings: UsageSettings { preferences.settings }

    func activate() {
        active = true
        preferencesChanged()
        loadIfStale()
    }

    /// Where the mode is, for the history and `place.json`.
    var place: HubUsagePlace { HubUsagePlace(section: section, session: analysisSession) }

    func deactivate() { active = false }

    /// The window came back (it became key, or it can be seen again): while the mode is open, the open section reads
    /// again what is older than `maxAge`, so percentages and countdowns left open for hours do not stay frozen.
    func windowReturned(at now: Date = Date()) {
        guard active else { return }
        loadIfStale(now: now)
    }

    func loadIfStale(now: Date = Date()) {
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

    /// The preferences changed, on screen or while another mode showed (UsageMain is not in the tree then, so its
    /// `onChange` never saw it): the range-bound doors read again when the range, the resolution or the stack moved,
    /// else the lanes rebuild from what is loaded.
    func preferencesChanged() {
        let now = settings
        defer { seenSettings = now }
        guard let old = seenSettings, old != now else { return }
        if old.range != now.range || old.resolution != now.resolution || old.spendStack != now.spendStack {
            rangeChanged()
        } else {
            settingsChanged()
        }
    }

    /// The range or the resolution changed: the range-bound doors read again, and a read still running for the old
    /// range is dropped when it lands.
    func rangeChanged() {
        invalidate([.series, .health, .spikes, .pivot, .waste])
        loadIfStale()
    }

    /// Forgets what the doors hold and any read in flight for them, so the next `loadIfStale` asks again.
    private func invalidate(_ keys: [HubUsageDoorKey]) {
        for key in keys {
            generations[key, default: 0] += 1
            loaded[key] = nil
            loading.remove(key)
        }
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
        return start...UsageAccountLanes.domainEnd(lanes, now: builtAt, range: range, projection: settings.drawsForecast)
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
    /// The failed acknowledge, on the sections that show the alerts.
    var sectionAckError: String? { section.doors(settings).contains(.alerts) ? ackError : nil }
    var sectionLoading: Bool { section.doors(settings).contains(where: loading.contains) }

    private func load(_ keys: [HubUsageDoorKey]) {
        guard !keys.isEmpty else { return }
        let settings = settings
        let session = analysisSession
        var requests: [HubUsageDoorKey: Int] = [:]
        for key in keys {
            generations[key, default: 0] += 1
            requests[key] = generations[key]
        }
        loading.formUnion(keys)
        let done = HubSnapshotLoads.begin("usage")
        let span = HubPerf.begin("usage.load", keys.map(\.rawValue).joined(separator: ","), awaits: true)
        Task {
            await withTaskGroup(of: Void.self) { group in
                for key in keys {
                    let generation = requests[key] ?? 0
                    group.addTask { await self.fetch(key, generation: generation, settings: settings, session: session) }
                }
            }
            // `.drift` too: the table's verdict column reads it, and Efficiency loads it without the Limits doors.
            if keys.contains(where: [.limits, .series, .health, .spikes, .drift].contains) { await rebuild() }
            span.end()
            done()
        }
    }

    private func fetch(_ key: HubUsageDoorKey, generation: Int, settings: UsageSettings, session: HubUsageSessionRef?) async {
        let range = settings.range
        let resolution = settings.resolution.door(range)
        let apply: () -> Void
        do {
            switch key {
            case .limits:
                let value = try await client.envelope(.limits, as: UsageLimitsData.self)
                apply = { self.limits = value }
            case .series:
                let value = try await client.envelope(.series(range, step: resolution.step, agg: resolution.agg), as: UsageSeriesData.self)
                apply = { self.series = value }
            case .health:
                let value = try await client.envelope(.health(range), as: UsageHealthData.self)
                apply = { self.health = value }
            case .spikes:
                let value = try await client.envelope(.spikes(range), as: UsageSpikesData.self)
                apply = { self.spikes = value }
            case .alerts:
                let value = try await client.envelope(.alerts, as: UsageAlertsData.self)
                apply = {
                    self.alerts = value
                    if let id = self.ackFailedAlert, !value.data.alerts.contains(where: { $0.id == id && $0.isOpen }) {
                        self.ackFailedAlert = nil
                        self.ackError = nil
                    }
                }
            case .advise:
                let value = try await client.envelope(.advise, as: UsageAdviseData.self)
                apply = { self.advise = value }
            case .pivot:
                let value = try await client.envelope(.pivot(range, by: settings.spendStack.rawValue), as: UsagePivotData.self)
                let pivotData = value.data
                let bars = await Task.detached(priority: .userInitiated) { UsageSpendBar.bars(pivotData) }.value
                apply = {
                    self.pivot = value
                    self.spendBars = bars
                }
            case .waste:
                let value = try await client.envelope(.waste(range), as: UsageWasteData.self)
                apply = { self.waste = value }
            case .attribution:
                let value = try await client.envelope(.attribution, as: UsageAttributionData.self)
                apply = { self.attribution = value }
            case .drift:
                let value = try await client.envelope(.drift, as: UsageDriftData.self)
                apply = { self.drift = value }
            case .plans:
                let value = try await client.envelope(.plans, as: UsagePlansData.self)
                apply = { self.plans = value }
            case .proxy:
                let value = try await client.envelope(.proxy, as: UsageProxyData.self)
                apply = { self.proxy = value }
            case .workers:
                let value = try await client.plain(.workers, as: UsageWorkersReport.self)
                apply = { self.workers = value }
            case .report:
                if let session {
                    let value = try await client.plain(.sessionReport(id: session.id, harness: session.harness), as: UsageSessionReportEnvelope.self)
                    apply = { self.report = value }
                } else {
                    apply = { self.report = nil }
                }
            }
        } catch {
            guard generations[key] == generation else { return }
            errors[key] = "\(Self.command(key, settings: settings, session: session)) failed: \(error.localizedDescription)"
            HubPerf.log("usage.\(key.rawValue) failed: \(error)")
            loading.remove(key)
            return
        }
        // A newer request owns the door now (the range or the session changed): this answer is for the old one.
        guard generations[key] == generation else { return }
        apply()
        errors[key] = nil
        loaded[key] = Date()
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
        applyPendingAccounts()
    }

    /// A link's Usage place: its accounts, or every account (`--usage-all-accounts` drops the selection and any name
    /// still waiting for its row), then its session or section.
    func open(_ request: HubRequest) {
        if request.usageAllAccounts {
            pendingAccounts = []
            selectedAccounts = []
            section = .limits
        } else if !request.usageAccounts.isEmpty {
            selectAccounts(named: request.usageAccounts)
            section = .limits
        }
        if let id = request.usageSession {
            openSession(id, harness: request.usageHarness)
        } else if let section = request.usageSection.flatMap(HubUsageSection.init(rawValue:)) {
            self.section = section
        }
    }

    /// Selects the accounts a link named (`--usage-account`). Rows already on screen take the selection at once (a
    /// fresh table starts no load, so waiting for the next rebuild left the old selection); the names wait for the
    /// next rebuild only while no row matches yet. Each name resolves as `tools ai usage --account` does: an id,
    /// `provider/name` or a name, case-insensitive, and a name two providers share selects nothing.
    func selectAccounts(named names: [String]) {
        pendingAccounts = names
        applyPendingAccounts()
    }

    private func applyPendingAccounts() {
        guard !pendingAccounts.isEmpty else { return }
        let ids = pendingAccounts.compactMap { Self.uniqueRow(for: $0, in: table.rows)?.id }
        if !ids.isEmpty {
            selectedAccounts = ids
            pendingAccounts = []
        }
    }

    /// The one row a selector names, or nil when it names none or several.
    static func uniqueRow(for selector: String, in rows: [UsageTableRow]) -> UsageTableRow? {
        let wanted = selector.lowercased()
        let matches = rows.filter { row in
            let account = row.account
            return [account.accountId, account.accountName, account.provider + "/" + account.accountName]
                .contains { $0.lowercased() == wanted }
        }
        return matches.count == 1 ? matches[0] : nil
    }

    /// Acknowledges an alert (`tools ai usage alerts ack <id>`), then reads the alerts again. A failure goes to
    /// `ackError`, which that read does not clear.
    func acknowledge(_ alert: UsageAlert) {
        let client = client
        Task {
            do {
                _ = try await client.fetch(["ai", "usage", "alerts", "ack", String(alert.id)])
                ackFailedAlert = nil
                ackError = nil
            } catch {
                ackFailedAlert = alert.id
                ackError = "tools ai usage alerts ack \(alert.id) failed: \(error.localizedDescription)"
            }
            invalidate([.alerts])
            load([.alerts])
        }
    }

    /// A lane setting changed (scoped windows, a hidden absent window): the lanes rebuild from what is loaded.
    func settingsChanged() {
        Task { await rebuild() }
    }
}
