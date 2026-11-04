import Foundation

/// The Audio tab's noise reduction, with the meaning of the `denoise` op (src/utils/recording-editor/project.ts):
/// on is 12 dB on every track, a track can be left out or given its own strength, and off takes it away. Only the
/// export cleans the sound (src/utils/recording-editor/denoise.ts); the preview plays it as recorded.
extension EditorModel {
    nonisolated static func denoised(_ audio: EditProject.AudioSettings, enabled: Bool) -> EditProject.AudioSettings {
        var next = audio
        if enabled {
            next.denoise = audio.denoise ?? EditProject.Denoise()
            next.include = true
        } else {
            next.denoise = nil
        }
        return next
    }

    /// One track in or out; every track is nil (as the op writes it), and no track is no noise reduction.
    nonisolated static func denoised(_ audio: EditProject.AudioSettings, track: Int, on: Bool, trackCount: Int) -> EditProject.AudioSettings {
        var next = denoised(audio, enabled: true)
        guard var settings = next.denoise else { return next }
        var tracks = Set(settings.tracks ?? Array(0..<max(1, trackCount)))
        if on { tracks.insert(track) } else { tracks.remove(track) }
        guard !tracks.isEmpty else {
            next.denoise = nil
            return next
        }
        settings.tracks = tracks.count >= trackCount && tracks.isSuperset(of: 0..<trackCount) ? nil : tracks.sorted()
        next.denoise = settings
        return next
    }

    /// A track's strength in whole dB, 1 to 40; with one track it is the setting's own `reductionDb`.
    nonisolated static func denoised(_ audio: EditProject.AudioSettings, track: Int, reductionDb: Double, trackCount: Int) -> EditProject.AudioSettings {
        var next = denoised(audio, enabled: true)
        guard var settings = next.denoise else { return next }
        let db = min(40, max(1, reductionDb.rounded()))
        if trackCount <= 1 {
            settings.reductionDb = db
        } else {
            var map = settings.trackReductionDb ?? [:]
            map[String(track)] = db == settings.reductionDb ? nil : db
            settings.trackReductionDb = map.isEmpty ? nil : map
        }
        next.denoise = settings
        return next
    }

    func setDenoise(enabled: Bool) {
        applyAudioOnly(Self.denoised(project.audio, enabled: enabled))
    }

    func setDenoiseTrack(_ track: Int, on: Bool) {
        applyAudioOnly(Self.denoised(project.audio, track: track, on: on, trackCount: max(1, audioTrackCount)))
    }

    func setDenoiseStrength(_ track: Int, reductionDb: Double) {
        applyAudioOnly(Self.denoised(project.audio, track: track, reductionDb: reductionDb, trackCount: max(1, audioTrackCount)))
    }

    /// The export reads these settings; the preview's sound does not change, so the movie is not built again.
    private func applyAudioOnly(_ audio: EditProject.AudioSettings) {
        var next = project
        next.audio = audio
        apply(next, rebuildMovie: false)
    }
}
