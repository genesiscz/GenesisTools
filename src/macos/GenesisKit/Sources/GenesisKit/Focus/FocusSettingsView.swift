// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Focus/FocusSettingsView.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import AppKit
import SwiftUI

/// Settings → Focus, in the shared native settings style.
///
/// Every stored Focus key has a control here: the timer, capture, retention, the exclusion lists and the project
/// rules. Each row explains its consequence in one line; a switch whose effect is invisible is a bug, not a preference.
/// Edits commit on change through `FlowFocusConfiguration.updateFocus`, which writes off the main thread.
public struct FocusSettingsView: View {
    @MainActor
    public init(controller: FocusController? = nil, configuration: FlowFocusConfiguration? = nil) {
        self.controller = controller ?? .shared
        self.configuration = configuration ?? controller?.configuration ?? .shared
    }

    @ObservedObject private var controller: FocusController
    @ObservedObject private var configuration: FlowFocusConfiguration
    @State private var settings = FocusSettings()
    @State private var plan = PomodoroPlan()
    @State private var hudStyle = FocusHUDWindowController.savedStyle
    @State private var newHost = ""
    @State private var forgetRange = FocusForgetRange.lastHour
    @State private var confirmForget = false
    @State private var forgetting = false
    @State private var notice: FocusSettingsNotice?
    @State private var editor: FocusRuleEditor?

    public var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let error = configuration.lastError {
                NoticePill(text: error, isError: true, dismiss: configuration.dismissError)
            }
            if !controller.available {
                NativeSettingsCard("Focus is off") {
                    Text(controller.lastError ?? "The activity ledger could not be opened, so nothing is being recorded.")
                        .font(.system(size: 12)).foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            timerCard
            alertsCard
            captureCard
            privacyCard
            excludedAppsCard
            excludedSitesCard
            projectsCard
        }
        .onAppear(perform: load)
        .onChange(of: configuration.revision) { _, _ in load() }
        .confirmationDialog(
            "Delete activity from \(forgetRange.phrase)?", isPresented: $confirmForget, titleVisibility: .visible
        ) {
            Button("Delete activity", role: .destructive) { forget() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Window titles, sites, input counts and Focus sessions recorded in that period are removed from this Mac. This cannot be undone.")
        }
        // `.contain` first: on a plain VStack a bare identifier propagates to every child and clobbers their own ids.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("settings-focus")
    }

    // MARK: - Timer

    private var timerCard: some View {
        NativeSettingsCard("Timer", subtitle: "The length of each phase and how one leads into the next.") {
            minutesRow("Flow", detail: "One focused stretch of work.", seconds: plan.flowSec,
                       options: [15, 20, 25, 30, 45, 50, 60, 90], identifier: "focus.flow") { plan.flowSec = $0; save() }
            Divider()
            minutesRow("Short break", detail: "The break after each flow.", seconds: plan.shortBreakSec,
                       options: [3, 5, 10, 15], identifier: "focus.shortBreak") { plan.shortBreakSec = $0; save() }
            Divider()
            minutesRow("Long break", detail: "The break at the end of a cycle.", seconds: plan.longBreakSec,
                       options: [10, 15, 20, 30, 45], identifier: "focus.longBreak") { plan.longBreakSec = $0; save() }
            Divider()
            NativeSettingsRow("Flows per cycle", detail: "A long break follows this many flows.") {
                Stepper(value: Binding(get: { plan.cycleLength }, set: { plan.cycleLength = $0; save() }), in: 1 ... 10) {
                    Text(verbatim: "\(plan.cycleLength)").monospacedDigit().font(.system(size: 13, weight: .medium))
                        .frame(minWidth: 18, alignment: .trailing)
                }
                .fixedSize()
                .accessibilityLabel("Flows per cycle")
                .accessibilityIdentifier("focus.cycleLength")
            }
            Divider()
            toggle("Start breaks automatically", "A finished flow rolls straight into its break.", "focus.autoStartBreaks",
                   isOn: plan.autoStartBreaks) { plan.autoStartBreaks = $0 }
            Divider()
            toggle("Start flows automatically", "A finished break rolls straight into the next flow.", "focus.autoStartFlows",
                   isOn: plan.autoStartFlows) { plan.autoStartFlows = $0 }
            Divider()
            toggle("Allow overrun", "A flow that reaches zero keeps counting up instead of ending.", "focus.allowOverrun",
                   isOn: plan.allowOverrun) { plan.allowOverrun = $0 }
        }
    }

    private var alertsCard: some View {
        NativeSettingsCard("Alerts and idle time", subtitle: "What happens at a phase boundary and while you are away.") {
            toggle("Do Not Disturb while flowing", "Turns on Do Not Disturb for each flow and restores your setting after it.",
                   "focus.dnd", isOn: plan.dndWhileFlowing) { plan.dndWhileFlowing = $0 }
            Divider()
            NativeSettingsRow("Phase chime", detail: "Plays at every phase boundary, with a notification carrying the same sentence.") {
                HStack(spacing: 8) {
                    Picker("Phase chime", selection: Binding(get: { plan.sound }, set: { name in
                        plan.sound = name
                        if name != "off" { FocusChime.preview(name) }
                        save()
                    })) {
                        Text("Silent").tag("off")
                        Divider()
                        ForEach(chimeOptions, id: \.self) { Text($0).tag($0) }
                    }
                    .labelsHidden().fixedSize()
                    .accessibilityIdentifier("settings-focus-sound")
                    IconButton(systemName: "play.fill", tooltip: "Play the phase chime") { FocusChime.preview(plan.sound) }
                        .disabled(plan.sound == "off")
                }
            }
            Divider()
            secondsRow("Pause when idle", detail: "A flow with no keyboard or mouse input this long pauses itself. Breaks never do.",
                       seconds: plan.idlePauseSec, options: [0, 60, 120, 300], identifier: "focus.idlePause") {
                plan.idlePauseSec = $0
                save()
            }
            Divider()
            toggle("Resume when you are back", "The first key or mouse move restarts a flow that paused itself. A pause you pressed stays paused.",
                   "focus.resumeOnActivity", isOn: plan.resumeOnActivity) { plan.resumeOnActivity = $0 }
            Divider()
            secondsRow("Nudge when stopped", detail: "Typing while no flow runs blinks the timer and plays a soft chime, at most this often.",
                       seconds: plan.nudgeEverySec, options: [0, 300, 600, 1_800], identifier: "focus.nudge") {
                plan.nudgeEverySec = $0
                save()
            }
            Divider()
            NativeSettingsRow("Timer window", detail: "Compact is the small pill: phase, clock and one button. Double-click either shape to open Focus Studio.") {
                Picker("Timer window", selection: Binding(get: { hudStyle }, set: { style in
                    hudStyle = style
                    controller.setHUDStyle(style)
                })) {
                    Text("Full").tag(FocusHUDStyle.full)
                    Text("Compact").tag(FocusHUDStyle.compact)
                }
                .labelsHidden().pickerStyle(.segmented).fixedSize()
                .accessibilityIdentifier("focus.hudStyle")
            }
        }
    }

    private var chimeOptions: [String] {
        FocusChime.available.contains(plan.sound) || plan.sound == "off" ? FocusChime.available : FocusChime.available + [plan.sound]
    }

    // MARK: - Capture

    private var captureCard: some View {
        NativeSettingsCard("Capture", subtitle: "What the activity ledger records: which app, window and site had focus, and keystroke counts. Never what you type.") {
            toggle("Record desktop activity", "Turn off to stop recording. The timer keeps working.", "focus.captureEnabled",
                   isOn: settings.captureEnabled) { settings.captureEnabled = $0 }
            Divider()
            NativeSettingsRow("Window titles", detail: "Hashed keeps switch counts honest while making the title unreadable.") {
                Picker("Window titles", selection: Binding(get: { settings.titleMode }, set: { settings.titleMode = $0; save() })) {
                    Text("Full").tag(FocusSettings.TitleMode.full)
                    Text("App only").tag(FocusSettings.TitleMode.appOnly)
                    Text("Hashed").tag(FocusSettings.TitleMode.hashed)
                }
                .labelsHidden().pickerStyle(.segmented).fixedSize()
                .accessibilityIdentifier("focus.titleMode")
            }
            Divider()
            NativeSettingsRow("Browser addresses", detail: "Private windows never record an address, whatever this says.") {
                Picker("Browser addresses", selection: Binding(get: { settings.urlMode }, set: { settings.urlMode = $0; save() })) {
                    Text("Off").tag(FocusSettings.URLMode.off)
                    Text("Site").tag(FocusSettings.URLMode.host)
                    Text("Site and path").tag(FocusSettings.URLMode.hostPath)
                }
                .labelsHidden().pickerStyle(.segmented).fixedSize()
                .accessibilityIdentifier("focus.urlMode")
            }
            Divider()
            secondsRow("Idle after", detail: "No keyboard or mouse input for this long marks you as away.",
                       seconds: settings.idleThresholdSec, options: [30, 60, 120, 180, 300, 600, 900], identifier: "focus.idleThreshold") {
                settings.idleThresholdSec = $0
                save()
            }
            Divider()
            secondsRow("Interruption after", detail: "Leaving the app a flow started in for this long counts as one interruption.",
                       seconds: settings.interruptionThresholdSec, options: [15, 30, 45, 60, 120, 300], identifier: "focus.interruption") {
                settings.interruptionThresholdSec = $0
                save()
            }
            Divider()
            NativeSettingsRow("Menu bar", detail: "Takes effect the next time Focus starts.") {
                Picker("Menu bar", selection: Binding(get: { settings.menuBarStyle }, set: { settings.menuBarStyle = $0; save() })) {
                    Text("Countdown").tag("time")
                    Text("Dot only").tag("dot")
                    Text("Hidden").tag("off")
                }
                .labelsHidden().pickerStyle(.segmented).fixedSize()
                .accessibilityIdentifier("focus.menuBar")
            }
        }
    }

    // MARK: - Privacy

    private var privacyCard: some View {
        NativeSettingsCard("Privacy", subtitle: "The ledger is a local file only you can read (mode 0600). Nothing in it is sent anywhere.") {
            NativeSettingsRow("Activity ledger") {
                PathLabel(path: controller.store?.dbPath ?? ActivityStore.defaultPath)
                    .lineLimit(1).truncationMode(.middle)
                    .frame(maxWidth: 320, alignment: .trailing)
            }
            Divider()
            NativeSettingsRow("Keep activity for", detail: "Older activity is deleted automatically, at start and once a day.") {
                Picker("Keep activity for", selection: Binding(get: { settings.retentionDays }, set: { settings.retentionDays = $0; save() })) {
                    ForEach(FocusRetention.options(including: settings.retentionDays), id: \.self) { days in
                        Text(FocusRetention.label(days)).tag(days)
                    }
                }
                .labelsHidden().fixedSize()
                .accessibilityIdentifier("focus.retention")
            }
            Divider()
            NativeSettingsRow("Delete activity", detail: "Removes window titles, sites, input counts and sessions recorded in the chosen period.") {
                HStack(spacing: 8) {
                    Picker("Period to delete", selection: $forgetRange) {
                        ForEach(FocusForgetRange.allCases) { Text($0.title).tag($0) }
                    }
                    .labelsHidden().fixedSize()
                    .accessibilityIdentifier("focus.forget.range")
                    Button(forgetting ? "Deleting…" : "Delete…") { confirmForget = true }
                        .buttonStyle(.bordered)
                        .disabled(forgetting || !controller.available)
                        .nativeSettingsPointer()
                        .accessibilityIdentifier("focus.forget")
                }
            }
            if let notice {
                NoticePill(text: notice.text, isError: notice.isError) { self.notice = nil }
            }
        }
    }

    private func forget() {
        let range = forgetRange
        let now = Date()
        forgetting = true
        notice = nil
        Task { @MainActor in
            defer { forgetting = false }
            do {
                // One second past now, so the segment the recorder is writing at this moment is included.
                let result = try await controller.forgetActivity(from: range.start(now: now), to: now.addingTimeInterval(1))
                notice = FocusSettingsNotice(text: FocusForgetRange.summary(result), isError: false)
            } catch {
                notice = FocusSettingsNotice(text: "Activity was not deleted: \(error.localizedDescription)", isError: true)
            }
        }
    }

    // MARK: - Exclusions

    private var userExcludedBundles: [String] {
        settings.excludedBundles.subtracting(FocusSettings.defaultExcludedBundles).sorted()
    }

    private var excludedAppsCard: some View {
        NativeSettingsCard("Excluded apps", subtitle: "Nothing is recorded while one of these apps is in front: no title, no address and no input counts.") {
            if userExcludedBundles.isEmpty {
                Text("You have not excluded any apps.").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            ForEach(userExcludedBundles, id: \.self) { bundleID in
                NativeSettingsApplicationRow(bundleID: bundleID) {
                    settings.excludedBundles.remove(bundleID)
                    save()
                }
            }
            Text("Password managers are always excluded: 1Password, Keychain Access and Bitwarden.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Add application…", action: addApplication)
                .buttonStyle(.bordered)
                .nativeSettingsPointer()
                .accessibilityIdentifier("focus.excludedApps.add")
        }
    }

    private func addApplication() {
        let panel = NSOpenPanel()
        panel.title = "Exclude an application from Focus"
        panel.prompt = "Exclude"
        panel.directoryURL = URL(fileURLWithPath: "/Applications", isDirectory: true)
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.applicationBundle]
        panel.begin { response in
            MainActor.assumeIsolated {
                guard response == .OK, let url = panel.url else { return }
                guard let bundleID = Bundle(url: url)?.bundleIdentifier else {
                    notice = FocusSettingsNotice(text: "\(url.lastPathComponent) has no bundle identifier, so it cannot be excluded.", isError: true)
                    return
                }
                guard settings.excludedBundles.insert(bundleID).inserted else { return }
                save()
            }
        }
    }

    private var excludedSitesCard: some View {
        NativeSettingsCard("Excluded sites", subtitle: "No address on these sites or their subdomains is recorded.") {
            if settings.excludedHosts.isEmpty {
                Text("You have not excluded any sites.").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            ForEach(settings.excludedHosts.sorted(), id: \.self) { host in
                HStack(spacing: 12) {
                    Image(systemName: "globe").font(.system(size: 14)).foregroundStyle(.secondary).frame(width: 32)
                    Text(host).font(.system(size: 13, weight: .medium)).textSelection(.enabled)
                    Spacer(minLength: 0)
                    IconButton(systemName: "minus.circle", tooltip: "Remove \(host)") {
                        settings.excludedHosts.remove(host)
                        save()
                    }
                }
                .padding(.vertical, 3)
            }
            HStack(spacing: 8) {
                TextField("example.com", text: $newHost)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 260)
                    .onSubmit(addHost)
                    .accessibilityLabel("Site to exclude")
                    .accessibilityIdentifier("focus.excludedSites.field")
                Button("Add site", action: addHost)
                    .buttonStyle(.bordered)
                    .disabled(FocusSettings.normalizedHost(newHost) == nil)
                    .nativeSettingsPointer()
                    .accessibilityIdentifier("focus.excludedSites.add")
            }
            if !newHost.trimmingCharacters(in: .whitespaces).isEmpty, FocusSettings.normalizedHost(newHost) == nil {
                Text("Enter a site name such as example.com.").font(.system(size: 11)).foregroundStyle(.orange)
            }
        }
    }

    private func addHost() {
        guard let host = FocusSettings.normalizedHost(newHost) else { return }
        newHost = ""
        guard settings.excludedHosts.insert(host).inserted else { return }
        save()
    }

    // MARK: - Projects

    private struct RuleRow: Identifiable {
        let id: String
        let index: Int
        let rule: FocusSettings.ProjectRule
    }

    /// Rules are positional (the first match wins), so the row identity is the name, made unique for a hand-edited
    /// file that repeats one. The editor itself refuses a duplicate name.
    private var ruleRows: [RuleRow] {
        var seen: [String: Int] = [:]
        return settings.projects.enumerated().map { index, rule in
            let count = seen[rule.name, default: 0]
            seen[rule.name] = count + 1
            return RuleRow(id: count == 0 ? rule.name : "\(rule.name)#\(count)", index: index, rule: rule)
        }
    }

    private var projectsCard: some View {
        NativeSettingsCard("Projects", subtitle: "A rule names the project for the activity it matches. cmux sessions are checked first, then window titles, then sites; the first matching rule wins.") {
            if settings.projects.isEmpty && editor == nil {
                Text("No rules yet. Activity no rule matches shows as unattributed in Focus Studio.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(ruleRows) { row in
                ruleRow(row)
                if editor?.index == row.index { ruleEditor }
            }
            if editor != nil && editor?.index == nil {
                ruleEditor
            } else if editor == nil {
                Button("Add rule") { editor = FocusRuleEditor() }
                    .buttonStyle(.bordered)
                    .nativeSettingsPointer()
                    .accessibilityIdentifier("focus.projects.add")
            }
        }
    }

    private func ruleRow(_ row: RuleRow) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(row.rule.name).font(.system(size: 13, weight: .medium))
                Text(Self.ruleDescription(row.rule)).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 0)
            IconButton(systemName: "arrow.up", tooltip: "Check \(row.rule.name) earlier") { moveRule(row.index, by: -1) }
                .disabled(row.index == 0)
            IconButton(systemName: "arrow.down", tooltip: "Check \(row.rule.name) later") { moveRule(row.index, by: 1) }
                .disabled(row.index == settings.projects.count - 1)
            IconButton(systemName: "pencil", tooltip: "Edit \(row.rule.name)") { editor = FocusRuleEditor(index: row.index, rule: row.rule) }
            IconButton(systemName: "minus.circle", tooltip: "Remove \(row.rule.name)") {
                if editor?.index == row.index { editor = nil }
                settings.projects.remove(at: row.index)
                save()
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("focus.projects.rule.\(row.rule.name)")
    }

    private var ruleEditor: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(editor?.index == nil ? "New rule" : "Edit rule").font(.system(size: 12, weight: .semibold))
            editorField("Project name", text: binding(\.name), prompt: "Example project", identifier: "focus.rule.name")
            editorField("cmux session contains", text: binding(\.cmuxSession), prompt: "project-", identifier: "focus.rule.cmux")
            editorField("Window title contains", text: binding(\.titleContains), prompt: "Example project", identifier: "focus.rule.title")
            editorField("Site", text: binding(\.host), prompt: "example.com", identifier: "focus.rule.host")
            if let error = editor?.error {
                Text(error).font(.system(size: 11)).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button("Cancel") { editor = nil }
                    .keyboardShortcut(.cancelAction)
                    .nativeSettingsPointer()
                Button(editor?.index == nil ? "Add rule" : "Save rule", action: commitRule)
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .nativeSettingsPointer()
                    .accessibilityIdentifier("focus.rule.save")
            }
        }
        .padding(14)
        .background(.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(.white.opacity(0.08), lineWidth: 0.5))
    }

    private func editorField(_ title: String, text: Binding<String>, prompt: String, identifier: String) -> some View {
        HStack(spacing: 12) {
            Text(title).font(.system(size: 12)).frame(width: 160, alignment: .leading)
            TextField(prompt, text: text)
                .textFieldStyle(.roundedBorder)
                .onSubmit(commitRule)
                .accessibilityLabel(title)
                .accessibilityIdentifier(identifier)
        }
    }

    private func binding(_ path: WritableKeyPath<FocusRuleEditor, String>) -> Binding<String> {
        Binding(get: { editor?[keyPath: path] ?? "" }, set: { value in
            editor?[keyPath: path] = value
            editor?.error = nil
        })
    }

    private func commitRule() {
        guard let draft = editor else { return }
        let others = settings.projects.enumerated().filter { $0.offset != draft.index }.map(\.element.name)
        do {
            let rule = try FocusSettings.ProjectRule.validated(
                name: draft.name, cmuxSession: draft.cmuxSession, titleContains: draft.titleContains,
                host: draft.host, existingNames: others)
            if let index = draft.index, settings.projects.indices.contains(index) {
                settings.projects[index] = rule
            } else {
                settings.projects.append(rule)
            }
            editor = nil
            save()
        } catch {
            editor?.error = error.localizedDescription
        }
    }

    private func moveRule(_ index: Int, by offset: Int) {
        let target = index + offset
        guard settings.projects.indices.contains(index), settings.projects.indices.contains(target) else { return }
        settings.projects.swapAt(index, target)
        if editor?.index == index { editor?.index = target } else if editor?.index == target { editor?.index = index }
        save()
    }

    static func ruleDescription(_ rule: FocusSettings.ProjectRule) -> String {
        var parts: [String] = []
        if let value = rule.cmuxSession { parts.append("cmux session contains “\(value)”") }
        if let value = rule.titleContains { parts.append("window title contains “\(value)”") }
        if let value = rule.host { parts.append("site is \(value)") }
        return parts.isEmpty ? "No condition" : parts.joined(separator: " · ")
    }

    // MARK: - Rows

    private func toggle(_ title: String, _ detail: String, _ identifier: String, isOn: Bool,
                        set: @escaping (Bool) -> Void) -> some View {
        NativeSettingsToggle(title, detail: detail, identifier: identifier, isOn: Binding(get: { isOn }, set: { value in
            set(value)
            save()
        }))
    }

    private func minutesRow(_ title: String, detail: String, seconds: Int, options: [Int], identifier: String,
                            set: @escaping (Int) -> Void) -> some View {
        let minutes = seconds / 60
        let values = options.contains(minutes) ? options : (options + [minutes]).sorted()
        return NativeSettingsRow(title, detail: detail) {
            Picker(title, selection: Binding(get: { minutes }, set: { set($0 * 60) })) {
                ForEach(values, id: \.self) { Text("\($0) min").tag($0) }
            }
            .labelsHidden().fixedSize()
            .accessibilityIdentifier(identifier)
        }
    }

    private func secondsRow(_ title: String, detail: String, seconds: Int, options: [Int], identifier: String,
                            set: @escaping (Int) -> Void) -> some View {
        let values = options.contains(seconds) ? options : (options + [seconds]).sorted()
        return NativeSettingsRow(title, detail: detail) {
            Picker(title, selection: Binding(get: { seconds }, set: set)) {
                ForEach(values, id: \.self) { Text(FocusRetention.duration(seconds: $0)).tag($0) }
            }
            .labelsHidden().fixedSize()
            .accessibilityIdentifier(identifier)
        }
    }

    // MARK: - Persistence

    private func load() {
        let app = configuration.app
        settings = FocusSettings.from(appConfig: app)
        plan = PomodoroPlan.from(appConfig: app)
        hudStyle = FocusHUDWindowController.savedStyle
    }

    /// Commits on change rather than on every keystroke: these are switches, pickers and list edits, each one
    /// deliberate act. The write itself runs off the main thread (`FlowFocusConfiguration.applyPatch`).
    private func save() {
        configuration.updateFocus(settings: settings, plan: plan)
        controller.apply(appConfig: configuration.app)
    }
}

private struct FocusSettingsNotice: Equatable {
    let text: String
    let isError: Bool
}

/// The project rule being added (`index` nil) or edited.
private struct FocusRuleEditor: Equatable {
    var index: Int?
    var name = ""
    var cmuxSession = ""
    var titleContains = ""
    var host = ""
    var error: String?

    init() {}

    init(index: Int, rule: FocusSettings.ProjectRule) {
        self.index = index
        name = rule.name
        cmuxSession = rule.cmuxSession ?? ""
        titleContains = rule.titleContains ?? ""
        host = rule.host ?? ""
    }
}

/// The periods "Delete activity" offers.
enum FocusForgetRange: String, CaseIterable, Identifiable {
    case lastHour, lastDay, lastWeek, lastMonth, everything

    var id: String { rawValue }

    var title: String {
        switch self {
        case .lastHour: return "The last hour"
        case .lastDay: return "The last 24 hours"
        case .lastWeek: return "The last 7 days"
        case .lastMonth: return "The last 30 days"
        case .everything: return "All time"
        }
    }

    /// The same period inside a sentence ("Delete activity from the last hour?").
    var phrase: String { self == .everything ? "all time" : title.prefix(1).lowercased() + title.dropFirst() }

    func start(now: Date) -> Date {
        switch self {
        case .lastHour: return now.addingTimeInterval(-3_600)
        case .lastDay: return now.addingTimeInterval(-86_400)
        case .lastWeek: return now.addingTimeInterval(-7 * 86_400)
        case .lastMonth: return now.addingTimeInterval(-30 * 86_400)
        case .everything: return Date(timeIntervalSince1970: 0)
        }
    }

    static func summary(_ result: FocusForgetResult) -> String {
        if result.segments == 0 && result.sessions == 0 { return "Nothing was recorded in that period." }
        let segments = result.segments == 1 ? "1 activity record" : "\(result.segments) activity records"
        let sessions = result.sessions == 1 ? "1 session" : "\(result.sessions) sessions"
        return "Deleted \(segments) and \(sessions)."
    }
}

/// Labels for the retention and duration pickers.
enum FocusRetention {
    static let presets = [7, 30, 90, 180, 365, 730, 1_825, 36_500]

    static func options(including days: Int) -> [Int] {
        presets.contains(days) ? presets : (presets + [days]).sorted()
    }

    static func label(_ days: Int) -> String {
        switch days {
        case 36_500: return "100 years"
        case 365: return "1 year"
        case 730: return "2 years"
        case 1_825: return "5 years"
        case 180: return "6 months"
        case 1: return "1 day"
        default: return "\(days) days"
        }
    }

    static func duration(seconds: Int) -> String {
        if seconds == 0 { return "Off" }
        if seconds % 60 == 0 { return "\(seconds / 60) min" }
        return "\(seconds) s"
    }
}
