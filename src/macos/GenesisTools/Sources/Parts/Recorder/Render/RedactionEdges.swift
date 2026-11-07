import AVFoundation
import Foundation

// R5 5 redaction edges
/// The source movie's frame times, read through a sample cursor (no decoding). A screen recording writes a frame only
/// when something changes, so a frame can stay on screen long after its own time: the frame at 3.95 s of a recording
/// that wrote nothing until 4.10 s is what every output frame between them shows.
final class SourceFrames: @unchecked Sendable {
    private let track: AVAssetTrack
    private let durationUs: Int64
    private let lock = NSLock()
    private var next: [Int64: Int64] = [:]

    init(track: AVAssetTrack, durationUs: Int64) {
        self.track = track
        self.durationUs = durationUs
    }

    /// The time of the first frame at or after `us`: until then the frame before `us` stays on screen. The movie's
    /// end when no frame follows.
    func nextFrame(atOrAfter us: Int64) -> Int64 {
        lock.lock()
        if let known = next[us] {
            lock.unlock()
            return known
        }
        lock.unlock()
        let time = CMTime(value: us, timescale: 1_000_000)
        var answer = durationUs
        if let cursor = track.makeSampleCursor(presentationTimeStamp: time) {
            // The cursor sits on the last frame at or before `time` (or the first frame of the movie).
            if cursor.presentationTimeStamp >= time {
                answer = Self.us(cursor.presentationTimeStamp)
            } else if cursor.stepInPresentationOrder(byCount: 1) == 1 {
                answer = Self.us(cursor.presentationTimeStamp)
            }
        }
        lock.lock()
        next[us] = answer
        lock.unlock()
        return answer
    }

    private static func us(_ time: CMTime) -> Int64 { Int64((time.seconds * 1_000_000).rounded()) }
}

/// The hidden parts as the renderer draws them. A hiding part (blur, pixelate, black) covers every output frame that
/// shows a source frame from its own time:
/// - its end moves to the next source frame, so a frame from inside the part that stays on screen after the part's end
///   (a screen recording writes no frame while nothing moves) stays covered;
/// - with `redactionJoins.snapMs` (250 ms unless set), an end that falls that close before a cut moves to the cut, a
///   start that close after a cut moves to it, and a gap that short between two hiding parts closes, so the frames a
///   box placed a little early or late would leave open are covered too.
/// Spotlights keep their own times. Nothing here ever shortens a part.
enum RedactionEdges {
    /// What `effective` reads from a project, so a cached answer is compared per frame without the whole project.
    struct Key: Equatable {
        var redactions: [EditProject.Redaction]?
        var clips: [EditProject.Clip]
        var joins: EditProject.RedactionJoins?

        init(_ project: EditProject) {
            redactions = project.redactions
            clips = project.clips
            joins = project.redactionJoins
        }
    }

    static func effective(_ project: EditProject, frames: SourceFrames?) -> [EditProject.Redaction] {
        guard var parts = project.redactions, !parts.isEmpty else { return [] }
        let snapUs = Int64(max(0, (project.redactionJoins ?? .init()).snapMs)) * 1000
        let cuts = cutEdges(project)
        for index in parts.indices where parts[index].style != .spotlight {
            var part = parts[index]
            if snapUs > 0 {
                if let end = cuts.ends.first(where: { $0 > part.endUs && $0 - part.endUs <= snapUs }) { part.endUs = end }
                if let start = cuts.starts.last(where: { $0 < part.startUs && part.startUs - $0 <= snapUs }) { part.startUs = start }
            }
            parts[index] = part
        }
        if snapUs > 0 {
            // Two hiding parts with a short gap meet: the earlier one stays on until the later one starts.
            let hiding = parts.indices.filter { parts[$0].style != .spotlight }
            for index in hiding {
                let end = parts[index].endUs
                let following = hiding.map { parts[$0].startUs }.filter { $0 > end && $0 - end <= snapUs }.min()
                if let following { parts[index].endUs = following }
            }
        }
        if let frames {
            for index in parts.indices where parts[index].style != .spotlight {
                parts[index].endUs = max(parts[index].endUs, frames.nextFrame(atOrAfter: parts[index].endUs))
            }
        }
        return parts
    }

    /// The source times where a kept clip ends before a cut (or the movie's end) and starts after one.
    static func cutEdges(_ project: EditProject) -> (ends: [Int64], starts: [Int64]) {
        let clips = project.clips.filter { $0.sourceDurationUs > 0 }
        var ends: [Int64] = [], starts: [Int64] = []
        for (index, clip) in clips.enumerated() {
            let previous = index > 0 ? clips[index - 1] : nil
            let next = index + 1 < clips.count ? clips[index + 1] : nil
            if next?.fromUs != clip.toUs { ends.append(clip.toUs) }
            if previous?.toUs != clip.fromUs, clip.fromUs > 0 { starts.append(clip.fromUs) }
        }
        return (ends.sorted(), starts.sorted())
    }
}
