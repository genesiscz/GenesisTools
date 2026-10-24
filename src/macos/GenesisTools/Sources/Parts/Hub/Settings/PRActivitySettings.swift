import AppKit
import GenesisKit
import SwiftUI

// Settings → Notifications → PR activity: what the one `hub-pr-notify` daemon task watches. It ticks every minute;
// each project polls at its own cadence, side by side, with its own event filter (src/hub/lib/notify-poll.ts). Reads
// `tools hub notify status --json` and writes through `tools hub notify set` (HubNotifyStore, shared with the bell in
// the hub's PRs list), so the next tick uses a change without a daemon restart.

@MainActor
enum PRActivitySettingsPages {
    static let pageID = "notifications.prActivity"

    static func section(store: HubNotifyStore) -> NativeSettingsSection {
        NativeSettingsSection(
            id: "notifications", title: "Notifications",
            pages: [
                NativeSettingsPage(
                    id: pageID, title: "PR activity", symbol: "bell.badge", tint: .red,
                    subtitle: "Banners for review threads, review requests, CI and merges, per project."
                ) {
                    PRActivitySettingsView(store: store)
                },
            ], order: 36)
    }
}

@MainActor
struct PRActivitySettingsView: View {
    @ObservedObject var store: HubNotifyStore

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let status = store.status {
                content(status)
            } else if store.busy || store.message == nil {
                NativeSettingsCard {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Reading the notification settings…").font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                }
            }
            HubNotifyNoticeView(store: store)
        }
        .onAppear { store.load() }
    }

    @ViewBuilder
    private func content(_ status: HubNotifyStatus) -> some View {
        let config = status.config
        NativeSettingsCard {
            NativeSettingsToggle(
                "PR notifications",
                detail: HubNotifyWords.enabledDetail,
                identifier: "prActivity.enabled",
                isOn: Binding(get: { config.enabled }, set: { store.set(["--enabled", $0 ? "on" : "off"]) }))
            Divider()
            NativeSettingsRow(status.daemonTitle, detail: pollLine(status)) {
                HStack(spacing: 8) {
                    if store.busy { ProgressView().controlSize(.small) }
                    if let fix = status.daemonFixTitle {
                        // The tooltip says what happens; the command is one right-click away, for a terminal (O7).
                        Button(fix) {
                            store.installDaemonTask()
                        }
                        .buttonStyle(.bordered).nativeSettingsPointer()
                        .instantTooltip(HubNotifyWords.installDetail)
                        .contextMenu {
                            Button("Copy the terminal command") { Clipboard.copy(HubNotifyWords.installCommand, what: "command") }
                        }
                        .accessibilityIdentifier("prActivity.install")
                    }
                    Button("Check now") { store.pollNow() }
                        .buttonStyle(.bordered).nativeSettingsPointer()
                        .instantTooltip(HubNotifyWords.pollNowDetail)
                        .accessibilityIdentifier("prActivity.pollNow")
                }
            }
        }
        .disabled(store.busy && store.status == nil)

        NativeSettingsCard("Projects", subtitle: "Each project polls at its own cadence. A failing one backs off alone.") {
            let paths = config.repos.keys.sorted {
                name($0).localizedCaseInsensitiveCompare(name($1)) == .orderedAscending
            }
            if paths.isEmpty {
                Text("No project yet. Add a checkout; worktrees of the same repo share its PRs.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
            ForEach(paths, id: \.self) { path in
                PRActivityProjectRow(path: path, name: name(path), config: config, status: status, store: store)
                if path != paths.last { Divider() }
            }
            HStack {
                Button("Add a project…") { addProject() }
                    .buttonStyle(.bordered).nativeSettingsPointer()
                    .accessibilityIdentifier("prActivity.addProject")
                Spacer(minLength: 0)
            }
        }

        NativeSettingsCard("Defaults", subtitle: "A project follows these until you change its own cadence or events.") {
            NativeSettingsRow("Cadence", detail: HubNotifyWords.cadenceDetail) {
                Picker("Cadence", selection: Binding(
                    get: { config.intervalMinutes },
                    set: { store.set(["--interval", String($0)]) }
                )) {
                    ForEach(HubNotifyWords.cadenceOptions(including: config.intervalMinutes), id: \.self) {
                        Text(HubNotifyWords.cadenceTitle($0)).tag($0)
                    }
                }
                .pickerStyle(.menu).labelsHidden().frame(width: 170)
                .accessibilityIdentifier("prActivity.defaultCadence")
            }
            Divider()
            ForEach(HubNotifyEvent.allCases) { event in
                NativeSettingsToggle(
                    event.title, detail: event.detail, identifier: "prActivity.event.\(event.rawValue)",
                    isOn: Binding(
                        get: { config.events[event.rawValue] ?? false },
                        set: { store.set(["--event", "\(event.rawValue)=\($0 ? "on" : "off")"]) }))
            }
            Divider()
            NativeSettingsToggle(
                "Only my PRs", detail: HubNotifyWords.onlyMineDetail,
                identifier: "prActivity.onlyMine",
                isOn: Binding(get: { config.onlyMine }, set: { store.set(["--only-mine", $0 ? "on" : "off"]) }))
        }

        HStack(spacing: 12) {
            Button("Send a test") { store.sendTest(pr: nil) }
                .buttonStyle(.genHoverPlain()).font(.system(size: 12))
                .instantTooltip("Post one notification marked as a test; its click opens the hub's PRs")
            Button("Config file") { PathOpener.cursor(status.configPath) }
                .buttonStyle(.genHoverPlain()).font(.system(size: 12))
                .instantTooltip("Open \((status.configPath as NSString).abbreviatingWithTildeInPath) in Cursor")
            Spacer(minLength: 0)
        }
    }

    private func name(_ path: String) -> String {
        URL(fileURLWithPath: path).lastPathComponent
    }

    private func pollLine(_ status: HubNotifyStatus) -> String {
        let last = HubFormat.date(status.lastPollAt).map { "Last poll \($0.formatted(date: .omitted, time: .shortened))" }
            ?? "Never polled"
        return "\(last) · \(status.pollsLastHour) polls and \(status.requestsLastHour) host requests in the last hour"
    }

    private func addProject() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Watch"
        panel.message = "Choose a git checkout whose PRs to watch"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        store.set(["--repo", url.path, "--repo-enabled", "on"])
    }
}

@MainActor
private struct PRActivityProjectRow: View {
    let path: String
    let name: String
    let config: HubNotifyStatus.Config
    let status: HubNotifyStatus
    @ObservedObject var store: HubNotifyStore

    private var repo: HubNotifyStatus.Repo? { config.repos[path] }
    private var watched: Bool { repo?.enabled == true }
    private var state: HubNotifyStatus.RepoState? { status.repos.values.first { $0.path == path } }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(name).font(.system(size: 13, weight: .medium))
                    PathLabel(path: path, font: .system(size: 10.5, design: .monospaced), showIcons: false)
                }
                Spacer(minLength: 8)
                if watched {
                    cadenceMenu
                    eventsMenu
                }
                Toggle("Watch \(name)", isOn: Binding(
                    get: { watched },
                    set: { store.set(["--repo", path, "--repo-enabled", $0 ? "on" : "off"]) }
                ))
                .labelsHidden().toggleStyle(.switch).controlSize(.small)
                .accessibilityIdentifier("prActivity.repo.\(name).watch")
            }
            if watched {
                stateLine
            }
        }
        .padding(.vertical, 2)
    }

    private var cadenceMenu: some View {
        let own = repo?.intervalMinutes
        return MenuButton(items: {
            [MenuButtonItem.action("Default (\(HubNotifyWords.cadenceTitle(config.intervalMinutes).lowercased()))", checked: own == nil) {
                store.set(["--repo", path, "--reset-repo-interval"])
            }, .divider]
                + HubNotifyWords.cadenceChoices.map { minutes in
                    .action(HubNotifyWords.cadenceTitle(minutes), checked: own == minutes) {
                        store.set(["--repo", path, "--interval", String(minutes)])
                    }
                }
        }) {
            menuLabel(own.map(HubNotifyWords.cadenceTitle) ?? "\(HubNotifyWords.cadenceTitle(config.intervalMinutes)) (default)")
        }
        .fixedSize()
        .instantTooltip("How often this project is polled")
        .accessibilityIdentifier("prActivity.repo.\(name).cadence")
    }

    private var eventsMenu: some View {
        MenuButton(items: {
            HubNotifyWords.eventItems(path: path, repo: repo, config: config, store: store)
        }) {
            menuLabel(HubNotifyWords.eventsSummary(repo: repo, config: config))
        }
        .fixedSize()
        .instantTooltip(HubNotifyWords.eventsDetail)
        .accessibilityIdentifier("prActivity.repo.\(name).events")
    }

    private func menuLabel(_ text: String) -> some View {
        HStack(spacing: 4) {
            Text(text).font(.system(size: 12))
            Image(systemName: "chevron.up.chevron.down").font(.system(size: 8, weight: .semibold))
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
    }

    @ViewBuilder
    private var stateLine: some View {
        if let state, let error = state.lastError {
            // One sentence; the host's own error behind Details, whole (it was cut at two lines, H21).
            NoticePill(text: state.problemText, more: error, tone: .warning)
        } else if let state, let ok = HubFormat.date(state.lastOkAt) {
            LiveAgo(date: ok, style: .ago) { "Polled \($0)" }
                .font(.system(size: 11)).foregroundStyle(.secondary)
        } else {
            Text("Not polled yet").font(.system(size: 11)).foregroundStyle(.secondary)
        }
    }
}
