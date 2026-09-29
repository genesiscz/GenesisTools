import Foundation
import SwiftUI

// PR notifications settings: the bell in the PRs list header. The watcher itself is TS
// (src/hub/lib/notify*.ts) and runs as the `hub-pr-notify` daemon task, so notifications arrive
// while the hub is closed; this popover only reads `tools hub notify status --json` and writes
// through `tools hub notify set`. Config file: ~/.genesis-tools/hub/notify.json.

struct HubNotifyStatus: Decodable, Equatable {
    struct Repo: Decodable, Equatable {
        let enabled: Bool
        let events: [String: Bool]?
    }

    struct Config: Decodable, Equatable {
        let enabled: Bool
        let intervalMinutes: Int
        let onlyMine: Bool
        let events: [String: Bool]
        let repos: [String: Repo]
        let botLogins: [String]
    }

    struct RepoState: Decodable, Equatable {
        let path: String?
        let failures: Int
        let nextAt: String?
        let lastOkAt: String?
        let lastError: String?
    }

    struct Event: Decodable, Equatable, Identifiable {
        let type: String
        let key: String
        let provider: String
        let project: String
        let number: Int
        let title: String
        let message: String
        let at: String
        let posted: Bool
        var id: String { "\(at) \(key) \(type)" }
        var ref: String { "\(project)\(provider == "gitlab" ? "!" : "#")\(number)" }
    }

    let config: Config
    let configPath: String
    let lastPollAt: String?
    let repos: [String: RepoState]
    let recent: [Event]
    let requestsLastHour: Int
    let pollsLastHour: Int
    let daemonTask: Bool?

    /// `tools hub notify status --json` (src/hub/lib/notify-poll.ts `notifyStatus`).
    static func decode(_ data: Data) throws -> HubNotifyStatus {
        try JSONDecoder().decode(HubNotifyStatus.self, from: data)
    }
}

enum HubNotifyEvent: String, CaseIterable, Identifiable {
    case thread, ciFailed, ciPassed, botReview, merged
    var id: String { rawValue }
    var title: String {
        switch self {
        case .thread: return "New review threads"
        case .ciFailed: return "CI failed"
        case .ciPassed: return "CI passed"
        case .botReview: return "A review bot finished"
        case .merged: return "PR merged"
        }
    }
}

@MainActor
final class HubNotifyStore: ObservableObject {
    static let shared = HubNotifyStore()

    @Published private(set) var status: HubNotifyStatus?
    @Published private(set) var busy = false
    @Published var message: String?
    /// Runs in flight: `busy` holds until the last one ends, not the first.
    private var inFlight = 0 {
        didSet { busy = inFlight > 0 }
    }
    /// Bumped per status read; an older read that ends after a newer one does not publish.
    private var statusGeneration = 0

    func load() {
        run(["hub", "notify", "status", "--json"], label: "notify.status", decodesStatus: true)
    }

    /// One `tools hub notify set` change, then the status again.
    func set(_ flags: [String]) {
        run(["hub", "notify", "set"] + flags + ["--json"], label: "notify.set", reload: true)
    }

    func pollNow() {
        run(["hub", "notify", "poll", "--force", "--json"], label: "notify.poll", reload: true, summary: Self.pollSummary)
    }

    /// One line for `tools hub notify poll --json` (src/hub/lib/notify-poll.ts `PollReport`).
    nonisolated static func pollSummary(_ data: Data) -> String? {
        guard let report = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return "Reading the poll report failed"
        }
        let items = (report["items"] as? [Any])?.count ?? 0
        let posted = report["posted"] as? Int ?? 0
        let requests = report["requests"] as? Int ?? 0
        if let skipped = report["skipped"] as? String { return "Poll skipped: \(skipped)" }
        return "Polled: \(items) events, \(posted) posted, \(requests) requests"
    }

    func sendTest(pr: String?) {
        run(["hub", "notify", "test"] + (pr.map { ["--pr", $0] } ?? []), label: "notify.test") { _ in "Test notification posted" }
    }

    /// `decodesStatus`: the output is `status --json`. Only `load` sets it; `set --json` prints the config alone.
    private func run(
        _ args: [String], label: String, decodesStatus: Bool = false, reload: Bool = false,
        summary: ((Data) -> String?)? = nil
    ) {
        inFlight += 1
        if decodesStatus {
            statusGeneration += 1
        }
        let generation = statusGeneration
        Task {
            let span = HubPerf.begin("prs.\(label)", awaits: true)
            let result = await Task.detached(priority: .userInitiated) { Result { try ToolsCLIRunner.run(args) } }.value
            inFlight -= 1
            switch result {
            case .success(let data):
                span.end()
                if let summary {
                    message = summary(data)
                } else if decodesStatus, generation == statusGeneration {
                    // A silent `try?` left the popover on "Reading the notification settings…" forever
                    // whenever the CLI's JSON and this Decodable drifted apart.
                    do {
                        status = try HubNotifyStatus.decode(data)
                    } catch {
                        message = "Reading tools hub notify status --json failed: \(error)"
                    }
                }
                if reload { load() }
            case .failure(let error):
                span.end("failed")
                message = "\(error)"
            }
        }
    }
}

/// The bell: filled while notifications are on and at least one repo is watched.
struct HubNotifyButton: View {
    @ObservedObject var prs: PRsModel
    @ObservedObject private var store = HubNotifyStore.shared
    @State private var open = false

    private var active: Bool {
        guard let config = store.status?.config else { return false }
        return config.enabled && config.repos.values.contains { $0.enabled }
    }

    var body: some View {
        IconButton(systemName: active ? "bell.fill" : "bell", tooltip: "PR notifications: which events, which repos") { open.toggle() }
            .popover(isPresented: $open, arrowEdge: .bottom) {
                HubNotifySettings(prs: prs, store: store)
            }
            .task { if store.status == nil { store.load() } }
    }
}

struct HubNotifySettings: View {
    @ObservedObject var prs: PRsModel
    @ObservedObject var store: HubNotifyStore
    @State private var find = PanelFindModel(scope: "notify", title: "repos and recent events")

    /// The hub's projects (one checkout each) plus every configured repo, by path.
    private var repoPaths: [(path: String, name: String)] {
        var seen: [String: String] = [:]
        for pr in prs.prs {
            if let root = pr.repoRoot, seen[root] == nil { seen[root] = pr.repo }
        }
        for path in store.status?.config.repos.keys.map({ $0 }) ?? [] where seen[path] == nil {
            seen[path] = URL(fileURLWithPath: path).lastPathComponent
        }
        return seen.map { ($0.key, $0.value) }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            PanelFindBar(find: find)
            if let status = store.status {
                content(status)
            } else {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Reading the notification settings…").font(.system(size: 11.5)).foregroundColor(ReviewPalette.dim)
                }
            }
            if let message = store.message {
                NoticePill(text: message, isError: message.contains("exited") || message.contains("failed")) { store.message = nil }
            }
        }
        .padding(14)
        .frame(width: 400)
        .onAppear { store.load() }
        .panelFind(find, revision: store.status) { findRows }
    }

    /// What ⌘F searches here: the repo names and the recent events, as shown.
    private var findRows: [PanelFindRow] {
        repoPaths.map { PanelFindRow(id: "repo:\($0.path)", fields: [PanelFindField("name", $0.name)]) }
            + (store.status?.recent.prefix(5) ?? []).map { PanelFindRow(id: "event:\($0.id)", fields: [PanelFindField("message", $0.message)]) }
    }

    @ViewBuilder
    private func content(_ status: HubNotifyStatus) -> some View {
        let config = status.config
        HStack {
            Toggle("PR notifications", isOn: Binding(get: { config.enabled }, set: { store.set(["--enabled", $0 ? "on" : "off"]) }))
                .toggleStyle(.switch)
                .font(.system(size: 13, weight: .semibold))
            Spacer()
            if store.busy { ProgressView().controlSize(.small) }
        }
        Text(pollLine(status))
            .font(.system(size: 11))
            .foregroundColor(ReviewPalette.dim)
            .fixedSize(horizontal: false, vertical: true)
        if status.daemonTask == false {
            daemonHint
        }

        section("Events")
        ForEach(HubNotifyEvent.allCases) { event in
            Toggle(event.title, isOn: Binding(
                get: { config.events[event.rawValue] ?? false },
                set: { store.set(["--event", "\(event.rawValue)=\($0 ? "on" : "off")"]) }
            ))
            .toggleStyle(.checkbox)
            .font(.system(size: 12))
        }
        HStack(spacing: 14) {
            Toggle("Only my PRs", isOn: Binding(get: { config.onlyMine }, set: { store.set(["--only-mine", $0 ? "on" : "off"]) }))
                .toggleStyle(.checkbox)
                .instantTooltip("Only PRs/MRs you opened")
            Stepper(value: Binding(get: { config.intervalMinutes }, set: { store.set(["--interval", String($0)]) }), in: 1...60) {
                Text(verbatim: "Every \(config.intervalMinutes) min").font(.system(size: 12, design: .monospaced))
            }
            .instantTooltip("Minutes between polls of each repo; a failing repo backs off up to an hour")
        }
        .font(.system(size: 12))

        section("Repos")
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(repoPaths, id: \.path) { repo in
                    repoRow(repo.path, name: repo.name, config: config, state: status)
                        .findRow("repo:\(repo.path)", cornerRadius: 5)
                }
            }
        }
        .frame(maxHeight: 180)

        if !status.recent.isEmpty {
            section("Recent")
            VStack(alignment: .leading, spacing: 2) {
                ForEach(status.recent.prefix(5)) { event in
                    HStack(spacing: 6) {
                        LiveAgo(date: HubFormat.date(event.at)).font(.system(size: 10.5, design: .monospaced)).foregroundColor(ReviewPalette.dim).frame(width: 42, alignment: .leading)
                        FindText(event.message, field: "message").font(.system(size: 11.5)).lineLimit(1).truncationMode(.tail)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 4)
                    .frame(height: 22)
                    .contentShape(Rectangle())
                    .rowButton(cornerRadius: 5) {
                        if let ref = HubPRRef(event.ref) { prs.request(ref) }
                    }
                    .findRow("event:\(event.id)", cornerRadius: 5)
                    .instantTooltip("\(event.ref): \(event.title)")
                }
            }
        }

        HStack(spacing: 12) {
            Button("Check now") { store.pollNow() }
                .instantTooltip("Poll every watched repo now, ignoring the interval and any backoff")
            Button("Send a test") { store.sendTest(pr: prs.selected.map { "\($0.project)\($0.isGitLab ? "!" : "#")\($0.number)" }) }
                .instantTooltip("Post one notification marked as a test; its click opens the hub at the selected PR")
            Spacer()
            Button("Config file") { PathOpener.cursor(status.configPath) }
                .instantTooltip(status.configPath)
        }
        .buttonStyle(.genHoverPlain())
        .font(.system(size: 11.5))
        .disabled(store.busy)
    }

    private var daemonHint: some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle").foregroundColor(ReviewPalette.modified)
            Text("Nothing polls yet. Run `tools hub notify install` once to add the daemon task.")
                .font(.system(size: 11))
                .fixedSize(horizontal: false, vertical: true)
            IconButton(systemName: "doc.on.doc", tooltip: "Copy the command") { PathOpener.copy("tools hub notify install") }
        }
    }

    private func pollLine(_ status: HubNotifyStatus) -> String {
        let last = status.lastPollAt.map { "Last poll \(HubFormat.ago(HubFormat.date($0)))" } ?? "Never polled"
        return "\(last) · \(status.pollsLastHour) polls, \(status.requestsLastHour) host requests in the last hour"
    }

    private func section(_ title: String) -> some View {
        Text(title).font(.system(size: 11, weight: .semibold)).foregroundColor(ReviewPalette.dim).padding(.top, 4)
    }

    private func repoRow(_ path: String, name: String, config: HubNotifyStatus.Config, state: HubNotifyStatus) -> some View {
        let repo = config.repos[path]
        let watched = repo?.enabled == true
        let problem = watched ? state.repos.values.first { $0.path == path && $0.lastError != nil } : nil
        return HStack(spacing: 6) {
            Toggle(isOn: Binding(get: { watched }, set: { store.set(["--repo", path, "--repo-enabled", $0 ? "on" : "off"]) })) {
                FindText(name, field: "name").font(.system(size: 12))
            }
            .toggleStyle(.checkbox)
            .instantTooltip(path)
            if let problem, let error = problem.lastError {
                Image(systemName: "exclamationmark.circle")
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.removed)
                    .instantTooltip("\(problem.failures) failed polls; next try \(problem.nextAt ?? "soon")\n\(error)")
            }
            Spacer(minLength: 4)
            if watched {
                Menu {
                    ForEach(HubNotifyEvent.allCases) { event in
                        let own = repo?.events?[event.rawValue]
                        let effective = own ?? config.events[event.rawValue] ?? false
                        Button {
                            store.set(["--repo", path, "--event", "\(event.rawValue)=\(effective ? "off" : "on")"])
                        } label: {
                            Label("\(event.title)\(own == nil ? "" : " (this repo)")", systemImage: effective ? "checkmark.square" : "square")
                        }
                    }
                    Divider()
                    Button("Follow the global switches") { store.set(["--repo", path, "--reset-repo-events"]) }
                        .disabled(repo?.events == nil)
                } label: {
                    Text(repo?.events == nil ? "All events" : "Own events").font(.system(size: 11))
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .instantTooltip("Which events this repo posts; the global switches apply unless you change one here")
            }
        }
        .frame(height: 24)
    }
}
