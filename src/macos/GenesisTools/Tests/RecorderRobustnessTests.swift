import AVFoundation
import XCTest
@testable import GenesisToolsRecorder

/// Inputs that used to reach an AVFoundation call which raises an Objective-C exception, or a Swift trap. Swift cannot
/// catch either, so each one crashed the recorder face (and every editor window in it). Each test feeds the input and
/// checks the guard answers with a Swift error or a safe value instead.
final class RecorderRobustnessTests: XCTestCase {
    private func ramps(_ cuts: [Int64], lengthUs: Int64 = 10_000_000) -> [(startUs: Int64, endUs: Int64, from: Double, to: Double)] {
        Declick.ramps(at: cuts, lengthUs: lengthUs)
    }

    /// Lays the ramps on a real audio mix track: an overlapping one raises NSInvalidArgumentException here and the test
    /// process dies, which is the crash this guards.
    private func applyToAMix(_ ramps: [(startUs: Int64, endUs: Int64, from: Double, to: Double)]) {
        let composition = AVMutableComposition()
        guard let track = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            return XCTFail("no audio track")
        }
        let parameters = AVMutableAudioMixInputParameters(track: track)
        for ramp in ramps {
            parameters.setVolumeRamp(fromStartVolume: Float(ramp.from), toEndVolume: Float(ramp.to),
                                     timeRange: CMTimeRange(start: EditRenderer.us(ramp.startUs), duration: EditRenderer.us(ramp.endUs - ramp.startUs)))
        }
    }

    private func assertNoOverlap(_ ramps: [(startUs: Int64, endUs: Int64, from: Double, to: Double)], file: StaticString = #filePath, line: UInt = #line) {
        for ramp in ramps {
            XCTAssertGreaterThan(ramp.endUs, ramp.startUs, "every ramp has a length", file: file, line: line)
        }
        for (a, b) in zip(ramps, ramps.dropFirst()) {
            XCTAssertLessThanOrEqual(a.endUs, b.startUs, "ramp \(a) overlaps \(b)", file: file, line: line)
        }
    }

    func testTwoCutsTenMillisecondsApartShareOneSilenceInsteadOfOverlappingRamps() {
        // Cut 1–2 s and 2.01–3 s: the 10 ms clip between them makes two cuts 10 ms apart in the output.
        let edit = EditProject(source: .init(video: "/m.mp4", durationUs: 5_000_000, width: 320, height: 200),
                               clips: [.init(id: "a", fromUs: 0, toUs: 1_000_000), .init(id: "b", fromUs: 2_000_000, toUs: 2_010_000),
                                       .init(id: "c", fromUs: 3_000_000, toUs: 5_000_000)])
        let cuts = Declick.cuts(in: edit)
        XCTAssertEqual(cuts, [1_000_000, 1_010_000])
        let result = ramps(cuts, lengthUs: edit.outputDurationUs)
        assertNoOverlap(result)
        XCTAssertEqual(result.map(\.startUs), [975_000, 1_000_000, 1_010_000], "down before the first cut, silent between, up after the last")
        XCTAssertEqual(result.map(\.to), [0, 0, 1])
        applyToAMix(result)
    }

    func testCutsOnOneTimeAndAtTheEdgesMakeNoOverlapOrEmptyRamp() {
        // A clip that plays for 0 µs (5 µs at 16×) puts two cuts on one output time.
        for cuts: [Int64] in [[2_000_000, 2_000_000], [0, 10_000], [9_990_000, 10_000_000], [3_000_000, 3_049_999, 3_060_000], [-5, 20_000_000]] {
            let result = ramps(cuts)
            assertNoOverlap(result)
            applyToAMix(result)
        }
        XCTAssertEqual(ramps([3_000_000]).map(\.startUs), [2_975_000, 3_000_000], "a lone cut keeps its two 25 ms ramps")
    }
}
