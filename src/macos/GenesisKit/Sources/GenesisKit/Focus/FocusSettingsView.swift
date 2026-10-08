// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Focus/FocusSettingsView.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import SwiftUI

/// Spec 22 (S6) §10.5 — Settings → Focus.
///
/// Four groups in this order, because the privacy group is the one that needs to be found:
/// Timer, Capture, Privacy, Projects. Every row explains its consequence in one line; a toggle
/// whose effect is invisible is a bug, not a preference.
public struct FocusSettingsView: View {
    public init() {}

    @ObservedObject private var controller = FocusController.shared
    @State private var settings = FocusSettings()
    @State private var plan = PomodoroPlan()
    @State private var hudStyle = FocusHUDWindowController.savedStyle
    @ObservedObject private var configuration = FlowFocusConfiguration.shared

    private let accent = Color.neonAmber

    public var body: some View {
        // No ScrollView, padding or background of its own: the Settings shell
        // already scrolls and pads every tab. The nested copies indented this
        // tab 24pt deeper than the others.
        VStack(alignment: .leading, spacing: 16) {
            if let error = configuration.lastError {
                NoticePill(text: error, isError: true, dismiss: configuration.dismissError)
            }
            if !controller.available {
                unavailableCard
            }
            timerCard
            captureCard
            privacyCard
            projectsCard
        }
        .onAppear(perform: load)
        .onChange(of: configuration.revision) { _, _ in load() }
        // `.contain` first: on a plain VStack a bare identifier propagates to
        // every child and clobbers their own ids (the ScrollView that carried
        // it before was its own AX element).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("settings-focus")
    }

    // MARK: - Cards

    private var unavailableCard: some View {
        SettingsCard(icon: "exclamationmark.triangle", title: "FOCUS IS OFF", accentColor: .genError) {
            Text(controller.lastError ?? "The activity ledger could not be opened, so nothing is being recorded.")
                .font(GenTypography.caption(11))
                .foregroundStyle(Color.settingsTextSecondary)
        }
    }

    private var timerCard: some View {
        SettingsCard(icon: "timer", title: "TIMER", accentColor: accent) {
            VStack(alignment: .leading, spacing: GenSpacing.sm) {
                durationRow("Flow", minutes: plan.flowSec / 60, options: [15, 20, 25, 30, 45, 50, 60, 90]) {
                    plan.flowSec = $0 * 60
                    save()
                }
                durationRow("Short break", minutes: plan.shortBreakSec / 60, options: [5, 10]) {
                    plan.shortBreakSec = $0 * 60
                    save()
                }
                durationRow("Long break", minutes: plan.longBreakSec / 60, options: [15, 20, 30]) {
                    plan.longBreakSec = $0 * 60
                    save()
                }
                stepperRow("Flows per cycle", value: plan.cycleLength, range: 1 ... 10) {
                    plan.cycleLength = $0
                    save()
                }
                toggleRow("Start breaks automatically",
                          "A finished flow rolls straight into its break.",
                          isOn: plan.autoStartBreaks) { plan.autoStartBreaks = $0; save() }
                toggleRow("Start flows automatically",
                          "A finished break rolls straight into the next flow.",
                          isOn: plan.autoStartFlows) { plan.autoStartFlows = $0; save() }
                toggleRow("Allow overrun",
                          "A flow that hits zero keeps counting up instead of ending.",
                          isOn: plan.allowOverrun) { plan.allowOverrun = $0; save() }
                toggleRow("Do Not Disturb while flowing",
                          "Uses the same Focus snapshot and restore the voice mode uses.",
                          isOn: plan.dndWhileFlowing) { plan.dndWhileFlowing = $0; save() }
                chimeRow
                pickerRow("Pause when idle", selection: String(plan.idlePauseSec),
                          options: [("0", "off"), ("60", "1 min"), ("120", "2 min"), ("300", "5 min")],
                          explanation: "A flow with no keyboard or mouse input this long pauses itself. Breaks never do.") {
                    plan.idlePauseSec = Int($0) ?? 0
                    save()
                }
                toggleRow("Resume when you are back",
                          "The first key or mouse move restarts a flow that paused itself. A pause you pressed stays paused.",
                          isOn: plan.resumeOnActivity) { plan.resumeOnActivity = $0; save() }
                pickerRow("Nudge when stopped", selection: String(plan.nudgeEverySec),
                          options: [("0", "off"), ("300", "5 min"), ("600", "10 min"), ("1800", "30 min")],
                          explanation: "Typing while no flow runs blinks the timer and plays a soft chime, at most this often.") {
                    plan.nudgeEverySec = Int($0) ?? 0
                    save()
                }
                hudStyleRow
            }
        }
    }

    /// The sound a phase boundary makes. Picking one plays it: a chime you cannot hear before
    /// committing to it is a preference chosen blind.
    private var chimeRow: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text("Phase chime")
                    .font(GenTypography.body(13))
                    .foregroundStyle(Color.settingsText)
                Spacer()
                Menu(plan.sound == "off" ? "silent" : plan.sound) {
                    Button("silent") { plan.sound = "off"; save() }
                    Divider()
                    ForEach(FocusChime.available, id: \.self) { name in
                        Button(name) {
                            plan.sound = name
                            FocusChime.preview(name)
                            save()
                        }
                    }
                } primaryAction: {
                    FocusChime.preview(plan.sound)
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .genHoverEffect(accent: accent)
                .accessibilityIdentifier("settings-focus-sound")
                .instantTooltip("Click to hear this chime, arrow to pick another")
            }
            Text("Plays at every phase boundary, with a notification carrying the same sentence. Click the name to hear it.")
                .font(GenTypography.caption(10))
                .foregroundStyle(Color.settingsTextMuted)
        }
    }

    /// Shape of the always-on-top timer window, mirrored from the HUD's own menu so the two
    /// cannot disagree about which shape is current.
    private var hudStyleRow: some View {
        pickerRow("Timer window", selection: hudStyle.rawValue,
                  options: [("full", "full"), ("compact", "compact")],
                  explanation: "Compact is the small pill: phase, clock and one button. Double-click either shape to open Focus Studio.") {
            let style = FocusHUDStyle(rawValue: $0) ?? .full
            hudStyle = style
            FocusController.shared.setHUDStyle(style)
        }
    }

    private var captureCard: some View {
        SettingsCard(icon: "record.circle", title: "CAPTURE", accentColor: .neonCyan) {
            VStack(alignment: .leading, spacing: GenSpacing.sm) {
                toggleRow("Record desktop activity",
                          "Which app, window and site had focus, plus keystroke counts. Never their content.",
                          isOn: settings.captureEnabled) { settings.captureEnabled = $0; save() }
                pickerRow("Window titles", selection: settings.titleMode.rawValue,
                          options: [("full", "full"), ("app-only", "app only"), ("hashed", "hashed")],
                          explanation: "Hashed keeps switch counts honest while making the title unreadable.") {
                    settings.titleMode = FocusSettings.TitleMode(rawValue: $0) ?? .full
                    save()
                }
                pickerRow("Browser addresses", selection: settings.urlMode.rawValue,
                          options: [("off", "off"), ("host", "host"), ("host+path", "host and path")],
                          explanation: "Private windows never record an address, whatever this says.") {
                    settings.urlMode = FocusSettings.URLMode(rawValue: $0) ?? .host
                    save()
                }
                stepperRow("Idle after (seconds)", value: settings.idleThresholdSec, range: 30 ... 900, step: 30) {
                    settings.idleThresholdSec = $0
                    save()
                }
                pickerRow("Menu bar", selection: settings.menuBarStyle,
                          options: [("time", "countdown"), ("dot", "dot only"), ("off", "hidden")],
                          explanation: "Takes effect on the next launch.") {
                    settings.menuBarStyle = $0
                    save()
                }
            }
        }
    }

    private var privacyCard: some View {
        SettingsCard(icon: "hand.raised", title: "PRIVACY", accentColor: .neonPurple) {
            VStack(alignment: .leading, spacing: GenSpacing.sm) {
                SettingsInfoRow(label: "Ledger", value: ActivityStore.defaultPath)
                Text("Local file, mode 0600, never sent anywhere. Password managers are excluded before you configure anything.")
                    .font(GenTypography.caption(10))
                    .foregroundStyle(Color.settingsTextMuted)

                if !settings.excludedBundles.isEmpty {
                    Text("Excluded apps")
                        .font(GenTypography.caption(10, weight: .semibold))
                        .foregroundStyle(Color.settingsTextSecondary)
                    FlowingTags(items: settings.excludedBundles.sorted())
                }
                if !settings.excludedHosts.isEmpty {
                    Text("Excluded sites")
                        .font(GenTypography.caption(10, weight: .semibold))
                        .foregroundStyle(Color.settingsTextSecondary)
                    FlowingTags(items: settings.excludedHosts.sorted())
                }
                Text("Delete a range with: genesis focus forget --since 7d")
                    .font(GenTypography.mono(10))
                    .foregroundStyle(Color.settingsTextMuted)
            }
        }
    }

    private var projectsCard: some View {
        SettingsCard(icon: "folder", title: "PROJECTS", accentColor: .genSuccess) {
            VStack(alignment: .leading, spacing: GenSpacing.xs) {
                if settings.projects.isEmpty {
                    Text("No rules yet. A rule matches a cmux session, a window title fragment, or a host, in that order, and the first match wins.")
                        .font(GenTypography.caption(11))
                        .foregroundStyle(Color.settingsTextSecondary)
                    Text(#"Add them under app.focus.projects in ~/.genesis/client.json, e.g. {"name":"Example project","cmuxSession":"project-"}"#)
                        .font(GenTypography.mono(10))
                        .foregroundStyle(Color.settingsTextMuted)
                } else {
                    ForEach(settings.projects, id: \.name) { rule in
                        HStack(spacing: GenSpacing.sm) {
                            TagPill(text: rule.name, color: .genSuccess)
                            Text(ruleDescription(rule))
                                .font(GenTypography.mono(10))
                                .foregroundStyle(Color.settingsTextMuted)
                                .lineLimit(1)
                            Spacer()
                        }
                    }
                }
            }
        }
    }

    // MARK: - Rows

    private func toggleRow(_ title: String, _ subtitle: String, isOn: Bool,
                           set: @escaping (Bool) -> Void) -> some View {
        SettingsToggleRow(title: title, subtitle: subtitle,
                          isOn: Binding(get: { isOn }, set: set), accent: accent)
    }

    private func durationRow(_ title: String, minutes: Int, options: [Int],
                             set: @escaping (Int) -> Void) -> some View {
        HStack {
            Text(title)
                .font(GenTypography.body(13))
                .foregroundStyle(Color.settingsText)
            Spacer()
            ForEach(options, id: \.self) { option in
                Button {
                    set(option)
                } label: {
                    Text("\(option)")
                        .font(GenTypography.mono(11))
                        .foregroundStyle(option == minutes ? Color.genBackground : Color.settingsTextSecondary)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(option == minutes ? accent : Color.white.opacity(0.06)))
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip("Set \(title.lowercased()) to \(option) minutes")
            }
        }
    }

    private func stepperRow(_ title: String, value: Int, range: ClosedRange<Int>, step: Int = 1,
                            set: @escaping (Int) -> Void) -> some View {
        HStack {
            Text(title)
                .font(GenTypography.body(13))
                .foregroundStyle(Color.settingsText)
            Spacer()
            Stepper(value: Binding(get: { value }, set: set), in: range, step: step) {
                Text("\(value)")
                    .font(GenTypography.mono(12))
                    .foregroundStyle(Color.settingsTextSecondary)
            }
            .fixedSize()
        }
    }

    private func pickerRow(_ title: String, selection: String, options: [(String, String)],
                           explanation: String, set: @escaping (String) -> Void) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(title)
                    .font(GenTypography.body(13))
                    .foregroundStyle(Color.settingsText)
                Spacer()
                Picker("", selection: Binding(get: { selection }, set: set)) {
                    ForEach(options, id: \.0) { option in Text(option.1).tag(option.0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
            }
            Text(explanation)
                .font(GenTypography.caption(10))
                .foregroundStyle(Color.settingsTextMuted)
        }
    }

    private func ruleDescription(_ rule: FocusSettings.ProjectRule) -> String {
        if let value = rule.cmuxSession { return "cmux contains \(value)" }
        if let value = rule.titleContains { return "title contains \(value)" }
        if let value = rule.host { return "host is \(value)" }
        return "no condition"
    }

    // MARK: - Persistence

    private func load() {
        let app = FlowFocusConfiguration.shared.app
        settings = FocusSettings.from(appConfig: app)
        plan = PomodoroPlan.from(appConfig: app)
        hudStyle = FocusHUDWindowController.savedStyle
    }

    /// Commits on change rather than on every keystroke: these are toggles and pickers, not
    /// text fields, so each write is one deliberate act. `ConfigStore.mutate` is a locked,
    /// synchronous disk write — never call it from a continuously changing value.
    private func save() {
        FlowFocusConfiguration.shared.updateFocus(settings: settings, plan: plan)
        FocusController.shared.apply(appConfig: FlowFocusConfiguration.shared.app)
    }
}

/// Wrapping row of small tags, for the exclusion lists.
public struct FlowingTags: View {
    public let items: [String]

    public var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(items, id: \.self) { item in
                Text(item)
                    .font(GenTypography.mono(10))
                    .foregroundStyle(Color.settingsTextSecondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Color.white.opacity(0.06)))
            }
        }
    }
}
