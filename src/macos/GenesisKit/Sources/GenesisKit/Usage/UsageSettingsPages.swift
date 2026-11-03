import SwiftUI

/// The AI usage section of the settings window: how the hub's Usage mode draws its lanes and its tabs
/// (`UsagePreferences`). The hub reads the same values and follows a change at once.
@MainActor
public enum UsageSettingsPages {
    public static let pageID = "usage.charts"

    public static func section(preferences: UsagePreferences? = nil) -> NativeSettingsSection {
        let preferences = preferences ?? .shared
        return NativeSettingsSection(
            id: "usage", title: "AI usage",
            pages: [
                NativeSettingsPage(
                    id: pageID, title: "Usage charts", symbol: "chart.xyaxis.line", tint: .mint,
                    subtitle: "How the hub's Usage mode draws limits, forecasts and spend."
                ) {
                    UsageChartSettings(preferences: preferences)
                },
            ], order: 36)
    }
}

@MainActor
private struct UsageChartSettings: View {
    @ObservedObject var preferences: UsagePreferences

    var body: some View {
        VStack(spacing: 18) {
            NativeSettingsCard("Burn lanes", subtitle: "One lane per window of each account, on one time axis.") {
                picker("Range", detail: "How far back the lanes reach when the Usage mode opens.",
                       selection: preferences.binding(\.range), options: UsageRange.allCases, title: \.title,
                       identifier: "usage.range")
                Divider()
                picker("Resolution", detail: "Auto draws every reading up to 48 h and min-max bins above, so a short peak stays visible.",
                       selection: preferences.binding(\.resolution), options: UsageResolution.allCases, title: \.title,
                       identifier: "usage.resolution")
                Divider()
                picker("Line shape", detail: "Step holds a value until the next reading, as the store records it. Linear joins the readings.",
                       selection: preferences.binding(\.lineShape), options: UsageLineShape.allCases, title: \.title,
                       identifier: "usage.lineShape")
                Divider()
                picker("Window with no limit", detail: "An account without a 5h limit gets a hatched band, or no 5h lane.",
                       selection: preferences.binding(\.absentWindow), options: UsageAbsentWindow.allCases, title: \.title,
                       identifier: "usage.absentWindow")
                Divider()
                NativeSettingsToggle("Scoped windows", detail: "Give Fable and other scoped windows lanes of their own.",
                                     identifier: "usage.scopedWindows", isOn: preferences.binding(\.scopedWindows))
                Divider()
                NativeSettingsToggle("Reset bands", detail: "Shade every other window period and draw a line at each reset.",
                                     identifier: "usage.resetBands", isOn: preferences.binding(\.resetBands))
                Divider()
                NativeSettingsToggle("Severity colour", detail: "Colour the line by its reading: green, orange at 75%, red at 90%. Off uses the provider's colour.",
                                     identifier: "usage.severityColour", isOn: preferences.binding(\.severityColour))
            }
            NativeSettingsCard("Forecast", subtitle: "From the recent burn, to the window's reset.") {
                NativeSettingsToggle("Projection", detail: "A dashed line from now to the reset at the current rate.",
                                     identifier: "usage.projection", isOn: preferences.binding(\.projection))
                Divider()
                NativeSettingsToggle("Cone", detail: "Shade between the slow and the fast pace (the 25th and 75th percentile of the burn).",
                                     identifier: "usage.cone", isOn: preferences.binding(\.cone))
                Divider()
                NativeSettingsToggle("Safe pace", detail: "A thin line at the constant rate that lands at exactly 100% at the reset.",
                                     identifier: "usage.safePace", isOn: preferences.binding(\.safePace))
                Divider()
                NativeSettingsToggle("Cone in the Today digest", detail: "A small cone beside each account in the hub's Today digest.",
                                     identifier: "usage.digestCone", isOn: preferences.binding(\.digestCone))
            }
            NativeSettingsCard("Markers", subtitle: "What the lanes mark on top of the line.") {
                NativeSettingsToggle("Spikes", detail: "A diamond on each sharp rise, sized by the jump. A click lists the sessions that spent then.",
                                     identifier: "usage.spikeMarkers", isOn: preferences.binding(\.spikeMarkers))
                Divider()
                NativeSettingsToggle("Events", detail: "A tick for each rate limit, cooldown, poll pause, block and refused probe.",
                                     identifier: "usage.eventMarkers", isOn: preferences.binding(\.eventMarkers))
                Divider()
                NativeSettingsToggle("Poll coverage", detail: "A strip under each account: measured, stale, blocked, held back or not measured.",
                                     identifier: "usage.coverageStrip", isOn: preferences.binding(\.coverageStrip))
            }
            NativeSettingsCard("Spend") {
                picker("Stack by", detail: "What the Spend tab's bars are split by when it opens.",
                       selection: preferences.binding(\.spendStack), options: UsageSpendStack.allCases, title: \.title,
                       identifier: "usage.spendStack")
            }
            Text("Changes apply to a running hub at once.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func picker<Option: Hashable & Identifiable>(
        _ title: String, detail: String, selection: Binding<Option>, options: [Option], title label: KeyPath<Option, String>,
        identifier: String
    ) -> some View {
        NativeSettingsRow(title, detail: detail) {
            Picker(title, selection: selection) {
                ForEach(options) { option in Text(option[keyPath: label]).tag(option) }
            }
            .labelsHidden()
            .pickerStyle(.segmented)
            .frame(width: 250, alignment: .trailing)
            .accessibilityIdentifier(identifier)
        }
    }
}
