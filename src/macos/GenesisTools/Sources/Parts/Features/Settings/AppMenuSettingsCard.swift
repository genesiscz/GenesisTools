import GenesisKit
import SwiftUI

struct AppMenuSettingsCard: View {
    @AppStorage private var shown: Bool
    let preview: Bool

    init(defaults: UserDefaults, preview: Bool) {
        _shown = AppStorage(wrappedValue: true, MenuBarSettings.appKey, store: defaults)
        self.preview = preview
    }

    var body: some View {
        NativeSettingsCard("Menu bar") {
            NativeSettingsToggle("Show GenesisTools in the menu bar",
                                 detail: "Open installed tools from one menu.",
                                 identifier: MenuBarSettings.appKey,
                                 isOn: Binding(get: { shown }, set: { value in
                                     shown = value
                                     guard !preview else { return }
                                     MenuBarSettings.postChanged()
                                     if value { WidgetLaunch.ensureRunningIfShown() }
                                 }))
        }
    }
}
