import AppKit
import GenesisKit
import SwiftUI

struct RecastTranscriptReview: Codable, Identifiable {
    struct Segment: Codable, Identifiable {
        var text: String
        var startMs: Double
        var endMs: Double
        var id: String { "\(startMs):\(endMs):\(text)" }
    }
    var id: String
    var documentId: String
    var revision: Int
    var sourceId: String
    var sourceHash: String
    var startMs: Double
    var endMs: Double
    var text: String
    var engine: String
    var language: String?
    var timing: String
    var segments: [Segment]
    var warnings: [String]
}

extension RecastModel {
    var selectedAudioInterval: (start: Double, end: Double) {
        let end = audio.selectionEnd * 1000
        return (audio.selectionStart * 1000, min(end, source?.durationMs ?? end))
    }

    func transcribeAudio(modelRef: String, language: String) {
        guard let source, source.kind == "audio", let data = assets[source.assetName] else { return }
        let (start, end) = selectedAudioInterval
        guard end > start else { error = "Choose an audio interval first."; return }
        audio.pause()
        perform("Transcribing selected audio") { model in
            let saved = try await model.checkpointForInference(anchor: RecastAnchor(id: recastID("anchor"), sourceId: source.id,
                sourceHash: source.contentHash, label: "Selected transcription interval",
                region: RecastRegion(kind: "audio", startMs: start, endMs: end)))
            let prepared = try await Task.detached(priority: .userInitiated) {
                let folder = FileManager.default.temporaryDirectory.appendingPathComponent("recast-recording-" + UUID().uuidString)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                let url = folder.appendingPathComponent(source.assetName)
                do { try data.write(to: url, options: .atomic) }
                catch {
                    do { try FileManager.default.removeItem(at: folder) }
                    catch { HubPerf.log("recast: recording preparation cleanup failed: \(error)") }
                    throw error
                }
                return (folder, url)
            }.value
            defer {
                do { try FileManager.default.removeItem(at: prepared.0) }
                catch { HubPerf.log("recast: recording cleanup failed: \(error)") }
            }
            try Task.checkCancellation()
            var args = ["--source", source.id, "--audio", prepared.1.path, "--start-ms", String(start), "--end-ms", String(end)]
            if !modelRef.isEmpty { args += ["--model", modelRef] }
            if !language.isEmpty { args += ["--language", language] }
            let answer = try await model.command("transcribe", file: saved, arguments: args, timeoutSeconds: 620)
            model.audioTranscript = try JSONDecoder().decode(RecastTranscriptReview.self, from: Data(answer.utf8))
        }
    }

    func saveAudioTranscript(_ review: RecastTranscriptReview, mode: String) {
        guard audioTranscript?.id == review.id, let file, file.id == review.documentId, file.revision == review.revision else {
            error = "The conversion changed. Transcribe this interval again before saving readings."
            return
        }
        guard let collection else { return }
        let recordId = selectedRecord, fieldId = selectedField
        perform("Saving reviewed transcript") { model in
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("recast-transcript-" + UUID().uuidString)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            defer {
                do { try FileManager.default.removeItem(at: folder) }
                catch { HubPerf.log("recast: transcript preparation cleanup failed: \(error)") }
            }
            let url = folder.appendingPathComponent("review.json")
            try JSONEncoder().encode(review).write(to: url, options: .atomic)
            var args = ["--review", url.path, "--collection", collection.id, "--mode", mode]
            if mode == "field" { args += ["--record", recordId, "--field", fieldId] }
            let answer = try await model.command("capture-transcript", file: file, arguments: args)
            let operations = try JSONDecoder().decode([RecastJSON].self, from: Data(answer.utf8))
            try await model.apply(operations, title: "Save transcript readings")
            model.audioTranscript = nil
            model.notice = "Literal transcript saved. Listen to the recording and review proposed values before accepting."
        }
    }
}

struct RecastAudioPane: View {
    @ObservedObject var model: RecastModel
    @ObservedObject var audio: NativeAudioPlayback
    var readOnly: Bool
    @State private var choices: [RecastTaskAccountChoice] = []
    @State private var muted = false
    @State private var choice = ""
    @State private var modelID = ""
    @State private var language = ""
    @State private var choicesLoading = false
    @State private var choicesError: String?
    private var selected: RecastTaskAccountChoice? { choices.first { $0.id == choice } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack {
                    Image(systemName: "waveform").font(.system(size: 26)).foregroundStyle(ReviewPalette.renamed)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Recording").font(.system(size: 16, weight: .semibold))
                        Text(String(format: "%.1f seconds · original audio", audio.duration))
                            .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                    }
                    Spacer()
                    if audio.isLoading { ProgressView().controlSize(.small) }
                }
                HStack(spacing: 14) {
                    Button(audio.isPlaying ? "Pause" : "Play selection", systemImage: audio.isPlaying ? "pause.fill" : "play.fill") {
                        if audio.isPlaying { audio.pause() } else { audio.playSelection() }
                    }.buttonStyle(.genHoverPlain()).disabled(!audio.canPlay)
                    Toggle("Mute", isOn: $muted).toggleStyle(.checkbox).accessibilityLabel("Mute audio playback")
                        .onAppear { muted = audio.volume == 0 }
                        .onChange(of: muted) { _, value in audio.volume = value ? 0 : 1 }
                    Spacer()
                    Text(String(format: "%.2f / %.2f s", audio.position, audio.selectionEnd)).monospacedDigit()
                }.font(.system(size: 12))
                if audio.selectionEnd > audio.selectionStart {
                    Slider(value: Binding(get: { audio.position }, set: { audio.seek(to: $0) }),
                           in: audio.selectionStart...audio.selectionEnd)
                        .accessibilityLabel("Playback position in selected audio interval")
                        .disabled(audio.isLoading)
                }
                HStack(spacing: 14) {
                    intervalField("Start", value: audio.selectionStart) { audio.select(start: $0, end: audio.selectionEnd) }
                    intervalField("End", value: audio.selectionEnd) { audio.select(start: audio.selectionStart, end: $0) }
                    Button("Whole recording") { audio.select(start: 0, end: audio.duration) }
                        .buttonStyle(.genHoverPlain()).disabled(audio.duration <= 0)
                }.font(.system(size: 11))
                Text("Playback stops at the end of this selection. Selecting source evidence sets the corresponding interval.")
                    .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                if let error = audio.error { Text(error).foregroundStyle(ReviewPalette.modified).font(.system(size: 12)) }
                if !readOnly {
                    Divider()
                    Text("Turn speech into source readings").font(.system(size: 13, weight: .semibold))
                    if choicesLoading { ProgressView("Reading configured providers…").controlSize(.small) }
                    else if choices.isEmpty {
                        Text("No enabled transcription account is configured. Add one in AI settings, then refresh.")
                            .font(.system(size: 12)).foregroundStyle(ReviewPalette.dim)
                    } else {
                        Picker("Transcription account", selection: $choice) {
                            ForEach(choices) { item in
                                Text(item.name + " · " + item.provider + (item.local ? " · local" : "")).tag(item.id)
                            }
                        }.accessibilityLabel("Transcription account")
                        TextField("Model (provider default when blank)", text: $modelID).textFieldStyle(.roundedBorder)
                            .accessibilityLabel("Transcription model")
                        TextField("Spoken language, optional (for example en or cs)", text: $language).textFieldStyle(.roundedBorder)
                            .accessibilityLabel("Spoken language")
                        if let selected {
                            Text(selected.local ?
                                "Runs through your configured local provider. A model download may be needed." :
                                "The selected interval will be sent to " + selected.provider + " using this account.")
                                .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                        }
                    }
                    if let choicesError { Text(choicesError).font(.system(size: 11)).foregroundStyle(ReviewPalette.modified) }
                    HStack {
                        Button("Refresh accounts") { Task { await loadChoices() } }.buttonStyle(.genHoverPlain()).disabled(choicesLoading)
                        Spacer()
                        Button("Transcribe selection", systemImage: "text.bubble") {
                            guard let selected else { return }
                            let id = modelID.trimmingCharacters(in: .whitespacesAndNewlines)
                            model.transcribeAudio(modelRef: selected.modelRef + (id.isEmpty ? "" : ":" + id),
                                language: language.trimmingCharacters(in: .whitespacesAndNewlines))
                        }.buttonStyle(.genHoverPlain()).disabled(model.busy || selected == nil || audio.selectionEnd <= audio.selectionStart)
                    }.font(.system(size: 12))
                    Text("You will review the transcript before saving readings or creating records. Missing word times remain explicit.")
                        .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                }
            }.padding(20)
        }
        .task { if !readOnly { await loadChoices() } }
        .onChange(of: choice) { _, _ in modelID = selected?.defaultModel ?? "" }
    }

    private func intervalField(_ title: String, value: Double, update: @escaping (Double) -> Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title + " (seconds)").foregroundStyle(ReviewPalette.dim)
            TextField(title, value: Binding(get: { value }, set: { _ = update($0) }),
                      format: .number.precision(.fractionLength(0...3)))
                .textFieldStyle(.roundedBorder).frame(maxWidth: 100).accessibilityLabel(title + " of audio selection in seconds")
        }
    }

    private func loadChoices() async {
        guard !choicesLoading else { return }
        choicesLoading = true; choicesError = nil
        defer { choicesLoading = false }
        do {
            let answer = try await model.command("transcription-choices")
            try Task.checkCancellation()
            choices = try JSONDecoder().decode([RecastTaskAccountChoice].self, from: Data(answer.utf8))
            if !choices.contains(where: { $0.id == choice }) { choice = choices.first(where: \.local)?.id ?? choices.first?.id ?? "" }
        } catch is CancellationError { HubPerf.log("recast: transcription account listing cancelled") }
        catch { choicesError = error.localizedDescription }
    }
}

struct RecastTranscriptSheet: View {
    @ObservedObject var model: RecastModel
    @ObservedObject var audio: NativeAudioPlayback
    var review: RecastTranscriptReview
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Review transcript").font(.system(size: 20, weight: .semibold))
                    Text((model.file?.sources.first { $0.id == review.sourceId }?.name ?? "Recording") + " · " + review.engine)
                        .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                }
                Spacer()
                Button("Discard") { audio.pause(); model.audioTranscript = nil; dismiss() }
                    .buttonStyle(.genHoverPlain()).disabled(model.busy)
            }
            ForEach(review.warnings, id: \.self) { Text($0).font(.system(size: 12)).foregroundStyle(ReviewPalette.modified) }
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text(review.text).textSelection(.enabled).font(.system(size: 13)).frame(maxWidth: .infinity, alignment: .leading)
                    if !review.segments.isEmpty {
                        Divider()
                        Text("Timed readings").font(.system(size: 12, weight: .semibold))
                        LazyVStack(alignment: .leading, spacing: 8) {
                            ForEach(Array(review.segments.enumerated()), id: \.offset) { _, segment in
                                HStack(alignment: .top, spacing: 10) {
                                    Button(String(format: "%.1f–%.1f s", segment.startMs / 1000, segment.endMs / 1000)) {
                                        play(start: segment.startMs, end: segment.endMs)
                                    }.buttonStyle(.genHoverPlain()).disabled(!audio.canPlay).frame(width: 100)
                                    Text(segment.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                                }.font(.system(size: 12))
                            }
                        }
                    }
                }.padding(12)
            }.background(ReviewPalette.renamed.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
            if let error = model.error { NoticePill(text: error, isError: true) { model.error = nil } }
            if model.busy { ProgressView(model.progress).controlSize(.small) }
            HStack {
                Button(audio.isPlaying ? "Pause" : "Listen to selection") {
                    if audio.isPlaying { audio.pause() } else { play(start: review.startMs, end: review.endMs) }
                }.buttonStyle(.genHoverPlain()).disabled(!audio.canPlay)
                Spacer()
                Button("Save readings") { model.saveAudioTranscript(review, mode: "readings") }.buttonStyle(.genHoverPlain())
                Button("Create rows") { model.saveAudioTranscript(review, mode: "rows") }.buttonStyle(.genHoverPlain())
                Button("Read into field") { model.saveAudioTranscript(review, mode: "field") }.buttonStyle(.genHoverPlain())
                    .disabled(model.record == nil || model.field == nil)
            }.font(.system(size: 12)).disabled(model.busy)
        }.padding(22).frame(width: 880, height: 660).preferredColorScheme(.dark)
        .onAppear {
            model.selectedSource = review.sourceId
            audio.select(start: review.startMs / 1000, end: review.endMs / 1000)
        }
        .onDisappear { audio.pause() }
    }

    private func play(start: Double, end: Double) {
        if audio.select(start: start / 1000, end: end / 1000) { audio.playSelection() }
    }
}
