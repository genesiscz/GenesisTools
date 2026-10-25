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
                    subtitle: "Defaults for the Agent processes and Worktree cleanup panes."
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
                }
            }
            NativeSettingsCard {
                // Glass belongs to the Hub style; the Native style takes its look from General → Theme alone.
                NativeSettingsToggle(
                    "Glass",
                    detail: native
                        ? "Native follows General → Theme."
                        : "Let the desktop show through the hub, blurred. ⌘⇧G in the hub does the same.",
                    identifier: "hub.glass", isOn: $preferences.glass)
                    .disabled(native)
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

    var body: some View {
        VStack(spacing: 18) {
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
            Text("The panes in the hub show the same controls. Changes apply to a running hub at once.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

@MainActor
private struct HubHistorySettings: View {
    @ObservedObject var preferences: HubPreferences

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
                NativeSettingsRow(
                    "Keep the last", detail: "Older places leave History, Back and Forward. The log is in ~/.genesis-tools/hub/data.db."
                ) {
                    HStack(spacing: 8) {
                        NativeSettingsNumberPicker(
                            "Places kept",
                            range: HubPreferences.navigationLimitRange.lowerBound
                                ..< (HubPreferences.navigationLimitRange.upperBound + 1),
                            identifier: "hub.nav.limit", value: $preferences.navigationLimit)
                        Text("places").font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                }
            }
            Text("⌘[ and ⌘] go back and forward; ⌘Y lists every place. Changes apply to a running hub at once.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
