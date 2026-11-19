import AppKit
import Observation
import SwiftUI

struct MicrophoneReading: Decodable {
    struct Channel: Decodable {
        let dbfs: Double?
        let device: String?
        let sampled: Bool
    }
    struct Calibration: Decodable {
        let layout: String
        let sourceMicShare: Double?
    }
    let mic: Channel
    let system: Channel
    let micShare: Double?
    let voiceMicShare: Double?
    let calibration: Calibration
}

@MainActor @Observable
final class MicrophoneTest {
    var reading: MicrophoneReading?
    var warning: String?
    var status = "Ready"
    var running = false
    @ObservationIgnored private var stream: ToolsLineStream?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var sampledMicrophone = false

    func start() {
        guard stream == nil else { return }
        generation += 1
        let request = generation
        status = "Opening audio inputs…"
        warning = nil
        reading = nil
        sampledMicrophone = false
        running = true
        do {
            stream = try ToolsLineStream(bridge: MeetingsCLI.bridge, subcommand: "meetings",
                args: ["levels", "--stream", "--seconds", "60", "--until-stdin-closes"],
                onLines: { [weak self] lines in
                    guard let self, self.generation == request else { return }
                    self.receive(lines)
                },
                onExit: { [weak self] result in
                    guard let self, self.generation == request else { return }
                    self.finished(status: result.status, stderr: result.stderr)
                })
        } catch {
            running = false
            status = "Could not start the test"
            warning = error.localizedDescription
        }
    }

    func receive(_ lines: [String]) {
        struct Warning: Decodable { let warning: String }
        let decoder = JSONDecoder()
        var newest: MicrophoneReading?
        for line in lines {
            let data = Data(line.utf8)
            if let row = try? decoder.decode(MicrophoneReading.self, from: data) {
                sampledMicrophone = sampledMicrophone || row.mic.sampled
                newest = row
            } else if let notice = try? decoder.decode(Warning.self, from: data) {
                warning = notice.warning
            }
        }
        if let newest {
            reading = newest
            status = sampledMicrophone ? "Listening" : "Waiting for microphone samples…"
        }
    }

    func finished(status exitStatus: Int32, stderr: String) {
        stream = nil
        running = false
        status = exitStatus == 0 && sampledMicrophone ? "Test finished" : "Test unavailable"
        if exitStatus != 0 {
            warning = MeetingsCLI.sentence(fromStderr: stderr) ?? "The audio monitor exited with status \(exitStatus)."
        } else if !sampledMicrophone, warning == nil {
            warning = "No microphone samples were received."
        }
    }

    func stop() {
        generation += 1
        stream?.stop()
        stream = nil
        running = false
        status = "Stopped"
    }
}

struct MeetingsMicrophonePage: View {
    let model: MeetingsSettingsModel
    @State private var test = MicrophoneTest()
    @State private var host = HostWindow()
    @State private var closed = false
    @Environment(\.nativeSettingsIndexing) private var indexing
    @AppStorage("meetings.microphone.startOnOpen") private var startOnOpen = true

    init(model: MeetingsSettingsModel, defaults: UserDefaults) {
        self.model = model
        _startOnOpen = AppStorage(wrappedValue: true, "meetings.microphone.startOnOpen", store: defaults)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            NativeSettingsCard("Test audio inputs", subtitle: "Say something with playback stopped. Then play something while you stay quiet.") {
                meter("Microphone", test.reading?.mic)
                Divider()
                meter("System sound", test.reading?.system)
                Divider()
                LabeledContent("Microphone share", value: percent(test.reading?.micShare))
                LabeledContent("Last minute", value: conclusion)
                LabeledContent("Share during louder microphone passages", value: percent(test.reading?.calibration.sourceMicShare))
                if let warning = test.warning, !warning.isEmpty {
                    Label(warning, systemImage: "exclamationmark.triangle").foregroundStyle(.orange).textSelection(.enabled)
                }
                HStack {
                    Text(test.status).foregroundStyle(.secondary)
                    Spacer()
                    Button(test.running ? "Stop test" : "Start test") {
                        if test.running { test.stop() } else { test.start() }
                    }
                    .disabled(!model.writes || indexing)
                    .accessibilityIdentifier("meetings.microphone.test")
                }
                Divider()
                NativeSettingsToggle("Start a test when this page opens", detail: "Listen for up to one minute. Test audio is never saved.",
                                     identifier: "meetings.microphone.startOnOpen", isOn: $startOnOpen)
            }
            MeetingsSettingsFrame(model: model) { settings in
                let saved = settings.global.capture.levels
                NativeSettingsCard("During recordings") {
                    NativeSettingsToggle("Save level readings", detail: "Keep levels, microphone share, audio devices and mute state with the meeting.",
                                         identifier: "meetings.capture.levels.enabled",
                                         isOn: Binding(get: { saved?.enabled ?? true },
                                                       set: { model.set(["global", "capture", "levels", "enabled"], $0) }))
                    Divider()
                    Stepper(value: Binding(get: { saved?.intervalSec ?? 30 },
                                           set: { model.set(["global", "capture", "levels", "intervalSec"], $0) }), in: 1...3600) {
                        LabeledContent("Save a reading every", value: Plural.count(saved?.intervalSec ?? 30, "second"))
                    }
                    .disabled(saved?.enabled == false)
                    .accessibilityIdentifier("meetings.capture.levels.intervalSec")
                }
            }
        }
        .background(HostWindowReader(host: host))
        .onAppear { if model.writes && !indexing && startOnOpen { test.start() } }
        .onDisappear { test.stop() }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.willCloseNotification)) { notice in
            if let window = notice.object as? NSWindow, window === host.window { closed = true; test.stop() }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { notice in
            guard closed, let window = notice.object as? NSWindow, window === host.window else { return }
            closed = false
            if model.writes && !indexing && startOnOpen { test.start() }
        }
    }

    private var conclusion: String {
        if let value = test.reading?.voiceMicShare { return "Your voice stays on the microphone: " + percent(value) }
        return test.reading == nil ? "Awaiting audio" : "Channel separation unconfirmed"
    }

    private func percent(_ value: Double?) -> String {
        value.map { $0.formatted(.percent.precision(.fractionLength(0))) } ?? "—"
    }

    private func meter(_ name: String, _ channel: MicrophoneReading.Channel?) -> some View {
        let value = channel?.dbfs
        let label = value.map { String(format: "%.1f dBFS", $0) } ?? (channel?.sampled == true ? "Silent" : "No samples")
        return VStack(alignment: .leading, spacing: 4) {
            HStack { Text(name); Spacer(); Text(label).monospacedDigit() }
            ProgressView(value: max(0, min(60, (value ?? -60) + 60)), total: 60)
                .progressViewStyle(.linear).accessibilityHidden(true)
            Text(channel?.device ?? "Device unavailable").font(.caption).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}
