import Darwin
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
        if case .number(let count) = block.at(["workers"]), count >= 1 { workers = min(Self.maxWorkers, Int(count)) }
    }

    /// The worker count `auto` means: the performance cores minus the one-minute load average, at least one and at
    /// most four. The same rule as `voiceWorkerCount` in src/utils/meetings/config.ts, which the engine reads once when
    /// a pass starts.
    static func autoWorkers(performanceCores: Int, load1: Double) -> Int {
        max(1, min(4, Int((Double(performanceCores) - load1).rounded(.down))))
    }

    /// What `auto` means on this Mac at this moment, read as the engine reads it (`readPerformanceCores`, `loadavg`).
    static func autoWorkersNow() -> Int {
        var load = [Double](repeating: 0, count: 3)
        let load1 = getloadavg(&load, 3) > 0 ? load[0] : 0
        let cores = sysctlInteger("hw.perflevel0.physicalcpu") ?? sysctlInteger("hw.physicalcpu")
            ?? max(1, ProcessInfo.processInfo.activeProcessorCount / 2)
        return autoWorkers(performanceCores: cores, load1: load1)
    }

    private static func sysctlInteger(_ name: String) -> Int? {
        var value: Int32 = 0
        var size = MemoryLayout<Int32>.size
        guard sysctlbyname(name, &value, &size, nil, 0) == 0, value > 0 else { return nil }
        return Int(value)
    }
}

/// The Speakers page: how the engine names who spoke. The window's own speaker settings (order, chips, renaming)
/// stay on the Window page with the side panel's cards; this page holds what runs in the Meetings service.
struct MeetingsSpeakersPage: View {
    @Bindable var model: MeetingsSettingsModel
    /// What `auto` means now; read when the page shows, since the load changes.
    @State private var autoNow = MeetingsVoiceCompute.autoWorkersNow()

    var body: some View {
        MeetingsSettingsFrame(model: model) { _ in
            MeetingsVoicePassCard(compute: MeetingsVoiceCompute(raw: model.settingsRaw), autoNow: autoNow) { path, value in
                model.set(path, value)
            }
            .nativeSettingsAnchor(MeetingsSettingsPages.voicePassAnchor)
        }
        .onAppear { autoNow = MeetingsVoiceCompute.autoWorkersNow() }
    }
}

/// The voice pass card: its priority and its worker count, each choice explained with what it costs on a real meeting.
struct MeetingsVoicePassCard: View {
    let compute: MeetingsVoiceCompute
    /// The count `auto` means on this Mac now.
    let autoNow: Int
    let set: ([String], Any) -> Void

    static let normalDetail = "Runs on the fast cores and finishes soonest: about 90 CPU seconds for a one-hour meeting. "
        + "Other work on the Mac can feel slower while it runs."
    static let backgroundDetail = "Yields to everything else and keeps the Mac quiet, but takes much longer: "
        + "32 minutes and 251 CPU seconds for the same one-hour meeting on a busy Mac."

    static func autoDetail(now: Int) -> String {
        "Auto uses the cores that are free when the pass starts (at most 4), so a busy Mac gets one worker. "
            + "Right now that is \(Plural.count(now, "worker")); it changes with the load."
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
            ], selection: Binding(get: { compute.priority.rawValue },
                                  set: { set(MeetingsVoiceCompute.path + ["priority"], $0) }))
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

    /// Auto writes `"auto"`; a fixed number starts at what auto means now, so the next pass does not change by the switch.
    func chooseWorkers(_ choice: String) {
        if choice == "auto" {
            set(MeetingsVoiceCompute.path + ["workers"], "auto")
        } else if compute.workers == nil {
            set(MeetingsVoiceCompute.path + ["workers"], autoNow)
        }
    }
}
