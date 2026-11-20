import Foundation

/// The Audio tab's noise reduction through the `denoise` op (src/utils/recording-editor/project.ts): on is 12 dB on
/// every track, a track can be left out or given its own strength, and off takes it away. The service keeps the
/// rules (every track is no track list, a strength equal to the base is not written, no track left is off); the
/// window names the change and how many sound tracks the movie has. Only the export cleans the sound
/// (src/utils/recording-editor/denoise.ts); the preview plays it as recorded, so no change rebuilds the movie. To hear
/// a strength, Preview asks the engine for 5 s from the playhead cleaned by the export's own filters
/// (`movie.denoisePreview`, `tools recorder denoise-preview`), a file in the denoise cache that replaces the last one.
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

    /// The cleaned preview of 5 s from the playhead at the saved strength: the file's URL, or why there is none.
    func makeDenoisePreview(_ done: @escaping @MainActor (Result<URL, ApplyFailure>) -> Void) {
        afterGesturesSaved { [weak self] saved in
            guard let self else { return }
            guard saved else { return done(.failure(ApplyFailure(reason: "the strength was not saved, so there is nothing to preview"))) }
            let at = self.playheadSourceSeconds
            self.ask("denoisePreview", ["at": at], argv: ["recorder", "denoise-preview", self.store.url.path, "--at", String(format: "%.3f", at)],
                     timeout: 150) { result in
                switch result {
                case let .success(data):
                    let answer = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                    if let path = answer?["path"] as? String {
                        done(.success(URL(fileURLWithPath: path)))
                    } else {
                        done(.failure(ApplyFailure(reason: "the engine answered without a preview file")))
                    }
                case let .failure(failure): done(.failure(failure))
                }
            }
        }
    }
}
