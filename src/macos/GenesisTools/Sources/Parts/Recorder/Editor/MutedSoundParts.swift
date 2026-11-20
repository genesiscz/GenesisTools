import Foundation

/// A part of one sound lane made silent (`audioMute`) and played again (`audioUnmute`). Both go through the edit op
/// path, so ⌘Z undoes them and the recorder service owns the rules (the source clock, splits, the new part's id).
extension EditorModel {
    /// The range a sound lane mutes, in output microseconds: the range dragged on the frames lane, else the part
    /// between I and O.
    var soundSelection: TimelineRange? {
        if let range = timelineRange { return range }
        return exportPart.map { TimelineRange(fromUs: $0.fromUs, toUs: $0.toUs) }
    }

    /// Only the recorded sound mixes per part; a voiceover or the music bed has its own clock.
    static func lanePartsMute(_ lane: EditProject.AudioLane) -> Bool {
        lane.source != .voiceover && lane.source != .music
    }

    /// Mutes what plays over the selected range on `row`'s lane, as a muted part of its own.
    func muteSelection(_ row: EditorSoundRow) {
        guard let range = soundSelection else {
            show("Drag a range on the frames lane, or set a part with I and O, then mute it on a sound lane.", error: false)
            return
        }
        let from = TimelineMap.sourceTime(atOutput: range.fromUs, in: project)
        let to = TimelineMap.sourceTime(atOutput: range.toUs, in: project)
        guard to > from else { return }
        timelineRange = nil
        let name = row.name
        edit([.audioMute(.init(id: row.id, from: EditOpDiff.seconds(from), to: EditOpDiff.seconds(to)))], then: { [weak self] _, _ in
            self?.show("Muted \(name) from \(formatClockRange(range.fromUs, range.toUs)); ⌘Z plays it again.", error: false)
        }, failed: { [weak self] reason in
            self?.show("Nothing was muted: \(reason)", error: false)
        })
    }

    /// Plays one muted part of `row`'s lane again.
    func unmutePart(_ row: EditorSoundRow, _ part: EditProject.AudioLane.MutedRange) {
        edit([.audioUnmute(.init(id: row.id, part: part.id))])
    }

    /// A muted part as the ruler shows it ("00:01.0 to 00:01.5"), or its recording time when the edit cut it.
    func mutedPartTitle(_ part: EditProject.AudioLane.MutedRange) -> String {
        let range = editRange(project, fromUs: part.startUs, toUs: part.endUs)
        return range.edit == "Cut from the edit" ? (range.recording ?? range.edit) : range.edit
    }
}
