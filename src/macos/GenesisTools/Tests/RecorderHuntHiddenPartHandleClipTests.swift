import CoreGraphics
import XCTest
@testable import GenesisToolsRecorder

/// The Hide tab's outline shows only the piece of a hidden part or spotlight that the picture shows, because a zoom or
/// a cover crop can put the rest outside it. A click or a drag on that outline wrote the clipped piece back as the part,
/// so a plain click shrank it, and outside the zoom the export no longer hid the rest. A drag now starts from the whole
/// part (HiddenPartDrag), and a grip on a clipped edge moves that edge only once the pointer is inside the picture.
final class RecorderHuntHiddenPartHandleClipTests: XCTestCase {
    /// A 2x zoom centred at (0.25, 0.5): the view spans source x 0 to 0.5, so a part from x 0.4 to 0.6 reaches past it.
    private let zoomed = Looks.sourceToCanvas(view: ZoomCurve.View(scale: 2, centerX: 0.25, centerY: 0.5), frame: nil,
                                              picture: CGSize(width: 1920, height: 1080), canvas: CGSize(width: 1920, height: 1080))
    private let stored = CGRect(x: 0.4, y: 0.4, width: 0.2, height: 0.2)
    private let size = CGSize(width: 960, height: 540)

    private func assertRect(_ rect: CGRect, _ expected: CGRect, _ message: String, line: UInt = #line) {
        XCTAssertEqual(rect.minX, expected.minX, accuracy: 1e-9, "\(message): x", line: line)
        XCTAssertEqual(rect.minY, expected.minY, accuracy: 1e-9, "\(message): y", line: line)
        XCTAssertEqual(rect.width, expected.width, accuracy: 1e-9, "\(message): width", line: line)
        XCTAssertEqual(rect.height, expected.height, accuracy: 1e-9, "\(message): height", line: line)
    }

    func testAClickOrADragOnAPartThatReachesPastTheZoomKeepsTheWholePart() {
        assertRect(HiddenPartDrag.moved(stored, by: .zero, size: size, map: zoomed), stored, "a click keeps the part")
        // 48 pt of a 960 pt view is 0.05 of the canvas, which is 0.025 of the source under a 2x zoom.
        assertRect(HiddenPartDrag.moved(stored, by: CGSize(width: -48, height: 0), size: size, map: zoomed),
                   CGRect(x: 0.375, y: 0.4, width: 0.2, height: 0.2), "a drag moves the whole part")
    }

    func testTheOutlineAndTheGripsSitOnThePieceThePictureShows() throws {
        // Canvas x 0.8 to 1.0 (clipped from 1.2) and y 0.3 to 0.7, in a 960 x 540 view.
        let shown = try XCTUnwrap(HiddenPartDrag.shown(stored, size: size, map: zoomed))
        assertRect(shown, CGRect(x: 768, y: 162, width: 192, height: 216), "the outline is the piece that shows")
        let corner = HiddenPartDrag.corner(.bottomRight, of: shown)
        XCTAssertEqual(corner.x, 960, accuracy: 1e-9)
        XCTAssertEqual(corner.y, 378, accuracy: 1e-9)
        XCTAssertNil(HiddenPartDrag.shown(CGRect(x: 0.7, y: 0.4, width: 0.1, height: 0.1), size: size, map: zoomed),
                     "a part wholly outside the zoom has no outline, so it has no grips to drag either")
    }

    func testAGripMovesItsEdgeAndKeepsTheEdgesItDidNotGrab() {
        // The left edge shows: it follows the drag, and the clipped right edge keeps its stored 0.6.
        assertRect(HiddenPartDrag.resized(stored, grip: .bottomLeft, by: CGSize(width: -48, height: 0), size: size, map: zoomed),
                   CGRect(x: 0.375, y: 0.4, width: 0.225, height: 0.2), "the left grip")
        // The right grip sits at the view's edge (source 0.5): pulled 48 pt in, the edge lands under the pointer.
        assertRect(HiddenPartDrag.resized(stored, grip: .bottomRight, by: CGSize(width: -48, height: 0), size: size, map: zoomed),
                   CGRect(x: 0.4, y: 0.4, width: 0.075, height: 0.2), "the right grip pulled into the picture")
        // Pushed out past the picture's edge, but not as far as the stored edge: nothing shows a change, so nothing changes.
        assertRect(HiddenPartDrag.resized(stored, grip: .bottomRight, by: CGSize(width: 20, height: 0), size: size, map: zoomed),
                   stored, "the right grip pushed out a little")
        // Pushed out further than the stored edge, the edge goes with the pointer: 960 + 300 pt is canvas 1.3125.
        assertRect(HiddenPartDrag.resized(stored, grip: .bottomRight, by: CGSize(width: 300, height: 0), size: size, map: zoomed),
                   CGRect(x: 0.4, y: 0.4, width: 0.25625, height: 0.2), "the right grip pushed out far")
        // A grip held still writes the part back unchanged.
        for grip in HiddenPartDrag.Grip.allCases {
            assertRect(HiddenPartDrag.resized(stored, grip: grip, by: .zero, size: size, map: zoomed), stored, "\(grip) at rest")
        }
    }

    func testAPartPastACoverCropKeepsItsWidthOnAClick() throws {
        var frame = EditProject.Frame()
        frame.fit = .cover
        let map = Looks.sourceToCanvas(view: .whole, frame: frame, picture: CGSize(width: 160, height: 100),
                                       canvas: CGSize(width: 100, height: 100))
        let size = CGSize(width: 400, height: 400)
        let part = CGRect(x: 0.02, y: 0.3, width: 0.3, height: 0.2)
        let shown = try XCTUnwrap(HiddenPartDrag.shown(part, size: size, map: map))
        XCTAssertLessThan(shown.width, HiddenPartDrag.viewRect(map.rect(part), size: size).width - 1,
                          "the case needs a part that the cover crop cuts")
        assertRect(HiddenPartDrag.moved(part, by: .zero, size: size, map: map), part, "a click keeps the part")
        let dragged = HiddenPartDrag.moved(part, by: CGSize(width: 8, height: 0), size: size, map: map)
        XCTAssertEqual(dragged.width, part.width, accuracy: 1e-9)
        XCTAssertEqual(dragged.minX, part.minX + 8 / size.width / map.scaleX, accuracy: 1e-9)
    }
}
