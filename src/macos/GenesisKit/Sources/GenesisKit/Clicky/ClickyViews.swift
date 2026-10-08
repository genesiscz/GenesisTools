import AppKit
import SwiftUI

public enum ClickyPage: String, CaseIterable, Identifiable {
    case general = "General"
    case sound = "Sound"
    case sleep = "Sleep"
    case visualizer = "Visualizer"
    case notifications = "Notifications"
    case stats = "Stats"
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
        case .about: return "Small sounds. Made for your Mac."
        }
    }
}

private struct ClickyGlass: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var systemOpaque
    let opaque: Bool
    var radius: CGFloat = 18
    func body(content: Content) -> some View {
        if systemOpaque || opaque {
            content.background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: radius))
        } else if #available(macOS 26, *) {
            content.foregroundStyle(Color.white).glassEffect(
                .regular.tint(.black.opacity(0.14)), in: RoundedRectangle(cornerRadius: radius))
        } else {
            content.background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: radius))
        }
    }
}

@MainActor
public struct ClickySettingsView: View {
    @ObservedObject private var model: ClickyModel
    @State private var page: ClickyPage
    @State private var confirmReset = false
    @State private var copied = false
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.accessibilityReduceTransparency) private var systemOpaque

    public init(model: ClickyModel, page: ClickyPage = .sound) {
        self.model = model
        _page = State(initialValue: page)
    }

    public var body: some View {
        HStack(spacing: 0) {
            sidebar
            Divider()
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 12) {
                    pageIcon(page, size: 34)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(page.rawValue).font(.system(size: 23, weight: .semibold))
                        Text(page.subtitle).font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Circle().fill(model.enabled && !model.isPaused ? .mint : .secondary).frame(width: 7, height: 7)
                    Text(model.enabled ? "On" : "Off").font(.system(size: 11, weight: .medium))
                }.padding(26)
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        if let error = model.error {
                            Label(error, systemImage: "exclamationmark.triangle.fill")
                                .font(.system(size: 12)).foregroundStyle(.orange).padding(14)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .modifier(ClickyGlass(opaque: model.preferences.reduceTransparency))
                        }
                        pageContent
                    }.padding(.horizontal, 26).padding(.bottom, 28)
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background {
            if systemOpaque || model.preferences.reduceTransparency {
                Color(nsColor: .windowBackgroundColor)
            } else {
                ZStack {
                    Color(nsColor: .windowBackgroundColor)
                    LinearGradient(
                        colors: [.purple.opacity(0.12), .clear, .pink.opacity(0.06)],
                        startPoint: .topTrailing, endPoint: .bottomLeading)
                }
            }
        }
        .frame(minWidth: 760, minHeight: 610)
        .preferredColorScheme(.dark)
        .alert("Reset Clicky statistics?", isPresented: $confirmReset) {
            Button("Cancel", role: .cancel) {}
            Button("Reset", role: .destructive) { model.resetStatistics() }
        } message: {
            Text("This removes your saved aggregate counts from this Mac.")
        }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 10) {
                Image(systemName: "keyboard.fill").font(.system(size: 20)).foregroundStyle(.pink)
                Text("Clicky").font(.system(size: 23, weight: .bold, design: .rounded))
            }.padding(.horizontal, 14).padding(.top, 26).padding(.bottom, 25)
            pageRow(.general)
            Text("Settings").font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
                .padding(.horizontal, 14).padding(.top, 23).padding(.bottom, 6)
            ForEach([ClickyPage.sound, .sleep, .visualizer, .notifications]) { pageRow($0) }
            Text("Clicky").font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
                .padding(.horizontal, 14).padding(.top, 23).padding(.bottom, 6)
            pageRow(.stats)
            pageRow(.about)
            Spacer()
            VStack(alignment: .leading, spacing: 8) {
                Text(model.status).font(.system(size: 11)).foregroundStyle(.secondary)
                Button(model.enabled ? "Turn off" : "Enable Clicky") {
                    if model.enabled { model.deactivate() } else { model.activate() }
                }.buttonStyle(.bordered).controlSize(.small)
            }.padding(14)
        }.padding(.horizontal, 12).frame(width: 184)
            .background {
                if systemOpaque || model.preferences.reduceTransparency {
                    Color(nsColor: .windowBackgroundColor)
                } else {
                    Rectangle().fill(.thinMaterial)
                }
            }
    }

    private func pageRow(_ item: ClickyPage) -> some View {
        Button {
            if systemReduceMotion || model.preferences.reduceMotion {
                page = item
            } else {
                withAnimation(.easeInOut(duration: 0.16)) { page = item }
            }
        } label: {
            HStack(spacing: 10) {
                pageIcon(item, size: 27)
                Text(item.rawValue).font(.system(size: 13, weight: page == item ? .semibold : .regular))
                Spacer(minLength: 0)
            }.padding(.horizontal, 10).padding(.vertical, 9).contentShape(Rectangle())
        }
        .buttonStyle(.genHoverRow())
        .background(page == item ? Color.primary.opacity(0.09) : .clear, in: RoundedRectangle(cornerRadius: 11))
        .accessibilityAddTraits(page == item ? .isSelected : [])
        .accessibilityIdentifier("clicky.page.\(item.id)")
    }

    private func pageIcon(_ item: ClickyPage, size: CGFloat) -> some View {
        Image(systemName: item.symbol).font(.system(size: size * 0.51, weight: .semibold))
            .foregroundStyle(.white).frame(width: size, height: size)
            .background(item.tint.gradient, in: RoundedRectangle(cornerRadius: size * 0.25))
            .accessibilityHidden(true)
    }

    @ViewBuilder private var pageContent: some View {
        switch page {
        case .general: general
        case .sound: sound
        case .sleep: sleep
        case .visualizer: visualizer
        case .notifications: notifications
        case .stats: stats
        case .about: about
        }
    }

    private func card<Content: View>(_ title: String? = nil, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 15) {
            if let title { Text(title).font(.system(size: 13, weight: .semibold)) }
            content()
        }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
            .modifier(ClickyGlass(opaque: model.preferences.reduceTransparency))
    }

    private func setting(_ title: String, detail: String, value: Binding<Bool>) -> some View {
        HStack(spacing: 20) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.system(size: 13, weight: .medium))
                Text(detail).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(
                    horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Toggle(title, isOn: value).labelsHidden().toggleStyle(.switch).controlSize(.small)
                .accessibilityIdentifier("clicky.setting.\(title)")
        }
    }

    private var general: some View {
        VStack(spacing: 18) {
            card {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Give your keyboard a voice.").font(.system(size: 22, weight: .semibold, design: .rounded))
                        Text("Clicky plays a small sound as you press and release a key.")
                            .font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: "waveform").font(.system(size: 34)).foregroundStyle(.pink)
                }
                Divider()
                HStack {
                    Text(model.status).font(.system(size: 12))
                    Spacer()
                    Button(model.enabled ? "Turn off" : "Enable Clicky") {
                        if model.enabled { model.deactivate() } else { model.activate() }
                    }.buttonStyle(.borderedProminent).tint(.purple)
                }
            }
            card("Input permission") {
                Text(
                    "Enable Clicky to request Input Monitoring. Only physical key positions are used to play sounds. Typed text and passwords are never read or saved. Secure Input automatically silences Clicky."
                )
                .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Button("Open Input Monitoring settings", action: model.openInputSettings).buttonStyle(.genHoverPlain())
            }
            card("Appearance") {
                setting(
                    "Reduce motion", detail: "Keep page changes and the visualizer still.",
                    value: $model.preferences.reduceMotion)
                Divider()
                setting(
                    "Reduce transparency", detail: "Use solid panels. macOS accessibility settings are also respected.",
                    value: $model.preferences.reduceTransparency)
            }
            Text("Clicky starts off each time you open it. Enable it when you want keyboard sounds.")
                .font(.system(size: 11)).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var sound: some View {
        VStack(spacing: 18) {
            card {
                HStack {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(model.preferences.selectedSwitch.name).font(
                            .system(size: 25, weight: .semibold, design: .rounded))
                        Text(model.preferences.selectedSwitch.detail).font(.system(size: 12)).foregroundStyle(
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
                                model.preferences.selectedSwitch = profile
                                model.preview(profile)
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
                                    if model.preferences.selectedSwitch == profile {
                                        Image(systemName: "checkmark").foregroundStyle(.pink).font(
                                            .system(size: 12, weight: .semibold))
                                    }
                                }.padding(.vertical, 7).padding(.horizontal, 6).contentShape(Rectangle())
                            }.buttonStyle(.genHoverRow())
                                .accessibilityLabel("Select \(profile.name) switch")
                            IconButton(systemName: "play.fill", tooltip: "Preview \(profile.name)") {
                                model.preview(profile)
                            }
                        }
                    }
                }
            }
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
                HStack {
                    DatePicker("From", selection: timeBinding(\.quietStart), displayedComponents: .hourAndMinute)
                    DatePicker("Until", selection: timeBinding(\.quietEnd), displayedComponents: .hourAndMinute)
                }.disabled(!model.preferences.quietHours)
                Text("Equal start and end times disable the schedule. Sleep and screen sleep always pause sounds.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
            card("Muted applications") {
                Text("Clicky stays quiet while any of these applications is in front.").font(.system(size: 12))
                    .foregroundStyle(.secondary)
                ForEach(model.preferences.excludedApplications, id: \.self) { bundleID in
                    HStack {
                        Text(bundleID).font(.system(size: 11)).textSelection(.enabled)
                        Spacer()
                        IconButton(systemName: "minus.circle", tooltip: "Remove \(bundleID)") {
                            model.preferences.excludedApplications.removeAll { $0 == bundleID }
                        }
                    }
                }
                Button("Add application…", action: model.excludeApplication).buttonStyle(.bordered)
            }
        }
    }

    private func timeBinding(_ path: WritableKeyPath<ClickyPreferences, Int>) -> Binding<Date> {
        Binding(
            get: {
                let minute = model.preferences[keyPath: path]
                return Calendar.current.startOfDay(for: Date()).addingTimeInterval(Double(minute * 60))
            },
            set: { date in
                let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
                model.preferences[keyPath: path] = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
            })
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
                        set: { enabled in
                            if enabled && model.notificationStatus != "Allowed" {
                                model.requestNotifications()
                            } else {
                                model.preferences.notifications = enabled
                            }
                        }))
                Divider()
                HStack {
                    Text(model.notificationStatus).font(.system(size: 12)).foregroundStyle(.secondary)
                    Spacer()
                    Button("Allow notifications", action: model.requestNotifications).buttonStyle(.bordered)
                }
            }
            Text(
                "Clicky asks macOS only when you press Allow notifications. Notification style and sound are controlled in System Settings."
            )
            .font(.system(size: 12)).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var stats: some View {
        VStack(spacing: 18) {
            HStack(spacing: 14) {
                metric("Key presses", value: model.statistics.presses, symbol: "arrow.down")
                metric("Key releases", value: model.statistics.releases, symbol: "arrow.up")
            }
            card {
                HStack {
                    Label("Sessions enabled", systemImage: "power").font(.system(size: 13))
                    Spacer()
                    Text(model.statistics.sessions.formatted()).font(
                        .system(size: 24, weight: .semibold, design: .rounded)
                    ).monospacedDigit()
                }
                Text("Since \(model.statistics.startedAt.formatted(date: .abbreviated, time: .omitted))").font(
                    .system(size: 11)
                ).foregroundStyle(.secondary)
            }
            card("Privacy") {
                setting(
                    "Keep local statistics",
                    detail: "Save only total presses, releases and sessions. No words, key history or app history.",
                    value: $model.preferences.collectStats)
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

    private var about: some View {
        VStack(spacing: 18) {
            ZStack {
                RoundedRectangle(cornerRadius: 20).fill(
                    LinearGradient(
                        colors: [.indigo, .purple.opacity(0.6), .blue], startPoint: .topLeading,
                        endPoint: .bottomTrailing))
                VStack(spacing: 18) {
                    ClickyDemoKeys(model: model)
                    Text("Clicky").font(.system(size: 34, weight: .bold, design: .rounded))
                    Text("A GenesisTools native feature").font(.system(size: 12)).foregroundStyle(.white.opacity(0.7))
                }.padding(30)
            }.frame(height: 230)
            card("Made for the keys you already love.") {
                Text(
                    "Seven original switch voices. Separate press and release sounds. Small pitch variations and stereo positioning, all generated on your Mac."
                )
                .font(.system(size: 13)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Divider()
                HStack {
                    Text("Version \(model.version)").font(.system(size: 12)).foregroundStyle(.secondary)
                    Spacer()
                    Button(copied ? "Copied" : "Copy feedback details") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(
                            "Clicky \(model.version)\nmacOS \(ProcessInfo.processInfo.operatingSystemVersionString)\nSwitch: \(model.preferences.selectedSwitch.name)\n\nFeedback:\n",
                            forType: .string)
                        copied = true
                    }.buttonStyle(.bordered)
                }
            }
            Text(
                "Sound synthesis is original to Clicky. No third-party recordings are bundled. Feedback details contain the app version, macOS version and chosen switch only."
            )
            .font(.system(size: 11)).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
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
                    model.preview(position: Float(index - 1) * 0.65)
                } label: {
                    Text(label).font(.system(size: 21, weight: .semibold, design: .rounded))
                        .frame(width: 49, height: 49)
                        .modifier(ClickyGlass(opaque: model.preferences.reduceTransparency, radius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(.white.opacity(0.14), lineWidth: 1))
                }.buttonStyle(.genHoverPlain()).instantTooltip("Preview a key press")
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
                    !systemReduceMotion, !model.preferences.reduceMotion
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
                    model.preferences.selectedSwitch = profile
                    model.preview(profile)
                } label: {
                    HStack {
                        Text(profile.name)
                        Spacer()
                        if model.preferences.selectedSwitch == profile { Image(systemName: "checkmark") }
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
