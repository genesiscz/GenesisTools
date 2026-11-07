import AppKit
import SwiftUI
import UniformTypeIdentifiers

// R4 voiceover clips, 8 music ducking: the Audio tab's voiceover list and the dip of the music under speech.

extension EditorModel {
    /// A sound file played from the playhead's source time (the `voiceover` op, which measures its length); one undo.
    func addVoiceover() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.audio]
        panel.canChooseDirectories = false
        panel.message = "A voiceover to play from the playhead"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let atUs = TimelineMap.sourceTime(atOutput: clock.outUs, in: project)
        let op: [String: Any] = ["op": "voiceover", "at": Double(atUs) / 1_000_000, "file": url.path,
                                 "label": url.deletingPathExtension().lastPathComponent]
        let json = (try? JSONSerialization.data(withJSONObject: op, options: [.sortedKeys])).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
        applyOps(json) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success: self.show("Added \(url.lastPathComponent) at \(formatClock(self.clock.outUs, tenths: true)). ⌘Z takes it back.", error: false)
            case let .failure(failure): self.show("The voiceover was not added: \(failure.reason)", error: true)
            }
        }
    }

    func removeVoiceover(_ id: String) {
        applyOps(#"{"id":"\#(id)","op":"unvoiceover"}"#) { [weak self] result in
            guard let self else { return }
            if case let .failure(failure) = result { self.show("The voiceover was not removed: \(failure.reason)", error: true) }
        }
    }

    /// The dB dip of the music; nil goes back to the music's older share.
    func setDucking(_ change: ((inout EditProject.Ducking) -> Void)?) {
        setAudio { audio in
            guard let change else {
                audio.ducking = nil
                return
            }
            var ducking = audio.ducking ?? EditProject.Ducking()
            change(&ducking)
            audio.ducking = ducking
        }
    }
}

/// How far the music drops under speech, in dB, and under what (the `ducking` op). Off keeps the share slider above.
struct DuckingSection: View {
    @Bindable var model: EditorModel

    var body: some View {
        let ducking = model.project.audio.ducking
        VStack(alignment: .leading, spacing: 8) {
            SwitchRow("Set the dip in dB", isOn: Binding(get: { ducking != nil }, set: { on in
                model.setDucking(on ? { _ in } : nil)
            }))
            .instantTooltip("The music drops by a set number of decibels under speech, with its own fade time and sources")
            .accessibilityIdentifier("recorder.audio.ducking")
            if let ducking {
                SectionLabel(text: "Quieter by", value: ducking.db == 0 ? "Off" : "\(Int(ducking.db.rounded())) dB")
                Slider(value: Binding(get: { ducking.db }, set: { value in model.setDucking { $0.db = value.rounded() } }), in: 0...30)
                    .accessibilityLabel("Music quieter under speech, in decibels")
                    .accessibilityValue("\(Int(ducking.db.rounded())) dB")
                    .accessibilityIdentifier("recorder.audio.ducking.db")
                SectionLabel(text: "Dip and return")
                GenSegmentedTabs("Dip time", items: [.init(0, "Cut"), .init(150, "0.15 s"), .init(300, "0.3 s"), .init(600, "0.6 s"), .init(1000, "1 s")],
                                 selection: Binding(get: { [0, 150, 300, 600, 1000].min { abs($0 - ducking.fadeMs) < abs($1 - ducking.fadeMs) } ?? 300 },
                                                    set: { value in model.setDucking { $0.fadeMs = value } }),
                                 minSegmentWidth: 40, identifier: "recorder.audio.ducking.fade", fillsWidth: true)
                SwitchRow("Under the transcript's lines", isOn: Binding(get: { ducking.transcript }, set: { on in model.setDucking { $0.transcript = on } }))
                    .accessibilityIdentifier("recorder.audio.ducking.transcript")
                SwitchRow("Under the voiceovers", isOn: Binding(get: { ducking.voiceovers }, set: { on in model.setDucking { $0.voiceovers = on } }))
                    .accessibilityIdentifier("recorder.audio.ducking.voiceovers")
            }
        }
    }
}

/// The voiceover clips: each with its time, where it plays, its volume and a remove button; one add button.
struct VoiceoverSection: View {
    @Bindable var model: EditorModel

    var body: some View {
        let clips = model.project.audio.voiceovers ?? []
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(text: "Voiceovers", value: clips.isEmpty ? nil : "\(clips.count)")
            ForEach(clips) { clip in
                VoiceoverRow(model: model, clip: clip)
            }
            WideButton(title: "Add Voiceover at the Playhead…", systemImage: "waveform.badge.plus") {
                model.addVoiceover()
            }
            .instantTooltip("A narration file (mp3, wav, aiff) that plays from here; the music drops under it")
            .accessibilityIdentifier("recorder.audio.voiceover.add")
        }
    }
}

private struct VoiceoverRow: View {
    let model: EditorModel
    let clip: EditProject.Voiceover

    var body: some View {
        let missing = !FileManager.default.fileExists(atPath: clip.file)
        let plays = TimelineMap.outputTime(ofSource: clip.atUs, in: model.project)
        let name = clip.label ?? URL(fileURLWithPath: clip.file).deletingPathExtension().lastPathComponent
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: missing ? "exclamationmark.triangle.fill" : "waveform")
                    .foregroundStyle(missing ? Color.orange : RecorderPalette.dim)
                    .accessibilityHidden(true)
                Text(verbatim: name).lineLimit(1).truncationMode(.middle)
                    .instantTooltip(missing ? "\(clip.file) is gone; it does not play" : clip.file)
                Spacer()
                Text(verbatim: plays.map { formatClock($0, tenths: true) } ?? "cut")
                    .font(.system(size: 11.5).monospacedDigit()).foregroundStyle(plays == nil ? Color.orange : RecorderPalette.dim)
                    .instantTooltip(plays == nil ? "Its start is in a cut part, so it does not play" : "Where it starts in the edited movie")
                IconButton(systemName: "trash", tooltip: "Remove this voiceover") {
                    model.removeVoiceover(clip.id)
                }
                .accessibilityIdentifier("recorder.audio.voiceover.remove.\(clip.id)")
            }
            Slider(value: Binding(get: { clip.volume }, set: { value in
                model.setAudio { audio in
                    guard let index = audio.voiceovers?.firstIndex(where: { $0.id == clip.id }) else { return }
                    audio.voiceovers?[index].volume = (value * 20).rounded() / 20
                }
            }), in: 0...2)
            .accessibilityLabel("\(name) volume")
            .accessibilityValue("\(Int((clip.volume * 100).rounded())) percent")
        }
        .accessibilityElement(children: .contain)
        .liveRow()
    }
}
