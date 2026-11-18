import SwiftUI

/// Keyboard focus belongs to one control in one window, even when the Audio tab and timeline show the same lane.
struct EditorRowFocus: Equatable {
    enum Area: Equatable { case layers, timelineSound, inspectorSound }
    let area: Area
    let id: String
    var isLayer: Bool { area == .layers }
    func withID(_ id: String) -> Self { Self(area: area, id: id) }
}

struct EditorSoundRow: Identifiable {
    let lane: EditProject.AudioLane
    let waveform: Waveform
    let voiceover: EditProject.Voiceover?
    let music: EditProject.Music?
    let mixed: Bool
    var id: String { lane.id }
    var name: String { mixed ? "Mixed sound" : lane.displayName }
    var level: String { "\(Int((lane.volume * 100).rounded()))%" }
    var accessibilityValue: String { lane.muted ? "muted" : level }

    /// Source files follow kept clips. Music follows output time and starts its next loop at file time zero.
    @MainActor
    func peak(source: Range<Int64>, output: Range<Int64>) -> Float {
        let duration = waveform.durationUs
        guard duration > 0 else { return 0 }
        var range = source
        if let music {
            let skip = min(Int64(music.startMs ?? 0) * 1000, max(0, duration - 500_000))
            let start = skip + output.lowerBound
            let end = skip + output.upperBound
            if music.loop != false {
                if end - start >= duration { return level(0..<duration) }
                let low = start % duration
                if end / duration > start / duration {
                    return max(level(low..<duration), level(0..<(end % duration)))
                }
                return level(low..<(end % duration))
            }
            range = start..<end
        } else if let voiceover {
            guard voiceover.card == nil else { return 0 }
            let played = range.clamped(to: voiceover.atUs..<(voiceover.atUs + voiceover.durationUs))
            let origin = voiceover.atUs - (voiceover.skipUs ?? 0)
            range = (played.lowerBound - origin)..<(played.upperBound - origin)
        } else if lane.file != nil {
            let origin = Int64(lane.offsetMs) * 1000
            range = (range.lowerBound - origin)..<(range.upperBound - origin)
        }
        return level(range.clamped(to: 0..<duration))

        func level(_ range: Range<Int64>) -> Float {
            guard !range.isEmpty else { return 0 }
            return waveform.peak(fromUs: range.lowerBound, toUs: range.upperBound - 1, track: lane.track ?? 0)
        }
    }
}

struct SoundLanesView: View {
    let model: EditorModel
    /// Nil in the Audio inspector, which uses the very same controls without the waveform.
    var scale: TimelineScale?
    @FocusState private var focus: String?

    var body: some View {
        let area: EditorRowFocus.Area = scale == nil ? .inspectorSound : .timelineSound
        LazyVStack(spacing: 0) {
            ForEach(model.soundRows) { row in
                let prefix = scale == nil ? "recorder.audio.sound." : "recorder.timeline.sound."
                let id = prefix + row.id
                HStack(spacing: 5) {
                    Button { model.toggleMute(row) } label: {
                        Image(systemName: row.lane.muted ? "speaker.slash.fill" : "speaker.wave.2")
                            .frame(width: 26, height: 26)
                    }
                    .buttonStyle(.genHoverPlain())
                    .accessibilityLabel(row.lane.muted ? "Unmute \(row.name)" : "Mute \(row.name)")
                    .accessibilityIdentifier(id + ".mute")
                    .instantTooltip(row.lane.muted ? "Unmute \(row.name) (M)" : "Mute \(row.name) (M)")
                    Text(verbatim: row.name).lineLimit(1)
                    if scale == nil { Spacer(minLength: 2) }
                    Menu { levels(row) } label: {
                        Text(verbatim: row.level).monospacedDigit().frame(minHeight: 24)
                    }
                    .fixedSize()
                    .menuStyle(.borderlessButton)
                    .accessibilityLabel("\(row.name) volume")
                    .accessibilityValue(row.level)
                    .accessibilityIdentifier(id + ".volume")
                    .instantTooltip("Set \(row.name) volume")
                    if scale != nil { Spacer(minLength: 0) }
                }
                .font(.system(size: 11.5))
                .padding(.horizontal, 6)
                .padding(.bottom, scale == nil ? 0 : 8)
                .frame(height: TimelineView.sourceRowHeight)
                .background(alignment: .bottom) {
                    if let scale {
                        LaneWaveform(row: row, placed: model.rowClips, scale: scale)
                            .frame(height: 9)
                    }
                }
                .background(focus == row.id ? Color.accentColor.opacity(0.16) : Color.clear)
                .contentShape(Rectangle())
                .onTapGesture { focus = row.id }
                .focusable()
                .focused($focus, equals: row.id)
                .contextMenu { levels(row) }
                .accessibilityElement(children: .contain)
                .accessibilityLabel(row.name)
                .accessibilityValue(row.accessibilityValue)
                .accessibilityIdentifier(id)
                .id(row.id)
            }
        }
        .onChange(of: focus) { _, id in
            if let id {
                model.focusedEditorRow = .init(area: area, id: id)
                model.requestedRowFocus = model.focusedEditorRow
            }
            else if model.focusedEditorRow?.area == area { model.focusedEditorRow = nil }
        }
        .onChange(of: model.requestedRowFocus) { _, next in
            if next?.area == area { focus = next?.id }
        }
        .onDisappear { if model.focusedEditorRow?.area == area { model.focusedEditorRow = nil } }
    }

    @ViewBuilder private func levels(_ row: EditorSoundRow) -> some View {
        ForEach([0, 25, 50, 75, 100, 125, 150, 175, 200], id: \.self) { percent in
            Button {
                model.edit([.audioLane(.init(id: row.id, volume: Double(percent) / 100))])
            } label: {
                if row.lane.volume == Double(percent) / 100 {
                    Label("\(percent)%", systemImage: "checkmark")
                } else { Text("\(percent)%") }
            }
        }
    }
}

private struct LaneWaveform: View {
    let row: EditorSoundRow
    let placed: [TimelineMap.Placed]
    let scale: TimelineScale

    var body: some View {
        let ready = row.waveform.hasAudio
        Canvas { context, size in
            guard ready else { return }
            var bars = Path()
            for clip in placed {
                let width = scale.width(clip.clip.outputDurationUs)
                let count = max(1, Int(width / 3))
                for i in 0..<count {
                    let a = Double(i) / Double(count), b = Double(i + 1) / Double(count)
                    func span(start: Int64, length: Int64) -> Range<Int64> {
                        (start + Int64(Double(length) * a))..<(start + Int64(Double(length) * b))
                    }
                    let peak = row.peak(source: span(start: clip.clip.fromUs, length: clip.clip.sourceDurationUs),
                                        output: span(start: clip.outStartUs, length: clip.clip.outputDurationUs))
                    let height = CGFloat(peak) * size.height
                    bars.addRect(CGRect(x: scale.x(clip.outStartUs) + a * width,
                                        y: (size.height - height) / 2, width: 2, height: height))
                }
            }
            context.fill(bars, with: .color(.green.opacity(row.lane.muted ? 0.25 : 0.8)))
        }
        .accessibilityHidden(true)
        .allowsHitTesting(false)
    }
}
