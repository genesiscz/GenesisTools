import AppKit
import SwiftUI

public enum ClickyPage: String, CaseIterable, Identifiable {
    case general = "General"
    case sound = "Sound"
    case sleep = "Sleep"
    case visualizer = "Visualizer"
    case notifications = "Notifications"
    case stats = "Stats"
    case performance = "Performance"
    case about = "About"
    public var id: String { rawValue }
    var symbol: String {
        switch self {
        case .general: return "gearshape.fill"
        case .sound: return "speaker.wave.2.fill"
        case .sleep: return "moon.zzz.fill"
        case .visualizer: return "keyboard.fill"
        case .notifications: return "bell.badge.fill"
        case .stats: return "chart.bar.fill"
        case .performance: return "speedometer"
        case .about: return "info.circle.fill"
        }
    }
    var tint: Color {
        switch self {
        case .general, .about: return .gray
        case .sound: return .pink
        case .sleep: return .indigo
        case .visualizer: return .purple
        case .notifications: return .orange
        case .stats: return .mint
        case .performance: return .cyan
        }
    }
    var subtitle: String {
        switch self {
        case .general: return "A little more character in every keystroke."
        case .sound: return "Find your sound. Make it your own."
        case .sleep: return "Quiet when you need it."
        case .visualizer: return "See the rhythm of your keyboard."
        case .notifications: return "Choose when Clicky gets your attention."
        case .stats: return "Your typing, counted locally."
        case .performance: return "Your pace, your patterns and a little perspective."
        case .about: return "Small sounds. Made for your Mac."
        }
    }
}

@MainActor
public enum ClickySettingsPages {
    public static func pageID(_ page: ClickyPage) -> String {
        switch page {
        case .general: return "general"
        case .about: return "about"
        default: return "clicky.\(page.rawValue.lowercased())"
        }
    }

    public static func sections(model: ClickyModel) -> [NativeSettingsSection] {
        func page(_ item: ClickyPage) -> NativeSettingsPage {
            NativeSettingsPage(
                id: pageID(item), title: item.rawValue, symbol: item.symbol,
                tint: item.tint, subtitle: item.subtitle
            ) {
                ClickySettingsPageContent(model: model, page: item)
            }
        }
        return [
            NativeSettingsSection(
                id: "general", title: "",
                pages: [
                    NativeSettingsPage(
                        id: "general", title: "General", symbol: "gearshape.fill", tint: .gray,
                        subtitle: "GenesisTools appearance and accessibility."
                    ) {
                        NativeSettingsGeneralPage()
                    }
                ], order: 0),
            NativeSettingsSection(
                id: "clicky", title: "Clicky",
                pages: [ClickyPage.sound, .sleep, .notifications, .stats, .performance, .visualizer].map(page), order: 10),
            NativeSettingsSection(
                id: "about", title: "",
                pages: [
                    NativeSettingsPage(
                        id: "about", title: "About", symbol: "info.circle.fill", tint: .gray,
                        subtitle: "GenesisTools for your Mac."
                    ) {
                        NativeSettingsAboutPage(additionalInfo: [
                            "Clicky includes seven original synthesized switch voices. No third-party recordings are bundled."
                        ])
                    }
                ], order: 90),
        ]
    }
}

@MainActor
public struct ClickySettingsView: View {
    @StateObject private var store: NativeSettingsStore
    public init(model: ClickyModel, page: ClickyPage = .sound) {
        _store = StateObject(
            wrappedValue: NativeSettingsStore(
                sections: ClickySettingsPages.sections(model: model),
                defaults: model.settingsDefaults, initialPageID: ClickySettingsPages.pageID(page),
                appearance: model.appearance))
    }
    public var body: some View { FeatureSettingsView(store: store) }
}

@MainActor
private struct ClickySettingsPageContent: View {
    @ObservedObject var model: ClickyModel
    let page: ClickyPage
    @State private var confirmReset = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let recovery = model.statisticsLoadError {
                Label(recovery, systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 12)).foregroundStyle(.orange)
                    .padding(16).nativeGlassSurface()
                    .accessibilityIdentifier("clicky.statistics.recovery")
            }
            if let error = model.error {
                HStack(alignment: .top, spacing: 12) {
                    Label(error, systemImage: "exclamationmark.triangle.fill").font(.system(size: 12)).foregroundStyle(
                        .orange)
                    Spacer(minLength: 0)
                    IconButton(systemName: "xmark", tooltip: "Dismiss message", action: model.dismissError)
                }.padding(16).nativeGlassSurface()
            }
            switch page {
            case .general, .sound: sound
            case .sleep: sleep
            case .visualizer: visualizer
            case .notifications: notifications
            case .stats: stats
            case .performance: ClickyPerformanceView(store: model.analytics, defaults: model.settingsDefaults)
            case .about: NativeSettingsAboutPage()
            }
        }
        .alert("Reset Clicky statistics?", isPresented: $confirmReset) {
            Button("Cancel", role: .cancel) {}
            Button("Reset", role: .destructive) { model.resetStatistics() }
        } message: {
            Text(model.statisticsLoadError == nil
                ? "This removes your saved aggregate counts from this Mac."
                : "This starts a new typing history and keeps a backup of the unreadable original data.")
        }
    }

    private func card<Content: View>(_ title: String? = nil, @ViewBuilder content: () -> Content) -> some View {
        NativeSettingsCard(title, content: content)
    }

    private func setting(_ title: String, detail: String, value: Binding<Bool>) -> some View {
        NativeSettingsToggle(title, detail: detail, identifier: "clicky.setting.\(title)", isOn: value)
    }

    private var activation: some View {
        card {
            NativeSettingsRow("Keyboard sounds", detail: model.status) {
                Toggle(
                    "Enable Clicky",
                    isOn: Binding(
                        get: { model.enabled },
                        set: { enabled in
                            if enabled { model.activate() } else { model.deactivate() }
                        })
                ).labelsHidden().toggleStyle(.switch).accessibilityIdentifier("clicky.enabled")
            }
            NativeSettingsDisclosure("Input permission and privacy", identifier: "clicky.inputPrivacy") {
                VStack(alignment: .leading, spacing: 12) {
                    Label(model.hasInputPermission ? "Input Monitoring is allowed" : "Input Monitoring is required",
                          systemImage: model.hasInputPermission ? "checkmark.shield" : "hand.raised")
                        .font(.system(size: 11, weight: .medium))
                    Text(
                        "Enable Clicky to request Input Monitoring. Only physical key positions are used for sounds. Typed text and passwords are never read or saved. Secure Input automatically silences Clicky."
                    )
                    .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Button("Open Input Monitoring settings", action: model.openInputSettings).buttonStyle(
                        .genHoverPlain())
                    Text("Clicky starts off each time you open it.").font(.system(size: 11)).foregroundStyle(.secondary)
                }.padding(.top, 8)
            }.font(.system(size: 12))
        }
    }

    private var sound: some View {
        VStack(spacing: 18) {
            activation
            card {
                HStack {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(model.selectedSoundName).font(
                            .system(size: 25, weight: .semibold, design: .rounded))
                        Text(model.selectedSoundDetail).font(.system(size: 12)).foregroundStyle(
                            .secondary)
                    }
                    Spacer()
                    ClickyDemoKeys(model: model)
                }
                HStack(spacing: 12) {
                    Image(systemName: "speaker.fill").foregroundStyle(.secondary)
                    Slider(value: $model.preferences.volume, in: 0...1).tint(.pink).accessibilityLabel("Sound volume")
                    Text("\(Int(model.preferences.volume * 100))%").monospacedDigit().font(.system(size: 11)).frame(
                        width: 32)
                }
            }
            card("Switch collection") {
                VStack(spacing: 2) {
                    ForEach(Array(ClickySwitch.allCases.enumerated()), id: \.element.id) { index, profile in
                        HStack(spacing: 12) {
                            Button {
                                model.selectBuiltIn(profile)
                                model.previewStroke(profile)
                            } label: {
                                HStack(spacing: 12) {
                                    RoundedRectangle(cornerRadius: 8).fill(switchColor(index).gradient)
                                        .frame(width: 30, height: 30)
                                        .overlay(
                                            Image(systemName: "plus").font(.system(size: 11, weight: .bold))
                                                .foregroundStyle(.white.opacity(0.9)))
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(profile.name).font(.system(size: 12, weight: .semibold))
                                        Text(profile.detail).font(.system(size: 10)).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if model.preferences.selectedPack == nil && model.preferences.selectedSwitch == profile {
                                        Image(systemName: "checkmark").foregroundStyle(.pink).font(
                                            .system(size: 12, weight: .semibold))
                                    }
                                }.padding(.vertical, 7).padding(.horizontal, 6).contentShape(Rectangle())
                            }.buttonStyle(.genHoverRow())
                                .accessibilityLabel("Select \(profile.name) switch")
                            IconButton(systemName: "play.fill", tooltip: "Preview \(profile.name)") {
                                model.previewStroke(profile)
                            }
                        }
                    }
                }
            }
            ClickySoundLibraryView(model: model, library: model.soundLibrary)
            card("Sound behavior") {
                setting(
                    "Key release sounds", detail: "A separate sound when each key comes back up.",
                    value: $model.preferences.releaseSounds)
                Divider()
                setting(
                    "Randomized pitch", detail: "Small variations keep repeated keys from sounding identical.",
                    value: $model.preferences.randomizedPitch)
                Divider()
                setting(
                    "Spatial audio", detail: "Pan sounds left and right with the physical keyboard layout.",
                    value: $model.preferences.spatialAudio)
                Divider()
                setting(
                    "Held-key repeats", detail: "Play repeated sounds while a key is held down.",
                    value: $model.preferences.repeatSounds)
            }
            Text(
                "All seven sounds are synthesized locally at 48 kHz. Headphones make the stereo positioning easier to hear."
            )
            .font(.system(size: 11)).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func switchColor(_ index: Int) -> Color {
        [.gray, .purple, .teal, .orange, .yellow, .red, .blue][index]
    }

    private var sleep: some View {
        VStack(spacing: 18) {
            card("Take a break") {
                HStack {
                    if let until = model.sleepingUntil {
                        Text("Paused until \(until.formatted(date: .omitted, time: .shortened))").font(
                            .system(size: 12))
                        Spacer()
                        Button("Resume", action: model.resume).buttonStyle(.bordered)
                    } else {
                        Text("Silence Clicky for a while.").font(.system(size: 12)).foregroundStyle(.secondary)
                        Spacer()
                        Button("15 min") { model.snooze(minutes: 15) }.buttonStyle(.bordered)
                        Button("1 hour") { model.snooze(minutes: 60) }.buttonStyle(.bordered)
                    }
                }
            }
            card("Quiet hours") {
                setting(
                    "Scheduled quiet hours", detail: "Automatically pause each day during this time.",
                    value: $model.preferences.quietHours)
                HStack(spacing: 12) {
                    NativeSettingsTimePicker("From", identifier: "clicky.quietStart", minutes: $model.preferences.quietStart)
                    NativeSettingsTimePicker("Until", identifier: "clicky.quietEnd", minutes: $model.preferences.quietEnd)
                }.disabled(!model.preferences.quietHours)
                Text("Equal start and end times disable the schedule. Sleep and screen sleep always pause sounds.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
            card("Muted applications") {
                Text("Clicky stays quiet while any of these applications is in front.").font(.system(size: 12))
                    .foregroundStyle(.secondary)
                ForEach(model.preferences.excludedApplications, id: \.self) { bundleID in
                    NativeSettingsApplicationRow(bundleID: bundleID) {
                        model.preferences.excludedApplications.removeAll { $0 == bundleID }
                    }
                }
                Button("Add application…", action: model.excludeApplication).buttonStyle(.bordered)
            }
        }
    }

    private var visualizer: some View {
        VStack(spacing: 18) {
            card {
                VStack(spacing: 25) {
                    ClickyKeyboard(model: model).frame(height: 145)
                    Text("A little light for every sound.").font(.system(size: 20, weight: .semibold, design: .rounded))
                    ClickyDemoKeys(model: model)
                    Text("Press the demo keys here, or enable Clicky and type in another app.")
                        .font(.system(size: 12)).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }.frame(maxWidth: .infinity).padding(.vertical, 12)
            }
            card {
                setting(
                    "Show key feedback",
                    detail: "Light the keyboard region where a sound plays. No typed characters are displayed.",
                    value: $model.preferences.visualizer)
            }
        }
    }

    private var notifications: some View {
        VStack(spacing: 18) {
            card("Notifications") {
                setting(
                    "Activation notifications", detail: "Show a macOS notification when Clicky is enabled.",
                    value: Binding(
                        get: { model.preferences.notifications },
                        set: model.setActivationNotifications))
                Divider()
                HStack {
                    Text(model.notificationStatus).font(.system(size: 12)).foregroundStyle(.secondary)
                    Spacer()
                    if model.notificationBusy { ProgressView().controlSize(.small) }
                    Button(model.notificationActionTitle, action: model.requestNotifications)
                        .buttonStyle(.bordered).disabled(model.notificationBusy)
                        .accessibilityIdentifier("clicky.notificationPermission")
                }
            }
            Text(
                model.notificationHelp
            )
            .font(.system(size: 12)).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var stats: some View {
        VStack(spacing: 18) {
            ClickyAnalyticsView(store: model.analytics)
            card("Privacy") {
                setting(
                    "Keep local statistics",
                    detail: "Minute and hour totals, daily totals and aggregate physical-key counts. No typed text, key sequence or application history.",
                    value: $model.preferences.collectStats)
                Text("Minute history: 30 days · Hourly: 1 year · Daily: 2 years. Earlier lifetime totals are preserved without inventing historical detail.")
                    .font(.caption).foregroundStyle(.secondary)
                Text("Counts are recorded while Clicky is listening. Paused or muted applications and Secure Input are not counted.")
                    .font(.caption).foregroundStyle(.secondary)
                Divider()
                Button("Reset statistics…", role: .destructive) { confirmReset = true }.buttonStyle(.genHoverPlain())
            }
        }
    }

    private func metric(_ title: String, value: Int, symbol: String) -> some View {
        card {
            Image(systemName: symbol).font(.system(size: 18, weight: .semibold)).foregroundStyle(.mint)
            Text(value.formatted()).font(.system(size: 34, weight: .semibold, design: .rounded)).monospacedDigit()
            Text(title).font(.system(size: 12)).foregroundStyle(.secondary)
        }
    }

}

@MainActor
private struct ClickyDemoKeys: View {
    @ObservedObject var model: ClickyModel
    var body: some View {
        HStack(spacing: 9) {
            ForEach(Array(["C", "L", "Y"].enumerated()), id: \.offset) { index, label in
                Button {
                    model.previewStroke(position: Float(index - 1) * 0.65)
                } label: {
                    Text(label).font(.system(size: 21, weight: .semibold, design: .rounded))
                        .frame(width: 49, height: 49)
                        .nativeGlassControl(radius: 12)
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(.white.opacity(0.14), lineWidth: 1))
                }.buttonStyle(.genHoverPlain()).instantTooltip("Preview key press and release")
                    .accessibilityIdentifier("clicky.demo.\(label)")
                    .contextMenu {
                        Button("Preview key release") {
                            model.preview(release: true, position: Float(index - 1) * 0.65)
                        }
                    }
            }
        }
    }
}

@MainActor
private struct ClickyKeyboard: View {
    @ObservedObject var model: ClickyModel
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.nativeSettingsReduceMotion) private var sharedReduceMotion
    @State private var lit = false
    var body: some View {
        VStack(spacing: 7) {
            ForEach(0..<4) { row in
                HStack(spacing: 7) {
                    ForEach(0..<12) { column in
                        RoundedRectangle(cornerRadius: 5)
                            .fill(
                                lit && abs(Float(column) / 11 * 1.5 - 0.75 - model.lastPan) < 0.18
                                    ? Color.pink : Color.primary.opacity(0.10)
                            )
                            .frame(width: 27, height: 24)
                    }
                }.offset(x: row.isMultiple(of: 2) ? 0 : 5)
            }
        }.accessibilityLabel("Keyboard sound visualization")
            .task(id: model.pulse) {
                guard model.pulse > 0, model.preferences.visualizer,
                    !systemReduceMotion, !sharedReduceMotion
                else {
                    lit = false
                    return
                }
                lit = true
                do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
                withAnimation(.easeOut(duration: 0.35)) { lit = false }
            }
            .onChange(of: model.preferences.visualizer) { _, enabled in
                if !enabled { lit = false }
            }
            .onChange(of: sharedReduceMotion) { _, reduced in
                if reduced { lit = false }
            }
    }
}

@MainActor
public struct ClickyPopoverView: View {
    @ObservedObject var model: ClickyModel
    let showSettings: () -> Void
    let quit: () -> Void
    public init(model: ClickyModel, showSettings: @escaping () -> Void, quit: @escaping () -> Void) {
        self.model = model
        self.showSettings = showSettings
        self.quit = quit
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Toggle(
                "Clicky",
                isOn: Binding(
                    get: { model.enabled },
                    set: { on in
                        if on { model.activate() } else { model.deactivate() }
                    })
            ).font(.headline).toggleStyle(.switch)
            Text(model.status).font(.system(size: 11)).foregroundStyle(.secondary)
            if let error = model.error { Text(error).font(.system(size: 11)).foregroundStyle(.orange) }
            Divider()
            HStack {
                Image(systemName: "speaker.wave.2.fill").foregroundStyle(.secondary)
                Slider(value: $model.preferences.volume, in: 0...1).accessibilityLabel("Sound volume")
            }
            Text("Switches").font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
            ForEach(ClickySwitch.allCases) { profile in
                Button {
                    model.selectBuiltIn(profile)
                    model.previewStroke(profile)
                } label: {
                    HStack {
                        Text(profile.name)
                        Spacer()
                        if model.preferences.selectedPack == nil && model.preferences.selectedSwitch == profile { Image(systemName: "checkmark") }
                    }.padding(.horizontal, 8).padding(.vertical, 5).contentShape(Rectangle())
                }.buttonStyle(.genHoverRow())
            }
            Divider()
            Text("Version \(model.version)").font(.system(size: 10)).foregroundStyle(.secondary)
            Button("Clicky settings…", action: showSettings).buttonStyle(.genHoverPlain())
            Button("Quit Clicky", action: quit).buttonStyle(.genHoverPlain())
        }.padding(20).frame(width: 265).preferredColorScheme(.dark)
    }
}
