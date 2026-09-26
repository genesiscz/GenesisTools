import Foundation
import SwiftUI

// Sessions mode → "Agent processes": every agent CLI session (claude, codex, grok, cursor-agent) with
// its whole process tree (MCP servers, tool shells, `tools` children), the `tools claude run` wrappers
// whose agent is gone, and the orphans launchd adopted, from `tools hub procs --json`
// (src/hub/lib/procs/). One `ps` per refresh on the tools side; the pane refreshes every 10 s only
// while it is on screen (a `.task` loop that SwiftUI cancels when the pane goes). Stopping goes
// through `tools hub procs --stop <pid> --yes`: SIGTERM, SIGKILL after the grace period, by pid only,
// and the CLI refuses the tree that runs the asking process.

enum AgentProcs {
    /// The Sessions mode's selection that shows this pane instead of one session.
    static let selectionID = "::procs"
    static let energyKey = "hub.procs.energy"
    static let refreshSeconds: UInt64 = 10
}

struct ProcEntry: Decodable, Hashable, Identifiable {
    let pid: Int
    let ppid: Int
    let depth: Int
    let kind: String
    let label: String
    let command: String
    let cpu: Double
    let rssKb: Double
    let energy: Double?
    let startedAt: String?
    let state: String

    var id: Int { pid }
}

struct ProcSessionMatch: Decodable, Hashable {
    let provider: String
    let sessionId: String
    let title: String?
    /// Epoch ms.
    let lastActivityAt: Double?
    /// argv, shell or cwd.
    let match: String
}

struct ProcGroup: Decodable, Hashable, Identifiable {
    struct Parent: Decodable, Hashable {
        let pid: Int
        let label: String?
        let alive: Bool
    }

    struct Totals: Decodable, Hashable {
        let cpu: Double
        let rssKb: Double
        let energy: Double?
        let processes: Int
    }

    let id: String
    /// agent, wrapper or orphan.
    let kind: String
    let rootPid: Int
    let provider: String?
    let label: String
    let command: String
    let cwd: String?
    let startedAt: String?
    let ageMs: Double?
    let parent: Parent
    let wrapperPid: Int?
    let parentAgentPid: Int?
    let orphan: Bool
    let orphanReason: String?
    let launchdLabel: String?
    let idle: Bool
    let idleReason: String?
    /// Stopped (`ps` state T) in its shell; optional so an older CLI's report still decodes.
    let suspended: Bool?
    let session: ProcSessionMatch?
    let own: Bool
    let totals: Totals
    let processes: [ProcEntry]

    var started: Date? { HubFormat.date(startedAt) }
    /// A launchd job and the tree of the asking process cannot be stopped from here (the CLI refuses both).
    var stoppable: Bool { !own && launchdLabel == nil }
    var title: String { session?.title.flatMap { $0.isEmpty ? nil : $0 } ?? label }
}

struct ProcsReport: Decodable {
    struct Totals: Decodable {
        let groups: Int
        let orphans: Int
        let idle: Int
        let processes: Int
        let cpu: Double
        let rssKb: Double
    }

    let groups: [ProcGroup]
    let totals: Totals
    let energy: Bool
    let takenAt: String
    let elapsedMs: Int
    let warnings: [String]
}

struct ProcStopOutcome: Decodable {
    let pid: Int
    let label: String
    let pids: [Int]
    let stopped: Bool
    let signal: String?
    let survivors: [Int]
    let reason: String?
}

enum ProcsFormat {
    static func memory(_ kb: Double) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(kb * 1024), countStyle: .memory)
    }

    /// `42m`, `5h 10m`, `6d 1h`: the same words as `tools hub procs`.
    static func age(_ ms: Double?) -> String {
        guard let ms else { return "—" }
        let minutes = Int(ms / 60_000)
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        return hours < 48 ? "\(hours)h \(minutes % 60)m" : "\(hours / 24)d \(hours % 24)h"
    }

    static func summary(_ report: ProcsReport) -> String {
        let totals = report.totals
        var text = "\(totals.groups) trees · \(totals.processes) processes · \(String(format: "%.1f", totals.cpu)) % CPU · \(memory(totals.rssKb))"
        if totals.orphans > 0 { text += " · \(totals.orphans) orphan\(totals.orphans == 1 ? "" : "s")" }
        if totals.idle > 0 { text += " · \(totals.idle) idle" }
        return text
    }
}

@MainActor
final class AgentProcsStore: ObservableObject {
    static let shared = AgentProcsStore()

    @Published private(set) var report: ProcsReport?
    @Published private(set) var loading = false
    @Published private(set) var stopping = Set<Int>()
    @Published var expanded = Set<String>()
    @Published var notice: (text: String, isError: Bool)?
    // Published and saved by hand: `@AppStorage` inside an ObservableObject never publishes.
    @Published var energy = HubDefaults.store.bool(forKey: AgentProcs.energyKey) {
        didSet { HubDefaults.store.set(energy, forKey: AgentProcs.energyKey) }
    }

    var orphans: [ProcGroup] { report?.groups.filter { $0.orphan && $0.stoppable } ?? [] }

    func refresh() async {
        guard !loading else { return }
        loading = true
        let args = ["hub", "procs", "--json"] + (energy ? ["--energy"] : [])
        let span = HubPerf.begin("procs.refresh", energy ? "energy" : "", awaits: true)
        let result = await Task.detached(priority: .utility) { () -> Result<ProcsReport, Error> in
            Result { try JSONDecoder().decode(ProcsReport.self, from: ToolsCLIRunner.run(args)) }
        }.value
        loading = false
        switch result {
        case .success(let fresh):
            span.end("\(fresh.groups.count) groups, \(fresh.totals.orphans) orphans, \(fresh.elapsedMs) ms in tools")
            report = fresh
            HubMainBusy.measure("procs.rows")
            if let warning = fresh.warnings.first {
                notice = (warning, true)
            }
        case .failure(let error):
            span.end("failed")
            notice = ("Process list failed: \(error)", true)
        }
    }

    /// The Sessions list's entry shows the orphan count: one read when it first appears, no polling.
    func loadOnce() async {
        if report == nil {
            await refresh()
        }
    }

    /// Runs while the pane is on screen; SwiftUI cancels the `.task` that calls it when the pane goes.
    func poll() async {
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(nanoseconds: AgentProcs.refreshSeconds * 1_000_000_000)
        }
    }

    /// One `tools hub procs --stop <pid>` per tree, in turn; each re-reads the table and re-checks every
    /// pid's start time and command before a signal.
    func stop(_ groups: [ProcGroup]) async {
        let pids = groups.map(\.rootPid).filter { !stopping.contains($0) }
        guard !pids.isEmpty else { return }
        stopping.formUnion(pids)
        var outcomes: [ProcStopOutcome] = []
        var failure: String?
        for pid in pids {
            let span = HubPerf.begin("procs.stop", "\(pid)", awaits: true)
            let result = await Task.detached(priority: .userInitiated) { () -> Result<ProcStopOutcome, Error> in
                Result {
                    // Exit 1 means "not stopped"; the JSON on stdout still says why.
                    let capture = try ToolsCLIRunner.capture(["hub", "procs", "--stop", String(pid), "--yes", "--json"], timeout: 60)
                    return try JSONDecoder().decode(ProcStopOutcome.self, from: capture.stdout)
                }
            }.value
            stopping.remove(pid)
            switch result {
            case .success(let outcome):
                span.end(outcome.stopped ? "stopped \(outcome.signal ?? "")" : "kept: \(outcome.reason ?? "")")
                outcomes.append(outcome)
            case .failure(let error):
                span.end("failed")
                failure = "\(error)"
            }
        }
        stopping.subtract(pids)
        let stopped = outcomes.filter(\.stopped)
        if let failure {
            notice = ("Stop failed: \(failure)", true)
        } else if let kept = outcomes.first(where: { !$0.stopped }) {
            notice = ("Stopped \(stopped.count), kept \(kept.pid) \(kept.label): \(kept.reason ?? "refused")", true)
        } else {
            let processes = stopped.reduce(0) { $0 + $1.pids.count }
            notice = ("Stopped \(stopped.count) tree\(stopped.count == 1 ? "" : "s") (\(processes) processes)", false)
        }
        await refresh()
    }
}

struct AgentProcsView: View {
    @ObservedObject var model: HubModel
    @ObservedObject private var store = AgentProcsStore.shared
    @State private var pending: [ProcGroup]?
    @State private var find = PanelFindModel(scope: "procs", title: "the agent processes")

    var body: some View {
        let groups = store.report?.groups ?? []
        VStack(spacing: 0) {
            header
            PanelFindBar(find: find)
            if groups.isEmpty {
                Text(store.loading || store.report == nil ? "Reading the process table…" : "No agent processes run.")
                    .foregroundColor(ReviewPalette.dim)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(groups) { group in
                            AgentProcsRow(
                                group: group,
                                expanded: store.expanded.contains(group.id),
                                stopping: store.stopping.contains(group.rootPid),
                                energy: store.report?.energy ?? false,
                                toggle: { toggle(group) },
                                reveal: { reveal(group) },
                                stop: { pending = [group] }
                            )
                            .findRow(group.id, cornerRadius: 8)
                        }
                    }
                    .padding(.vertical, 8)
                }
            }
        }
        .hubSurface(.content)
        .panelFind(find, revision: groups) { groups.map(Self.searchable) }
        .onAppear { HubMainBusy.measure("procs.open") }
        .task { await store.poll() }
        .task(id: store.energy) {
            // A switch of the energy column refreshes at once instead of at the next tick.
            if store.report != nil, store.report?.energy != store.energy {
                await store.refresh()
            }
        }
        .confirmationDialog(
            confirmTitle,
            isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
            titleVisibility: .visible,
            presenting: pending
        ) { groups in
            Button(groups.count == 1 ? "Stop it" : "Stop all \(groups.count)", role: .destructive) {
                pending = nil
                Task { await store.stop(groups) }
            }
            Button("Cancel", role: .cancel) { pending = nil }
        } message: { groups in
            Text(confirmMessage(groups))
        }
    }

    private var confirmTitle: String {
        guard let groups = pending else { return "" }
        return groups.count == 1 ? "Stop \(groups[0].label) (\(groups[0].rootPid)) and its tree?" : "Stop \(groups.count) orphan trees?"
    }

    private func confirmMessage(_ groups: [ProcGroup]) -> String {
        var lines = groups.prefix(12).map { group in
            "• \(group.rootPid) \(group.title): \(group.totals.processes) processes, \(ProcsFormat.memory(group.totals.rssKb))"
        }
        if groups.count > 12 {
            lines.append("… and \(groups.count - 12) more")
        }
        lines.append("")
        lines.append("SIGTERM to every process of the tree, then SIGKILL after 5 s for what is left. Each pid's start time and command are checked again first, so a reused pid is never signalled.")
        return lines.joined(separator: "\n")
    }

    private func toggle(_ group: ProcGroup) {
        if store.expanded.contains(group.id) {
            store.expanded.remove(group.id)
        } else {
            store.expanded.insert(group.id)
        }
    }

    /// The session in the Sessions list, when it is among the listed ones; else the filter finds it.
    private func reveal(_ group: ProcGroup) {
        guard let sessionId = group.session?.sessionId else { return }
        if let session = model.sessions.first(where: { $0.sessionId == sessionId }) {
            model.select(session.id)
        } else {
            model.filter = sessionId
            store.notice = ("\(sessionId.prefix(8)) is not among the last \(HubModel.recentHours) h; the filter searches its history", false)
        }
    }

    // MARK: Header

    private var header: some View {
        let orphans = store.orphans
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Image(systemName: "cpu").foregroundColor(ReviewPalette.dim)
                Text("Agent processes").font(.system(size: 15, weight: .semibold))
                Spacer()
                if let notice = store.notice {
                    NoticePill(text: notice.text, isError: notice.isError) { store.notice = nil }
                }
                Toggle("Energy", isOn: $store.energy)
                    .toggleStyle(.checkbox)
                    .font(.system(size: 12))
                    .instantTooltip("Add macOS energy impact (one `top` sample of about 1 s per refresh)")
                Button {
                    pending = orphans
                } label: {
                    Label("Stop all orphans (\(orphans.count))", systemImage: "xmark.octagon")
                }
                .disabled(orphans.isEmpty || !store.stopping.isEmpty)
                .instantTooltip("Asks first, listing every tree that goes")
                IconButton(systemName: "arrow.clockwise", tooltip: "Read the process table again") {
                    Task { await store.refresh() }
                }
                .disabled(store.loading)
            }
            .buttonStyle(.genHoverPlain())
            HStack(spacing: 6) {
                // A fixed slot: the summary beside it stays put on every refresh.
                ZStack {
                    if store.loading {
                        ProgressView().controlSize(.small)
                    }
                }
                .frame(width: 16, height: 16)
                Text(verbatim: store.report.map(ProcsFormat.summary) ?? "")
                    .font(.system(size: 11.5))
                    .foregroundColor(ReviewPalette.dim)
                    .lineLimit(1)
                Spacer()
            }
            Text("Orphan: an agent, MCP server, tool shell or `tools … run` wrapper whose parent is gone (launchd adopted it) and that is not a launchd job. Idle: its session wrote nothing for 2 h and the tree uses under 1 % CPU. Refreshes every 10 s while this pane is open.")
                .font(.system(size: 11))
                .foregroundColor(ReviewPalette.dim)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.leading, 18)
        .padding(.trailing, 14)
        .padding(.top, 34)
        .padding(.bottom, 10)
        .overlay(Rectangle().fill(ReviewPalette.hairline).frame(height: 1), alignment: .bottom)
    }

    /// What ⌘F searches in a row: the texts the row shows, under the keys its FindTexts use.
    static func searchable(_ group: ProcGroup) -> PanelFindRow {
        PanelFindRow(id: group.id, fields: [
            PanelFindField("title", group.title),
            PanelFindField("label", group.label),
            PanelFindField("reason", group.orphanReason ?? group.idleReason ?? ""),
        ])
    }
}

/// One tree: values only (no store, no model), and its buttons only while the pointer is on it.
struct AgentProcsRow: View {
    let group: ProcGroup
    let expanded: Bool
    let stopping: Bool
    let energy: Bool
    let toggle: () -> Void
    let reveal: () -> Void
    let stop: () -> Void
    @State private var hovering = false

    private var tone: Color {
        if group.orphan { return ReviewPalette.removed }
        if group.idle { return ReviewPalette.modified }
        return ReviewPalette.added
    }

    private var status: String {
        if group.orphan { return "orphan" }
        if group.suspended == true { return "suspended" }
        if group.idle { return "idle" }
        return group.kind == "wrapper" ? "wrapper" : "live"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 10) {
                Circle().fill(tone).frame(width: 8, height: 8).padding(.top, 5)
                    .instantTooltip(group.orphanReason ?? group.idleReason ?? "running")
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 8) {
                        if let provider = group.provider, group.kind == "agent" {
                            ProviderBadge(provider: provider == "cursor-agent" ? "cursor" : provider)
                        }
                        FindText(group.title, field: "title")
                            .font(.system(size: 12.5, weight: .medium))
                            .lineLimit(1)
                            .truncationMode(.middle)
                        FindText(group.label, field: "label")
                            .font(.system(size: 10.5, weight: .medium))
                            .foregroundColor(ReviewPalette.dim)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(Color.white.opacity(0.06)))
                        Text(verbatim: status)
                            .font(.system(size: 10.5, weight: .semibold))
                            .foregroundColor(tone)
                        if group.own {
                            Text("this session").font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim)
                        }
                    }
                    HStack(spacing: 6) {
                        Text(verbatim: "pid \(group.rootPid)")
                        Text(verbatim: "·")
                        Text(verbatim: group.parent.pid == 1 ? "parent launchd" : "parent \(group.parent.pid) \(group.parent.label ?? "")")
                        if let cwd = group.cwd {
                            Text(verbatim: "·")
                            Text(verbatim: PathLabel.display(cwd)).lineLimit(1).truncationMode(.middle)
                        }
                    }
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundColor(ReviewPalette.dim)
                    if let reason = group.orphanReason ?? group.idleReason {
                        FindText(reason, field: "reason")
                            .font(.system(size: 11))
                            .foregroundColor(group.orphan ? ReviewPalette.removed : ReviewPalette.modified)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 8)
                numbers
                actions
            }
            if expanded {
                ForEach(group.processes) { entry in
                    processLine(entry)
                }
                .padding(.leading, 18)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 8).fill(hovering ? Color.white.opacity(0.04) : Color.clear))
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .padding(.horizontal, 6)
    }

    private var numbers: some View {
        HStack(spacing: 14) {
            VStack(alignment: .trailing, spacing: 2) {
                Text(verbatim: String(format: "%.1f %%", group.totals.cpu)).font(.system(size: 11.5, design: .monospaced))
                Text(verbatim: "\(group.totals.processes) procs").font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim)
            }
            .frame(width: 64, alignment: .trailing)
            VStack(alignment: .trailing, spacing: 2) {
                Text(verbatim: ProcsFormat.memory(group.totals.rssKb)).font(.system(size: 11.5, design: .monospaced))
                if energy {
                    Text(verbatim: "energy \(String(format: "%.1f", group.totals.energy ?? 0))").font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim)
                }
            }
            .frame(width: 84, alignment: .trailing)
            VStack(alignment: .trailing, spacing: 2) {
                Text(verbatim: ProcsFormat.age(group.ageMs)).font(.system(size: 11.5, design: .monospaced))
                if let last = group.session?.lastActivityAt {
                    LiveAgo(date: Date(timeIntervalSince1970: last / 1000), format: { "wrote \($0)" })
                        .font(.system(size: 10.5))
                        .foregroundColor(ReviewPalette.dim)
                }
            }
            .frame(width: 110, alignment: .trailing)
        }
    }

    @ViewBuilder
    private var actions: some View {
        HStack(spacing: 4) {
            if hovering || expanded {
                IconButton(systemName: expanded ? "chevron.up" : "chevron.down", tooltip: expanded ? "Hide the processes" : "Show every process of the tree") { toggle() }
                if group.session != nil {
                    IconButton(systemName: "arrow.right.circle", tooltip: "Show this session in the Sessions list", action: reveal)
                }
                if group.stoppable {
                    IconButton(systemName: "stop.circle", tooltip: "Stop this tree: SIGTERM, then SIGKILL after 5 s (asks first)", action: stop)
                        .disabled(stopping)
                }
            } else if stopping {
                ProgressView().controlSize(.mini)
            } else {
                Color.clear.frame(width: 16, height: 16)
            }
        }
        .frame(width: 64, alignment: .trailing)
    }

    private func processLine(_ entry: ProcEntry) -> some View {
        HStack(spacing: 8) {
            Text(verbatim: String(repeating: "  ", count: entry.depth) + (entry.depth == 0 ? "" : "└ ") + entry.label)
                .font(.system(size: 11, design: .monospaced))
                .lineLimit(1)
            Text(verbatim: "\(entry.pid)")
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundColor(ReviewPalette.dim)
            Spacer(minLength: 6)
            Text(verbatim: String(format: "%.1f %%", entry.cpu)).font(.system(size: 10.5, design: .monospaced)).frame(width: 56, alignment: .trailing)
            Text(verbatim: ProcsFormat.memory(entry.rssKb)).font(.system(size: 10.5, design: .monospaced)).frame(width: 72, alignment: .trailing)
        }
        .foregroundColor(Color.white.opacity(0.8))
        .instantTooltip(entry.command)
    }
}

/// The Sessions list's first row: opens the process pane, with the orphan count once known.
struct AgentProcsEntry: View {
    @ObservedObject var model: HubModel
    @ObservedObject private var store = AgentProcsStore.shared

    var body: some View {
        let selected = model.selectedID == AgentProcs.selectionID
        let orphans = store.report?.totals.orphans ?? 0
        HStack(spacing: 8) {
            Image(systemName: "cpu")
                .font(.system(size: 11))
                .foregroundColor(ReviewPalette.dim)
                .frame(width: 16)
            Text("Agent processes")
                .font(.system(size: 12.5, weight: selected ? .semibold : .regular))
            Spacer(minLength: 4)
            if orphans > 0 {
                Text(verbatim: "\(orphans)")
                    .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                    .foregroundColor(ReviewPalette.removed)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(Color.white.opacity(0.08)))
                    .instantTooltip("\(orphans) orphaned process trees (an agent, MCP server or tool shell whose parent is gone)")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 8).fill(selected ? Color.white.opacity(0.08) : Color.clear))
        .padding(.horizontal, 6)
        .contentShape(Rectangle())
        .rowButton { model.select(AgentProcs.selectionID) }
        .instantTooltip("Every agent session's processes: CPU, memory, age, orphans; stop a tree by pid")
        .task { await store.loadOnce() }
    }
}
