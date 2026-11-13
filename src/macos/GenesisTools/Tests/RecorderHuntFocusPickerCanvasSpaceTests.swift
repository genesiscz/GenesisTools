import CoreGraphics
import XCTest
@testable import GenesisToolsRecorder

/// The zoom inspector's focus picker works in the space the zoom's focus counts in. A canvas zoom's focus is 0...1 of
/// the framed canvas (ZoomCurve.canvasView, Looks.zoomCanvas), so its picker shows the canvas with the picture at the
/// frame's place, and a drag onto the phone of a phone-left frame stores the phone's place on the canvas. Before, the
/// picker showed the bare picture and stored 0.5 for the phone's middle, and the export zoomed into the background.
/// "Apply Zoom Level to All" also set canvas zooms from a picture zoom's level.
@MainActor
final class RecorderHuntFocusPickerCanvasSpaceTests: XCTestCase {
    private let pickerSize = CGSize(width: 320, height: 180)

    /// A phone-left style frame: 16:9, a 4 % margin, the picture against the left edge.
    private func framedProject(width: Int, height: Int, layout: EditProject.FrameLayout) -> EditProject {
        var project = EditProject.whole(video: "/nonexistent/focus-picker.mp4", durationUs: 10_000_000, width: width, height: height,
                                        cursor: nil, recording: nil)
        project.frame = EditProject.Frame(aspect: .wide, padding: 0.04, cornerRadius: 0.035, layout: layout)
        return project
    }

    private func zoom(_ id: String, scale: Double = 2, target: EditProject.ZoomTarget?) -> EditProject.Zoom {
        EditProject.Zoom(id: id, startUs: 1_000_000, endUs: 3_000_000, scale: scale, focusX: 0.15, focusY: 0.5, target: target)
    }

    private func assertRect(_ rect: CGRect, _ expected: CGRect, accuracy: CGFloat = 0.001, _ message: String, line: UInt = #line) {
        XCTAssertEqual(rect.minX, expected.minX, accuracy: accuracy, "\(message): x", line: line)
        XCTAssertEqual(rect.minY, expected.minY, accuracy: accuracy, "\(message): y", line: line)
        XCTAssertEqual(rect.width, expected.width, accuracy: accuracy, "\(message): width", line: line)
        XCTAssertEqual(rect.height, expected.height, accuracy: accuracy, "\(message): height", line: line)
    }

    /// The picker point where a picture point (0...1 of the picture) is drawn.
    private func pickerPoint(ofPicture point: CGPoint, _ layout: FocusPickerLayout) -> CGPoint {
        CGPoint(x: (layout.tile.minX + (point.x - layout.crop.minX) / layout.crop.width * layout.tile.width) * pickerSize.width,
                y: (layout.tile.minY + (point.y - layout.crop.minY) / layout.crop.height * layout.tile.height) * pickerSize.height)
    }

    func testACanvasZoomPickerShowsTheCanvasWithThePictureAtTheFramesPlace() {
        // 1728 x 1080 on a 1920 x 1080 canvas: 43.2 px of margin, the picture scaled 0.92 then 0.5, 794.88 x 496.8.
        let project = framedProject(width: 1728, height: 1080, layout: .init(align: .left, scale: 0.5))
        let layout = FocusPickerLayout.make(project: project, zoom: zoom("z1", target: .canvas))
        XCTAssertEqual(layout.aspect, 16.0 / 9, accuracy: 0.001, "the picker has the canvas's shape")
        assertRect(layout.tile, CGRect(x: 43.2 / 1920, y: 291.6 / 1080, width: 794.88 / 1920, height: 496.8 / 1080), "the tile sits where the frame puts the picture")
        assertRect(layout.crop, CGRect(x: 0, y: 0, width: 1, height: 1), "the whole picture shows")
        assertRect(layout.box, CGRect(x: 0, y: 0.25, width: 0.5, height: 0.5), "the box is the canvas view at focus 0.15")
        XCTAssertNotNil(layout.frame)

        // A drag onto the middle of the picture stores the picture's middle on the canvas, which is where the
        // renderer's map puts it.
        let focus = layout.focus(at: pickerPoint(ofPicture: CGPoint(x: 0.5, y: 0.5), layout), size: pickerSize)
        let rendered = Looks.sourceToCanvas(view: .whole, frame: project.frame, picture: CGSize(width: 1728, height: 1080),
                                            canvas: CGSize(width: 1920, height: 1080)).point(CGPoint(x: 0.5, y: 0.5))
        XCTAssertEqual(focus.x, (43.2 + 794.88 / 2) / 1920, accuracy: 0.001, "the picture's middle is at canvas x 0.23, not 0.5")
        XCTAssertEqual(focus.y, 0.5, accuracy: 0.001)
        XCTAssertEqual(focus.x, rendered.x, accuracy: 0.001)
        XCTAssertEqual(focus.y, rendered.y, accuracy: 0.001)
    }

    func testAPhoneInAPhoneLeftFrameIsAimedAtByItsCanvasPlace() {
        // The verifier's movie: 590 x 1278 on a 2272 x 1278 canvas; the phone spans canvas x 0.022 to 0.261.
        let project = framedProject(width: 590, height: 1278, layout: .init(align: .left, scale: 1))
        let layout = FocusPickerLayout.make(project: project, zoom: zoom("z1", target: .canvas))
        XCTAssertEqual(layout.aspect, 16.0 / 9, accuracy: 0.001)
        let focus = layout.focus(at: pickerPoint(ofPicture: CGPoint(x: 0.5, y: 0.5), layout), size: pickerSize)
        XCTAssertEqual(focus.x, 0.142, accuracy: 0.002, "the phone's middle on the canvas")
        XCTAssertEqual(focus.y, 0.5, accuracy: 0.002)
    }

    func testAPictureGrownPastItsRoomShowsThePartTheFrameKeeps() {
        // Scale 3 fills the room (1833.6 x 993.6) and crops the picture to 664.3 x 360 px around the layout's focus,
        // which sits near the top: the crop's top is 1080 - 864 - 180 = 36 px down.
        let project = framedProject(width: 1728, height: 1080, layout: .init(align: .left, scale: 3, focus: .init(x: 0.5, y: 0.2)))
        let layout = FocusPickerLayout.make(project: project, zoom: zoom("z1", target: .canvas))
        assertRect(layout.tile, CGRect(x: 0.0225, y: 0.04, width: 1833.6 / 1920, height: 993.6 / 1080), "the tile fills the room")
        assertRect(layout.crop, CGRect(x: (1728 - 664.35) / 2 / 1728, y: 36.0 / 1080, width: 664.35 / 1728, height: 360.0 / 1080),
                   accuracy: 0.002, "the tile shows the kept part, top-left based")
        let map = Looks.sourceToCanvas(view: .whole, frame: project.frame, picture: CGSize(width: 1728, height: 1080),
                                       canvas: CGSize(width: 1920, height: 1080))
        for point in [CGPoint(x: 0.5, y: 0.1), CGPoint(x: 0.45, y: 0.3), CGPoint(x: 0.6, y: 0.2)] {
            let focus = layout.focus(at: pickerPoint(ofPicture: point, layout), size: pickerSize)
            XCTAssertEqual(focus.x, map.point(point).x, accuracy: 0.001, "picture \(point) x")
            XCTAssertEqual(focus.y, map.point(point).y, accuracy: 0.001, "picture \(point) y")
        }
    }

    func testAPictureZoomAndAnUnframedCanvasZoomKeepThePicture() {
        let framed = framedProject(width: 1728, height: 1080, layout: .init(align: .left, scale: 0.5))
        var unframed = framed
        unframed.frame = nil
        for (name, project, target) in [("picture zoom", framed, EditProject.ZoomTarget?.none),
                                        ("explicit picture zoom", framed, .picture),
                                        ("canvas zoom without a frame", unframed, .canvas)] {
            let layout = FocusPickerLayout.make(project: project, zoom: zoom("z1", target: target))
            XCTAssertEqual(layout.aspect, 1.6, accuracy: 0.001, name)
            assertRect(layout.tile, CGRect(x: 0, y: 0, width: 1, height: 1), "\(name): the tile fills the picker")
            assertRect(layout.box, CGRect(x: 0, y: 0.25, width: 0.5, height: 0.5), "\(name): the box")
            XCTAssertNil(layout.frame, name)
            let focus = layout.focus(at: CGPoint(x: 160, y: 90), size: pickerSize)
            XCTAssertEqual(focus.x, 0.5, accuracy: 1e-9, name)
            XCTAssertEqual(focus.y, 0.5, accuracy: 1e-9, name)
        }
    }

    func testApplyZoomLevelToAllSetsOnlyTheZoomsOnTheSameTarget() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("focus-picker-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        var project = framedProject(width: 1728, height: 1080, layout: .init(align: .left, scale: 0.5))
        project.zooms = [zoom("z1", scale: 1.5, target: nil), zoom("z2", scale: 2.5, target: .canvas), zoom("z3", scale: 3, target: .picture),
                         zoom("z4", scale: 3.5, target: .canvas)]
        project.zooms[1].startUs = 4_000_000
        project.zooms[1].endUs = 5_000_000
        project.zooms[2].startUs = 6_000_000
        project.zooms[2].endUs = 7_000_000
        project.zooms[3].startUs = 8_000_000
        project.zooms[3].endUs = 9_000_000
        let model = EditorModel(project: project, store: ProjectStore(url: folder.appendingPathComponent("edit.json")), link: { nil })
        model.applyScaleToAll(of: "z1")
        XCTAssertEqual(model.project.zooms.map(\.scale), [1.5, 2.5, 1.5, 3.5], "a picture zoom's level reaches the picture zooms only")
        model.applyScaleToAll(of: "z2")
        XCTAssertEqual(model.project.zooms.map(\.scale), [1.5, 2.5, 1.5, 2.5], "a canvas zoom's level reaches the canvas zooms only")
        model.gesture?.commit?.cancel()
    }
}
