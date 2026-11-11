import CoreGraphics
import XCTest
@testable import GenesisToolsRecorder

/// check() judges a zoom against what the frame keeps in view through a TS port of `Looks.framePlacement`'s crop
/// (check.ts `frameCrop`). These are the same cases, with the same numbers, as its TS test ("frameCrop is what
/// framePlacement keeps in view"), so a change to either side fails one of the two.
final class RecorderHuntZoomEdgeFrameCropTests: XCTestCase {
    /// The crop as the TS port returns it: fractions of the picture with y from the top; the whole picture uncropped.
    private func keptInView(_ frame: EditProject.Frame, picture: CGSize, canvas: CGSize,
                            focus: CGPoint = CGPoint(x: 0.5, y: 0.5)) -> CGRect {
        let crop = Looks.framePlacement(frame, picture: picture, canvas: canvas, focus: focus).crop
            ?? CGRect(origin: .zero, size: picture)
        return CGRect(x: crop.minX / picture.width, y: 1 - crop.maxY / picture.height,
                      width: crop.width / picture.width, height: crop.height / picture.height)
    }

    private func assertRect(_ rect: CGRect, _ expected: [Double], file: StaticString = #filePath, line: UInt = #line) {
        let got = [rect.minX, rect.minY, rect.width, rect.height].map { Double($0) }
        for (index, name) in ["x", "y", "width", "height"].enumerated() {
            XCTAssertEqual(got[index], expected[index], accuracy: 0.0001, name, file: file, line: line)
        }
    }

    func testAPhoneGrownInAWideFrameKeepsItsBottomTwoThirds() {
        var frame = EditProject.Frame(aspect: .wide, padding: 0.04)
        frame.layout = .init(align: .left, scale: 1.5, focus: .init(x: 0.5, y: 1))
        let rect = keptInView(frame, picture: CGSize(width: 590, height: 1278), canvas: CGSize(width: 1920, height: 1080))
        assertRect(rect, [0, 0.3333, 1, 0.6667])
    }

    func testAWideMovieCoveringATallCanvasKeepsItsMiddleOrTheSideItsFocusNames() {
        var frame = EditProject.Frame(aspect: .portrait, padding: 0)
        frame.fit = .cover
        let picture = CGSize(width: 1920, height: 1080), canvas = CGSize(width: 1080, height: 1920)
        assertRect(keptInView(frame, picture: picture, canvas: canvas), [0.3418, 0, 0.3164, 1])
        assertRect(keptInView(frame, picture: picture, canvas: canvas, focus: CGPoint(x: 0.9, y: 0.2)),
                   [0.6836, 0, 0.3164, 1])
    }

    func testAGrownCoverCropsInsideTheCoverAroundTheLayoutsFocus() {
        var frame = EditProject.Frame(aspect: .portrait, padding: 0.05)
        frame.fit = .cover
        frame.layout = .init(align: .center, scale: 1.5, focus: .init(x: 0.45, y: 0.4))
        let rect = keptInView(frame, picture: CGSize(width: 1920, height: 1080), canvas: CGSize(width: 1080, height: 1920))
        assertRect(rect, [0.3843, 0.0667, 0.2012, 0.6667])
    }

    func testAFrameAtItsFittedSizeKeepsTheWholePicture() {
        var frame = EditProject.Frame(aspect: .wide, padding: 0.04)
        frame.layout = .init(align: .left, scale: 1)
        XCTAssertNil(Looks.framePlacement(frame, picture: CGSize(width: 590, height: 1278),
                                          canvas: CGSize(width: 1920, height: 1080)).crop)
    }
}
