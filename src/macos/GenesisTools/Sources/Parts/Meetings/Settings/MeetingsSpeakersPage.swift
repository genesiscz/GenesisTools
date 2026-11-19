import SwiftUI

/// The voice pass's settings (`global.speakerLabels.voice.compute` of the meetings config) as this side reads them. A
/// config without the block, or a service older than it, reads as the defaults: normal priority and auto workers.
struct MeetingsVoiceCompute: Equatable {
    enum Priority: String { case normal, background }

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
            MeetingsVoicePassCard(compute: MeetingsVoiceCompute(raw: model.settingsRaw), autoNow: autoNow) { path, value in
                model.set(path, value)
            }
            .nativeSettingsAnchor(MeetingsSettingsPages.voicePassAnchor)
        }
        .task { autoNow = await MeetingsVoiceCompute.autoWorkersNow(service: model.service) }
    }
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
