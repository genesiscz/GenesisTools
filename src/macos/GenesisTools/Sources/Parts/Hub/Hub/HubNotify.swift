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
        /// This repo's own cadence; nil follows `Config.intervalMinutes`.
        let intervalMinutes: Int?
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
        let lastAttemptAt: String?

        /// A failing project in one sentence ("2 polls failed. The next try is at 21:49."); the host's raw error goes
        /// behind Details, never into the sentence or a tooltip.
        var problemText: String {
            let next = HubFormat.date(nextAt).map { "at \($0.formatted(date: .omitted, time: .shortened))" } ?? "soon"
            return "\(Plural.count(failures, "poll")) failed. The next try is \(next)."
        }
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
    /// The daemon task's schedule, and the one-minute tick it should have (`tools hub notify install`).
    let daemonTaskEvery: String?
    let daemonTaskWanted: String?

    /// `tools hub notify status --json` (src/hub/lib/notify-poll.ts `notifyStatus`).
    static func decode(_ data: Data) throws -> HubNotifyStatus {
        try JSONDecoder().decode(HubNotifyStatus.self, from: data)
    }

    /// The daemon task's state in one line; the bell and the settings page say the same words.
    var daemonTitle: String {
        switch daemonTask {
        case true?:
            return daemonTaskEvery == daemonTaskWanted
                ? "The daemon checks every minute"
                : "The daemon task still runs \(daemonTaskEvery ?? "at an old cadence")"
        case false?: return "Nothing polls yet: the daemon task is missing"
        case nil: return "The daemon's task list is unreadable"
        }
    }

    /// The button that fixes the daemon task (`tools hub notify install`), or nil while it ticks every minute or the
    /// task list could not be read (the task may be there).
    var daemonFixTitle: String? {
        guard let daemonTask else { return nil }
        guard !daemonTask || daemonTaskEvery != daemonTaskWanted else { return nil }
        return daemonTask ? "Tick every minute" : "Add the daemon task"
    }
}

/// The words of the PR notification settings, shared by the bell popover and Settings, so one setting reads the same
/// in both places and offers the same choices (H17).
enum HubNotifyWords {
    static let enabledDetail = "When this is off, no project is polled and nothing posts."
    static let onlyMineDetail = "Changes on PRs someone else opened stay silent."
    static let cadenceDetail = "How often a project without its own cadence is polled."
    static let pollNowDetail = "Poll every watched project now, ignoring cadences and backoff"
    static let installDetail = "Adds one background task that checks every watched project each minute."
    static let installCommand = "tools hub notify install"
    static let eventsDetail = "Which events this project posts; the defaults apply until you change one here"

    /// The cadences a project can pick, in minutes (the CLI takes any whole minute from 1 to 60).
    static let cadenceChoices = [1, 2, 3, 5, 10, 15, 20, 30, 45, 60]

    static func cadenceTitle(_ minutes: Int) -> String {
        minutes == 1 ? "Every minute" : "Every \(minutes) minutes"
    }

    /// `cadenceChoices`, plus the stored value when the config holds another one.
    static func cadenceOptions(including value: Int) -> [Int] {
        cadenceChoices.contains(value) ? cadenceChoices : (cadenceChoices + [value]).sorted()
    }

    /// The label of a project's events menu: "All events (default)", "3 events".
    static func eventsSummary(repo: HubNotifyStatus.Repo?, config: HubNotifyStatus.Config) -> String {
        let on = HubNotifyEvent.allCases.filter { repo?.events?[$0.rawValue] ?? config.events[$0.rawValue] ?? false }
        let label = on.count == HubNotifyEvent.allCases.count ? "All events" : Plural.count(on.count, "event")
        return repo?.events == nil ? "\(label) (default)" : label
    }

    /// A project's events menu: each event checked as it applies to the project, then "Follow the defaults".
    @MainActor
    static func eventItems(path: String, repo: HubNotifyStatus.Repo?, config: HubNotifyStatus.Config, store: HubNotifyStore) -> [MenuButtonItem] {
        HubNotifyEvent.allCases.map { event -> MenuButtonItem in
            let own = repo?.events?[event.rawValue]
            let effective = own ?? config.events[event.rawValue] ?? false
            return .action("\(event.title)\(own == nil ? "" : " (this project)")", checked: effective) {
                store.set(["--repo", path, "--event", "\(event.rawValue)=\(effective ? "off" : "on")"])
            }
        } + [
            .divider,
            .action("Follow the defaults", enabled: repo?.events != nil) {
                store.set(["--repo", path, "--reset-repo-events"])
            },
        ]
    }
}

enum HubNotifyEvent: String, CaseIterable, Identifiable {
    case thread, reviewRequested, ciFailed, ciPassed, botReview, merged
    var id: String { rawValue }
    var title: String {
        switch self {
        case .thread: return "New review threads"
        case .reviewRequested: return "My review was requested"
        case .ciFailed: return "CI failed"
        case .ciPassed: return "CI passed"
        case .botReview: return "A review bot finished"
        case .merged: return "PR merged"
        }
    }

    /// When the event posts; the settings row's detail and the bell's tooltip.
    var detail: String {
        switch self {
        case .thread: return "Someone else opens a review thread or comment thread on a PR."
        case .reviewRequested: return "You are added as a reviewer."
        case .ciFailed: return "The checks of a PR's newest commit fail."
        case .ciPassed: return "The checks of a PR's newest commit pass."
        case .botReview: return "A review bot posts a review."
        case .merged: return "A watched open PR is merged."
        }
    }
}

/// A note of the PR notification settings: one sentence, its tone, the raw output behind Details, and what Retry runs
/// again. The code that knows what happened sets the tone; the words never pick a colour (H5, H6).
struct HubNotifyNotice {
    let id = UUID()
    let text: String
    let tone: NoticePill.Tone
    var detail: String?
    var more: String?
    var retry: (@MainActor () -> Void)?
}

@MainActor
final class HubNotifyStore: ObservableObject {
    static let shared = HubNotifyStore()

    @Published private(set) var status: HubNotifyStatus?
    @Published private(set) var busy = false
    @Published var message: HubNotifyNotice?
    /// Runs in flight: `busy` holds until the last one ends, not the first.
    private var inFlight = 0 {
        didSet { busy = inFlight > 0 }
    }
    /// Bumped per status read; an older read that ends after a newer one does not publish.
    private var statusGeneration = 0

    func load() {
        run(["hub", "notify", "status", "--json"], label: "notify.status", failure: "The notification settings could not be read.", decodesStatus: true)
    }

    /// The status read has ended, with the settings or with the error it shows.
    var settled: Bool { !busy && (status != nil || message != nil) }

    /// One `tools hub notify set` change, then the status again. Retry sends the same change.
    func set(_ flags: [String]) {
        run(["hub", "notify", "set"] + flags + ["--json"], label: "notify.set", failure: "The change was not saved.", reload: true)
    }

    func pollNow() {
        run(["hub", "notify", "poll", "--force", "--json"], label: "notify.poll", failure: "The check did not run.", reload: true, summary: Self.pollSummary)
    }

    /// One note for `tools hub notify poll --json` (src/hub/lib/notify-poll.ts `PollReport`): a count on success, the
    /// CLI's own reason behind Details when it skipped.
    nonisolated static func pollSummary(_ data: Data) -> HubNotifyNotice {
        guard let report = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return HubNotifyNotice(text: "The check ran, but its report could not be read.", tone: .warning, more: String(decoding: data.prefix(2000), as: UTF8.self))
        }
        let items = (report["items"] as? [Any])?.count ?? 0
        let posted = report["posted"] as? Int ?? 0
        let requests = report["requests"] as? Int ?? 0
        if let skipped = report["skipped"] as? String {
            return HubNotifyNotice(text: "The check did not run.", tone: .warning, more: skipped)
        }
        return HubNotifyNotice(
            text: "Polled: \(Plural.count(items, "event")), \(posted) posted, \(Plural.count(requests, "request"))",
            tone: .success
        )
    }

    /// `tools hub notify install`: the one `hub-pr-notify` daemon task, ticking every minute.
    func installDaemonTask() {
        run(["hub", "notify", "install"], label: "notify.install", failure: "The daemon task was not added.", reload: true) { _ in
            HubNotifyNotice(text: "The daemon task is installed; it ticks every minute", tone: .success)
        }
    }

    func sendTest(pr: String?) {
        run(["hub", "notify", "test"] + (pr.map { ["--pr", $0] } ?? []), label: "notify.test", failure: "The test notification was not posted.") { _ in
            HubNotifyNotice(text: "Test notification posted", tone: .success)
        }
    }

    /// `decodesStatus`: the output is `status --json`. Only `load` sets it; `set --json` prints the config alone.
    /// `failure`: the sentence a failed run shows; the CLI's own error goes behind Details, and Retry runs it again.
    private func run(
        _ args: [String], label: String, failure: String, decodesStatus: Bool = false, reload: Bool = false,
        summary: ((Data) -> HubNotifyNotice)? = nil
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
                    // whenever the CLI's JSON and this Decodable drifted apart. A retry cannot fix that drift.
                    do {
                        status = try HubNotifyStatus.decode(data)
                    } catch {
                        message = HubNotifyNotice(
                            text: failure, tone: .error,
                            detail: "The app and the tools command expect different formats. Updating both usually fixes it.",
                            more: "tools \(args.joined(separator: " ")): \(error)"
                        )
                    }
                }
                if reload { load() }
            case .failure(let error):
                span.end("failed")
                message = HubNotifyNotice(text: failure, tone: .error, more: "\(error)") { [weak self] in
                    self?.message = nil
                    self?.run(args, label: label, failure: failure, decodesStatus: decodesStatus, reload: reload, summary: summary)
                }
            }
        }
    }
}

/// The note under the bell's settings and the PR activity page, with Retry when a retry can help. VoiceOver hears a
/// failure, since it lands after the click that caused it.
struct HubNotifyNoticeView: View {
    @ObservedObject var store: HubNotifyStore
    /// The settings search draws the PR activity page hidden to learn its rows; a note there is nobody's to hear.
    @Environment(\.nativeSettingsIndexing) private var hidden

    var body: some View {
        if let message = store.message {
            NoticePill(
                text: message.text, detail: message.detail, more: message.more, tone: message.tone,
                fixes: message.retry.map { retry in [NoticeFix.button("Retry", symbol: "arrow.clockwise", perform: retry)] } ?? []
            ) { store.message = nil }
                .onAppear { announce(message) }
                .onChange(of: message.id) { _, _ in announce(message) }
        }
    }

    private func announce(_ message: HubNotifyNotice) {
        if !hidden, message.tone != .success { GenAnnounce.post(message.text) }
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
        IconButton(systemName: active ? "bell.fill" : "bell", tooltip: "PR notifications: which events, which projects") { open.toggle() }
            .popover(isPresented: $open, arrowEdge: .bottom) {
                HubNotifySettings(prs: prs, store: store)
            }
            .task { if store.status == nil { store.load() } }
    }
}

struct HubNotifySettings: View {
    @ObservedObject var prs: PRsModel
    @ObservedObject var store: HubNotifyStore
    @State private var find = PanelFindModel(scope: "notify", title: "projects and recent events")
    /// Failing projects whose error is open under their row.
    @State private var openProblems: Set<String> = []

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
            } else if store.busy || store.message == nil {
                SkeletonLines(count: 4)
                    .skeletonShimmer()
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Reading the notification settings")
            }
            HubNotifyNoticeView(store: store)
        }
        .padding(14)
        .frame(width: 400)
        .onAppear { store.load() }
        .panelFind(find, revision: store.status) { findRows }
    }

    /// What ⌘F searches here: the project names and the recent events, as shown.
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
                .instantTooltip(HubNotifyWords.enabledDetail)
            Spacer()
            if store.busy { ProgressView().controlSize(.small) }
        }
        LiveAgo(date: HubFormat.date(status.lastPollAt), fallback: "Never polled") { ago in
            pollLine(status, ago: ago)
        }
            .font(.system(size: 11))
            .foregroundColor(ReviewPalette.dim)
            .fixedSize(horizontal: false, vertical: true)
        if let fix = status.daemonFixTitle {
            daemonHint(status.daemonTitle, fix: fix)
        }

        section("Events")
        ForEach(HubNotifyEvent.allCases) { event in
            Toggle(event.title, isOn: Binding(
                get: { config.events[event.rawValue] ?? false },
                set: { store.set(["--event", "\(event.rawValue)=\($0 ? "on" : "off")"]) }
            ))
            .toggleStyle(.checkbox)
            .font(.system(size: 12))
            .instantTooltip(event.detail)
        }
        // The same switch, choices and words as Settings' PR activity page (H17): a stepper here once took any minute
        // while the page offered fixed choices.
        HStack(spacing: 14) {
            Toggle("Only my PRs", isOn: Binding(get: { config.onlyMine }, set: { store.set(["--only-mine", $0 ? "on" : "off"]) }))
                .toggleStyle(.checkbox)
                .instantTooltip(HubNotifyWords.onlyMineDetail)
            Spacer(minLength: 0)
            Picker("Cadence", selection: Binding(
                get: { config.intervalMinutes },
                set: { store.set(["--interval", String($0)]) }
            )) {
                ForEach(HubNotifyWords.cadenceOptions(including: config.intervalMinutes), id: \.self) {
                    Text(HubNotifyWords.cadenceTitle($0)).tag($0)
                }
            }
            .pickerStyle(.menu)
            .fixedSize()
            .instantTooltip(HubNotifyWords.cadenceDetail)
        }
        .font(.system(size: 12))

        section("Projects")
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
                        LiveAgo(date: HubFormat.date(event.at), style: .brief).font(.system(size: 10.5, design: .monospaced)).foregroundColor(ReviewPalette.dim).frame(width: 42, alignment: .leading)
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
                .instantTooltip(HubNotifyWords.pollNowDetail)
            Button("Send a test") { store.sendTest(pr: prs.selected.map { "\($0.project)\($0.isGitLab ? "!" : "#")\($0.number)" }) }
                .instantTooltip("Post one notification marked as a test; its click opens the hub at the selected PR")
            Spacer()
            Button("Config file") { PathOpener.cursor(status.configPath) }
                .instantTooltip("Open \((status.configPath as NSString).abbreviatingWithTildeInPath) in Cursor")
            Button("Settings…") { FeatureSettingsLaunch.open(pageID: PRActivitySettingsPages.pageID) }
                .instantTooltip("Open the PR activity page in Settings: a cadence and events per project")
        }
        .buttonStyle(.genHoverPlain())
        .font(.system(size: 11.5))
        .disabled(store.busy)
    }

    /// Nothing polls, or the daemon task ticks at an old cadence: the button Settings has, in the same words (H8).
    private func daemonHint(_ title: String, fix: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "exclamationmark.triangle").foregroundColor(ReviewPalette.modified)
            Text(title)
                .font(.system(size: 11))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            Button(fix) { store.installDaemonTask() }
                .buttonStyle(.genHover())
                .font(.system(size: 11.5))
                .disabled(store.busy)
                .instantTooltip(HubNotifyWords.installDetail)
                .contextMenu {
                    Button("Copy Command") { Clipboard.copy(HubNotifyWords.installCommand, what: "command") }
                }
                .accessibilityIdentifier("notify.install")
        }
    }

    /// `ago`: the live "5 min. ago" of the last poll, or "Never polled" (`LiveAgo`'s fallback).
    private func pollLine(_ status: HubNotifyStatus, ago: String) -> String {
        let last = HubFormat.date(status.lastPollAt) == nil ? ago : "Last poll \(ago)"
        return "\(last) · \(status.pollsLastHour) polls, \(status.requestsLastHour) host requests in the last hour"
    }

    private func section(_ title: String) -> some View {
        Text(title).font(.system(size: 11, weight: .semibold)).foregroundColor(ReviewPalette.dim).padding(.top, 4)
    }

    private func repoRow(_ path: String, name: String, config: HubNotifyStatus.Config, state: HubNotifyStatus) -> some View {
        let repo = config.repos[path]
        let watched = repo?.enabled == true
        let problem = watched ? state.repos.values.first { $0.path == path && $0.lastError != nil } : nil
        let showsProblem = problem != nil && openProblems.contains(path)
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Toggle(isOn: Binding(get: { watched }, set: { store.set(["--repo", path, "--repo-enabled", $0 ? "on" : "off"]) })) {
                    FindText(name, field: "name").font(.system(size: 12))
                }
                .toggleStyle(.checkbox)
                .instantTooltip(path)
                if let problem {
                    // The tooltip says what happened; a click shows the host's own error below the row (H21).
                    IconButton(
                        systemName: "exclamationmark.circle",
                        tooltip: showsProblem ? "Hide the error" : "\(problem.problemText) Click to see the error.",
                        size: 11, tint: ReviewPalette.modified
                    ) {
                        if showsProblem { openProblems.remove(path) } else { openProblems.insert(path) }
                    }
                }
                Spacer(minLength: 4)
                if watched {
                    MenuButton(items: {
                        HubNotifyWords.eventItems(path: path, repo: repo, config: config, store: store)
                    }) {
                        HStack(spacing: 3) {
                            Text(HubNotifyWords.eventsSummary(repo: repo, config: config)).font(.system(size: 11))
                            Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold))
                        }
                    }
                    .fixedSize()
                    .instantTooltip(HubNotifyWords.eventsDetail)
                }
            }
            .frame(height: 24)
            if showsProblem, let problem {
                NoticePill(text: problem.problemText, more: problem.lastError, tone: .warning)
                    .padding(.leading, 20)
                    .padding(.bottom, 4)
            }
        }
    }
}
