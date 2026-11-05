import Foundation

/// The Audio tab's noise reduction through the `denoise` op (src/utils/recording-editor/project.ts): on is 12 dB on
/// every track, a track can be left out or given its own strength, and off takes it away. The service keeps the
/// rules (every track is no track list, a strength equal to the base is not written, no track left is off); the
/// window names the change and how many sound tracks the movie has. Only the export cleans the sound
/// (src/utils/recording-editor/denoise.ts); the preview plays it as recorded, so no change rebuilds the movie.
extension EditorModel {
    func setDenoise(enabled: Bool) {
        edit([.denoise(EditOp.Denoise(enabled: enabled))])
    }

    func setDenoiseTrack(_ track: Int, on: Bool) {
        edit([.denoise(EditOp.Denoise(track: track, on: on, trackCount: max(1, audioTrackCount)))])
    }

    /// A track's strength in whole dB, 1 to 40; with one track it is the setting's own strength.
    func setDenoiseStrength(_ track: Int, reductionDb: Double) {
        let op = EditOp.Denoise(reductionDb: reductionDb, track: track, trackCount: max(1, audioTrackCount))
        continuous("denoise-strength:\(track)", [.denoise(op)])
    }
}
