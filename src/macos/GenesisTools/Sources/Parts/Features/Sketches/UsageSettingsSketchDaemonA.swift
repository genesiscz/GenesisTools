import GenesisKit
import SwiftUI

// Hub UX wave 2, area "usageSettings", option A for Background → Daemon: one compact row per task in one group, the
// statistics and runs folded under each row (C56b), on the grouped look of option A (C61, GenesisKit
// Sketches/UsageSettingsSketchSettingsA.swift). Drawn only in a run started with `--sketch usageSettings=a`.
// It lives in the features part because it reads `DaemonSettingsStore`, which GenesisKit does not have.

/// Background → Daemon, option A.
@MainActor
struct UsageSettingsSketchDaemonA: View {
    @ObservedObject var store: DaemonSettingsStore

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            UsageSettingsSketchGroupA("Daemon", symbol: "gearshape.2") {
                NativeSettingsRow(daemonTitle, detail: totalsLine) {
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
                    }
                }
                .usageSketchRowA()
            }
            if let message = store.message {
                NoticePill(text: message, isError: store.messageIsError) { store.message = nil }
            }
            if let status = store.status {
                UsageSettingsSketchGroupA(
                    "Tasks", symbol: "list.bullet.rectangle",
                    footer: "A row says the worst result of the last 24 hours first. Statistics and recent runs open under each row."
                ) {
                    ForEach(Array(status.tasks.enumerated()), id: \.element.id) { index, task in
                        if index > 0 { UsageSettingsSketchSeparatorA() }
                        UsageSketchDaemonRowA(
                            task: task,
                            stats: store.stats(for: task.name),
                            running: store.runningNow.contains(task.name),
                            saving: store.savingTasks.contains(task.name),
                            runNow: { store.runNow(task) },
                            setEnabled: { on in store.set(task, ["--enabled", on ? "on" : "off"]) { $0 = $0.with(enabled: on) } })
                    }
                }
            } else {
                UsageSettingsSketchGroupA {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Reading the daemon's tasks…").font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                    .usageSketchRowA()
                }
            }
        }
        .onAppear { store.load() }
    }

    private var daemonTitle: String {
        guard let daemon = store.status?.daemon else { return "Daemon" }
        if daemon.running, let pid = daemon.pid { return "Running (launchd, PID \(pid))" }
        if let pid = daemon.foregroundPid { return "Running (foreground, PID \(pid))" }
        return daemon.installed ? "Installed but not running" : "Not installed"
    }

    private var totalsLine: String {
        guard let totals = store.stats?.totals else { return "Reading the last 24 hours of runs…" }
        let failed = totals.failed + totals.timedOut + totals.killed
        return "Last 24 hours: \(Plural.count(totals.runs, "run")), \(failed) failed or timed out, \(totals.unfinished) unfinished."
    }
}

/// One task: a status glyph, the name, one line of what happened and when it runs, Run now and the switch; the
/// statistics and the recent runs fold under it.
@MainActor
private struct UsageSketchDaemonRowA: View {
    let task: DaemonTaskConfig
    let stats: DaemonTaskStats?
    let running: Bool
    let saving: Bool
    let runNow: () -> Void
    let setEnabled: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: glyph.symbol)
                    .font(.system(size: 14))
                    .foregroundStyle(glyph.color)
                    .frame(width: 18)
                    .accessibilityLabel(glyph.word)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(task.name).font(.system(size: 13, weight: .medium))
                        if let trouble {
                            Text(trouble)
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(Color.orange)
                        }
                    }
                    Text(summary)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                // lint-rules-ignore: short list (the daemon's registered tasks, a handful of rows)
                Button(running ? "Running…" : "Run now") { runNow() }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .nativeSettingsPointer()
                    .disabled(running)
                    .instantTooltip("Run this task once now, with its timeout and priority")
                Toggle("Enabled", isOn: Binding(get: { task.enabled }, set: { setEnabled($0) }))
                    .labelsHidden().toggleStyle(.switch).controlSize(.small)
                    .disabled(saving)
                    .accessibilityLabel("\(task.name) enabled")
            }
            NativeSettingsDisclosure(disclosureTitle, identifier: "sketch.daemon.\(task.name)") {
                details
            }
            .padding(.leading, 28)
        }
        .padding(.top, 10)
        .padding(.bottom, 2)
    }

    private var disclosureTitle: String {
        let runs = stats?.recentRuns.count ?? 0
        return runs == 0 ? "Statistics" : "Statistics and \(Plural.count(runs, "recent run"))"
    }

    private var lastRunInFlight: Bool {
        guard let last = stats?.lastRun, last.status == "unfinished", let started = SessionFormat.parseISO(last.startedAt) else { return false }
        return Date().timeIntervalSince(started) * 1000 < Double(task.timeoutMs)
    }

    private var trouble: String? {
        guard let stats else { return nil }
        let bad = stats.failed + stats.killed + stats.timedOut
        guard bad > 0 else { return nil }
        return "\(bad) of \(Plural.count(stats.runs, "run")) \(stats.timedOut == bad ? "timed out" : "failed")"
    }

    private var glyph: (symbol: String, color: Color, word: String) {
        if running || lastRunInFlight { return ("arrow.triangle.2.circlepath", .blue, "Running") }
        if !task.enabled { return ("pause.circle", .secondary, "Off") }
        guard let stats, let last = stats.lastRun else { return ("circle.dashed", .secondary, "No run in 24 hours") }
        if last.status == "failed" || last.status == "killed" { return ("xmark.octagon.fill", .red, "Last run failed") }
        if trouble != nil { return ("exclamationmark.triangle.fill", .orange, "Some runs failed") }
        return ("checkmark.circle.fill", .green, "Last run ok")
    }

    /// "Daily at 03:00 · last run 03:30, ok, 25m 35s"
    private var summary: String {
        var parts = [task.schedule.prefix(1).uppercased() + task.schedule.dropFirst()]
        if let last = stats?.lastRun, let date = SessionFormat.parseISO(last.startedAt) {
            var text = "last run \(date.formatted(date: .omitted, time: .shortened)), \(DaemonFormat.status(last.status).label)"
            if let ms = last.durationMs { text += ", \(DaemonFormat.duration(ms))" }
            parts.append(text)
        }
        if let description = task.description { parts.append(description) }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder
    private var details: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let stats {
                Text(verbatim: "\(Plural.count(stats.runs, "run")) in 24 hours: \(stats.ok) ok, \(stats.failed) failed, \(stats.timedOut) timed out (\(DaemonFormat.percent(stats.failureRate))). Typical \(DaemonFormat.duration(stats.p50Ms)), slow \(DaemonFormat.duration(stats.p90Ms)), longest \(DaemonFormat.duration(stats.maxMs)).")
                    .font(.system(size: 11.5))
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(stats.recentRuns.prefix(6)) { run in
                    HStack(spacing: 10) {
                        Circle().fill(DaemonFormat.status(run.status).color).frame(width: 6, height: 6)
                        Text(SessionFormat.parseISO(run.startedAt).map { $0.formatted(date: .abbreviated, time: .shortened) } ?? run.startedAt)
                            .font(.system(size: 11)).monospacedDigit()
                            .frame(width: 130, alignment: .leading)
                        Text(DaemonFormat.status(run.status).label).font(.system(size: 11))
                            .frame(width: 80, alignment: .leading)
                        Text(DaemonFormat.duration(run.durationMs)).font(.system(size: 11)).monospacedDigit()
                            .foregroundStyle(.secondary)
                        if let reason = run.reason {
                            Text(reason).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .accessibilityElement(children: .combine)
                }
            } else {
                Text("No run in the last 24 hours.").font(.system(size: 11.5)).foregroundStyle(.secondary)
            }
            Text("Timeout \(DaemonFormat.duration(Double(task.timeoutMs))), priority \(task.priority), \(Plural.count(task.retries, "retry", "retries")). The schedule editor stays in the current page; this sketch does not draw it.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.bottom, 8)
    }
}
