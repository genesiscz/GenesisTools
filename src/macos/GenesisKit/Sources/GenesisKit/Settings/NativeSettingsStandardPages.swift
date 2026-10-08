import AppKit
import SwiftUI

@MainActor
public struct NativeSettingsGeneralPage: View {
    @EnvironmentObject private var appearance: NativeSettingsAppearance
    @Environment(\.accessibilityReduceTransparency) private var systemOpaque
    public init() {}

    public var body: some View {
        VStack(spacing: 18) {
            NativeSettingsCard("Theme", subtitle: "Choose the background for native feature windows and widgets.") {
                NativeSettingsThemePicker(selection: $appearance.theme)
                if appearance.theme != .solid && (appearance.reduceTransparency || systemOpaque) {
                    Text(
                        "Reduce Transparency is showing solid surfaces. Your selected theme will return when it is turned off."
                    )
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
            NativeSettingsCard("Appearance", subtitle: "Applies to native feature windows and widgets.") {
                NativeSettingsToggle(
                    "Reduce motion", detail: "Keep transitions and visual feedback still.",
                    identifier: "settings.appearance.reduceMotion", isOn: $appearance.reduceMotion)
                Divider()
                NativeSettingsToggle(
                    "Reduce transparency", detail: "Use solid surfaces while keeping motion unchanged.",
                    identifier: "settings.appearance.reduceTransparency", isOn: $appearance.reduceTransparency)
            }
            NativeSettingsCard("Accessibility") {
                Label(
                    "Your macOS accessibility preferences are respected in addition to these settings.",
                    systemImage: "accessibility"
                )
                .font(.system(size: 12)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
            Text("Changes are shared with other running native feature windows for this app.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

@MainActor
public struct NativeSettingsAboutPage: View {
    private let appName: String
    private let additionalInfo: [String]
    @State private var copied = false
    public init(appName: String = "GenesisTools", additionalInfo: [String] = []) {
        self.appName = appName
        self.additionalInfo = additionalInfo
    }
    private var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
    }

    public var body: some View {
        VStack(spacing: 18) {
            VStack(spacing: 18) {
                Image(systemName: "slider.horizontal.3").font(.system(size: 40, weight: .medium))
                    .frame(width: 82, height: 82).nativeGlassControl(radius: 23)
                Text(appName).font(.system(size: 32, weight: .semibold, design: .rounded))
                Text("Native tools and feature settings").font(.system(size: 12)).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity).padding(.vertical, 32)
                .background(
                    LinearGradient(
                        colors: [.indigo.opacity(0.65), .purple.opacity(0.45), .blue.opacity(0.40)],
                        startPoint: .topLeading, endPoint: .bottomTrailing),
                    in: RoundedRectangle(cornerRadius: 24)
                )
                .nativeGlassSurface(radius: 24)
            NativeSettingsCard("About this app") {
                NativeSettingsRow("Version", detail: version) {
                    Button(copied ? "Copied" : "Copy feedback details") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(
                            "\(appName) \(version)\nmacOS \(ProcessInfo.processInfo.operatingSystemVersionString)\n\nFeedback:\n",
                            forType: .string)
                        copied = true
                    }.buttonStyle(.bordered)
                }
                ForEach(additionalInfo, id: \.self) { info in
                    Divider()
                    Text(info).font(.system(size: 12)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Text("Feedback details contain the app version and macOS version only. Nothing is sent automatically.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
