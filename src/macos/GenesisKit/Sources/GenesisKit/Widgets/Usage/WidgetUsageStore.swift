import AppKit
import Foundation

/// The widget's Usage module data (UI4, proposal 20): every account's windows now (`tools ai usage limits --cached`),
/// the last six hours with each window's forecast (`limits series --since 6h`) and the alerts (`usage alerts`). It reads
/// while the module is on screen and again when the usage poller rewrites its snapshots file, never on a timer.
@MainActor
public final class WidgetUsageStore: ObservableObject {
    @Published public private(set) var rows: [UsageTableRow] = []
    @Published public private(set) var alerts: [UsageAlert] = []
    @Published public private(set) var loading = false
    @Published public private(set) var error: String?
    /// What the doors said they could not measure (no history, no store), once each: an empty table with these is
    /// missing evidence, not an account with room.
    @Published public private(set) var warnings: [UsageWarning] = []
    /// A failed acknowledge, kept apart from `error` so the read that follows it does not clear it. It clears when an
    /// acknowledge works, or when a read finds that alert no longer open (acknowledged somewhere else).
    @Published public private(set) var ackError: String?
    private var ackFailedAlert: Int?
    @Published public private(set) var loadedAt: Date?

    private let client: UsageClient
    private let watchFolder: String
    private var watcher: DirectoryWatcher?
    private var visible = false
    private var loadTask: Task<Void, Never>?
    /// Opens the hub's Usage mode at an account (`--hub --usage-account <name>`), or at a session's analysis.
    let openHub: ([String]) -> Void

    /// `watchFolder`: where the usage poller writes `snapshots.json` (`~/.genesis-tools/ai-usage/cache`).
    public init(client: UsageClient, watchFolder: String = WidgetUsageStore.defaultWatchFolder,
                openHub: @escaping ([String]) -> Void = WidgetUsageStore.launchHub) {
        self.client = client
        self.watchFolder = watchFolder
        self.openHub = openHub
    }

    nonisolated public static var defaultWatchFolder: String {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".genesis-tools/ai-usage/cache").path
    }

    /// Starts this app's own `--hub` face with the arguments; a running hub takes them over.
    nonisolated public static func launchHub(_ arguments: [String]) {
        guard let executable = Bundle.main.executableURL else { return }
        let child = Process()
        child.executableURL = executable
        child.arguments = ["--hub"] + arguments
        child.standardInput = FileHandle.nullDevice
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        do { try child.run() } catch { PerfLog.mark("widget.usage open hub \(error.localizedDescription)") }
    }

    /// The open alerts, newest first.
    public var openAlerts: [UsageAlert] { alerts.filter(\.isOpen) }

    /// A critical open alert, or an account at or over 90 % of a window: the module's summary says so first.
    public var hasCritical: Bool {
        openAlerts.contains { $0.level == "critical" }
            || rows.contains { row in row.cells.values.contains { ($0.percent ?? 0) >= 90 } }
    }

    func visibilityChanged(_ presentation: WidgetModulePresentation?) {
        let shown = presentation != nil
        guard shown != visible else { return }
        visible = shown
        if shown {
            watcher = DirectoryWatcher(paths: [watchFolder], latency: 2, accepts: { $0.hasSuffix("snapshots.json") }) { [weak self] _ in
                self?.load()
            }
            load()
        } else {
            watcher?.stop()
            watcher = nil
            loadTask?.cancel()
            loadTask = nil
            loading = false
        }
    }

    public func load() {
        loadTask?.cancel()
        loading = true
        let client = client
        loadTask = Task { [weak self] in
            do {
                async let limits = client.envelope(.limits, as: UsageLimitsData.self)
                async let series = client.envelope(.series(.sixHours, step: "raw", agg: "raw"), as: UsageSeriesData.self)
                async let alerts = client.envelope(.alerts, as: UsageAlertsData.self)
                let (limitsValue, seriesValue, alertsValue) = try await (limits, series, alerts)
                let now = Date()
                let table = await Task.detached(priority: .utility) {
                    UsageTableBuilder.build(limits: limitsValue.data, series: seriesValue.data, now: now)
                }.value
                guard let self, !Task.isCancelled else { return }
                self.rows = table.rows
                self.alerts = alertsValue.data.alerts
                self.warnings = UsageWarning.merged([limitsValue.warnings, seriesValue.warnings, alertsValue.warnings])
                self.error = nil
                if let id = self.ackFailedAlert, !self.openAlerts.contains(where: { $0.id == id }) {
                    self.ackFailedAlert = nil
                    self.ackError = nil
                }
                self.loadedAt = now
            } catch is CancellationError {
                return
            } catch {
                self?.error = "Usage could not be read: \(error.localizedDescription)"
            }
            self?.loading = false
        }
    }

    public func acknowledge(_ alert: UsageAlert) {
        let client = client
        Task { [weak self] in
            do {
                _ = try await client.fetch(["ai", "usage", "alerts", "ack", String(alert.id)])
                self?.ackFailedAlert = nil
                self?.ackError = nil
            } catch {
                self?.ackFailedAlert = alert.id
                self?.ackError = "tools ai usage alerts ack \(alert.id) failed: \(error.localizedDescription)"
            }
            self?.load()
        }
    }

    /// Opens the hub at the alert's account, or at the Usage mode's Limits with no account picked when the alert
    /// names none.
    func openAlert(_ alert: UsageAlert) {
        if let account = alert.accountId ?? alert.accountName {
            openHub(["--usage-account", account])
        } else {
            openHub(["--mode", "usage", "--usage-section", "limits", "--usage-all-accounts"])
        }
    }

    /// The window a ring shows for an account: the preference's (the week, or the 5h), else the other one.
    public static func ring(_ row: UsageTableRow, window: WidgetUsageRingWindow) -> (percent: Double?, severity: String?, label: String, absent: Bool) {
        let wanted = window == .session ? "session" : "weekly"
        let other = window == .session ? "weekly" : "session"
        if let cell = row.cells[wanted], !cell.absent { return (cell.percent, cell.severity, window == .session ? "5h" : "wk", false) }
        if let cell = row.cells[other], !cell.absent { return (cell.percent, cell.severity, other == "session" ? "5h" : "wk", row.cells[wanted]?.absent == true) }
        return (nil, nil, "—", row.cells[wanted]?.absent == true)
    }
}

/// Which window a ring of the collapsed module shows.
public enum WidgetUsageRingWindow: String, CaseIterable, Identifiable, Codable, Sendable {
    case weekly, session
    public var id: String { rawValue }
    public var title: String { self == .weekly ? "Week" : "5 hours" }
}
