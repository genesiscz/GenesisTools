import SwiftUI

/// The voice pass's settings (`global.speakerLabels.voice.compute` of the meetings config) as this side reads them. A
/// config without the block, or a service older than it, reads as the defaults: normal priority and auto workers.
struct MeetingsVoiceCompute: Equatable {
    enum Priority: String { case normal, background }

    static let libraryPath = ["global", "speakerLabels", "voice"]
    static let doubtfulFirstKey = "meetings.voices.doubtfulFirst"
    static let meetingOnlyKey = "meetings.voices.meetingOnly"
    var sampleScope = "all"
    var outlierBelow = 0.5
    var priority: Priority = .normal
    /// nil is `auto`.
    var workers: Int?

    static let path = ["global", "speakerLabels", "voice", "compute"]
    /// `MAX_VOICE_WORKERS` in src/utils/meetings/config.ts.
    static let maxWorkers = 16

    init(priority: Priority = .normal, workers: Int? = nil) {
        self.priority = priority
        self.workers = workers
    }

    init(raw: JSONValue?) {
        let voice = raw?.at(Self.libraryPath) ?? .null
        if case .string("project") = voice.at(["sampleScope"]) { sampleScope = "project" }
        if case .number(let score) = voice.at(["outlierBelow"]), (-1...1).contains(score) { outlierBelow = score }
        let block = raw?.at(Self.path) ?? .null
        if case .string(let text) = block.at(["priority"]), let read = Priority(rawValue: text) { priority = read }
        // Clamped as a Double first: `Int(_:)` traps on a hand-written 1e300 in the config.
        if case .number(let count) = block.at(["workers"]), count >= 1 { workers = Int(min(Double(Self.maxWorkers), count)) }
    }

    /// What `auto` means on this Mac now, as the engine counts it: the Meetings service's `voices.workers` (the idle
    /// cores of a one-second CPU sample, at most the performance cores, 1 to 4; `voiceWorkerCount` in
    /// src/utils/meetings/config.ts). The window keeps no copy of the rule; nil when no service answers.
    static func autoWorkersNow(service: MeetingsService?) async -> Int? {
        guard let service else { return nil }
        return try? await service.call(MeetingsAPI.VoicesWorkers.self, .init()).auto
    }
}

/// The Speakers page: how the engine names who spoke. The window's own speaker settings (order, chips, renaming)
/// stay on the Window page with the side panel's cards; this page holds what runs in the Meetings service.
struct MeetingsSpeakersPage: View {
    @Bindable var model: MeetingsSettingsModel
    /// What `auto` means now; read from the engine each time the page shows, since the load changes.
    @State private var autoNow: Int?

    var body: some View {
        MeetingsSettingsFrame(model: model) { _ in
            RoomDeviceSettingsCard(raw: model.settingsRaw) { path, value in model.set(path, value) }
                .nativeSettingsAnchor("roomDevices")
            MeetingsVoiceLibraryCard(config: MeetingsVoiceCompute(raw: model.settingsRaw)) { path, value in model.set(path, value) }
                .nativeSettingsAnchor("voiceLibrary")
            MeetingsVoiceNamingCard(naming: MeetingsVoiceNaming(raw: model.settingsRaw)) { path, value in model.set(path, value) }
                .nativeSettingsAnchor("voiceNaming")
            MeetingsSpeakerEvidenceCard(evidence: MeetingsSpeakerEvidence(raw: model.settingsRaw)) { path, value in model.set(path, value) }
                .nativeSettingsAnchor("speakerEvidence")
            MeetingsVoicePassCard(compute: MeetingsVoiceCompute(raw: model.settingsRaw), autoNow: autoNow) { path, value in
                model.set(path, value)
            }
            .nativeSettingsAnchor(MeetingsSettingsPages.voicePassAnchor)
        }
        .task { autoNow = await MeetingsVoiceCompute.autoWorkersNow(service: model.service) }
    }
}

struct RoomDeviceSettingsCard: View {
    static let path = ["global", "speakerLabels", "seat", "deviceOfferMinMeetings"]
    // The config accepts any positive JavaScript safe integer.
    private static let counts = 1..<(1 << 53)
    let raw: JSONValue?
    let set: ([String], Int) -> Void

    var minimum: Int {
        guard case .number(let value) = raw?.at(Self.path), let count = Int(exactly: value),
              Self.counts.contains(count) else { return 2 }
        return count
    }

    func choose(_ count: Int) {
        if Self.counts.contains(count) { set(Self.path, count) }
    }

    var body: some View {
        NativeSettingsCard("Room devices") {
            NativeSettingsRow("Meetings before asking", detail: "Ask about a shared room account after it joins from the room in this many meetings.") {
                NativeSettingsNumberPicker("Meetings before asking", range: Self.counts, identifier: "meetings.devices.minimum",
                                           suffix: .counted("meeting"), value: Binding(get: { minimum }, set: choose))
            }
        }
    }
}

struct MeetingsVoiceLibraryCard: View {
    let config: MeetingsVoiceCompute
    let set: ([String], Any) -> Void
    @State private var draftThreshold: Double?
    @AppStorage(MeetingsVoiceCompute.doubtfulFirstKey) private var doubtfulFirst = true
    @AppStorage(MeetingsVoiceCompute.meetingOnlyKey) private var meetingOnly = false

    var body: some View {
        NativeSettingsCard("Voice library", subtitle: "Each person has one voice library across projects.") {
            NativeSettingsPicker("Samples used to suggest names", detail: "Choose which confirmed samples the voice pass compares.",
                                 identifier: "meetings.voice.sampleScope", options: [
                                    NativeSettingsOption("all", "All projects"),
                                    NativeSettingsOption("project", "Current project"),
                                 ], selection: Binding(get: { config.sampleScope }, set: chooseScope))
            Divider()
            NativeSettingsSlider("Flag a sample below", detail: "A cosine below this value marks a sample for review. The sample stays in the library.",
                                 identifier: "meetings.voice.outlierBelow",
                                 value: Binding(get: { draftThreshold ?? config.outlierBelow }, set: { draftThreshold = $0 }),
                                 in: -1...1, step: 0.01, format: VoiceScore.text, onCommit: { value in
                draftThreshold = nil
                chooseThreshold(value)
            })
            Divider()
            NativeSettingsToggle("Doubtful samples first", detail: "Show people and samples that need a listen first.",
                                 identifier: MeetingsVoiceCompute.doubtfulFirstKey, isOn: $doubtfulFirst)
            Divider()
            NativeSettingsToggle("Open inspector on this meeting only", detail: "When off, the inspector starts with samples from the whole project.",
                                 identifier: MeetingsVoiceCompute.meetingOnlyKey, isOn: $meetingOnly)
        }
    }

    func chooseScope(_ choice: String) { set(MeetingsVoiceCompute.libraryPath + ["sampleScope"], choice) }
    func chooseThreshold(_ value: Double) { set(MeetingsVoiceCompute.libraryPath + ["outlierBelow"], value) }
}

/// How the voice names lines (`global.speakerLabels.voice` of the meetings config) as this side reads them. A missing
/// key reads as the engine's default in src/utils/meetings/config.ts.
struct MeetingsVoiceNaming: Equatable {
    /// `voice.exclusion`: offer the only unsampled seat-mate for review when the sampled voices clearly differ.
    struct Exclusion: Equatable {
        static let path = MeetingsVoiceCompute.libraryPath + ["exclusion"]
        static let marginRange = 0.0...2.0
        static let maxLines = 1000
        var enabled = true
        var margin = 0.15
        var maxConfidence = 0.69
        var minLines = 3
        var coherence = 0.82
    }

    var supportOnSeatLines = true
    /// `voice.skipUnsampledNeverSpeaking`: a remote person the speaking indicator never shows speaking holds no line back.
    var skipUnsampledNeverSpeaking = true
    var exclusion = Exclusion()

    init() {}

    init(raw: JSONValue?) {
        let voice = raw?.at(MeetingsVoiceCompute.libraryPath) ?? .null
        if case .bool(let on) = voice.at(["supportOnSeatLines"]) { supportOnSeatLines = on }
        if case .bool(let on) = voice.at(["skipUnsampledNeverSpeaking"]) { skipUnsampledNeverSpeaking = on }
        let block = voice.at(["exclusion"])
        if case .bool(let on) = block.at(["enabled"]) { exclusion.enabled = on }
        if case .number(let value) = block.at(["margin"]), Exclusion.marginRange.contains(value) { exclusion.margin = value }
        if case .number(let value) = block.at(["maxConfidence"]), (0...1).contains(value) { exclusion.maxConfidence = value }
        // Clamped as a Double first: `Int(_:)` traps on a hand-written 1e300 in the config.
        if case .number(let value) = block.at(["minLines"]), value >= 1, value == value.rounded() {
            exclusion.minLines = Int(min(Double(Exclusion.maxLines), value))
        }
        if case .number(let value) = block.at(["coherence"]), (0...1).contains(value) { exclusion.coherence = value }
    }
}

/// The voice naming card: what the voice checks on a line the seat already names.
struct MeetingsVoiceNamingCard: View {
    let naming: MeetingsVoiceNaming
    let set: ([String], Any) -> Void
    /// A slider's value while it is dragged; written once at the end of the gesture.
    @State private var drafts: [String: Double] = [:]

    var body: some View {
        NativeSettingsCard("Naming by voice", subtitle: "How saved voice samples help name who spoke. A change applies from the next pass.") {
            NativeSettingsToggle("Support seat names with the voice",
                                 detail: "Also compare a line the seat gives to its only person with that person's samples, and show a match beside the seat's name. "
                                    + "When off, the voice checks such a line only for a stranger.",
                                 identifier: "meetings.voice.supportOnSeatLines",
                                 isOn: Binding(get: { naming.supportOnSeatLines }, set: chooseSupport))
            Divider()
            NativeSettingsToggle("Skip people never shown speaking",
                                 detail: "A remote person with no voice sample, whom the call never shows speaking while it shows others, "
                                    + "holds no line back for a sample. When off, every present person without a sample holds the line back.",
                                 identifier: "meetings.voice.skipUnsampledNeverSpeaking",
                                 isOn: Binding(get: { naming.skipUnsampledNeverSpeaking }, set: chooseSkipNeverSpeaking))
            Divider()
            NativeSettingsToggle("Offer the only unsampled person",
                                 detail: "When the sampled voices on a seat clearly differ from a line, offer the one person on that seat with no sample for review.",
                                 identifier: "meetings.voice.exclusion.enabled", isOn: exclusionEnabled)
            if naming.exclusion.enabled {
                ForEach(Self.exclusionSliders, id: \.key) { exclusionSlider($0) }
                NativeSettingsRow("Lines in one stay", detail: "The fewest lines in the same stay before an offer, so one stray sound names nobody.") {
                    NativeSettingsNumberPicker("Lines in one stay", range: 1..<(MeetingsVoiceNaming.Exclusion.maxLines + 1),
                                               identifier: "meetings.voice.exclusion.minLines", suffix: .counted("line"),
                                               value: exclusionMinLines)
                }
            }
        }
    }

    /// One slider of `voice.exclusion`: the config key it writes and the read value it shows.
    struct ExclusionSlider {
        let key: String
        let title: String
        let detail: String
        let value: KeyPath<MeetingsVoiceNaming.Exclusion, Double>
        let range: ClosedRange<Double>
    }

    /// The sliders the card draws, in order. The tests read each one's key and value from this list.
    static var exclusionSliders: [ExclusionSlider] {
        [
            .init(key: "margin", title: "Distance below a match",
                  detail: "How far under the score that names a person the sampled voices must stay. A larger margin keeps borderline lines undecided.",
                  value: \.margin, range: MeetingsVoiceNaming.Exclusion.marginRange),
            .init(key: "maxConfidence", title: "Highest confidence of an offer",
                  detail: "An offer never reaches the confidence that applies a name by itself, so a person reviews it first.",
                  value: \.maxConfidence, range: 0...1),
            .init(key: "coherence", title: "Voices must agree",
                  detail: "How alike the lines of the group must sound (mean score to their centre), so two different strangers are not offered as one.",
                  value: \.coherence, range: 0...1),
        ]
    }

    /// The "Offer the only unsampled person" switch.
    var exclusionEnabled: Binding<Bool> {
        Binding(get: { naming.exclusion.enabled }, set: { chooseExclusion("enabled", $0) })
    }

    /// The "Lines in one stay" count.
    var exclusionMinLines: Binding<Int> {
        Binding(get: { naming.exclusion.minLines }, set: { chooseExclusion("minLines", $0) })
    }

    /// The end of a slider's gesture: its one write.
    func commit(_ slider: ExclusionSlider, _ value: Double) { chooseExclusion(slider.key, value) }

    private func exclusionSlider(_ slider: ExclusionSlider) -> some View {
        Group {
            Divider()
            NativeSettingsSlider(slider.title, detail: slider.detail, identifier: "meetings.voice.exclusion.\(slider.key)",
                                 value: Binding(get: { drafts[slider.key] ?? naming.exclusion[keyPath: slider.value] },
                                                set: { drafts[slider.key] = $0 }),
                                 in: slider.range, step: 0.01, format: VoiceScore.text, onCommit: { committed in
                drafts[slider.key] = nil
                commit(slider, committed)
            })
        }
    }

    func chooseSupport(_ on: Bool) { set(MeetingsVoiceCompute.libraryPath + ["supportOnSeatLines"], on) }
    func chooseSkipNeverSpeaking(_ on: Bool) { set(MeetingsVoiceCompute.libraryPath + ["skipUnsampledNeverSpeaking"], on) }

    /// One key of `voice.exclusion`, written as the config spells it.
    func chooseExclusion(_ key: String, _ value: Any) { set(MeetingsVoiceNaming.Exclusion.path + [key], value) }
}

/// How findings about one line combine (`global.speakerLabels.fusion` and `global.speakerLabels.seat.retire` of the
/// meetings config) as this side reads them. A missing key, or a value the config refuses, reads as the engine's default
/// in src/utils/meetings/config.ts.
struct MeetingsSpeakerEvidence: Equatable {
    /// `seat.retire`: when a pass sets aside a seat name that the calibrated audio no longer puts on that seat.
    enum Retire: String, CaseIterable {
        case calibration, contradicted

        var title: String {
            switch self {
            case .calibration: "Always, when calibration moves the line"
            case .contradicted: "Only when something else names another person"
            }
        }

        var detail: String {
            switch self {
            case .calibration:
                "The name is set aside whenever the calibrated audio puts the line on the other seat. The line then waits for another answer."
            case .contradicted:
                "The name is set aside only when another range or the speaking indicator names someone else on the line. Otherwise it stays."
            }
        }
    }

    static let fusionPath = ["global", "speakerLabels", "fusion"]
    static let retirePath = ["global", "speakerLabels", "seat", "retire"]
    static let voiceMarginRange = 0.0...1.0
    /// `fusion.mode`: `independent` adds up findings that rest on different evidence and name the same person; `off` keeps
    /// each finding's own confidence.
    var countsAgreementTogether = true
    var voiceMargin = 0.15
    var retire = Retire.calibration

    init() {}

    init(raw: JSONValue?) {
        let fusion = raw?.at(Self.fusionPath) ?? .null
        if case .string(let mode) = fusion.at(["mode"]) {
            if mode == "independent" { countsAgreementTogether = true }
            if mode == "off" { countsAgreementTogether = false }
        }
        if case .number(let value) = fusion.at(["voiceMargin"]), Self.voiceMarginRange.contains(value) { voiceMargin = value }
        if case .string(let text) = raw?.at(Self.retirePath) ?? .null, let read = Retire(rawValue: text) { retire = read }
    }
}

/// The evidence card: how findings that name the same person on a line add up, and when an older seat name steps aside.
struct MeetingsSpeakerEvidenceCard: View {
    let evidence: MeetingsSpeakerEvidence
    let set: ([String], Any) -> Void
    /// The slider's value while it is dragged; written once at the end of the gesture.
    @State private var draftMargin: Double?

    /// The lead only matters while agreeing findings are counted together.
    var voiceMarginEnabled: Bool { evidence.countsAgreementTogether }

    var body: some View {
        NativeSettingsCard("Combining evidence", subtitle: "How the engine settles who spoke a line when more than one finding speaks to it. "
                            + "Turning the switch off shows each finding's own confidence at once; the other changes apply from the next speakers pass.") {
            NativeSettingsToggle("Count agreeing evidence together",
                                 detail: "Findings from different evidence that name the same person add up, so two agreeing guesses show the name plainly. "
                                    + "When off, each finding keeps its own confidence.",
                                 identifier: "meetings.fusion.mode",
                                 isOn: Binding(get: { evidence.countsAgreementTogether }, set: chooseCounting))
            Divider()
            NativeSettingsSlider("Lead a voice match needs",
                                 detail: "How far ahead of the next person a voice match must be before it counts as agreeing with another finding.",
                                 identifier: "meetings.fusion.voiceMargin",
                                 value: Binding(get: { draftMargin ?? evidence.voiceMargin }, set: { draftMargin = $0 }),
                                 in: MeetingsSpeakerEvidence.voiceMarginRange, step: 0.05, format: VoiceScore.text, onCommit: { committed in
                draftMargin = nil
                chooseVoiceMargin(committed)
            })
            .disabled(!voiceMarginEnabled)
            Divider()
            NativeSettingsPicker("Replace an older seat name",
                                 detail: "A seat name written before calibration can land on a line that the calibrated audio puts on the other seat. "
                                    + "Choose when it is set aside.",
                                 identifier: "meetings.seat.retire",
                                 options: MeetingsSpeakerEvidence.Retire.allCases.map { NativeSettingsOption($0, $0.title, detail: $0.detail) },
                                 selection: Binding(get: { evidence.retire }, set: chooseRetire), width: 380)
        }
    }

    /// On writes `independent`, off writes `off`, as the config spells them.
    func chooseCounting(_ on: Bool) { set(MeetingsSpeakerEvidence.fusionPath + ["mode"], on ? "independent" : "off") }

    /// Rounded to the slider's step grid, so a drag never saves 0.15000000000000002.
    func chooseVoiceMargin(_ value: Double) {
        let rounded = (value * 100).rounded() / 100
        if MeetingsSpeakerEvidence.voiceMarginRange.contains(rounded) { set(MeetingsSpeakerEvidence.fusionPath + ["voiceMargin"], rounded) }
    }

    func chooseRetire(_ choice: MeetingsSpeakerEvidence.Retire) { set(MeetingsSpeakerEvidence.retirePath, choice.rawValue) }
}

/// The voice pass card: its priority and its worker count, each choice explained with what it costs on a real meeting.
struct MeetingsVoicePassCard: View {
    let compute: MeetingsVoiceCompute
    /// The count `auto` means on this Mac now; nil until the engine answered.
    let autoNow: Int?
    let set: ([String], Any) -> Void

    static let normalDetail = "Runs on the fast cores and finishes soonest: about 90 CPU seconds for a one-hour meeting. "
        + "Other work on the Mac can feel slower while it runs."
    static let backgroundDetail = "Yields to everything else and keeps the Mac quiet, but takes much longer: "
        + "32 minutes and 251 CPU seconds for the same one-hour meeting on a busy Mac."

    static func autoDetail(now: Int?) -> String {
        "Auto uses the cores that are idle when the pass starts (at most 4), so a busy Mac gets one worker."
            + (now.map { " Right now that is \(Plural.count($0, "worker")); it changes with the load." } ?? "")
    }

    var body: some View {
        NativeSettingsCard("Voice pass", subtitle: "After a meeting, the voice pass decodes its sound and compares each line with "
                            + "the saved voice samples to name who spoke. A change applies from the next pass.") {
            NativeSettingsPicker("Priority", detail: "Normal finishes soonest. In the background keeps the Mac quiet, but takes several times longer.",
                                 identifier: "meetings.voice.priority", options: [
                NativeSettingsOption(MeetingsVoiceCompute.Priority.normal.rawValue, "Normal", detail: Self.normalDetail,
                                     symbol: "hare"),
                NativeSettingsOption(MeetingsVoiceCompute.Priority.background.rawValue, "In the background",
                                     detail: Self.backgroundDetail, symbol: "tortoise"),
            ], selection: Binding(get: { compute.priority.rawValue }, set: choosePriority))
            Divider()
            NativeSettingsPicker("Workers", detail: "Processes that compare lines side by side.", identifier: "meetings.voice.workers",
                                 options: [
                                     NativeSettingsOption("auto", "Auto", detail: Self.autoDetail(now: autoNow)),
                                     NativeSettingsOption("fixed", "A fixed number",
                                                          detail: "Every pass starts this many workers. More workers than free cores make each one slower."),
                                 ],
                                 selection: Binding(get: { compute.workers == nil ? "auto" : "fixed" }, set: chooseWorkers))
            if let workers = compute.workers {
                NativeSettingsRow("Number of workers") {
                    NativeSettingsNumberPicker("Number of workers", range: 1..<(MeetingsVoiceCompute.maxWorkers + 1),
                                               identifier: "meetings.voice.workerCount", suffix: .counted("worker"),
                                               value: Binding(get: { workers }, set: { set(MeetingsVoiceCompute.path + ["workers"], $0) }))
                }
            }
        }
    }

    /// The priority picker's choice, written as the config spells it (`normal`, `background`).
    func choosePriority(_ choice: String) {
        set(MeetingsVoiceCompute.path + ["priority"], choice)
    }

    /// Auto writes `"auto"`; a fixed number starts at what auto means now, so the next pass does not change by the switch.
    func chooseWorkers(_ choice: String) {
        if choice == "auto" {
            set(MeetingsVoiceCompute.path + ["workers"], "auto")
        } else if compute.workers == nil {
            set(MeetingsVoiceCompute.path + ["workers"], autoNow ?? 1)
        }
    }
}
