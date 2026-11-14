import AVFoundation
import SwiftUI

/// A bounded source interval, using the same service methods as CLI and agent clients.
struct AcousticEvidenceView: View {
    let service: MeetingsService?
    let meeting: String
    let fromSec: Double
    let toSec: Double
    @Environment(\.dismiss) private var dismiss
    @State private var inspection: MeetingsAPI.AcousticInspect.Result?
    @State private var tracks: MeetingsAPI.AcousticClip.Result?
    @State private var voice: MeetingsAPI.VoiceScore.Result?
    @State private var failure: String?
    @State private var busy = false
    @State private var enrolmentName = ""
    @State private var sound: AVAudioPlayer?

    private var params: MeetingsAPI.AcousticParams {
        .init(meeting: meeting, fromSec: fromSec, toSec: min(toSec, fromSec + 60))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Channel and voice evidence").font(.headline)
            Text("\(MeetingsFormat.clock(params.fromSec)) to \(MeetingsFormat.clock(params.toSec))")
                .foregroundStyle(.secondary)
            if let metric = tracks?.metric ?? inspection?.metric {
                Grid(alignment: .leading) {
                    GridRow { Text("Waveform correlation"); Text(metric.correlation, format: .number.precision(.fractionLength(3))) }
                    GridRow { Text("Explained microphone power"); Text(metric.echoOfCall, format: .percent.precision(.fractionLength(1))) }
                    GridRow { Text("Playback to microphone lag"); Text("\(metric.lagMs, specifier: "%.1f") ms") }
                    GridRow { Text("Raw microphone RMS"); Text(metric.rawMicRms, format: .number.precision(.fractionLength(5))) }
                    GridRow { Text("Residual microphone RMS"); Text(metric.cleanMicRms, format: .number.precision(.fractionLength(5))) }
                }
            }
            Text(inspection?.reason ?? "Evidence unavailable until explicitly collected.")
                .font(.callout).foregroundStyle(.secondary)
            Text("Cleaned microphone is a linear estimate. Speech quality is unverified. Raw audio stays available.")
                .font(.callout).foregroundStyle(.secondary)
            HStack {
                Button("Collect echo evidence") { collect() }.disabled(busy || service == nil)
                Button("Prepare public voice model") { prepareModel() }.disabled(busy || service == nil)
            }
            HStack {
                Button("Prepare channel previews") { prepare() }.disabled(busy || service == nil)
                if let tracks {
                    Button("Raw mic") { play(tracks.tracks.rawMic) }
                    Button("Isolated call") { play(tracks.tracks.isolatedCall) }
                    Button("Cleaned estimate") { play(tracks.tracks.cleanMic) }
                    Button("Stop") { sound?.stop() }
                }
            }
            HStack {
                Button("Score call voice") { score() }.disabled(busy || service == nil || inspection?.layout == nil)
                Button("Collect enrolled voice evidence") { collectVoices() }.disabled(busy || service == nil)
                if let voice {
                    Text(voice.person.map { "By voice: \($0)" } ?? "Voice unknown")
                    Text(voice.quality).foregroundStyle(.secondary)
                }
            }
            HStack {
                TextField("Confirmed speaker name for this call interval", text: $enrolmentName)
                Button("Enrol confirmed call voice") { enrol() }
                    .disabled(busy || service == nil || enrolmentName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || inspection?.layout == nil)
            }
            Text("Enrol only a single-speaker interval whose identity you confirmed. Raw microphone and call enrolments stay separate.")
                .font(.caption).foregroundStyle(.secondary)
            if let voice {
                ForEach(voice.candidates, id: \.person) { candidate in
                    HStack { Text(candidate.person); Text(candidate.score, format: .number.precision(.fractionLength(3))) }
                }
                Text("Cosine scores are not probabilities. \(voice.reason)").font(.caption).foregroundStyle(.secondary)
            }
            if let failure { Text(failure).foregroundStyle(.red).textSelection(.enabled) }
            HStack { Spacer(); Button("Done") { sound?.stop(); dismiss() }.keyboardShortcut(.defaultAction) }
        }
        .padding(20).frame(minWidth: 540)
        .accessibilityIdentifier("meetings.acoustic.evidence")
        .task {
            guard let service else { failure = "Meetings service unavailable"; return }
            do { inspection = try await service.call(MeetingsAPI.AcousticInspect.self, params) }
            catch { failure = asFailure(error).sentence }
        }
        .onDisappear { sound?.stop() }
    }
    private func prepare() {
        guard let service else { return }
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do { tracks = try await service.call(MeetingsAPI.AcousticClip.self, params) }
            catch { failure = asFailure(error).sentence }
        }
    }
    private func score() {
        guard let service, let layout = inspection?.layout else { return }
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do { voice = try await service.call(MeetingsAPI.VoiceScore.self, .init(meeting: meeting, fromSec: params.fromSec, toSec: params.toSec, channel: layout == "left-mic" ? 1 : 0)) }
            catch { failure = asFailure(error).sentence }
        }
    }
    private func collect() {
        guard let service else { return }
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do {
                _ = try await service.call(MeetingsAPI.AcousticCollect.self, .init(meeting: meeting), timeout: 300)
                inspection = try await service.call(MeetingsAPI.AcousticInspect.self, params)
            } catch { failure = asFailure(error).sentence }
        }
    }
    private func collectVoices() {
        guard let service else { return }
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do { _ = try await service.call(MeetingsAPI.VoiceCollect.self, .init(meeting: meeting), timeout: 3600) }
            catch { failure = asFailure(error).sentence }
        }
    }
    private func prepareModel() {
        guard let service else { return }
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do { _ = try await service.call(MeetingsAPI.VoicePrepare.self, .init(download: true), timeout: 300) }
            catch { failure = asFailure(error).sentence }
        }
    }
    private func enrol() {
        guard let service, let layout = inspection?.layout else { return }
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do {
                voice = try await service.call(MeetingsAPI.VoiceEnroll.self,
                    .init(meeting: meeting, fromSec: params.fromSec, toSec: params.toSec,
                          channel: layout == "left-mic" ? 1 : 0,
                          person: enrolmentName.trimmingCharacters(in: .whitespacesAndNewlines), confirmed: true))
            } catch { failure = asFailure(error).sentence }
        }
    }
    private func play(_ path: String) {
        sound?.stop()
        // The meeting's own playback pauses first: the channels are compared one at a time.
        NotificationCenter.default.post(name: MomentPlayer.previewWillPlay, object: nil)
        do { sound = try AVAudioPlayer(contentsOf: URL(fileURLWithPath: path)); sound?.play() }
        catch { failure = asFailure(error).sentence }
    }
}
