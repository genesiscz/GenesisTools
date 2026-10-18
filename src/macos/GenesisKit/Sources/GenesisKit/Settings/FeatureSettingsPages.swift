import SwiftUI

/// The two pages every feature settings window has: General first, About last.
@MainActor
public enum FeatureSettingsPages {
    public static var general: NativeSettingsSection {
        NativeSettingsSection(
            id: "general", title: "",
            pages: [
                NativeSettingsPage(
                    id: "general", title: "General", symbol: "gearshape.fill", tint: .gray,
                    subtitle: "GenesisTools appearance and accessibility."
                ) {
                    NativeSettingsGeneralPage()
                }
            ], order: 0)
    }

    public static func about(additionalInfo: [String] = []) -> NativeSettingsSection {
        NativeSettingsSection(
            id: "about", title: "",
            pages: [
                NativeSettingsPage(
                    id: "about", title: "About", symbol: "info.circle.fill", tint: .gray,
                    subtitle: "GenesisTools for your Mac."
                ) {
                    NativeSettingsAboutPage(additionalInfo: additionalInfo)
                }
            ], order: 90)
    }
}
