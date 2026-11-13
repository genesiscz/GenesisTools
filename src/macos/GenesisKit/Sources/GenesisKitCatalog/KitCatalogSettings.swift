import GenesisKit
import SwiftUI

@MainActor
extension KitCatalog {
    static var settingsEntries: [CatalogEntry] {
        [settingsRows, settingsChoices, settingsValues, settingsActions, settingsPaths, settingsAlerts, settingsTheme]
    }

    static var settingsRows: CatalogEntry {
        CatalogEntry(id: "settings-rows", group: "Settings", name: "Settings rows", summary: "Rows align titles, explanations and native controls. Cards group related choices without turning every row into a panel.",
            source: "GenesisKit/Settings/NativeSettingsViews.swift", critique: ["Keep explanations with the setting they describe.", "Long labels must leave room for a usable control."],
            sections: [CatalogSection("Group and availability", flow: .column, [
                CatalogVariant("Related settings") {
                    NativeSettingsCard("Playback", subtitle: "Changes apply to the next clip.") {
                        NativeSettingsToggle("Follow playback", detail: "Keep the current frame in view.", isOn: .constant(true))
                        NativeSettingsToggle("Show OCR boxes", isOn: .constant(false))
                        NativeSettingsRow("Status") { Badge("Ready") }
                    }.frame(width: 620)
                },
                CatalogVariant("Long explanation, disabled") {
                    NativeSettingsToggle("Use the selected display", detail: "This option becomes available after a recording includes more than one display.", isOn: .constant(false)).disabled(true).frame(width: 450)
                },
                CatalogVariant("Page identity") { HStack { NativeSettingsPageIcon(symbol: "play.circle", tint: KitHue.play.ink); Text("Playback") } },
            ])])
    }

    static var settingsChoices: CatalogEntry {
        let options = [NativeSettingsOption("auto", "Auto", detail: "Follow the recorded display focus.", symbol: "viewfinder"), NativeSettingsOption("fixed", "Fixed", detail: "Keep the selected display."), NativeSettingsOption("missing", "Unavailable", detail: "No matching display is recorded.", enabled: false)]
        return CatalogEntry(id: "settings-choices", group: "Settings", name: "Settings choices", summary: "A short set uses segments. Longer choices use a picker with the selected explanation below it.",
            source: "GenesisKit/Settings/NativeSettingsChoice.swift", critique: ["Show why an option cannot be selected.", "A selected explanation should not require reopening the menu."],
            sections: [CatalogSection("Short and explained choices", flow: .column, [
                CatalogVariant("Segments") { NativeSettingsSegmented("Display", identifier: "catalog.settings.display", options: Array(options.prefix(2)), selection: .constant("auto")).frame(width: 560) },
                CatalogVariant("Picker") { NativeSettingsPicker("Display", identifier: "catalog.settings.picker", options: options, selection: .constant("auto")).frame(width: 560) },
                CatalogVariant("Unavailable choice shown") { NativeSettingsPicker("Display", identifier: "catalog.settings.unavailable", options: options, selection: .constant("missing")).frame(width: 560) },
            ])])
    }

    static var settingsValues: CatalogEntry {
        CatalogEntry(id: "settings-values", group: "Settings", name: "Numbers, time and sliders", summary: "Typed values, nudges and sliders share a label and an explicit unit. A disclosure keeps infrequent settings nearby.",
            source: "GenesisKit/Settings/NativeSettingsControls.swift · GenesisKit/Settings/NativeSettingsSlider.swift · GenesisKit/Settings/NativeSettingsByteThreshold.swift", critique: ["A number without a unit is ambiguous.", "Sliders need keyboard input and an exact value alongside the track."],
            sections: [CatalogSection("Value controls", flow: .column, [
                CatalogVariant("Count") { NativeSettingsNumberPicker("History", range: 1..<61, identifier: "catalog.settings.count", suffix: .counted("day"), value: .constant(14)).frame(width: 560) },
                CatalogVariant("Time") { NativeSettingsTimePicker("Daily summary", identifier: "catalog.settings.time", minutes: .constant(9 * 60 + 30)).frame(width: 560) },
                CatalogVariant("Slider with exact value") { NativeSettingsSlider("Volume", identifier: "catalog.settings.volume", value: .constant(0.6), in: 0...1, step: 0.05, ticks: [0, 0.5, 1], format: { "\(Int($0 * 100))%" }).frame(width: 560) },
                CatalogVariant("Storage threshold") { NativeSettingsByteThreshold("Keep free", identifier: "catalog.settings.bytes", bytes: .constant(5_000_000_000), range: 1_000_000...100_000_000_000).frame(width: 560) },
                CatalogVariant("Disclosure") { NativeSettingsDisclosure("Advanced playback", identifier: "catalog.settings.advanced") { Text("Extra playback options") }.frame(width: 560) },
            ])])
    }

    static var settingsActions: CatalogEntry {
        CatalogEntry(id: "settings-actions", group: "Settings", name: "Settings actions", summary: "An action row names its effect and keeps progress and failure attached to that action.",
            source: "GenesisKit/Settings/NativeSettingsActionRow.swift", critique: ["Use a verb that names the result.", "A destructive action needs a clear confirmation before it runs."],
            sections: [CatalogSection("Normal and unavailable", flow: .column, [
                CatalogVariant("Action") { NativeSettingsActionRow("Recording library", detail: "Read the folders again.", identifier: "catalog.settings.refresh", buttonTitle: "Refresh", symbol: "arrow.clockwise", action: {}).frame(width: 560) },
                CatalogVariant("Disabled") { NativeSettingsActionRow("Export", detail: "Choose a recording first.", identifier: "catalog.settings.export", buttonTitle: "Export", action: {}).disabled(true).frame(width: 560) },
            ])])
    }

    static var settingsPaths: CatalogEntry {
        CatalogEntry(id: "settings-paths", group: "Settings", name: "Folder settings", summary: "A path list keeps each folder visible, with an explicit add action and an empty state.",
            source: "GenesisKit/Settings/NativeSettingsPathList.swift", critique: ["Do not hide the only path behind an ellipsis.", "An empty list must explain what can be added."],
            sections: [CatalogSection("Empty and populated", flow: .column, [
                CatalogVariant("Empty") { NativeSettingsPathList("Search folders", identifier: "catalog.paths.empty", paths: .constant([])).frame(width: 560) },
                CatalogVariant("Folders") { NativeSettingsPathList("Search folders", identifier: "catalog.paths.values", paths: .constant(["/Applications", "/Library"])).frame(width: 560) },
            ])])
    }

    static var settingsAlerts: CatalogEntry {
        let tiers = [NativeSettingsMatrixTier(id: "info", title: "Information", tint: KitHue.play.ink), NativeSettingsMatrixTier(id: "important", title: "Needs attention", detail: "A choice is waiting", tint: KitHue.ask.ink)]
        let channels = [NativeSettingsMatrixChannel(id: "window", title: "Window", symbol: "macwindow"), NativeSettingsMatrixChannel(id: "sound", title: "Sound", symbol: "speaker.wave.2"), NativeSettingsMatrixChannel(id: "notification", title: "Notification", symbol: "bell")]
        return CatalogEntry(id: "settings-alerts", group: "Alerts", name: "Alert channels", summary: "Each severity can use its own delivery channels. Unavailable cells stay visible and explain the missing option.",
            source: "GenesisKit/Settings/NativeSettingsChannelMatrix.swift", critique: ["Selection must be legible without relying on colour alone.", "A missing permission should not silently remove the channel."],
            sections: [CatalogSection("Delivery choices", flow: .column, [
                CatalogVariant("Selected and unavailable channels") { NativeSettingsChannelMatrix(identifier: "catalog.channels", tiers: tiers, channels: channels, selection: .constant(["info": ["window"], "important": ["window", "sound"]]), isAvailable: { _, channel in channel != "notification" }).frame(width: 560) },
            ])])
    }

    static var settingsTheme: CatalogEntry {
        CatalogEntry(id: "settings-theme", group: "Settings", name: "Theme choices", summary: "Small previews show what a theme changes before it is selected. The selected theme also carries a check mark.",
            source: "GenesisKit/Settings/NativeSettingsThemePicker.swift", critique: ["The preview should describe the real surface, not a decorative swatch.", "Keep the selected state visible on light and dark previews."],
            sections: [CatalogSection("Available themes", flow: .column, [
                CatalogVariant("Glass selected") { NativeSettingsThemePicker(selection: .constant(.glass)).frame(width: 560) },
                CatalogVariant("Solid selected") { NativeSettingsThemePicker(selection: .constant(.solid)).frame(width: 560) },
            ])])
    }
}
