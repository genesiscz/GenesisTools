import CoreImage
import XCTest
@testable import GenesisToolsRecorder

/// Each spotlight keeps its own fade when spotlights overlap in time: one that fades out while another holds the dim
/// closes its lit hole gradually instead of switching it off on its last frame.
final class RecorderHuntSpotlightFadesPerSpotlightTests: XCTestCase {
    private let white = CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: 200, height: 100))
    private let context = CIContext()

    private func gray(_ image: CIImage, _ x: Int, _ yFromTop: Int) -> Int {
        var pixel = [UInt8](repeating: 0, count: 4)
        context.render(image, toBitmap: &pixel, rowBytes: 4, bounds: CGRect(x: x, y: 100 - 1 - yFromTop, width: 1, height: 1),
                       format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
        return Int(pixel[0])
    }

    private func spots() -> (a: EditProject.Redaction, b: EditProject.Redaction) {
        var a = EditProject.Redaction(id: "a", startUs: 0, endUs: 6_000_000, x: 0.05, y: 0.2, width: 0.25, height: 0.6, style: .spotlight)
        a.cutout = .rect
        a.fadeMs = 1000
        var b = EditProject.Redaction(id: "b", startUs: 2_000_000, endUs: 4_000_000, x: 0.6, y: 0.2, width: 0.25, height: 0.6,
                                      style: .spotlight)
        b.cutout = .rect
        return (a, b)
    }

    func testEachSpotlightFadesOnItsOwnClock() {
        let (a, b) = spots()
        var project = EditProject.whole(video: "/tmp/x.mp4", durationUs: 6_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
        project.redactions = [a, b]
        let look = ZoomState(project: project, cursor: nil).look(atOutput: 3_900_000)
        XCTAssertEqual(look.spotlightFades["a"] ?? 0, 1, accuracy: 0.001, "A is fully in")
        XCTAssertEqual(look.spotlightFades["b"] ?? 0, 0.5, accuracy: 0.01, "B is half way out of its 200 ms fade")
    }

    func testASpotlightFadingOutClosesItsHoleWhileAnotherHoldsTheDim() {
        let (a, b) = spots()
        let full = Looks.redact([a, b], on: white, spotlightFades: ["a": 1, "b": 1])
        let fading = Looks.redact([a, b], on: white, spotlightFades: ["a": 1, "b": 0.5])
        let gone = Looks.redact([a], on: white, spotlightFades: ["a": 1])
        let lit = gray(full, 145, 50), half = gray(fading, 145, 50), closed = gray(gone, 145, 50)
        XCTAssertGreaterThan(lit, 240, "B's hole is lit while B is fully in")
        XCTAssertLessThan(half, lit - 20, "half way out, B's hole is partly dimmed")
        XCTAssertGreaterThan(half, closed + 20, "but not yet as dim as without B")
        XCTAssertEqual(gray(fading, 100, 5), gray(gone, 100, 5), accuracy: 1, "A holds the same dim around both")
        XCTAssertGreaterThan(gray(fading, 30, 50), 240, "A's hole stays lit")
    }

    func testASoloSpotlightStillFadesItsDim() {
        let (a, _) = spots()
        let full = gray(Looks.redact([a], on: white, spotlightFades: ["a": 1]), 100, 5)
        let half = gray(Looks.redact([a], on: white, spotlightFades: ["a": 0.5]), 100, 5)
        XCTAssertGreaterThan(half, full + 20)
        XCTAssertGreaterThan(gray(Looks.redact([a], on: white, spotlightFades: ["a": 0.5]), 30, 50), 240, "its hole stays lit")
    }
}
