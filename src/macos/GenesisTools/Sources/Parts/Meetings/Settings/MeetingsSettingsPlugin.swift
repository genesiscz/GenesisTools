import SwiftUI

/// The meetings part in the feature settings window: Recording, Projects, Dictionary and Window. Added by the
/// executable (Sources/GenesisTools/Parts.swift); it knows no other part.
@MainActor
package final class MeetingsSettingsPlugin: FeatureSettingsPlugin {
    private var model: MeetingsSettingsModel?

    package init() {}

    package func install(in host: FeatureSettingsPluginHost) {
        let model = MeetingsSettingsModel(writes: host.mode != .snapshot)
        self.model = model
        // A snapshot reads at once and waits for it; the live window reads when a Meetings page first shows, so
        // opening Settings for another page starts no meetings command.
        if host.mode == .snapshot { model.load() }
        host.register(section: MeetingsSettingsPages.section(model: model, defaults: host.defaults))
    }

    package func settingsReady(page: String?) -> Bool {
        guard let page, page.hasPrefix("meetings.") else { return true }
        // The Window page shows the engine's clip and tone from the config: a snapshot waits for that read only.
        if page == MeetingsSettingsPages.windowPage {
            guard let model else { return true }
            return model.settings.value != nil || model.settings.failure != nil
        }
        return model?.settled ?? true
    }

    package func settingsReopened() {
        model?.reloadRead()
    }
}

/// A language code as its English name ("cs" is "Czech"), for the sentences that name the meeting language.
enum MeetingsLanguage {
    static func name(_ code: String) -> String {
        Locale(identifier: "en").localizedString(forLanguageCode: code) ?? code
    }
}

@MainActor
enum MeetingsSettingsPages {
    static let recordingPage = "meetings.recording"
    static let projectsPage = "meetings.projects"
    static let dictionaryPage = "meetings.dictionary"
    static let windowPage = "meetings.window"
    /// The card on the Window page that picks where a transcript time plays.
    static let playbackAnchor = "playback"
    /// The card on the Window page that sets how long notices stay and where they float.
    static let noticesAnchor = "notices"
    /// The Window page's card for a side panel section: the section's id ("rows", "panes", "engine"), and the two
    /// older anchors for playback and notices, so a link written before the panel still lands on its card.
    static func anchor(forSection id: String) -> String {
        switch id {
        case "playback": return playbackAnchor
        case "notices": return noticesAnchor
        default: return id
        }
    }

    static func section(model: MeetingsSettingsModel, defaults: UserDefaults) -> NativeSettingsSection {
        NativeSettingsSection(id: "meetings", title: "Meetings", pages: [
            NativeSettingsPage(id: recordingPage, title: "Recording", symbol: "record.circle", tint: .red,
                               subtitle: "When the screen is recorded with a meeting, how often, and what it costs.") {
                MeetingsRecordingPage(model: model)
            },
            NativeSettingsPage(id: projectsPage, title: "Projects", symbol: "folder", tint: .blue,
                               subtitle: "How a meeting finds its project: rules, labels, paired people and the export folder.") {
                MeetingsProjectsPage(model: model)
            },
            NativeSettingsPage(id: dictionaryPage, title: "Dictionary", symbol: "character.book.closed", tint: .orange,
                               subtitle: "Words a transcript gets wrong, abbreviations and terms, globally and per project.") {
                MeetingsDictionaryPage(model: model)
            },
            NativeSettingsPage(id: windowPage, title: "Window", symbol: "macwindow", tint: .gray,
                               subtitle: "How the Meetings window opens and what it shows.") {
                MeetingsWindowPage(defaults: defaults, model: model)
            },
        ], order: 40)
    }
}

/// The page's read state, the notices of its actions (floating over the visible page), and the content once the
/// settings are there.
struct MeetingsSettingsFrame<Content: View>: View {
    @Bindable var model: MeetingsSettingsModel
    /// What the page shows beside the settings; only these read when it appears.
    var reads: MeetingsSettingsModel.Reads = []
    @ViewBuilder let content: (MeetingsSettings) -> Content
    @Environment(\.nativeSettingsIndexing) private var indexing

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let failure = model.settings.failure {
                NoticePill(text: failure.sentence, more: failure.detail, tone: .error,
                           fixes: [.button("Retry", symbol: "arrow.clockwise") { model.load(reads) },
                                   failure.detailsFix { model.load(reads) }])
            }
            if let settings = model.settings.value {
                content(settings)
            } else if model.settings.failure == nil {
                NativeSettingsCard {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Reading the meetings settings…").font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .modifier(PageNotices(model: model.notices, shown: !indexing))
        .onAppear { model.ensure(reads) }
    }
}

/// The settings pages' notices over the visible page; none while the search index draws the page off screen.
private struct PageNotices: ViewModifier {
    let model: NoticeStackModel
    let shown: Bool

    func body(content: Content) -> some View {
        if shown { content.noticeStack(model) } else { content }
    }
}

// MARK: - Recording

struct MeetingsRecordingPage: View {
    @Bindable var model: MeetingsSettingsModel

    var body: some View {
        MeetingsSettingsFrame(model: model, reads: .cost) { settings in
            let auto = settings.wispr?.autoRecord
            let capture = settings.global.capture
            let cost = model.cost.value
            NativeSettingsCard("Source audio") {
                NativeSettingsToggle("Preserve Wispr Flow audio",
                                     detail: "Keep a verified permanent copy when a meeting ends, even with screen recording off. Capture retention keeps these files.",
                                     identifier: "meetings.sourceAudio.preserve",
                                     isOn: Binding(get: { settings.wispr?.preserveAudio ?? true },
                                                   set: { model.set(["sources", "wisprflow", "preserveAudio"], $0) }))
            }
            NativeSettingsCard("Autostart") {
                NativeSettingsToggle("Record the screen with Wispr Flow",
                                     detail: "When Wispr Flow records a meeting, the screen is recorded too: frames when it changes, with OCR.",
                                     identifier: "meetings.autostart",
                                     isOn: Binding(get: { auto?.enabled ?? false }, set: { model.setAutostart($0) }))
                Divider()
                Group {
                    NativeSettingsToggle("Notify when it starts", detail: auto?.enabled == true ? "A notification says a recording began by itself."
                                                                                              : "Turn on recording with Wispr Flow first.",
                                         identifier: "meetings.autostart.notify",
                                         isOn: Binding(get: { auto?.notify ?? true },
                                                       set: { model.set(["sources", "wisprflow", "autoRecord", "notify"], $0) }))
                }
                .disabled(auto?.enabled != true)
            }

            NativeSettingsCard("Capture", subtitle: costLine(model.cost)) {
                NativeSettingsPicker("Displays", detail: "Which screens a recording records.", identifier: "meetings.capture.displays",
                                     options: [
                                         NativeSettingsOption(DisplayPolicy("all"), "All displays", detail: costText(cost?.displayCost("all"))),
                                         NativeSettingsOption(DisplayPolicy("follow-focus"), "The focused one", detail: costText(cost?.displayCost("follow-focus"))),
                                         NativeSettingsOption(DisplayPolicy("main"), "The main one", detail: costText(cost?.displayCost("main"))),
                                     ],
                                     selection: Binding(get: { capture.displays }, set: { policy in
                                         model.set(["global", "capture", "displays"], Int(policy.value).map { $0 as Any } ?? policy.value)
                                     }))
                Divider()
                NativeSettingsPicker("Frames per second while the screen changes", identifier: "meetings.capture.activeFps",
                                     options: fpsOptions([0.5, 1, 2], current: capture.activeFps, costs: cost?.activeFps),
                                     selection: Binding(get: { capture.activeFps }, set: { model.set(["global", "capture", "activeFps"], $0) }))
                Divider()
                NativeSettingsPicker("Frames per second while it does not", identifier: "meetings.capture.idleFps",
                                     options: fpsOptions([0.05, 0.1, 0.2], current: capture.idleFps, costs: cost?.idleFps,
                                                         when: "if each slow check finds a change"),
                                     selection: Binding(get: { capture.idleFps }, set: { model.set(["global", "capture", "idleFps"], $0) }))
                Divider()
                NativeSettingsPicker("Change threshold", detail: "The share of the screen that must change for a new frame.",
                                     identifier: "meetings.capture.threshold",
                                     options: thresholdOptions(current: capture.threshold, cost: cost),
                                     selection: Binding(get: { capture.threshold }, set: { model.set(["global", "capture", "threshold"], $0) }))
                Divider()
                NativeSettingsPicker("Keep frames for", detail: "Frames and OCR are deleted this many days after a meeting; its record stays.",
                                     identifier: "meetings.capture.retention",
                                     options: Array(Set([7, 14, 30, 90, capture.retentionDays])).sorted().map { NativeSettingsOption($0, Plural.count($0, "day")) },
                                     selection: Binding(get: { capture.retentionDays }, set: { model.set(["global", "capture", "retentionDays"], $0) }))
                Divider()
                NativeSettingsPicker("Notices while a capture fails",
                                     detail: "The recording keeps trying after failed captures; a stopped recording always says so.",
                                     identifier: "meetings.capture.failureNotices",
                                     options: [
                                         NativeSettingsOption("failing-and-recovered", "When it fails and when it works again"),
                                         NativeSettingsOption("failing", "Only when it starts failing"),
                                         NativeSettingsOption("off", "None"),
                                     ],
                                     selection: Binding(get: { capture.failureNotices ?? "failing-and-recovered" },
                                                        set: { model.set(["global", "capture", "failureNotices"], $0) }))
            }

            OcrLanguagesCard(model: model, language: settings.global.language, languages: settings.meetingLanguage?.ocr ?? [])
                .nativeSettingsAnchor("ocr-languages")
        }
    }

    /// `when` names the case the worst cost belongs to: a screen that keeps changing, or one that changes a little at
    /// every slow check.
    private func costText(_ seconds: Double?, when: String = "while the screen keeps changing") -> String? {
        seconds.map { "Up to \(MeetingsFormat.cpu($0)) \(when)." }
    }

    private func costLine(_ state: Loadable<CaptureCost>) -> String {
        guard let cost = state.value else {
            if let failure = state.failure { return "The cost of each choice could not be read: \(failure.sentence)" }
            return "Measuring what each choice costs…"
        }
        var parts = ["One kept frame costs about \(Int(cost.keptFrameCpuMs.rounded())) ms of CPU (Vision OCR, measured by the meetings-ocr bench)."]
        if let observed = cost.observed {
            parts.append("The last recording kept \(String(format: "%.0f", observed.framesPerMin)) frames a minute on \(Plural.count(observed.displays, "display")): about \(MeetingsFormat.cpu(observed.cpuSecPerMin)).")
        }
        return parts.joined(separator: " ")
    }

    private func fpsOptions(_ values: [Double], current: Double, costs: [CaptureCost.Choice<Double>]?,
                            when: String = "while the screen keeps changing") -> [NativeSettingsOption<Double>] {
        Array(Set(values + [current])).sorted().map { fps in
            let cost = costs?.first { $0.value == fps }?.maxCpuSecPerMin
            return NativeSettingsOption(fps, fps < 1 ? String(format: "%g (one every %g s)", fps, 1 / fps) : String(format: "%g", fps),
                                        detail: costText(cost, when: when))
        }
    }

    private func thresholdOptions(current: Double, cost: CaptureCost?) -> [NativeSettingsOption<Double>] {
        Array(Set([0.01, 0.02, 0.05, 0.1, current])).sorted().map { value in
            let measured = cost?.threshold.first { abs($0.value - value) < 0.0001 }
            let detail: String
            if let share = measured?.keptShare {
                detail = "Keeps \(Int((share * 100).rounded())) % of the frames of the last measured recording"
                    + (measured?.cpuSecPerMin.map { ": about \(MeetingsFormat.cpu($0))." } ?? ".")
            } else {
                detail = "A higher threshold keeps fewer frames. " + (cost?.thresholdNote.map { "Not measured yet: \($0)." } ?? "")
            }
            return NativeSettingsOption(value, "\(String(format: "%g", value * 100)) %", detail: detail)
        }
    }
}

/// The Vision OCR languages of the meeting language, in order of preference.
private struct OcrLanguagesCard: View {
    @Bindable var model: MeetingsSettingsModel
    let language: String
    let languages: [String]
    private static let known = ["cs-CZ", "sk-SK", "en-US", "en-GB", "de-DE", "pl-PL", "fr-FR", "es-ES", "it-IT", "uk-UA"]

    var body: some View {
        NativeSettingsCard("OCR languages", subtitle: "What Vision reads on the screen frames of a meeting held in \(MeetingsLanguage.name(language)), first one first.") {
            ForEach(Array(languages.enumerated()), id: \.element) { index, code in
                HStack {
                    Text(verbatim: "\(index + 1). \(code)").font(.system(size: 12.5).monospacedDigit())
                    Spacer()
                    IconButton(systemName: "arrow.up", tooltip: "Read \(code) earlier") { move(index, by: -1) }
                        .disabled(index == 0)
                    IconButton(systemName: "minus.circle", tooltip: "Stop reading \(code)") {
                        write(languages.filter { $0 != code })
                    }
                    .disabled(languages.count == 1)
                }
                if index < languages.count - 1 { Divider() }
            }
            HStack {
                MenuButton(items: {
                    Self.known.filter { !languages.contains($0) }.map { code in .action(code) { write(languages + [code]) } }
                }) {
                    Label("Add a language", systemImage: "plus").font(.system(size: 12))
                }
                .instantTooltip("Add a Vision OCR language at the end")
                Spacer()
            }
        }
    }

    private func move(_ index: Int, by offset: Int) {
        var list = languages
        let target = index + offset
        guard list.indices.contains(target) else { return }
        list.swapAt(index, target)
        write(list)
    }

    private func write(_ list: [String]) {
        model.set(["languages", language, "ocr"], list, done: "OCR reads \(list.joined(separator: ", "))")
    }
}

// MARK: - Window

/// The Window page: how the window opens, then one card per group of the side panel (`SidePanelCatalog`), with the same
/// words, choices and "Reset to Defaults" as the panel (G55), and the engine's clip and tone from the meetings config.
struct MeetingsWindowPage: View {
    let defaults: UserDefaults
    @Bindable var model: MeetingsSettingsModel
    @State private var openOn: String
    @State private var days: Int
    @State private var timeline: String
    @State private var afterExport: String
    /// A catalog row was written: the cards read the defaults again.
    @State private var revision = 0
    /// The named tones of the Clip and Tone card's sound row (`tone.presets`).
    @State private var tonePresets: TonePresetList = .loading
    @Environment(\.nativeSettingsIndexing) private var indexing

    /// The first frame shows the saved choices, never a default that snaps to them.
    init(defaults: UserDefaults, model: MeetingsSettingsModel) {
        self.defaults = defaults
        self.model = model
        _openOn = State(initialValue: MeetingsPreferences.openOn(defaults).rawValue)
        _days = State(initialValue: MeetingsPreferences.days(defaults))
        _timeline = State(initialValue: MeetingsPreferences.timelineLines(defaults).rawValue)
        _afterExport = State(initialValue: MeetingsPreferences.afterExport(defaults).rawValue)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            windowCard
            engineCard
            ForEach(sections) { section in
                MeetingsCatalogCard(section: section, change: changeWindow, reset: resetWindow)
                    .nativeSettingsAnchor(MeetingsSettingsPages.anchor(forSection: section.id))
            }
        }
        .modifier(PageNotices(model: model.notices, shown: !indexing))
        .onAppear { model.ensure([]) }
    }

    private var sections: [SidePanelSection] {
        _ = revision
        return SidePanelCatalog.windowSections(defaults)
    }

    private var windowCard: some View {
        NativeSettingsCard("The Meetings window") {
            NativeSettingsSegmented("Open on", identifier: "meetings.window.openOn", options: [
                NativeSettingsOption(MeetingsPreferences.OpenOn.needs.rawValue, "Needs you", detail: "The meetings that wait for you: no project, questions, suggestions."),
                NativeSettingsOption(MeetingsPreferences.OpenOn.all.rawValue, "All meetings", detail: "Every meeting of the chosen days, by day."),
            ], selection: binding($openOn, key: MeetingsPreferences.openOnKey))
            Divider()
            NativeSettingsPicker("Days in the list", detail: "How far back the window reads meetings; its toolbar changes it for one look.",
                                 identifier: "meetings.window.days",
                                 options: MeetingsPreferences.dayChoices.map { NativeSettingsOption($0, Plural.count($0, "day")) },
                                 selection: Binding(get: { days }, set: { days = $0; defaults.set($0, forKey: MeetingsPreferences.daysKey) }))
            Divider()
            NativeSettingsSegmented("Screen timeline shows", identifier: "meetings.window.timeline", options: [
                NativeSettingsOption(MeetingsPreferences.TimelineLines.changed.rawValue, "Changed lines", detail: "Each frame lists only the text its display did not show before."),
                NativeSettingsOption(MeetingsPreferences.TimelineLines.all.rawValue, "All lines", detail: "Each frame lists every line Vision read."),
            ], selection: binding($timeline, key: MeetingsPreferences.timelineKey))
            Divider()
            NativeSettingsPicker("After an export", detail: "What happens to the note the export wrote.", identifier: "meetings.window.afterExport",
                                 options: [
                                     NativeSettingsOption(MeetingsPreferences.AfterExport.genesis.rawValue, "Open it in Genesis"),
                                     NativeSettingsOption(MeetingsPreferences.AfterExport.finder.rawValue, "Show it in Finder"),
                                     NativeSettingsOption(MeetingsPreferences.AfterExport.nothing.rawValue, "Nothing"),
                                 ], selection: binding($afterExport, key: MeetingsPreferences.afterExportKey))
        }
    }

    /// The engine's clip and tone (`global.playback.listen`), written with `config.set` like the side panel's rows.
    @ViewBuilder
    private var engineCard: some View {
        if let raw = model.settingsRaw {
            MeetingsCatalogCard(section: SidePanelCatalog.engineSection(listen: raw.at(SidePanelCatalog.segments(SidePanelCatalog.listenPath)),
                                                                        presets: tonePresets),
                                change: changeEngine, reset: resetEngine, playTone: { model.previewTone($0) })
                .nativeSettingsAnchor(MeetingsSettingsPages.anchor(forSection: "engine"))
                .task {
                    let presets = await TonePresetList.load(service: model.service)
                    if presets != .loading { tonePresets = presets }
                }
        } else if let failure = model.settings.failure {
            NoticePill(text: "The clip and tone settings did not load: \(failure.sentence)", more: failure.detail, tone: .error,
                       fixes: [.button("Retry", symbol: "arrow.clockwise") { model.loadSettings() },
                                   failure.detailsFix { model.loadSettings() }])
        } else {
            NativeSettingsCard("Clip and Tone") {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Reading the meetings settings…").font(.system(size: 12)).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func changeWindow(_ row: SidePanelRow, _ value: SidePanelValue) {
        guard case .window(let key) = row.store else { return }
        SidePanelCatalog.write(value, key: key, to: defaults)
        revision += 1
    }

    private func resetWindow(_ section: SidePanelSection) {
        for key in section.windowKeys { defaults.removeObject(forKey: key) }
        revision += 1
    }

    private func changeEngine(_ row: SidePanelRow, _ value: SidePanelValue) {
        guard case .engine(let path) = row.store else { return }
        SidePanelCatalog.applyEngine(value, for: row) { json in
            if let json {
                model.set(SidePanelCatalog.segments(path), json.foundation)
            } else {
                model.unset(SidePanelCatalog.segments(path))
            }
        }
    }

    private func resetEngine(_ section: SidePanelSection) {
        for path in section.enginePaths { model.unset(SidePanelCatalog.segments(path)) }
    }

    private func binding(_ state: Binding<String>, key: String) -> Binding<String> {
        Binding(get: { state.wrappedValue }, set: { state.wrappedValue = $0; defaults.set($0, forKey: key) })
    }
}

/// One side panel section as a Settings card: a switch, a picker or a slider per row with its detail, a problem with the
/// saved value under it, the section's footnote and "Reset to Defaults" under the rows.
struct MeetingsCatalogCard: View {
    let section: SidePanelSection
    let change: (SidePanelRow, SidePanelValue) -> Void
    let reset: (SidePanelSection) -> Void
    var playTone: ((MeetingsAPI.ToneSoundSetting) -> Void)?

    var body: some View {
        NativeSettingsCard(section.title) {
            ForEach(Array(section.rows.enumerated()), id: \.element.id) { index, row in
                if index > 0 { Divider() }
                rowView(row)
            }
            Divider()
            HStack(spacing: 8) {
                if let footnote = section.footnote {
                    Label(footnote, systemImage: "clock.arrow.circlepath").font(.system(size: 11)).foregroundStyle(.secondary)
                }
                Spacer(minLength: 6)
                // lint-rules-ignore: short list (one card per window settings section, about six)
                Button("Reset to Defaults") { reset(section) }
                    .controlSize(.small)
                    .disabled(section.isDefault)
                    .instantTooltip(section.isDefault ? "Every \(section.title.lowercased()) setting is at its default"
                                                      : "Put every \(section.title.lowercased()) setting back to its default")
                    .accessibilityIdentifier("meetings.window.\(section.id).reset")
            }
        }
    }

    /// A row whose parent is off is disabled and says why (`SidePanelSection.isEnabled`, the same rule as the panel).
    @ViewBuilder
    private func rowView(_ row: SidePanelRow) -> some View {
        rowControl(row, detail: section.detail(row))
            .disabled(!section.isEnabled(row))
    }

    @ViewBuilder
    private func rowControl(_ row: SidePanelRow, detail: String) -> some View {
        if let slider = row.slider, case .number(let saved) = row.value {
            MeetingsCatalogSlider(row: row, detail: detail, saved: saved, slider: slider) { change(row, .number($0)) }
        } else if case .flag(let on) = row.value {
            NativeSettingsToggle(row.title, detail: detail, identifier: row.id,
                                 isOn: Binding(get: { on }, set: { change(row, .flag($0)) }))
        } else {
            VStack(alignment: .leading, spacing: 8) {
                NativeSettingsPicker(row.title, detail: detail, identifier: row.id,
                                     options: row.choices.map { NativeSettingsOption($0.value, $0.title, detail: $0.note, enabled: $0.available) },
                                     selection: Binding(get: { row.value }, set: { change(row, $0) }),
                                     trailing: playButton(row))
                    .help(row.valueHelp ?? "")
                if let problem = row.problem {
                    SidePanelProblem(text: problem)
                        .accessibilityIdentifier("meetings.window.problem.\(row.id)")
                }
            }
        }
    }

    /// The tone row's Play button beside its picker; off while the saved sound cannot play.
    private func playButton(_ row: SidePanelRow) -> AnyView? {
        guard let playTone, let sound = row.tone else { return nil }
        return AnyView(
            IconButton(systemName: "play.circle",
                       tooltip: row.problem == nil ? "Play the tone" : "The tone cannot play: \(row.problem ?? "")") { playTone(sound) }
                .disabled(row.problem != nil)
                .accessibilityIdentifier("meetings.window.playTone"))
    }
}

/// A slider row of a Settings card (the tone's volume): the kit's slider, which writes once per gesture, key step or
/// VoiceOver step. The draft stays until the saved value arrives, or 5 s after a write that did not land.
struct MeetingsCatalogSlider: View {
    let row: SidePanelRow
    let detail: String
    let saved: Double
    let slider: SidePanelRow.Slider
    let commit: (Double) -> Void
    @State private var draft: Double?
    @State private var written = 0

    var body: some View {
        NativeSettingsSlider(row.title, detail: detail, identifier: row.id,
                             value: Binding(get: { draft ?? saved }, set: { draft = $0 }),
                             in: slider.range, step: slider.step, format: SidePanelWords.percent,
                             onCommit: { value in
                                 commit(value)
                                 written += 1
                             })
            .onChange(of: saved) { draft = nil }
            .task(id: written) {
                guard written > 0 else { return }
                try? await Task.sleep(for: .seconds(5))
                if !Task.isCancelled { draft = nil }
            }
    }
}
