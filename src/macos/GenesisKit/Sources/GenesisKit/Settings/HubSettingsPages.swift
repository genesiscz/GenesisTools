import SwiftUI

/// The Hub section of the settings window: the hub window's preferences (`HubPreferences`). The hub reads the same
/// values and follows a change at once, and a change made in the hub (⌘⇧G) shows here.
@MainActor
public enum HubSettingsPages {
    public static let appearancePageID = "hub.appearance"
    public static let panesPageID = "hub.panes"

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
    /// The theme a Native hub shows: Glass while the glass switch is on, else General → Theme.
    private var hubTheme: NativeSettingsTheme { preferences.glass ? .glass : appearance.theme }

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
                    case .native: NativeSettingsThemePicker.preview(hubTheme)
                    }
                }
                if native {
                    Divider()
                    NativeSettingsRow(
                        "Theme: \(hubTheme.title)",
                        detail: preferences.glass
                            ? "Glass is on, so the hub uses the Glass theme."
                            : "The hub follows General → Theme."
                    ) {
                        Button("Open General") { store.select(pageID: "general") }
                            .buttonStyle(.bordered)
                            .nativeSettingsPointer()
                            .accessibilityIdentifier("hub.style.openGeneral")
                    }
                }
            }
            NativeSettingsCard {
                NativeSettingsToggle(
                    "Glass",
                    detail: native
                        ? "Use the Glass theme in the hub, whatever General → Theme says. ⌘⇧G in the hub does the same."
                        : "Let the desktop show through the hub, blurred. ⌘⇧G in the hub does the same.",
                    identifier: "hub.glass", isOn: $preferences.glass)
                if native && (appearance.reduceTransparency || systemOpaque) {
                    Text("Reduce transparency is on, so the hub shows solid surfaces.")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
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
