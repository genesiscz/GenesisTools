import CoreGraphics
import CoreImage
import XCTest
@testable import GenesisToolsRecorder

/// The editor's preview draws the hidden-part, spotlight, shape and screen-find handles through one source-to-canvas
/// map, and turns their drags back through it. The renderer moves the framed picture twice more after the frame: the
/// tilt turns it, then a canvas zoom scales the whole canvas. The map stopped at the frame, so during a canvas zoom an
/// outline sat where the part would be without the zoom (off by the zoom's factor), a part drawn there was saved
/// somewhere else, and under a tilt every outline was about 20 px off at 1080p (much more during the tilt-in).
final class RecorderHuntPreviewMapCanvasZoomTiltTests: XCTestCase {
    /// A 4112 x 2570 movie on a 16:9 canvas with a 0.1 padding, and a 2x canvas zoom at (0.25, 0.5) from 2 to 6 s.
    private func zoomedProject() -> EditProject {
        var project = EditProject.whole(video: "/tmp/hunt-preview-map.mp4", durationUs: 8_000_000, width: 4112, height: 2570,
                                        cursor: nil, recording: nil)
        var frame = EditProject.Frame()
        frame.aspect = .wide
        frame.padding = 0.1
        project.frame = frame
        project.zooms = [EditProject.Zoom(id: "c", startUs: 2_000_000, endUs: 6_000_000, scale: 2, focusX: 0.25, focusY: 0.5,
                                          easeInMs: 0, easeOutMs: 0, target: .canvas)]
        return project
    }

    private func assertRect(_ rect: CGRect, _ expected: CGRect, accuracy: Double, _ message: String, line: UInt = #line) {
        XCTAssertEqual(rect.minX, expected.minX, accuracy: accuracy, "\(message): x", line: line)
        XCTAssertEqual(rect.minY, expected.minY, accuracy: accuracy, "\(message): y", line: line)
        XCTAssertEqual(rect.width, expected.width, accuracy: accuracy, "\(message): width", line: line)
        XCTAssertEqual(rect.height, expected.height, accuracy: accuracy, "\(message): height", line: line)
    }

    func testTheMapFollowsACanvasZoomAsTheRendererDrawsIt() {
        let project = zoomedProject()
        let part = CGRect(x: 0.4, y: 0.4, width: 0.2, height: 0.2)
        // Before the zoom: the frame alone (the still at 1 s drew the part at 0.428, 0.420, 0.144, 0.160).
        let plain = Looks.sourceToCanvas(project: project, cursor: nil, atOutput: 1_000_000)
        assertRect(plain.rect(part), CGRect(x: 0.428, y: 0.420, width: 0.144, height: 0.160), accuracy: 0.002, "before the zoom")

        // Inside it: where Looks.zoomCanvasRect moves the framed rect (Core Image counts y from the bottom).
        let zoomed = Looks.sourceToCanvas(project: project, cursor: nil, atOutput: 4_000_000)
        let canvas = EditRenderer.outputSizes(source: CGSize(width: 4112, height: 2570), maxHeight: 0, aspect: .wide).canvas
        let framed = plain.rect(part)
        let pixels = CGRect(x: framed.minX * canvas.width, y: (1 - framed.maxY) * canvas.height,
                            width: framed.width * canvas.width, height: framed.height * canvas.height)
        let drawn = Looks.zoomCanvasRect(pixels, view: ZoomCurve.canvasView(atSource: 4_000_000, project: project), size: canvas)
        let expected = CGRect(x: drawn.minX / canvas.width, y: 1 - drawn.maxY / canvas.height,
                              width: drawn.width / canvas.width, height: drawn.height / canvas.height)
        assertRect(zoomed.rect(part), expected, accuracy: 1e-9, "inside the zoom, as the renderer draws it")
        // The still at 4 s drew it at 0.855, 0.340 and 0.288 x 0.320 (cut by the canvas's right edge).
        assertRect(zoomed.rect(part), CGRect(x: 0.856, y: 0.340, width: 0.288, height: 0.320), accuracy: 0.003, "the measured still")

        // A box drawn over canvas (0.6...0.8, 0.4...0.6) hides what the user saw there, and comes back 1:1.
        assertRect(zoomed.sourceRect(ofCanvas: CGRect(x: 0.6, y: 0.4, width: 0.2, height: 0.2)),
                   CGRect(x: 0.2222, y: 0.4375, width: 0.1389, height: 0.125), accuracy: 0.002, "a drawn box")
        assertRect(zoomed.sourceRect(ofCanvas: zoomed.rect(part)), part, accuracy: 1e-9, "the round trip")
        XCTAssertEqual(zoomed.point(CGPoint(x: 0.4, y: 0.5)).x, expected.minX, accuracy: 1e-9)
    }

    /// A 640 x 400 picture of three coloured dots on black, framed on a black 16:9 canvas, tilting in (a strong turn
    /// at 0.3 s), under a 1.4x canvas zoom: the renderer's steps, from its own look at that moment, against the map.
    func testTheMapLandsWhereTheRendererDrawsAFramedTiltedCanvasZoomedPicture() throws {
        var project = EditProject.whole(video: "/tmp/hunt-preview-map-tilt.mp4", durationUs: 4_000_000, width: 640, height: 400,
                                        cursor: nil, recording: nil)
        var frame = EditProject.Frame()
        frame.aspect = .wide
        frame.padding = 0.1
        frame.shadow = false
        frame.cornerRadius = 0
        frame.background = EditProject.Background(kind: .color, colors: ["#000000"])
        project.frame = frame
        project.tilt = EditProject.Tilt(strength: 1, drift: false, tiltIn: true, tiltOut: false)
        project.zooms = [EditProject.Zoom(id: "c", startUs: 0, endUs: 2_000_000, scale: 1.4, focusX: 0.45, focusY: 0.5,
                                          easeInMs: 0, easeOutMs: 0, target: .canvas)]
        let outUs: Int64 = 300_000
        let look = ZoomState(project: project, cursor: nil).look(atOutput: outUs)
        let pose = try XCTUnwrap(look.tilt, "the case needs a tilt")
        XCTAssertGreaterThan(look.canvasView.scale, 1.3, "the case needs a canvas zoom")

        let sizes = EditRenderer.outputSizes(source: CGSize(width: 640, height: 400), maxHeight: 0, aspect: .wide)
        let picture = sizes.picture, size = sizes.canvas
        let dots: [(point: CGPoint, color: CIColor)] = [
            (CGPoint(x: 0.25, y: 0.3), CIColor(red: 1, green: 0, blue: 0)),
            (CGPoint(x: 0.7, y: 0.35), CIColor(red: 0, green: 1, blue: 0)),
            (CGPoint(x: 0.45, y: 0.7), CIColor(red: 0, green: 0, blue: 1)),
        ]
        var image = CIImage(color: .black).cropped(to: CGRect(origin: .zero, size: picture))
        for dot in dots {
            let centre = CGPoint(x: dot.point.x * picture.width, y: (1 - dot.point.y) * picture.height)
            image = CIImage(color: dot.color).cropped(to: CGRect(x: centre.x - 4, y: centre.y - 4, width: 8, height: 8)).composited(over: image)
        }
        // EditRenderer's composition after the picture: the frame's layers, the tilt, then the canvas zoom.
        let placement = Looks.framePlacement(frame, picture: picture, canvas: size, focus: look.coverFocus)
        let layers = Looks.frameLayers(frame, to: image, canvas: size, placement: placement)
        var result = TiltLook.apply(layers.picture, rect: layers.rect, pose: pose, canvas: size)
            .composited(over: layers.background).cropped(to: CGRect(origin: .zero, size: size))
        result = Looks.zoomCanvas(result, view: look.canvasView, size: size)

        let width = Int(size.width), height = Int(size.height)
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        CIContext().render(result, toBitmap: &pixels, rowBytes: width * 4, bounds: CGRect(origin: .zero, size: size), format: .RGBA8,
                           colorSpace: nil)
        let map = Looks.sourceToCanvas(project: project, cursor: nil, atOutput: outUs)
        for (index, dot) in dots.enumerated() {
            // The bitmap's first row is the canvas's top; weigh each pixel by how much more of the dot's channel it has.
            var sum = 0.0, sumX = 0.0, sumY = 0.0
            for row in 0..<height {
                for column in 0..<width {
                    let at = (row * width + column) * 4
                    let channels = [Double(pixels[at]), Double(pixels[at + 1]), Double(pixels[at + 2])]
                    let weight = channels[index] - max(channels[(index + 1) % 3], channels[(index + 2) % 3])
                    guard weight > 20 else { continue }
                    sum += weight
                    sumX += weight * (Double(column) + 0.5)
                    sumY += weight * (Double(row) + 0.5)
                }
            }
            XCTAssertGreaterThan(sum, 0, "dot \(index) is on the canvas")
            guard sum > 0 else { continue }
            let mapped = map.point(dot.point)
            XCTAssertEqual(mapped.x * size.width, sumX / sum, accuracy: 1.5, "dot \(index) x, in pixels")
            XCTAssertEqual(mapped.y * size.height, sumY / sum, accuracy: 1.5, "dot \(index) y, in pixels")
            let back = map.sourcePoint(ofCanvas: mapped)
            XCTAssertEqual(back.x, dot.point.x, accuracy: 1e-6, "dot \(index) comes back, x")
            XCTAssertEqual(back.y, dot.point.y, accuracy: 1e-6, "dot \(index) comes back, y")
        }
    }

    /// Under a tilt a rectangle lands slanted; the map's rectangle for it and the source rectangle of that come back to
    /// the same part, so a click or a drag there and back never resizes a hidden part (HiddenPartDrag).
    func testAClickOrADragAndBackOnAPartUnderTheTiltKeepsThePart() {
        var project = zoomedProject()
        project.tilt = EditProject.Tilt(strength: 1, drift: true, tiltIn: true, tiltOut: true)
        let size = CGSize(width: 988, height: 556)
        let stored = CGRect(x: 0.3, y: 0.3, width: 0.2, height: 0.1)
        for outUs: Int64 in [300_000, 4_000_000] {
            let map = Looks.sourceToCanvas(project: project, cursor: nil, atOutput: outUs)
            assertRect(HiddenPartDrag.moved(stored, by: .zero, size: size, map: map), stored, accuracy: 1e-9, "a click at \(outUs)")
            let there = HiddenPartDrag.moved(stored, by: CGSize(width: 40, height: -24), size: size, map: map)
            assertRect(HiddenPartDrag.moved(there, by: CGSize(width: -40, height: 24), size: size, map: map), stored, accuracy: 1e-9,
                       "a drag there and back at \(outUs)")
            for grip in HiddenPartDrag.Grip.allCases {
                assertRect(HiddenPartDrag.resized(stored, grip: grip, by: .zero, size: size, map: map), stored, accuracy: 1e-9,
                           "\(grip) at rest at \(outUs)")
            }
        }
    }

    /// The editor's map takes the same inputs as the renderer's look at every moment (a picture zoom, a canvas zoom and
    /// a tilt drifting in and out), so the two cannot drift apart again.
    func testTheMapIsBuiltFromTheRenderersLook() {
        var project = zoomedProject()
        project.zooms.append(EditProject.Zoom(id: "p", startUs: 1_000_000, endUs: 5_000_000, scale: 1.5, focusX: 0.6, focusY: 0.4,
                                              easeInMs: 300, easeOutMs: 300))
        project.tilt = EditProject.Tilt()
        let state = ZoomState(project: project, cursor: nil)
        let sizes = EditRenderer.outputSizes(source: CGSize(width: 4112, height: 2570), maxHeight: 0, aspect: .wide)
        for outUs: Int64 in [0, 300_000, 1_100_000, 2_000_000, 4_000_000, 5_900_000, 7_900_000] {
            let look = state.look(atOutput: outUs)
            let expected = Looks.sourceToCanvas(view: look.view, frame: look.frame, picture: sizes.picture, canvas: sizes.canvas,
                                                coverFocus: look.coverFocus, tilt: look.tilt, canvasView: look.canvasView)
            XCTAssertEqual(Looks.sourceToCanvas(project: project, cursor: nil, atOutput: outUs), expected, "at \(outUs)")
            XCTAssertNotNil(expected.perspective, "the tilt turns the canvas at \(outUs)")
        }
    }

    /// The tilt is a plane turned and seen in perspective, so the four-corner map the perspective transform draws is the
    /// turn itself at every point, whichever layer's corners build it.
    func testTheTiltIsOneProjectiveMapOfTheCanvas() throws {
        let canvas = CGSize(width: 1920, height: 1080)
        let pose = try XCTUnwrap(TiltLook.pose(atOutputUs: 300_000, lengthUs: 4_000_000, tilt: EditProject.Tilt(strength: 1)))
        let map = try XCTUnwrap(TiltLook.homography(pose: pose, canvas: canvas))
        let turn = { TiltLook.project($0, pose: pose, pivot: CGPoint(x: 960, y: 540), distance: 2.2 * 1920) }
        let layer = try XCTUnwrap(Homography(rect: CGRect(x: 300, y: 120, width: 900, height: 700), corner: turn))
        for point in [CGPoint(x: 0, y: 0), CGPoint(x: 1700, y: 300), CGPoint(x: 512, y: 999), CGPoint(x: 960, y: 540)] {
            XCTAssertEqual(map.apply(point).x, turn(point).x, accuracy: 1e-6, "\(point) x")
            XCTAssertEqual(map.apply(point).y, turn(point).y, accuracy: 1e-6, "\(point) y")
            XCTAssertEqual(layer.apply(point).x, turn(point).x, accuracy: 1e-6, "\(point) x from a layer's corners")
            let back = try XCTUnwrap(map.inverted()).apply(map.apply(point))
            XCTAssertEqual(back.x, point.x, accuracy: 1e-6)
            XCTAssertEqual(back.y, point.y, accuracy: 1e-6)
        }
    }

    /// A map that folds the plane onto a line has no way back: the map then shows no outline rather than a wrong one.
    func testAMapThatFoldsThePlaneHasNoInverse() {
        XCTAssertNil(Homography(a: 1, b: 2, c: 3, d: 2, e: 4, f: 6, g: 0, h: 0, i: 1).inverted())
        XCTAssertNil(Homography(rect: CGRect(x: 0, y: 0, width: 0, height: 10), corner: { $0 }))
        XCTAssertNil(Homography(rect: CGRect(x: 0, y: 0, width: 10, height: 10), corner: { CGPoint(x: $0.x, y: $0.x) }))
        let canvas = CGSize(width: 100, height: 100)
        XCTAssertNil(Looks.sourceToCanvas(view: .whole, frame: nil, picture: canvas, canvas: canvas,
                                          tilt: TiltLook.Pose(pitch: .pi / 2, yaw: .pi / 2, scale: 1)).perspective)
    }
}
