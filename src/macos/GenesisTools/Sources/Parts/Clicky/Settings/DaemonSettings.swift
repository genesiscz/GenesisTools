import AppKit
import GenesisKit
import SwiftUI

// Settings → Background → Daemon: every `tools daemon` task with its state, settings, stats and runs. It reads
// `tools daemon status --json` (the tasks with their effective settings) and `tools daemon stats --json`
// (src/daemon/lib/stats.ts, contract version 1, the same 24 hours as `tools daemon stats --view overview`). Every
// write goes through `tools daemon config set <task> … --json`, so the running daemon reads it on its next tick and
// it survives a daemon restart. Nothing here writes the config file itself.

package struct DaemonTaskConfig: Decodable, Equatable, Identifiable {
    package struct MissedRun: Decodable, Equatable {
        package let mode: String
        package let times: [String]?
    }

    package let name: String
    package let command: String
    package let every: String
    package let enabled: Bool
    package let retries: Int
    package let timeoutMs: Int
    /// "on", "off" or "failure" (the CLI prints true, false or "failure").
    package let notify: String
    package let priority: String
    package let missedRun: MissedRun
    package let schedule: String
    package let description: String?
    package var id: String { name }
    /// "every day at 03:00": only these have missed runs.
    package var isTimeOfDay: Bool { every.contains(" at ") }

    private enum CodingKeys: String, CodingKey {
        case name, command, every, enabled, retries, timeoutMs, notify, priority, missedRun, schedule, description
    }

    package init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        command = try c.decode(String.self, forKey: .command)
        every = try c.decode(String.self, forKey: .every)
        enabled = try c.decode(Bool.self, forKey: .enabled)
        retries = try c.decodeIfPresent(Int.self, forKey: .retries) ?? 0
        timeoutMs = try c.decode(Int.self, forKey: .timeoutMs)
        if let flag = try? c.decode(Bool.self, forKey: .notify) {
            notify = flag ? "on" : "off"
        } else {
            notify = (try? c.decode(String.self, forKey: .notify)) ?? "on"
        }
        priority = try c.decode(String.self, forKey: .priority)
        missedRun = try c.decode(MissedRun.self, forKey: .missedRun)
        schedule = try c.decode(String.self, forKey: .schedule)
        description = try c.decodeIfPresent(String.self, forKey: .description)
    }
}

package struct DaemonStatusPayload: Decodable, Equatable {
    package struct Daemon: Decodable, Equatable {
        package let installed: Bool
        package let running: Bool
        package let pid: Int?
        package let foregroundPid: Int?
    }

    package let daemon: Daemon
    package let configPath: String
    package let logsBaseDir: String
    package var tasks: [DaemonTaskConfig]
}

package struct DaemonRun: Decodable, Equatable, Identifiable {
    package let task: String
    package let runId: String
    package let attempt: Int
    package let startedAt: String
    /// ok, failed, timedOut, killed or unfinished (no exit record yet: running now, or the daemon died).
    package let status: String
    package let exitCode: Int?
    package let durationMs: Double?
    package let logFile: String
    package let reason: String?
    package var id: String { runId }
}

package struct DaemonTaskStats: Decodable, Equatable {
    package struct Bucket: Decodable, Equatable {
        package let label: String
        package let count: Int
    }

    package let task: String
    package let runs: Int
    package let ok: Int
    package let failed: Int
    package let timedOut: Int
    package let killed: Int
    package let unfinished: Int
    package let failureRate: Double?
    package let p50Ms: Double?
    package let p90Ms: Double?
    package let maxMs: Double?
    package let histogram: [Bucket]
    package let lastRun: DaemonRun?
    package let recentRuns: [DaemonRun]
}

package struct DaemonStatsPayload: Decodable, Equatable {
    package struct Totals: Decodable, Equatable {
        package let runs: Int
        package let failed: Int
        package let timedOut: Int
        package let killed: Int
        package let unfinished: Int
        package let failureRate: Double?
    }

    package let version: Int
    package let totals: Totals
    package let tasks: [DaemonTaskStats]
}

package struct DaemonRunOutput: Decodable, Equatable {
    package struct Line: Decodable, Equatable {
        package let type: String
        package let ts: String?
        package let data: String?
    }

    package let lines: [Line]
}

/// The daemon's numbers in the words `tools daemon stats` prints (src/utils/format.ts `formatDuration`, tiered).
package enum DaemonFormat {
    package static func duration(_ ms: Double?) -> String {
        guard let ms else { return "—" }
        if ms < 1000 { return "\(Int(ms.rounded()))ms" }
        if ms < 60_000 { return String(format: "%.1fs", ms / 1000) }
        if ms < 3_600_000 { return "\(Int(ms / 60_000))m \(Int(ms.truncatingRemainder(dividingBy: 60_000) / 1000))s" }
        return "\(Int(ms / 3_600_000))h \(Int(ms.truncatingRemainder(dividingBy: 3_600_000) / 60_000))m"
    }

    package static func percent(_ rate: Double?) -> String {
        guard let rate else { return "—" }
        return String(format: "%.1f%%", rate * 100)
    }

    package static func status(_ status: String) -> (label: String, color: Color) {
        switch status {
        case "ok": return ("ok", .green)
        case "failed": return ("failed", .red)
        case "timedOut": return ("timed out", .orange)
        case "killed": return ("killed", .red)
        default: return ("no exit yet", .blue)
        }
    }
}

@MainActor
package final class DaemonSettingsStore: ObservableObject {
    package static let shared = DaemonSettingsStore()

    @Published package private(set) var status: DaemonStatusPayload?
    @Published package private(set) var stats: DaemonStatsPayload?
    @Published package private(set) var loading = false
    @Published package private(set) var runningNow: Set<String> = []
    @Published package private(set) var outputs: [String: DaemonRunOutput] = [:]
    @Published package var message: String?
    @Published package var messageIsError = false
    /// Bumped by every write; a load that started before a write does not replace the tasks the write returned.
    private var writeGeneration = 0
    private var loadGeneration = 0

    private nonisolated static func cli(_ args: [String], timeout: TimeInterval = 60) async -> Result<Data, Error> {
        await Task.detached(priority: .userInitiated) {
            Result {
                let capture = try ToolsCLIRunner.capture(args, timeout: timeout)
                guard capture.status == 0 else {
                    let stderr = String(decoding: capture.stderr, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
                    let stdout = String(decoding: capture.stdout, as: UTF8.self)
                    throw DaemonSettingsError(text: Self.errorText(stdout: stdout, stderr: stderr, status: capture.status))
                }
                return capture.stdout
            }
        }.value
    }

    /// `config set --json` prints `{error}` on stdout when it refuses; prefer that sentence over the stderr noise.
    private nonisolated static func errorText(stdout: String, stderr: String, status: Int32) -> String {
        if let data = stdout.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let error = object["error"] as? String
        {
            return error
        }
        let lastLine = stderr.split(separator: "\n").last.map(String.init) ?? ""
        return lastLine.isEmpty ? "tools exited \(status)" : lastLine
    }

    package func load() {
        loadGeneration += 1
        let generation = loadGeneration
        let writesAtStart = writeGeneration
        loading = true
        Task {
            async let statusResult = Self.cli(["daemon", "status", "--json"])
            async let statsResult = Self.cli(["daemon", "stats", "--json"], timeout: 90)
            let (statusData, statsData) = await (statusResult, statsResult)
            guard generation == loadGeneration else { return }
            loading = false
            switch statusData {
            case .success(let data):
                do {
                    let decoded = try JSONDecoder().decode(DaemonStatusPayload.self, from: data)
                    if writesAtStart == writeGeneration { status = decoded }
                } catch {
                    show("Reading tools daemon status --json failed: \(error)", error: true)
                }
            case .failure(let error):
                show("\(error)", error: true)
            }
            switch statsData {
            case .success(let data):
                do {
                    stats = try JSONDecoder().decode(DaemonStatsPayload.self, from: data)
                } catch {
                    show("Reading tools daemon stats --json failed: \(error)", error: true)
                }
            case .failure(let error):
                show("\(error)", error: true)
            }
        }
    }

    package func stats(for task: String) -> DaemonTaskStats? {
        stats?.tasks.first { $0.task == task }
    }

    /// One `tools daemon config set <task> <flags> --json`. The switch moves at once; the CLI's answer (the stored
    /// task) replaces it, and a refused change puts the old value back and says why.
    package func set(_ task: DaemonTaskConfig, _ flags: [String], optimistic: ((inout DaemonTaskConfig) -> Void)? = nil) {
        writeGeneration += 1
        let before = status
        if let optimistic, let index = status?.tasks.firstIndex(where: { $0.name == task.name }) {
            optimistic(&status!.tasks[index])
        }
        Task {
            switch await Self.cli(["daemon", "config", "set", task.name] + flags + ["--json"]) {
            case .success(let data):
                if let updated = try? JSONDecoder().decode(DaemonTaskConfig.self, from: data),
                    let index = status?.tasks.firstIndex(where: { $0.name == updated.name })
                {
                    status?.tasks[index] = updated
                }
                show("Saved \(task.name). The daemon uses it from its next tick.", error: false)
            case .failure(let error):
                status = before
                show("\(task.name): \(error)", error: true)
            }
        }
    }

    package func runNow(_ task: DaemonTaskConfig) {
        guard !runningNow.contains(task.name) else { return }
        runningNow.insert(task.name)
        show("Running \(task.name) now…", error: false)
        let timeout = TimeInterval(task.timeoutMs) / 1000 + 30
        Task {
            let result = await Self.cli(["daemon", "run", task.name, "--json"], timeout: timeout)
            runningNow.remove(task.name)
            switch result {
            case .success:
                show("\(task.name) finished.", error: false)
            case .failure(let error):
                show("\(task.name): \(error)", error: true)
            }
            load()
        }
    }

    package func loadOutput(_ run: DaemonRun) {
        guard outputs[run.runId] == nil else { return }
        Task {
            switch await Self.cli(["daemon", "stats", "--view", "run", "--run", run.runId, "--task", run.task, "--json"]) {
            case .success(let data):
                do {
                    outputs[run.runId] = try JSONDecoder().decode(DaemonRunOutput.self, from: data)
                } catch {
                    show("Reading run \(run.runId) failed: \(error)", error: true)
                }
            case .failure(let error):
                show("Run \(run.runId): \(error)", error: true)
            }
        }
    }

    private func show(_ text: String, error: Bool) {
        message = text
        messageIsError = error
    }
}

package struct DaemonSettingsError: Error, CustomStringConvertible {
    package let text: String
    package var description: String { text }
}

@MainActor
package enum DaemonSettingsPages {
    package static let pageID = "daemon"

    package static func section() -> NativeSettingsSection {
        NativeSettingsSection(
            id: "background", title: "Background",
            pages: [
                NativeSettingsPage(
                    id: pageID, title: "Daemon", symbol: "gearshape.2", tint: .gray,
                    subtitle: "The tasks the GenesisTools daemon runs: their schedule, limits, runs and output."
                ) {
                    DaemonSettingsView(store: .shared)
                },
            ], order: 37)
    }
}

@MainActor
package struct DaemonSettingsView: View {
    @ObservedObject package var store: DaemonSettingsStore

    package var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            overview
            if let message = store.message {
                NoticePill(text: message, isError: store.messageIsError) { store.message = nil }
            }
            if let status = store.status {
                ForEach(status.tasks) { task in
                    DaemonTaskCard(task: task, stats: store.stats(for: task.name), store: store)
                }
            } else {
                NativeSettingsCard {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Reading the daemon's tasks…").font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .onAppear { store.load() }
    }

    private var overview: some View {
        NativeSettingsCard {
            NativeSettingsRow(daemonTitle, detail: totalsLine) {
                HStack(spacing: 8) {
                    if store.loading { ProgressView().controlSize(.small) }
                    IconButton(systemName: "arrow.clockwise", tooltip: "Read the tasks and the last 24 hours of runs again") {
                        store.load()
                    }
                    .accessibilityIdentifier("daemon.refresh")
                    if let path = store.status?.configPath {
                        IconButton(systemName: "doc.text", tooltip: "Open the task config in Cursor: \(path)") {
                            PathOpener.cursor(path)
                        }
                    }
                }
            }
        }
    }

    private var daemonTitle: String {
        guard let daemon = store.status?.daemon else { return "Daemon" }
        if daemon.running, let pid = daemon.pid { return "Daemon running (launchd, PID \(pid))" }
        if let pid = daemon.foregroundPid { return "Daemon running (foreground, PID \(pid))" }
        return daemon.installed ? "Daemon installed but not running" : "Daemon not installed"
    }

    /// The footer of `tools daemon stats --view overview`, in its words.
    private var totalsLine: String {
        guard let totals = store.stats?.totals else { return "Reading the last 24 hours of runs…" }
        let failed = totals.failed + totals.timedOut + totals.killed
        return "Last 24 hours: \(totals.runs) runs · \(failed) failed (\(DaemonFormat.percent(totals.failureRate))) · \(totals.unfinished) unfinished"
    }
}

@MainActor
private struct DaemonTaskCard: View {
    let task: DaemonTaskConfig
    let stats: DaemonTaskStats?
    @ObservedObject var store: DaemonSettingsStore
    @State private var settingsOpen = false
    @State private var runsOpen = false

    var body: some View {
        NativeSettingsCard(task.name, subtitle: task.description) {
            NativeSettingsRow(stateTitle, detail: scheduleLine) {
                HStack(spacing: 10) {
                    Button(store.runningNow.contains(task.name) ? "Running…" : "Run now") { store.runNow(task) }
                        .buttonStyle(.bordered)
                        .nativeSettingsPointer()
                        .disabled(store.runningNow.contains(task.name))
                        .instantTooltip("Run it once now with its timeout and priority (tools daemon run \(task.name))")
                        .accessibilityIdentifier("daemon.\(task.name).run")
                    Toggle("Enabled", isOn: Binding(
                        get: { task.enabled },
                        set: { on in store.set(task, ["--enabled", on ? "on" : "off"]) { $0 = $0.with(enabled: on) } }
                    ))
                    .labelsHidden().toggleStyle(.switch).controlSize(.small)
                    .nativeSettingsDisabledLook()
                    .accessibilityIdentifier("daemon.\(task.name).enabled")
                }
            }
            if let stats {
                DaemonStatsStrip(stats: stats)
            }
            Divider()
            NativeSettingsDisclosure("Schedule and limits", identifier: "daemon.\(task.name).settings") {
                DaemonTaskEditor(task: task, store: store)
            }
            NativeSettingsDisclosure(runsTitle, identifier: "daemon.\(task.name).runs") {
                DaemonRunList(runs: stats?.recentRuns ?? [], store: store)
            }
        }
    }

    private var runsTitle: String {
        let count = stats?.recentRuns.count ?? 0
        return count == 0 ? "Recent runs" : "Recent runs (\(count))"
    }

    /// Idle, running now, or the last result.
    private var stateTitle: String {
        if store.runningNow.contains(task.name) { return "Running now" }
        guard let last = stats?.lastRun else { return task.enabled ? "No run in the last 24 hours" : "Off" }
        if last.status == "unfinished",
            let started = HubFormat.date(last.startedAt),
            Date().timeIntervalSince(started) * 1000 < Double(task.timeoutMs)
        {
            return "Running now"
        }
        let state = DaemonFormat.status(last.status).label
        return task.enabled ? "Last run \(state)" : "Off · last run \(state)"
    }

    private var scheduleLine: String {
        var parts = [task.schedule, "timeout \(DaemonFormat.duration(Double(task.timeoutMs)))", "priority \(task.priority)"]
        if task.retries > 0 { parts.append(Plural.count(task.retries, "retry", "retries")) }
        if task.isTimeOfDay { parts.append("missed runs: \(DaemonMissedRun.title(task.missedRun.mode).lowercased())") }
        if let last = stats?.lastRun, let date = HubFormat.date(last.startedAt) {
            parts.append("last \(date.formatted(date: .omitted, time: .shortened))")
        }
        return parts.joined(separator: " · ")
    }
}

/// The overview's columns for one task, plus its duration distribution.
private struct DaemonStatsStrip: View {
    let stats: DaemonTaskStats

    var body: some View {
        HStack(alignment: .bottom, spacing: 18) {
            metric("Runs", "\(stats.runs)")
            metric("OK", "\(stats.ok)")
            metric("Failed", "\(stats.failed)", alert: stats.failed > 0)
            metric("Timeout", "\(stats.timedOut)", alert: stats.timedOut > 0)
            metric("Fail %", DaemonFormat.percent(stats.failureRate), alert: (stats.failureRate ?? 0) > 0)
            metric("P50", DaemonFormat.duration(stats.p50Ms))
            metric("P90", DaemonFormat.duration(stats.p90Ms))
            metric("Max", DaemonFormat.duration(stats.maxMs))
            Spacer(minLength: 8)
            DaemonHistogram(buckets: stats.histogram)
        }
    }

    private func metric(_ title: String, _ value: String, alert: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
            Text(verbatim: value).font(.system(size: 13, weight: .medium, design: .rounded)).monospacedDigit()
                .foregroundStyle(alert ? Color.orange : Color.primary)
        }
    }
}

/// Run durations as small bars, one per bucket of `tools daemon stats --view durations`.
private struct DaemonHistogram: View {
    let buckets: [DaemonTaskStats.Bucket]

    var body: some View {
        let peak = max(1, buckets.map(\.count).max() ?? 1)
        HStack(alignment: .bottom, spacing: 2) {
            ForEach(Array(buckets.enumerated()), id: \.offset) { _, bucket in
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(bucket.count == 0 ? Color.white.opacity(0.08) : Color.accentColor.opacity(0.75))
                    .frame(width: 7, height: bucket.count == 0 ? 2 : max(3, 26 * CGFloat(bucket.count) / CGFloat(peak)))
            }
        }
        .frame(height: 26, alignment: .bottom)
        .instantTooltip(
            title: "Run durations, last 24 hours",
            bullets: buckets.filter { $0.count > 0 }.map { "\($0.label): \(Plural.count($0.count, "run"))" })
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Run durations: " + buckets.filter { $0.count > 0 }.map { "\($0.label) \($0.count)" }.joined(separator: ", "))
    }
}

package enum DaemonMissedRun {
    package static let modes = ["asap", "on-wake", "retry-at", "skip"]

    package static func title(_ mode: String) -> String {
        switch mode {
        case "on-wake": return "At the first full wake"
        case "retry-at": return "At set times"
        case "skip": return "Skip"
        default: return "As soon as possible"
        }
    }

    package static func detail(_ mode: String) -> String {
        switch mode {
        case "on-wake": return "Waits until the Mac is fully awake (not a dark wake), then runs at low priority."
        case "retry-at": return "Runs at the first of these times still ahead today; a failed run tries the next one."
        case "skip": return "Leaves the missed run out and waits for the next scheduled time."
        default: return "Runs at the daemon's first tick after the missed time, even in a dark wake."
        }
    }
}

@MainActor
private struct DaemonTaskEditor: View {
    let task: DaemonTaskConfig
    @ObservedObject var store: DaemonSettingsStore
    @State private var every = ""
    @State private var retryTimes = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            NativeSettingsRow("Schedule", detail: "\"every 5 minutes\", \"every 2 hours\" or \"every day at 03:00\". Return saves.") {
                TextField("every 5 minutes", text: $every)
                    .textFieldStyle(.roundedBorder).frame(width: 200)
                    .onSubmit { commitEvery() }
                    .accessibilityIdentifier("daemon.\(task.name).every")
            }
            NativeSettingsRow("Timeout", detail: "A run still going after this long is stopped and counts as timed out.") {
                HStack(spacing: 6) {
                    NativeSettingsNumberPicker(
                        "Timeout seconds", range: 1..<7201, identifier: "daemon.\(task.name).timeout",
                        value: Binding(
                            get: { max(1, task.timeoutMs / 1000) },
                            set: { seconds in
                                store.set(task, ["--timeout-ms", String(seconds * 1000)]) { $0 = $0.with(timeoutMs: seconds * 1000) }
                            }))
                    Text("s").font(.system(size: 12)).foregroundStyle(.secondary)
                }
            }
            NativeSettingsRow("Priority", detail: priorityDetail) {
                Picker("Priority", selection: Binding(
                    get: { task.priority },
                    set: { value in store.set(task, ["--priority", value]) { $0 = $0.with(priority: value) } }
                )) {
                    Text("High").tag("high")
                    Text("Normal").tag("normal")
                    Text("Low").tag("low")
                }
                .pickerStyle(.segmented).labelsHidden().frame(width: 210)
                .accessibilityIdentifier("daemon.\(task.name).priority")
            }
            NativeSettingsRow("Notifications", detail: "macOS banners for this task's runs.") {
                Picker("Notifications", selection: Binding(
                    get: { task.notify },
                    set: { value in store.set(task, ["--notify", value]) { $0 = $0.with(notify: value) } }
                )) {
                    Text("Every run").tag("on")
                    Text("Failures").tag("failure")
                    Text("Off").tag("off")
                }
                .pickerStyle(.segmented).labelsHidden().frame(width: 240)
                .accessibilityIdentifier("daemon.\(task.name).notify")
            }
            NativeSettingsRow("Retries", detail: "Extra attempts after a failed run, a little later each time.") {
                HStack(spacing: 8) {
                    Text(verbatim: "\(task.retries)")
                        .font(.system(size: 16, weight: .medium, design: .rounded)).monospacedDigit()
                    Stepper(
                        "Retries",
                        value: Binding(
                            get: { task.retries },
                            set: { value in store.set(task, ["--retries", String(value)]) { $0 = $0.with(retries: value) } }),
                        in: 0...10
                    )
                    .labelsHidden()
                    .accessibilityIdentifier("daemon.\(task.name).retries")
                }
            }
            if task.isTimeOfDay {
                NativeSettingsRow("Missed runs", detail: DaemonMissedRun.detail(task.missedRun.mode)) {
                    Picker("Missed runs", selection: Binding(
                        get: { task.missedRun.mode },
                        set: { mode in
                            if mode == "retry-at" {
                                let times = retryTimes.isEmpty ? "10:00,12:00" : retryTimes
                                retryTimes = times
                                store.set(task, ["--missed-run", "retry-at", "--retry-at", times])
                            } else {
                                store.set(task, ["--missed-run", mode])
                            }
                        }
                    )) {
                        ForEach(DaemonMissedRun.modes, id: \.self) { Text(DaemonMissedRun.title($0)).tag($0) }
                    }
                    .pickerStyle(.menu).labelsHidden().frame(width: 200)
                    .accessibilityIdentifier("daemon.\(task.name).missedRun")
                }
                if task.missedRun.mode == "retry-at" {
                    NativeSettingsRow("Times", detail: "Comma-separated, 24-hour HH:MM. Return saves.") {
                        TextField("10:00, 12:00", text: $retryTimes)
                            .textFieldStyle(.roundedBorder).frame(width: 200)
                            .onSubmit { store.set(task, ["--retry-at", retryTimes]) }
                            .accessibilityIdentifier("daemon.\(task.name).retryAt")
                    }
                }
            }
            NativeSettingsRow("Command", detail: task.command) { EmptyView() }
        }
        .onAppear(perform: syncFields)
        .onChange(of: task) { _, _ in syncFields() }
    }

    private var priorityDetail: String {
        switch task.priority {
        case "high": return "Starts first and is never throttled, even under a daemon installed at background priority."
        case "low": return "Starts last and runs at background priority: slower disk and CPU, no effect on your work."
        default: return "Runs at the daemon's priority, in the order the tasks became due."
        }
    }

    private func syncFields() {
        every = task.every
        retryTimes = (task.missedRun.times ?? []).joined(separator: ", ")
    }

    private func commitEvery() {
        let value = every.trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty, value != task.every else { return }
        store.set(task, ["--every", value])
    }
}

/// The recent runs; a click opens the run's output under it, from its run log.
@MainActor
private struct DaemonRunList: View {
    let runs: [DaemonRun]
    @ObservedObject var store: DaemonSettingsStore
    @State private var openRun: String?
    @GenReduceMotion private var reduceMotion

    var body: some View {
        list.onAppear {
            // `--expand daemon.run.<id>` opens that run's output in a snapshot.
            if openRun == nil, let run = runs.first(where: { NativeSettingsLaunch.expanded.contains("daemon.run.\($0.runId)") }) {
                store.loadOutput(run)
                openRun = run.runId
            }
        }
    }

    @ViewBuilder
    private var list: some View {
        if runs.isEmpty {
            Text("No runs in the last 24 hours.").font(.system(size: 12)).foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(runs) { run in
                    row(run)
                    if openRun == run.runId {
                        output(run).transition(.genReveal)
                    }
                }
            }
        }
    }

    private func row(_ run: DaemonRun) -> some View {
        let state = DaemonFormat.status(run.status)
        let open = openRun == run.runId
        return HStack(spacing: 10) {
            Image(systemName: "chevron.right")
                .font(.system(size: 9, weight: .semibold))
                .rotationEffect(.degrees(open ? 90 : 0))
                .foregroundStyle(.secondary)
            LiveAgo(date: HubFormat.date(run.startedAt), style: .ago)
                .font(.system(size: 11.5)).monospacedDigit().frame(width: 74, alignment: .leading)
            Circle().fill(state.color).frame(width: 7, height: 7)
            Text(state.label).font(.system(size: 12)).frame(width: 78, alignment: .leading)
            Text(verbatim: DaemonFormat.duration(run.durationMs)).font(.system(size: 12)).monospacedDigit()
                .frame(width: 64, alignment: .leading)
            if let reason = run.reason, reason != "scheduled" {
                Badge(reason, color: .secondary)
            }
            if run.attempt > 1 {
                Badge("try \(run.attempt)", color: .secondary)
            }
            Spacer(minLength: 0)
            Text(verbatim: run.runId).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 6)
        .frame(height: 26)
        .contentShape(Rectangle())
        .rowButton(cornerRadius: 6) { toggle(run) }
        .accessibilityLabel("Run \(run.runId), \(state.label)")
        .accessibilityIdentifier("daemon.run.\(run.runId)")
    }

    private func toggle(_ run: DaemonRun) {
        let opening = openRun != run.runId
        if opening { store.loadOutput(run) }
        GenMotion.perform(expanding: opening, reduceMotion: reduceMotion) {
            openRun = opening ? run.runId : nil
        }
    }

    @ViewBuilder
    private func output(_ run: DaemonRun) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let output = store.outputs[run.runId] {
                let lines = output.lines.filter { $0.type == "stdout" || $0.type == "stderr" }
                if lines.isEmpty {
                    Text("The run printed nothing.").font(.system(size: 11)).foregroundStyle(.secondary)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 1) {
                            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                                Text(verbatim: line.data ?? "")
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(line.type == "stderr" ? Color.secondary : Color.primary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                        .textSelection(.enabled)
                        .padding(10)
                    }
                    .frame(maxHeight: 280)
                    .background(.black.opacity(0.25), in: RoundedRectangle(cornerRadius: 8))
                }
            } else {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Reading the run log…").font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 6) {
                Text("Output from stdout; stderr in grey.").font(.system(size: 10.5)).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                PathLabel(path: run.logFile, font: .system(size: 10.5, design: .monospaced))
            }
        }
        .padding(.leading, 22).padding(.vertical, 4)
    }
}

extension DaemonTaskConfig {
    /// A copy with one field changed, for the optimistic state while `config set` runs.
    package func with(
        enabled: Bool? = nil, timeoutMs: Int? = nil, priority: String? = nil, notify: String? = nil, retries: Int? = nil
    ) -> DaemonTaskConfig {
        DaemonTaskConfig(
            copying: self, enabled: enabled ?? self.enabled, timeoutMs: timeoutMs ?? self.timeoutMs,
            priority: priority ?? self.priority, notify: notify ?? self.notify, retries: retries ?? self.retries)
    }

    private init(copying task: DaemonTaskConfig, enabled: Bool, timeoutMs: Int, priority: String, notify: String, retries: Int) {
        name = task.name
        command = task.command
        every = task.every
        self.enabled = enabled
        self.retries = retries
        self.timeoutMs = timeoutMs
        self.notify = notify
        self.priority = priority
        missedRun = task.missedRun
        schedule = task.schedule
        description = task.description
    }
}
