import AppKit
import SwiftUI

// MARK: - Window style (Hub or Native)

extension HubDefaults {
    /// The hub's preferences a person sets (GenesisKit `HubPreferences`): window style, glass, energy column,
    /// cleanup age. The settings window's Hub pages edit the same values. A scripted run works on its scratch copy
    /// and tells no other process about it.
    @MainActor static var preferences: HubPreferences { isolated ? scratchPreferences : .shared }

    /// General → Theme and Reduce transparency, which the Native style follows. A scripted run reads its scratch copy
    /// (`--set featureSettings.appearance.theme=gradient`).
    @MainActor static var appearance: NativeSettingsAppearance { isolated ? scratchAppearance : .shared }

    // First read after `isolate()`, so they open the scratch suite.
    @MainActor private static let scratchPreferences = HubPreferences(
        defaults: store, broadcasts: false, observeExternalChanges: false)
    @MainActor private static let scratchAppearance = NativeSettingsAppearance(
        defaults: store, observeExternalChanges: false)
}

/// What the hub window draws, from the window style, the glass switch and General → Theme.
///
/// - Hub style: today's look. Glass lets the desktop show through.
/// - Native style: the settings window's look for General → Theme only (Glass, Solid or Gradient there). The hub's
///   glass switch does not apply; Reduce transparency shows solid surfaces.
struct HubLook: Equatable {
    let style: HubWindowStyle
    /// The theme Native surfaces draw (`NativePaneFill`, `NativeSettingsBackdrop`): General → Theme.
    let theme: NativeSettingsTheme
    /// The window shows the blurred desktop (`HubGlass.apply`).
    let seeThrough: Bool

    static func resolve(style: HubWindowStyle, glass: Bool, general: NativeSettingsTheme, reduceTransparency: Bool) -> HubLook {
        switch style {
        case .hub:
            return HubLook(style: .hub, theme: general, seeThrough: glass)
        case .native:
            let effective = general.effective(reduceTransparency: reduceTransparency, systemReduceTransparency: false)
            return HubLook(style: .native, theme: general, seeThrough: effective == .glass)
        }
    }

    /// The look before SwiftUI's environment exists (the window's first frame at launch).
    @MainActor
    static var current: HubLook {
        let appearance = HubDefaults.appearance
        return resolve(
            style: HubDefaults.preferences.style, glass: HubDefaults.preferences.glass, general: appearance.theme,
            reduceTransparency: appearance.reduceTransparency || NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency)
    }
}

/// ⌘⇧G, the drop button, View → Glass and the palette's "glass": the switch belongs to the Hub style. In the Native
/// style the window follows General → Theme, so these do nothing there (the button and the menu item show as
/// unavailable, the palette says why).
@MainActor
enum HubGlassSwitch {
    nonisolated static let nativeNote = "Native follows General → Theme"

    static var available: Bool { HubDefaults.preferences.style == .hub }

    static func toggle() {
        guard available else { return }
        HubDefaults.preferences.glass.toggle()
    }
}

/// On the hub's root: follows the style, the glass switch and General → Theme, draws the window's backdrop and hands
/// the look to every `.hubSurface` below through the environment. A change (from the settings window too) re-runs
/// only this modifier and the surfaces that read the look, never the hub's views themselves.
struct HubStyleHost: ViewModifier {
    @ObservedObject private var preferences = HubDefaults.preferences
    @ObservedObject private var appearance = HubDefaults.appearance
    @Environment(\.accessibilityReduceTransparency) private var systemOpaque

    func body(content: Content) -> some View {
        let look = HubLook.resolve(
            style: preferences.style, glass: preferences.glass, general: appearance.theme,
            reduceTransparency: appearance.reduceTransparency || systemOpaque)
        let native = look.style == .native
        // The environment goes on last, so the backdrop reads the theme too.
        content
            .titlebarBackground(HubBackdrop(native: native))
            .background(HubWindowReader { window in HubGlass.apply(to: window, enabled: look.seeThrough) })
            .environment(\.hubGlass, look.seeThrough)
            .environment(\.nativePanes, native)
            .environment(\.nativeSettingsTheme, look.theme)
            .environment(\.nativeSettingsReduceTransparency, appearance.reduceTransparency)
    }
}

/// The window's backdrop: none in Hub style (the surfaces are opaque), the settings window's in Native style. The
/// Glass theme's blur is the window container's own (`HubGlass`), so the backdrop adds only its tint.
private struct HubBackdrop: View {
    let native: Bool

    var body: some View {
        if native {
            NativeSettingsBackdrop(windowMaterial: false)
        } else {
            Color.clear
        }
    }
}
