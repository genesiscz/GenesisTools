import CoreImage
import SnapshotSupport
import XCTest

/// What one ScreenCaptureKit window frame holds and where it is painted. The two defects these pin
/// were seen in a parent-plus-sheet movie: every window showed only its top-left quarter, scaled up
/// twice, and the sheet drew a second, smaller copy of its parent below the real one.
final class IsolatedFrameContentTests: XCTestCase {
    private let context = CIContext(options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull()])

    private func solid(_ color: CIColor, _ rect: CGRect) -> CIImage {
        CIImage(color: color).cropped(to: rect)
    }

    /// One pixel, addressed in Core Image's bottom-left space.
    private func pixel(_ image: CIImage, _ x: Int, _ y: Int) -> [UInt8] {
        var value = [UInt8](repeating: 9, count: 4)
        context.render(image, toBitmap: &value, rowBytes: 4, bounds: CGRect(x: x, y: y, width: 1, height: 1),
                       format: .RGBA8, colorSpace: nil)
        return value
    }

    func testContentRectInPointsCoversTheWholeRetinaSurface() {
        // A 10x10 point window on a 2x display: a 20x20 pixel surface, one colour per quadrant. SCK
        // reports the content rect in points, (0, 0, 10, 10), with scale factor 2.
        let surface = solid(.red, CGRect(x: 0, y: 10, width: 10, height: 10))
            .composited(over: solid(.green, CGRect(x: 10, y: 10, width: 10, height: 10)))
            .composited(over: solid(.blue, CGRect(x: 0, y: 0, width: 10, height: 10)))
            .composited(over: solid(.white, CGRect(x: 10, y: 0, width: 10, height: 10)))
        let window = CGRect(x: 0, y: 0, width: 10, height: 10)
        let pixels = surfacePixelRect(contentRect: CGRect(x: 0, y: 0, width: 10, height: 10), scaleFactor: 2)
        XCTAssertEqual(pixels, CGRect(x: 0, y: 0, width: 20, height: 20))

        let image = composeIsolatedFrame([IsolatedPaint(image: surface, contentRect: pixels, bounds: window)],
                                         geometry: CaptureCanvasGeometry(canvas: window, output: CGSize(width: 20, height: 20)),
                                         transparent: true)
        XCTAssertEqual(pixel(image, 5, 15), [255, 0, 0, 255], "top-left quadrant")
        XCTAssertEqual(pixel(image, 15, 15), [0, 255, 0, 255], "top-right quadrant: a points rect read as pixels loses it")
        XCTAssertEqual(pixel(image, 5, 5), [0, 0, 255, 255], "bottom-left quadrant")
        XCTAssertEqual(pixel(image, 15, 5), [255, 255, 255, 255], "bottom-right quadrant")
    }

    func testContentScreenSizeUndoesTheShrinkToFit() {
        // The measured sheet: a 440x760 parent group shrunk by 0.7368 into a 400x560 point surface.
        let size = contentScreenSize(contentRect: CGRect(x: 0, y: 0, width: 324.2105, height: 560), contentScale: 0.736842)
        XCTAssertEqual(size.width, 440, accuracy: 0.01)
        XCTAssertEqual(size.height, 760, accuracy: 0.01)
    }

    func testSheetIsPaintedOnceByItsParentOrFromItsGroup() {
        let parent = IsolatedWindowRow(id: 1, pid: 100, bounds: CGRect(x: 200, y: 325, width: 440, height: 760))
        let sheet = IsolatedWindowRow(id: 2, pid: 100, bounds: CGRect(x: 220, y: 425, width: 400, height: 560))
        let group = CGSize(width: 440, height: 760)

        XCTAssertEqual(isolatedContentPlacement(of: sheet, contentScreenSize: group, selected: [sheet, parent], onScreen: [sheet, parent]),
                       .shownBy(1), "the parent's stream already holds the sheet")
        XCTAssertEqual(isolatedContentPlacement(of: parent, contentScreenSize: group, selected: [sheet, parent], onScreen: [sheet, parent]),
                       .window)
        XCTAssertEqual(isolatedContentPlacement(of: sheet, contentScreenSize: group, selected: [sheet], onScreen: [sheet, parent]),
                       .group(parent.bounds), "a sheet recorded alone is cut out of its parent's group")
        XCTAssertEqual(isolatedContentPlacement(of: sheet, contentScreenSize: CGSize(width: 400.6, height: 559.5), selected: [sheet, parent],
                                                onScreen: [sheet, parent]),
                       .window, "a window over another one of its app, whose stream holds only itself, is painted itself")
        XCTAssertEqual(isolatedContentPlacement(of: sheet, contentScreenSize: nil, selected: [sheet, parent], onScreen: [sheet, parent]),
                       .window, "a frame without content scale changes nothing")

        let otherApp = IsolatedWindowRow(id: 3, pid: 200, bounds: parent.bounds)
        XCTAssertEqual(isolatedContentPlacement(of: sheet, contentScreenSize: group, selected: [sheet, otherApp], onScreen: [sheet, otherApp]),
                       .unplaced, "only a window of the sheet's own app can frame its group")
    }

    func testSheetDrawnFromItsGroupKeepsToItsOwnFrame() {
        // The group is a 40x40 point parent with a 20x20 sheet at (10, 10). The sheet's 20x20 pixel
        // surface holds the whole group at half size: blue parent, pink sheet in the middle.
        let surface = solid(CIColor(red: 1, green: 0, blue: 1), CGRect(x: 5, y: 5, width: 10, height: 10))
            .composited(over: solid(.blue, CGRect(x: 0, y: 0, width: 20, height: 20)))
        let parent = CGRect(x: 0, y: 0, width: 40, height: 40)
        let sheet = CGRect(x: 10, y: 10, width: 20, height: 20)
        let image = composeIsolatedFrame([IsolatedPaint(image: surface, contentRect: CGRect(x: 0, y: 0, width: 20, height: 20),
                                                        bounds: parent, clip: sheet)],
                                         geometry: CaptureCanvasGeometry(canvas: parent, output: CGSize(width: 40, height: 40)),
                                         transparent: true)

        for (x, y) in [(11, 11), (20, 20), (28, 28)] {
            XCTAssertEqual(pixel(image, x, y), [255, 0, 255, 255], "the sheet sits at its own place at (\(x), \(y))")
        }
        for (x, y) in [(2, 2), (2, 37), (37, 20), (20, 5)] {
            XCTAssertEqual(pixel(image, x, y), [0, 0, 0, 0], "no part of the parent is drawn for the sheet at (\(x), \(y))")
        }
    }
}
