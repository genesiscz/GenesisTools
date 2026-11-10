import SwiftUI

/// The Hub section of the settings window: the hub window's preferences (`HubPreferences`). The hub reads the same
/// values and follows a change at once, and a change made in the hub (⌘⇧G) shows here.
@MainActor
public enum HubSettingsPages {
    public static let appearancePageID = "hub.appearance"
    public static let panesPageID = "hub.panes"
    public static let historyPageID = "hub.history"

    public static func section(preferences: HubPreferences? = nil) -> NativeSettingsSection {
        let preferences = preferences ?? .shared
        return NativeSettingsSection(
            id: "hub", title: "Hub",
            pages: [
                NativeSettingsPage(
                    id: appearancePageID, title: "Appearance", symbol: "macwindow", tint: .indigo,
                    subtitle: "Choose how the hub window looks."
                ) {
                    HubAppearanceSettings(preferences: preferences)
                },
                NativeSettingsPage(
                    id: panesPageID, title: "Panes", symbol: "rectangle.split.3x1", tint: .teal,
                    subtitle: "Defaults for the diff, the Inbox, the PR overview, Activity, the Agents list, the Agent processes pane and the Worktree cleanup pane."
                ) {
                    HubPaneSettings(preferences: preferences)
                },
                NativeSettingsPage(
                    id: historyPageID, title: "History", symbol: "clock.arrow.circlepath", tint: .purple,
                    subtitle: "Back, Forward and the list of places the hub showed, yours and the agents'."
                ) {
                    HubHistorySettings(preferences: preferences)
                },
            ], order: 35)
    }
}

@MainActor
private struct HubAppearanceSettings: View {
    @ObservedObject var preferences: HubPreferences
    @EnvironmentObject private var appearance: NativeSettingsAppearance
    @EnvironmentObject private var store: NativeSettingsStore
    @Environment(\.accessibilityReduceTransparency) private var systemOpaque
    @AppStorage(GenScrollBarStyle.key) private var scrollBars = GenScrollBarStyle.genesis.rawValue

    private var native: Bool { preferences.style == .native }

    var body: some View {
        VStack(spacing: 18) {
            NativeSettingsCard(
                "Window style", subtitle: "Hub keeps the hub's own dark look. Native uses the look of this window."
            ) {
                NativeSettingsTilePicker(
                    selection: $preferences.style, options: HubWindowStyle.allCases, title: \.title,
                    accessibilityLabel: { "Window style: \($0.title)" }, identifier: { "hub.style.\($0.id)" }
                ) { style in
                    switch style {
                    case .hub: Color(nsColor: KitPalette.background)
                    case .native: NativeSettingsThemePicker.preview(appearance.theme)
                    }
                }
                if native {
                    Divider()
                    NativeSettingsRow("Theme: \(appearance.theme.title)", detail: "The hub follows General → Theme.") {
                        Button("Open General") { store.select(pageID: "general") }
                            .buttonStyle(.bordered)
                            .nativeSettingsPointer()
                            .accessibilityIdentifier("hub.style.openGeneral")
                    }
                    if appearance.reduceTransparency || systemOpaque {
                        Text("Reduce transparency is on, so the hub shows solid surfaces.")
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                } else {
                    // Glass belongs to the Hub style, so its switch shows only there, under the style it changes. The
                    // Native style takes its whole look from General → Theme (the row above), and a dimmed Glass switch
                    // beside "Theme: Glass" read as a contradiction (hub UX pass C54, 2026-11-10).
                    Divider()
                    NativeSettingsToggle(
                        "Glass",
                        detail: "Let the desktop show through the hub, blurred. ⌘⇧G in the hub does the same.",
                        identifier: "hub.glass", isOn: $preferences.glass)
                }
            }
            NativeSettingsCard("Scroll bars", subtitle: "The bars of the hub's lists, panes and diffs.") {
                NativeSettingsSegmented(
                    "Style", identifier: "hub.scrollBars",
                    options: GenScrollBarStyle.allCases.map { NativeSettingsOption($0, $0.title, detail: $0.detail) },
                    selection: Binding(
                        get: { GenScrollBarStyle(stored: scrollBars) },
                        set: { scrollBars = $0.rawValue }),
                    minSegmentWidth: 100)
            }
            Text("Changes apply to a running hub at once.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

@MainActor
private struct HubPaneSettings: View {
    @ObservedObject var preferences: HubPreferences
    @AppStorage(GitCommitClickMode.defaultsKey) private var commitClick = GitCommitClickMode.chooseThenShow.rawValue
    @AppStorage(HubResizeGrips.key) private var resizeGrips = HubResizeGrips.auto.rawValue
    @AppStorage(HubDiffLayout.key) private var diffLayout = HubDiffLayout.auto.rawValue
    @AppStorage(HubInboxCards.contextOpenKey) private var inboxContextOpen = false
    @AppStorage(HubAgentsEntry.openNewestKey) private var agentsOpenNewest = true
    @AppStorage(HubAgentsEntry.foldFinishedKey) private var agentsFoldFinished = true
    @AppStorage(HubPROverview.descriptionWholeKey) private var prDescriptionWhole = false
    @AppStorage(HubActivityRows.allActionsKey) private var activityAllActions = false
    @AppStorage(HubActivityRows.commitPrefixKey) private var activityCommitPrefix = false
    @AppStorage(HubSessionRows.hideSharedKey) private var sessionsHideShared = true
    @AppStorage(HubPRRowCI.key) private var prRowCI = HubPRRowCI.unusual.rawValue
    @AppStorage(HubFileTreeFold.key) private var filesFoldAbove = HubFileTreeFold.defaultAbove
    @AppStorage(TranscriptOutputFold.key) private var transcriptOutputFold = TranscriptOutputFold.defaultLines
    @AppStorage(HubChrome.glassButtonKey) private var glassButton = false

    var body: some View {
        VStack(spacing: 18) {
            NativeSettingsCard("Diff", subtitle: "The Split / Unified button in a review's header picks for that review only.") {
                NativeSettingsSegmented(
                    "Layout", identifier: "hub.diff.layout",
                    options: HubDiffLayout.allCases.map { NativeSettingsOption($0, $0.title, detail: $0.detail) },
                    selection: Binding(
                        get: { HubDiffLayout(rawValue: diffLayout) ?? .auto },
                        set: { diffLayout = $0.rawValue }),
                    minSegmentWidth: 90)
            }
            NativeSettingsCard("Inbox") {
                NativeSettingsToggle(
                    "Show each decision's context in full",
                    detail: "Off: a card shows five lines of its context and Show more; a code block in it shows five lines and opens on its own.",
                    identifier: "hub.inbox.contextOpen", isOn: $inboxContextOpen)
            }
            NativeSettingsCard("PR overview") {
                NativeSettingsToggle(
                    "Show each PR's whole description",
                    detail: "Off: a long description shows as much as fits in 60% of the column, then Show description. The hub remembers what you open per PR.",
                    identifier: "hub.prs.descriptionWhole", isOn: $prDescriptionWhole)
            }
            NativeSettingsCard("Activity") {
                NativeSettingsToggle(
                    "Show every action on a row",
                    detail: "Off: a hovered row shows open and copy, and one menu holds the rest. The right-click menu always lists every action.",
                    identifier: "hub.activity.allActions", isOn: $activityAllActions)
                Divider()
                NativeSettingsToggle(
                    "Start commit titles with their type and scope",
                    detail: "Off: a commit row starts with what changed, and its tooltip and open row keep the whole title.",
                    identifier: "hub.activity.commitPrefix", isOn: $activityCommitPrefix)
            }
            NativeSettingsCard("Agents list") {
                NativeSettingsToggle(
                    "Open the newest live agent",
                    detail: "Entering Agents with nothing open shows the newest running sub-agent, or the newest live session.",
                    identifier: "hub.agents.openNewest", isOn: $agentsOpenNewest)
                Divider()
                NativeSettingsToggle(
                    "Fold finished sub-agents",
                    detail: "A session's finished sub-agents sit in one row under its running ones until you open it.",
                    identifier: "hub.agents.foldFinished", isOn: $agentsFoldFinished)
                Divider()
                NativeSettingsSegmented(
                    "When a refresh moves a row", identifier: "hub.agents.motion",
                    options: HubListMotion.allCases.map { NativeSettingsOption($0, $0.title, detail: $0.detail) },
                    selection: $preferences.agentsMotion, minSegmentWidth: 80)
            }
            NativeSettingsCard("Agent processes") {
                NativeSettingsToggle(
                    "Measure energy impact",
                    detail: "Adds macOS energy impact to each process. Every refresh takes one top sample of about 1 s.",
                    identifier: "hub.procs.energy", isOn: $preferences.processEnergy)
            }
            NativeSettingsCard("Worktree cleanup") {
                NativeSettingsRow(
                    "Idle for at least",
                    detail: "Only worktrees idle this long count as removable. 0 days means any idle time."
                ) {
                    HStack(spacing: 8) {
                        NativeSettingsNumberPicker(
                            "Idle days",
                            range: HubPreferences.cleanupIdleDaysRange.lowerBound
                                ..< (HubPreferences.cleanupIdleDaysRange.upperBound + 1),
                            identifier: "hub.cleanup.idleDays", value: $preferences.cleanupIdleDays)
                        Text("days").font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                }
            }
            NativeSettingsCard("Commit list") {
                NativeSettingsSegmented(
                    "A click on a commit",
                    identifier: "hub.commitPicker.click",
                    options: [
                        NativeSettingsOption(
                            GitCommitClickMode.chooseThenShow, "Choose",
                            detail: "The first click chooses it and a second click shows it. A click on another commit chooses every commit between the two."),
                        NativeSettingsOption(
                            GitCommitClickMode.showAtOnce, "Show",
                            detail: "A click shows the commit at once. Shift-click chooses a run of commits."),
                    ],
                    selection: Binding(
                        get: { GitCommitClickMode(rawValue: commitClick) ?? .chooseThenShow },
                        set: { commitClick = $0.rawValue }))
            }
            NativeSettingsCard("Resize handles") {
                NativeSettingsSegmented(
                    "Show the grip", identifier: "hub.resizeGrips",
                    options: HubResizeGrips.allCases.map { NativeSettingsOption($0, $0.title, detail: $0.detail) },
                    selection: Binding(
                        get: { HubResizeGrips(rawValue: resizeGrips) ?? .auto },
                        set: { resizeGrips = $0.rawValue }),
                    minSegmentWidth: 80)
            }
            NativeSettingsCard("Lists and transcript") {
                NativeSettingsToggle(
                    "Hide what every session in a group shares",
                    detail: "A project, account or app chip that every row of a group shows appears on the group's first row only.",
                    identifier: "hub.sessions.hideShared", isOn: $sessionsHideShared)
                Divider()
                NativeSettingsSegmented(
                    "PR rows show CI", identifier: "hub.prs.rowCI",
                    options: HubPRRowCI.allCases.map { NativeSettingsOption($0, $0.title, detail: $0.detail) },
                    selection: Binding(get: { HubPRRowCI.stored(prRowCI) }, set: { prRowCI = $0.rawValue }),
                    minSegmentWidth: 90)
                Divider()
                NativeSettingsRow(
                    "Fold a files folder above",
                    detail: "A folder with more changed files starts folded, unless it holds half of the change or more. 0 never folds."
                ) {
                    HStack(spacing: 8) {
                        NativeSettingsNumberPicker(
                            "Files", range: HubFileTreeFold.range.lowerBound ..< (HubFileTreeFold.range.upperBound + 1),
                            identifier: "hub.files.foldAbove", value: $filesFoldAbove)
                        Text("files").font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                }
                Divider()
                NativeSettingsRow(
                    "Fold tool output after",
                    detail: "Longer output shows these lines and \"… +N lines\" at every transcript level, Verbose too. 0 shows it all in Verbose."
                ) {
                    HStack(spacing: 8) {
                        NativeSettingsNumberPicker(
                            "Lines", range: TranscriptOutputFold.range.lowerBound ..< (TranscriptOutputFold.range.upperBound + 1),
                            identifier: "sessionTranscript.outputFold", value: $transcriptOutputFold)
                        Text("lines").font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                }
                Divider()
                NativeSettingsToggle(
                    "Show a Glass button beside Settings",
                    detail: "Off: Glass stays in View → Glass (⌘⇧G), the command palette and Appearance.",
                    identifier: "hub.chrome.glassButton", isOn: $glassButton)
            }
            Text("The panes in the hub show the same controls. Changes apply to a running hub at once.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

@MainActor
private struct HubHistorySettings: View {
    @ObservedObject var preferences: HubPreferences

    /// Where `tools hub nav` keeps the places.
    static let logPath = (NSHomeDirectory() as NSString).appendingPathComponent(".genesis-tools/hub/data.db")

    var body: some View {
        VStack(spacing: 18) {
            NativeSettingsCard(
                "When an agent opens something",
                subtitle: "An agent or a link names a PR, a commit, a worktree or a session (tools hub nav open)."
            ) {
                NativeSettingsSegmented(
                    "Agent navigation", identifier: "hub.nav.agentNavigation",
                    options: HubAgentNavigation.allCases.map { NativeSettingsOption($0, $0.title, detail: $0.detail) },
                    selection: $preferences.agentNavigation, minSegmentWidth: 90)
            }
            NativeSettingsCard("History") {
                NativeSettingsRow("Keep the last", detail: "Older places leave History, Back and Forward.") {
                    HStack(spacing: 8) {
                        NativeSettingsNumberPicker(
                            "Places kept",
                            range: HubPreferences.navigationLimitRange.lowerBound
                                ..< (HubPreferences.navigationLimitRange.upperBound + 1),
                            identifier: "hub.nav.limit", value: $preferences.navigationLimit)
                        Text("places").font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                }
                Divider()
                // The database path is a diagnostic detail: it sits behind a button, not in the retention choice's text.
                NativeSettingsRow("History log", detail: "The places live in the hub's database, kept by tools hub nav.") {
                    Button("Reveal in Finder") { PathOpener.reveal(Self.logPath) }
                        .buttonStyle(.bordered)
                        .nativeSettingsPointer()
                        .instantTooltip((Self.logPath as NSString).abbreviatingWithTildeInPath)
                        .contextMenu {
                            Button("Copy Path") { Clipboard.copy(Self.logPath, what: "path") }
                        }
                        .accessibilityIdentifier("hub.nav.revealLog")
                }
            }
            Text("⌘[ and ⌘] go back and forward; ⌘Y lists every place. Changes apply to a running hub at once.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
