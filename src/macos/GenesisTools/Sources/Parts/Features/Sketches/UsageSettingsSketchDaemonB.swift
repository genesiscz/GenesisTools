import GenesisKit
import SwiftUI

// Hub UX wave 2, area "usageSettings", option B for Background → Daemon: a table of every task (one line each, the
// columns compare the jobs), and the selected task's detail under it (C56b), on the flat look of option B (C61,
// GenesisKit Sketches/UsageSettingsSketchSettingsB.swift). Drawn only in a run started with
// `--sketch usageSettings=b`. It lives in the features part because it reads `DaemonSettingsStore`.

/// Background → Daemon, option B.
@MainActor
struct UsageSettingsSketchDaemonB: View {
    @ObservedObject var store: DaemonSettingsStore
    /// The task the detail shows. View state only; nil picks the first task with a failure, else the first task.
    @State private var selectedName: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 26) {
            UsageSettingsSketchSectionB(daemonTitle, subtitle: totalsLine) {
                HStack(spacing: 8) {
                    if store.loading { ProgressView().controlSize(.small) }
                    IconButton(systemName: "arrow.clockwise", tooltip: "Read the tasks and the last 24 hours of runs again") {
                        store.load()
                    }
                    if let path = store.status?.configPath {
                        IconButton(systemName: "doc.text", tooltip: "Open the task config in Cursor: \(path)") {
                            PathOpener.cursor(path)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .padding(.top, 8)
            }
            if let message = store.message {
                NoticePill(text: message, isError: store.messageIsError) { store.message = nil }
            }
            if let status = store.status {
                table(status.tasks)
                if let task = selected(status.tasks) {
                    detail(task)
                }
            } else {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Reading the daemon's tasks…").font(.system(size: 12)).foregroundStyle(.secondary)
                }
            }
        }
        .onAppear { store.load() }
    }

    private var daemonTitle: String {
        guard let daemon = store.status?.daemon else { return "Daemon" }
        if daemon.running, let pid = daemon.pid { return "Daemon running (launchd, PID \(pid))" }
        if let pid = daemon.foregroundPid { return "Daemon running (foreground, PID \(pid))" }
        return daemon.installed ? "Daemon installed but not running" : "Daemon not installed"
    }

    private var totalsLine: String {
        guard let totals = store.stats?.totals else { return "Reading the last 24 hours of runs…" }
        let failed = totals.failed + totals.timedOut + totals.killed
        return "Last 24 hours: \(Plural.count(totals.runs, "run")), \(failed) failed or timed out, \(totals.unfinished) unfinished."
    }

    private func bad(_ stats: DaemonTaskStats?) -> Int {
        guard let stats else { return 0 }
        return stats.failed + stats.killed + stats.timedOut
    }

    private func selected(_ tasks: [DaemonTaskConfig]) -> DaemonTaskConfig? {
        if let selectedName, let task = tasks.first(where: { $0.name == selectedName }) { return task }
        return tasks.first { bad(store.stats(for: $0.name)) > 0 } ?? tasks.first
    }

    // MARK: Table

    private func table(_ tasks: [DaemonTaskConfig]) -> some View {
        let current = selected(tasks)?.name
        return UsageSettingsSketchSectionB("Tasks", subtitle: "One line per task. Select a task for its runs and statistics.") {
            HStack(spacing: 10) {
                Text("Task").frame(maxWidth: .infinity, alignment: .leading)
                Text("Last run").frame(width: 92, alignment: .leading)
                Text("Problems").frame(width: 78, alignment: .leading)
                Text("Typical").frame(width: 64, alignment: .leading)
                Text("On").frame(width: 40, alignment: .trailing)
            }
            .font(.system(size: 10.5, weight: .semibold))
            .foregroundStyle(.secondary)
            .padding(.vertical, 6)
            .padding(.horizontal, 8)
            .accessibilityHidden(true)
            UsageSettingsSketchRuleB()
            ForEach(tasks) { task in
                row(task, selected: task.name == current)
            }
        }
    }

    private func row(_ task: DaemonTaskConfig, selected: Bool) -> some View {
        let stats = store.stats(for: task.name)
        let last = stats?.lastRun
        let problems = bad(stats)
        return HStack(spacing: 10) {
            HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                Text(task.name).font(.system(size: 12.5, weight: .medium)).lineLimit(1)
                Text(task.schedule).font(.system(size: 10.5)).foregroundStyle(.secondary).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 5) {
                Circle().fill(last.map { DaemonFormat.status($0.status).color } ?? Color.secondary).frame(width: 6, height: 6)
                Text(last.map { DaemonFormat.status($0.status).label } ?? "no run").font(.system(size: 11.5))
            }
            .frame(width: 92, alignment: .leading)
            Text(verbatim: problems == 0 ? "none" : "\(problems) of \(stats?.runs ?? 0)")
                .font(.system(size: 11.5)).monospacedDigit()
                .foregroundStyle(problems == 0 ? Color.secondary : Color.orange)
                .frame(width: 78, alignment: .leading)
            Text(DaemonFormat.duration(stats?.p50Ms))
                .font(.system(size: 11.5)).monospacedDigit()
                .frame(width: 64, alignment: .leading)
            }
            .frame(height: 38)
            .contentShape(Rectangle())
            .rowButton(cornerRadius: 6) { selectedName = task.name }
            .liveRow(selected: selected)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
            // The switch sits outside the row's button, so a click on it never also selects the row.
            Toggle("Enabled", isOn: Binding(
                get: { task.enabled },
                set: { on in store.set(task, ["--enabled", on ? "on" : "off"]) { $0 = $0.with(enabled: on) } }))
                .labelsHidden().toggleStyle(.switch).controlSize(.mini)
                .disabled(store.savingTasks.contains(task.name))
                .accessibilityLabel("\(task.name) enabled")
                .frame(width: 40, alignment: .trailing)
        }
        .padding(.horizontal, 8)
        .background(RoundedRectangle(cornerRadius: 6).fill(selected ? Color.accentColor.opacity(0.18) : Color.clear))
    }

    // MARK: Detail

    /// An unfinished last run still inside its timeout is running, as option A and the current page read it.
    private static func lastRunInFlight(_ task: DaemonTaskConfig, _ stats: DaemonTaskStats?) -> Bool {
        guard let last = stats?.lastRun, last.status == "unfinished", let started = SessionFormat.parseISO(last.startedAt) else { return false }
        return Date().timeIntervalSince(started) * 1000 < Double(task.timeoutMs)
    }

    private func detail(_ task: DaemonTaskConfig) -> some View {
        let stats = store.stats(for: task.name)
        let running = store.runningNow.contains(task.name)
        return UsageSettingsSketchSectionB(task.name, subtitle: task.description) {
            NativeSettingsRow(
                DaemonFormat.stateTitle(enabled: task.enabled, stats: stats, running: running,
                                         lastRunInFlight: Self.lastRunInFlight(task, stats)),
                detail: "\(task.schedule) · timeout \(DaemonFormat.duration(Double(task.timeoutMs))) · priority \(task.priority) · \(Plural.count(task.retries, "retry", "retries"))"
            ) {
                Button(running ? "Running…" : "Run now") { store.runNow(task) }
                    .buttonStyle(.bordered)
                    .nativeSettingsPointer()
                    .disabled(running)
                    .instantTooltip("Run this task once now, with its timeout and priority")
            }
            .usageSketchRowB()
            if let stats {
                UsageSettingsSketchRuleB()
                HStack(alignment: .bottom, spacing: 22) {
                    fact("Runs", "\(stats.runs)")
                    fact("Ok", "\(stats.ok)")
                    fact("Failed", "\(stats.failed + stats.killed)", alert: stats.failed + stats.killed > 0)
                    fact("Timed out", "\(stats.timedOut)", alert: stats.timedOut > 0)
                    fact("Typical", DaemonFormat.duration(stats.p50Ms))
                    fact("Slow", DaemonFormat.duration(stats.p90Ms))
                    fact("Longest", DaemonFormat.duration(stats.maxMs))
                    Spacer(minLength: 8)
                    histogram(stats.histogram)
                }
                .usageSketchRowB()
                UsageSettingsSketchRuleB()
                VStack(alignment: .leading, spacing: 4) {
                    Text("Recent runs").font(.system(size: 12, weight: .medium))
                    ForEach(stats.recentRuns.prefix(8)) { run in
                        HStack(spacing: 10) {
                            Circle().fill(DaemonFormat.status(run.status).color).frame(width: 6, height: 6)
                            Text(SessionFormat.parseISO(run.startedAt).map { $0.formatted(date: .abbreviated, time: .shortened) } ?? run.startedAt)
                                .font(.system(size: 11)).monospacedDigit()
                                .frame(width: 140, alignment: .leading)
                            Text(DaemonFormat.status(run.status).label).font(.system(size: 11))
                                .frame(width: 80, alignment: .leading)
                            Text(DaemonFormat.duration(run.durationMs)).font(.system(size: 11)).monospacedDigit()
                                .foregroundStyle(.secondary)
                                .frame(width: 70, alignment: .leading)
                            Text(run.reason ?? "").font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                            Spacer(minLength: 0)
                        }
                        .frame(height: 20)
                        .accessibilityElement(children: .combine)
                    }
                    if stats.recentRuns.isEmpty {
                        Text("No run in the last 24 hours.").font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                }
                .usageSketchRowB()
            }
            UsageSettingsSketchRuleB()
            NativeSettingsRow("Schedule and limits", detail: "The editor of the current page goes here: run time, missed runs, timeout, priority, retries, notify.") {
                EmptyView()
            }
            .usageSketchRowB()
        }
    }

    private func fact(_ title: String, _ value: String, alert: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.system(size: 10.5)).foregroundStyle(.secondary)
            Text(verbatim: value).font(.system(size: 13, weight: .medium)).monospacedDigit()
                .foregroundStyle(alert ? Color.orange : Color.primary)
        }
        .accessibilityElement(children: .combine)
    }

    private func histogram(_ buckets: [DaemonTaskStats.Bucket]) -> some View {
        let peak = max(1, buckets.map(\.count).max() ?? 1)
        return HStack(alignment: .bottom, spacing: 2) {
            ForEach(Array(buckets.enumerated()), id: \.offset) { _, bucket in
                Rectangle()
                    .fill(bucket.count == 0 ? Color.primary.opacity(0.1) : Color.accentColor.opacity(0.75))
                    .frame(width: 7, height: bucket.count == 0 ? 2 : max(3, 26 * CGFloat(bucket.count) / CGFloat(peak)))
            }
        }
        .frame(height: 26, alignment: .bottom)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Run durations: " + buckets.filter { $0.count > 0 }.map { "\($0.label) \($0.count)" }.joined(separator: ", "))
    }
}
