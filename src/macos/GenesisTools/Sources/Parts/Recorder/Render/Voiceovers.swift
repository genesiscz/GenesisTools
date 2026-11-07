import AVFoundation
import Foundation

// R4 voiceover clips
/// The edit's voiceover clips in the movie's sound: each file plays from its start's OUTPUT time at its own speed (a
/// sped-up clip under it does not speed the voice), cut short at the movie's end, on its own audio track. A clip whose
/// start is cut is left out (check() says so); a missing or silent file is skipped with a log line, never a throw.
enum VoiceoverMix {
    struct Placement: Equatable {
        var clip: EditProject.Voiceover
        /// Where it starts in the edited movie.
        var outUs: Int64
        /// How long it plays there.
        var playUs: Int64
    }

    /// The clips that play, in output order. `lengthUs` nil is the edit's own output length.
    static func placements(_ project: EditProject, lengthUs: Int64? = nil) -> [Placement] {
        let lengthUs = lengthUs ?? project.outputDurationUs
        return (project.audio.voiceovers ?? []).compactMap { clip in
            guard let outUs = TimelineMap.outputTime(ofSource: clip.atUs, in: project), outUs < lengthUs else { return nil }
            let playUs = min(clip.durationUs, lengthUs - outUs)
            return playUs > 0 ? Placement(clip: clip, outUs: outUs, playUs: playUs) : nil
        }.sorted { $0.outUs < $1.outUs }
    }

    /// Lays every clip that plays into the composition; one mix input per clip at its volume.
    static func add(to composition: AVMutableComposition, project: EditProject, lengthUs: Int64) async -> [AVMutableAudioMixInputParameters] {
        var inputs: [AVMutableAudioMixInputParameters] = []
        for placement in placements(project, lengthUs: lengthUs) {
            let asset = AVURLAsset(url: URL(fileURLWithPath: placement.clip.file))
            do {
                guard let source = try await asset.loadTracks(withMediaType: .audio).first else {
                    HubPerf.log("recorder.voiceover: no sound in \(placement.clip.file); skipped")
                    continue
                }
                let available = try await source.load(.timeRange)
                let duration = CMTimeMinimum(available.duration, EditRenderer.us(placement.playUs))
                guard duration > .zero,
                      let out = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { continue }
                try out.insertTimeRange(CMTimeRange(start: available.start, duration: duration), of: source,
                                        at: EditRenderer.us(placement.outUs))
                let parameters = AVMutableAudioMixInputParameters(track: out)
                parameters.setVolume(Float(placement.clip.volume), at: .zero)
                inputs.append(parameters)
            } catch {
                HubPerf.log("recorder.voiceover: \(placement.clip.file) skipped: \(error.localizedDescription)")
            }
        }
        if !inputs.isEmpty { HubPerf.log("recorder.voiceover: \(inputs.count) clips in the mix") }
        return inputs
    }
}
