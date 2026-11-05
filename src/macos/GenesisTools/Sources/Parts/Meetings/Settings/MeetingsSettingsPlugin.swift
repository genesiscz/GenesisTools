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
        if page == MeetingsSettingsPages.windowPage { return true }
        return model?.settled ?? true
    }

    package func settingsReopened() {
        model?.load()
    }
}

@MainActor
enum MeetingsSettingsPages {
    static let recordingPage = "meetings.recording"
    static let projectsPage = "meetings.projects"
    static let dictionaryPage = "meetings.dictionary"
    static let windowPage = "meetings.window"

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
                MeetingsWindowPage(defaults: defaults)
            },
        ], order: 40)
    }
}

/// The page's read state, the last action's note, and the content once the settings are there.
struct MeetingsSettingsFrame<Content: View>: View {
    @Bindable var model: MeetingsSettingsModel
    @ViewBuilder let content: (MeetingsSettings) -> Content
    @Environment(\.nativeSettingsIndexing) private var indexing

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let notice = model.notice, !indexing {
                NoticePill(text: notice.text, detail: notice.detail, more: notice.more, tone: notice.tone,
                           fixes: notice.actionTitle.map { title in
                               [NoticeFix.button(title, symbol: notice.actionSymbol) { model.notice = nil; notice.action?() }]
                           } ?? []) { model.notice = nil }
                    .id(notice.id)
            }
            if let failure = model.settings.failure {
                NoticePill(text: failure.sentence, more: failure.detail, tone: .error,
                           fixes: [.button("Retry", symbol: "arrow.clockwise") { model.load() }])
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
        .onAppear { if model.settings == .idle { model.load() } }
    }
}

// MARK: - Recording

struct MeetingsRecordingPage: View {
    @Bindable var model: MeetingsSettingsModel

    var body: some View {
        MeetingsSettingsFrame(model: model) { settings in
            let auto = settings.wispr?.autoRecord
            let capture = settings.global.capture
            let cost = model.cost.value
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
        NativeSettingsCard("OCR languages", subtitle: "What Vision reads on the screen frames of a meeting held in \(language), first one first.") {
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

struct MeetingsWindowPage: View {
    let defaults: UserDefaults
    @State private var openOn: String
    @State private var days: Int
    @State private var timeline: String
    @State private var afterExport: String
    @State private var undoSeconds: Int
    @State private var typedAnswer: String

    /// The first frame shows the saved choices, never a default that snaps to them.
    init(defaults: UserDefaults) {
        self.defaults = defaults
        _openOn = State(initialValue: MeetingsPreferences.openOn(defaults).rawValue)
        _days = State(initialValue: MeetingsPreferences.days(defaults))
        _timeline = State(initialValue: MeetingsPreferences.timelineLines(defaults).rawValue)
        _afterExport = State(initialValue: MeetingsPreferences.afterExport(defaults).rawValue)
        _undoSeconds = State(initialValue: MeetingsPreferences.undoSeconds(defaults))
        _typedAnswer = State(initialValue: MeetingsPreferences.typedAnswer(defaults).rawValue)
    }

    var body: some View {
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
            Divider()
            NativeSettingsPicker("Undo stays for", detail: "After a confirm or a reject, the Undo button waits this long.",
                                 identifier: "meetings.window.undoSeconds",
                                 options: MeetingsPreferences.undoChoices.map { NativeSettingsOption($0, "\($0) s") },
                                 selection: Binding(get: { undoSeconds }, set: { undoSeconds = $0; defaults.set($0, forKey: MeetingsPreferences.undoSecondsKey) }))
            Divider()
            NativeSettingsSegmented("Type an answer", identifier: "meetings.window.typedAnswer", options: [
                NativeSettingsOption(MeetingsPreferences.TypedAnswer.always.rawValue, "On every question", detail: "A field beside the choices takes the word you heard."),
                NativeSettingsOption(MeetingsPreferences.TypedAnswer.noChoices.rawValue, "Without choices", detail: "Only a question with no choices gets the field."),
            ], selection: binding($typedAnswer, key: MeetingsPreferences.typedAnswerKey))
        }
    }

    private func binding(_ state: Binding<String>, key: String) -> Binding<String> {
        Binding(get: { state.wrappedValue }, set: { state.wrappedValue = $0; defaults.set($0, forKey: key) })
    }
}
