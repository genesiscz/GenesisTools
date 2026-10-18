import AppKit
import GenesisKit
import SwiftUI

// Settings → Notifications → PR activity: what the one `hub-pr-notify` daemon task watches. It ticks every minute;
// each project polls at its own cadence, side by side, with its own event filter (src/hub/lib/notify-poll.ts). Reads
// `tools hub notify status --json` and writes through `tools hub notify set` (HubNotifyStore, shared with the bell in
// the hub's PRs list), so the next tick uses a change without a daemon restart.

@MainActor
package enum PRActivitySettingsPages {
    package static let pageID = "notifications.prActivity"

    package static func section() -> NativeSettingsSection {
        NativeSettingsSection(
            id: "notifications", title: "Notifications",
            pages: [
                NativeSettingsPage(
                    id: pageID, title: "PR activity", symbol: "bell.badge", tint: .red,
                    subtitle: "Banners for review threads, review requests, CI and merges, per project."
                ) {
                    PRActivitySettingsView(store: .shared)
                },
            ], order: 36)
    }
}

/// The cadences a project can pick, in minutes (the CLI takes any whole minute from 1 to 60).
private let cadenceChoices = [1, 2, 3, 5, 10, 15, 20, 30, 45, 60]

private func cadenceTitle(_ minutes: Int) -> String {
    minutes == 1 ? "Every minute" : "Every \(minutes) minutes"
}

@MainActor
package struct PRActivitySettingsView: View {
    @ObservedObject package var store: HubNotifyStore

    package var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let status = store.status {
                content(status)
            } else {
                NativeSettingsCard {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Reading the notification settings…").font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                }
            }
            if let message = store.message {
                NoticePill(text: message, isError: message.contains("exited") || message.contains("failed")) {
                    store.message = nil
                }
            }
        }
        .onAppear { store.load() }
    }

    @ViewBuilder
    private func content(_ status: HubNotifyStatus) -> some View {
        let config = status.config
        NativeSettingsCard {
            NativeSettingsToggle(
                "PR notifications",
                detail: "When this is off, no project is polled and nothing posts.",
                identifier: "prActivity.enabled",
                isOn: Binding(get: { config.enabled }, set: { store.set(["--enabled", $0 ? "on" : "off"]) }))
            Divider()
            NativeSettingsRow(tickTitle(status), detail: pollLine(status)) {
                HStack(spacing: 8) {
                    if store.busy { ProgressView().controlSize(.small) }
                    if status.daemonTask != true || status.daemonTaskEvery != status.daemonTaskWanted {
                        Button(status.daemonTask == true ? "Tick every minute" : "Add the daemon task") {
                            store.installDaemonTask()
                        }
                        .buttonStyle(.bordered).nativeSettingsPointer()
                        .instantTooltip("tools hub notify install: one daemon task that ticks every minute")
                        .accessibilityIdentifier("prActivity.install")
                    }
                    Button("Check now") { store.pollNow() }
                        .buttonStyle(.bordered).nativeSettingsPointer()
                        .instantTooltip("Poll every watched project now, ignoring cadences and backoff")
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
            NativeSettingsRow("Cadence", detail: "How often a project without its own cadence is polled.") {
                Picker("Cadence", selection: Binding(
                    get: { config.intervalMinutes },
                    set: { store.set(["--interval", String($0)]) }
                )) {
                    ForEach(cadenceOptions(including: config.intervalMinutes), id: \.self) { Text(cadenceTitle($0)).tag($0) }
                }
                .pickerStyle(.menu).labelsHidden().frame(width: 170)
                .accessibilityIdentifier("prActivity.defaultCadence")
            }
            Divider()
            ForEach(HubNotifyEvent.allCases) { event in
                NativeSettingsToggle(
                    event.title, detail: eventDetail(event), identifier: "prActivity.event.\(event.rawValue)",
                    isOn: Binding(
                        get: { config.events[event.rawValue] ?? false },
                        set: { store.set(["--event", "\(event.rawValue)=\($0 ? "on" : "off")"]) }))
            }
            Divider()
            NativeSettingsToggle(
                "Only my PRs", detail: "Changes on PRs someone else opened stay silent.",
                identifier: "prActivity.onlyMine",
                isOn: Binding(get: { config.onlyMine }, set: { store.set(["--only-mine", $0 ? "on" : "off"]) }))
        }

        HStack(spacing: 12) {
            Button("Send a test") { store.sendTest(pr: nil) }
                .buttonStyle(.genHoverPlain()).font(.system(size: 12))
                .instantTooltip("Post one notification marked as a test; its click opens the hub's PRs")
            Button("Config file") { PathOpener.cursor(status.configPath) }
                .buttonStyle(.genHoverPlain()).font(.system(size: 12))
                .instantTooltip(status.configPath)
            Spacer(minLength: 0)
        }
    }

    private func name(_ path: String) -> String {
        URL(fileURLWithPath: path).lastPathComponent
    }

    private func tickTitle(_ status: HubNotifyStatus) -> String {
        switch status.daemonTask {
        case true?:
            return status.daemonTaskEvery == status.daemonTaskWanted
                ? "The daemon checks every minute"
                : "The daemon task still runs \(status.daemonTaskEvery ?? "at an old cadence")"
        case false?: return "Nothing polls yet: the daemon task is missing"
        case nil: return "The daemon's task list is unreadable"
        }
    }

    private func pollLine(_ status: HubNotifyStatus) -> String {
        let last = HubFormat.date(status.lastPollAt).map { "Last poll \($0.formatted(date: .omitted, time: .shortened))" }
            ?? "Never polled"
        return "\(last) · \(status.pollsLastHour) polls and \(status.requestsLastHour) host requests in the last hour"
    }

    private func eventDetail(_ event: HubNotifyEvent) -> String {
        switch event {
        case .thread: return "Someone else opens a review thread or comment thread on a PR."
        case .reviewRequested: return "You are added as a reviewer."
        case .ciFailed: return "The checks of a PR's newest commit fail."
        case .ciPassed: return "The checks of a PR's newest commit pass."
        case .botReview: return "A review bot posts a review."
        case .merged: return "A watched open PR is merged."
        }
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

/// `cadenceChoices`, plus the stored value when the config holds another one.
private func cadenceOptions(including value: Int) -> [Int] {
    cadenceChoices.contains(value) ? cadenceChoices : (cadenceChoices + [value]).sorted()
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
            [MenuButtonItem.action("Default (\(cadenceTitle(config.intervalMinutes).lowercased()))", checked: own == nil) {
                store.set(["--repo", path, "--reset-repo-interval"])
            }, .divider]
                + cadenceChoices.map { minutes in
                    .action(cadenceTitle(minutes), checked: own == minutes) {
                        store.set(["--repo", path, "--interval", String(minutes)])
                    }
                }
        }) {
            menuLabel(own.map(cadenceTitle) ?? "\(cadenceTitle(config.intervalMinutes)) (default)")
        }
        .fixedSize()
        .instantTooltip("How often this project is polled")
        .accessibilityIdentifier("prActivity.repo.\(name).cadence")
    }

    private var eventsMenu: some View {
        MenuButton(items: {
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
        }) {
            menuLabel(eventsSummary)
        }
        .fixedSize()
        .instantTooltip("Which events this project posts; the defaults apply until you change one here")
        .accessibilityIdentifier("prActivity.repo.\(name).events")
    }

    private var eventsSummary: String {
        let on = HubNotifyEvent.allCases.filter { repo?.events?[$0.rawValue] ?? config.events[$0.rawValue] ?? false }
        let label = on.count == HubNotifyEvent.allCases.count ? "All events" : Plural.count(on.count, "event")
        return repo?.events == nil ? "\(label) (default)" : label
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
            Label(
                "\(Plural.count(state.failures, "failed poll")) · next try \(HubFormat.date(state.nextAt)?.formatted(date: .omitted, time: .shortened) ?? "soon") · \(error)",
                systemImage: "exclamationmark.circle"
            )
            .font(.system(size: 11)).foregroundStyle(.orange).lineLimit(2)
        } else if let state, let ok = HubFormat.date(state.lastOkAt) {
            LiveAgo(date: ok, style: .ago) { "Polled \($0)" }
                .font(.system(size: 11)).foregroundStyle(.secondary)
        } else {
            Text("Not polled yet").font(.system(size: 11)).foregroundStyle(.secondary)
        }
    }
}
