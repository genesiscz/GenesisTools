import AVFoundation
import Foundation

// R4 voiceover clips
/// The edit's voiceover clips in the movie's sound: each file plays from its start's OUTPUT time at its own speed (a
/// sped-up clip under it does not speed the voice), cut short at the movie's end, on its own audio track. A clip whose
/// start is cut is left out (check() says so); a missing or silent file is skipped with a log line, never a throw.
/// Round 3 (2026-11-08): a clip with a `card` plays over that card in the export, `atUs` from the card's first frame,
/// and may run on into what follows the card.
enum VoiceoverMix {
    struct Placement: Equatable {
        var clip: EditProject.Voiceover
        /// Where it starts: in the edited movie for `placements`, in the exported file for `exportPlacements`.
        var outUs: Int64
        /// How long it plays there.
        var playUs: Int64
    }

    /// The movie's own clips that play, in output order (a card's clip has no movie time). `lengthUs` nil is the
    /// edit's own output length.
    static func placements(_ project: EditProject, lengthUs: Int64? = nil) -> [Placement] {
        let lengthUs = lengthUs ?? project.outputDurationUs
        return (project.audio.voiceovers ?? []).compactMap { clip in
            guard clip.card == nil,
                  let outUs = TimelineMap.outputTime(ofSource: clip.atUs, in: project), outUs < lengthUs else { return nil }
            let playUs = min(clip.durationUs, lengthUs - outUs)
            return playUs > 0 ? Placement(clip: clip, outUs: outUs, playUs: playUs) : nil
        }.sorted { $0.outUs < $1.outUs }
    }

    /// Every clip that plays in the exported file, where it starts there (the intro card's first frame is 0): a movie
    /// clip after the intro, cut at the movie's end; a card's clip from its card's start, cut at the file's end. Cards
    /// that are off (the preview) leave their clips out. voiceoverExportSpans in project.ts computes the same.
    static func exportPlacements(_ project: EditProject, cards: CardSpans, movieUs: Int64? = nil) -> [Placement] {
        let movieUs = movieUs ?? project.outputDurationUs
        let totalUs = cards.leadUs + movieUs + cards.tailUs
        var placed = placements(project, lengthUs: movieUs).map {
            Placement(clip: $0.clip, outUs: $0.outUs + cards.leadUs, playUs: $0.playUs)
        }
        for clip in project.audio.voiceovers ?? [] {
            guard let card = clip.card else { continue }
            let startUs: Int64
            switch card {
            case .intro:
                guard cards.intro != nil else { continue }
                startUs = clip.atUs
            case .end:
                guard cards.end != nil else { continue }
                startUs = cards.leadUs + movieUs + clip.atUs
            }
            let playUs = min(clip.durationUs, totalUs - startUs)
            if playUs > 0 { placed.append(Placement(clip: clip, outUs: startUs, playUs: playUs)) }
        }
        return placed.sorted { $0.outUs < $1.outUs }
    }

    /// Lays every clip that plays into the composition, at its place in the exported file; one mix input per clip at
    /// its volume. `cards` off (the preview) is the movie alone.
    static func add(to composition: AVMutableComposition, project: EditProject, movieUs: Int64,
                    cards: CardSpans) async -> [AVMutableAudioMixInputParameters] {
        var inputs: [AVMutableAudioMixInputParameters] = []
        for placement in exportPlacements(project, cards: cards, movieUs: movieUs) {
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
