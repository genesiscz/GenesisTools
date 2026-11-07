import CoreImage
import XCTest
@testable import GenesisToolsRecorder

/// Round 4 fx-render: transitions at cuts, the magnifier lens and the 3D tilt, checked on rendered pixels.
final class RecorderFxTests: XCTestCase {
    private let context = CIContext()

    private func gray(_ image: CIImage, _ x: Int, _ y: Int) -> UInt8 {
        var pixel = [UInt8](repeating: 0, count: 4)
        context.render(image, toBitmap: &pixel, rowBytes: 4, bounds: CGRect(x: x, y: y, width: 1, height: 1),
                       format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
        return pixel[0]
    }

    private func alpha(_ image: CIImage, _ x: Int, _ y: Int) -> UInt8 {
        var pixel = [UInt8](repeating: 0, count: 4)
        context.render(image, toBitmap: &pixel, rowBytes: 4, bounds: CGRect(x: x, y: y, width: 1, height: 1),
                       format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
        return pixel[3]
    }

    /// A cut at 4 s of output (source 4 to 5 s gone) and a split at 7 s that joins nothing.
    private func cutProject(_ transitions: EditProject.Transitions?) -> EditProject {
        var project = EditProject.whole(video: "/movies/demo.mp4", durationUs: 10_000_000, width: 200, height: 100, cursor: nil, recording: nil)
        project.clips = [
            .init(id: "c1", fromUs: 0, toUs: 4_000_000),
            .init(id: "c2", fromUs: 5_000_000, toUs: 7_000_000),
            .init(id: "c3", fromUs: 7_000_000, toUs: 10_000_000),
        ]
        project.transitions = transitions
        return project
    }

    func testAJoinIsACutNotASplitAndItsTransitionIsCentredOnIt() throws {
        XCTAssertTrue(TransitionLook.joins(in: cutProject(nil)).isEmpty, "no settings: a hard cut")
        let fade = EditProject.Transitions(default: .init(kind: .crossfade, ms: 400))
        let joins = TransitionLook.joins(in: cutProject(fade))
        XCTAssertEqual(joins.map(\.clip), ["c2"], "the split at 7 s joins nothing")
        XCTAssertEqual(joins.first?.atUs, 4_000_000)
        XCTAssertEqual(joins.first?.outgoingSourceUs, 3_999_999)
        XCTAssertEqual(joins.first?.incomingSourceUs, 5_000_000)
        XCTAssertNil(TransitionLook.mark(atOutputUs: 3_700_000, project: cutProject(fade), track: nil), "before the 200 ms half")
        let before = try XCTUnwrap(TransitionLook.mark(atOutputUs: 3_900_000, project: cutProject(fade), track: nil))
        XCTAssertFalse(before.incoming)
        XCTAssertEqual(before.otherSourceUs, 5_000_000, "before the join the still is the incoming clip's first frame")
        XCTAssertEqual(before.progress, 0.25, accuracy: 0.001)
        let after = try XCTUnwrap(TransitionLook.mark(atOutputUs: 4_100_000, project: cutProject(fade), track: nil))
        XCTAssertTrue(after.incoming)
        XCTAssertEqual(after.otherSourceUs, 3_999_999)
        // One join's own transition wins over the default, and none there is a hard cut.
        let own = EditProject.Transitions(default: .init(kind: .crossfade, ms: 400), joins: ["c2": .init(kind: .none, ms: 300)])
        XCTAssertTrue(TransitionLook.joins(in: cutProject(own)).isEmpty)
    }

    func testEachTransitionBlendsBothSidesAtTheJoin() {
        let extent = CGRect(x: 0, y: 0, width: 200, height: 100)
        let black = CIImage(color: .black).cropped(to: extent)
        let white = CIImage(color: .white).cropped(to: extent)
        for kind in [EditProject.TransitionKind.crossfade, .zoom] {
            let middle = TransitionLook.Mark(kind: kind, progress: 0.5, incoming: false, otherSourceUs: 0, otherRedactions: [])
            let value = Int(gray(TransitionLook.blend(live: black, still: white, mark: middle), 100, 50))
            XCTAssertTrue((60...200).contains(value), "\(kind) at the join is between both sides, got \(value)")
            let start = TransitionLook.Mark(kind: kind, progress: 0, incoming: false, otherSourceUs: 0, otherRedactions: [])
            XCTAssertEqual(gray(TransitionLook.blend(live: black, still: white, mark: start), 100, 50), 0, "\(kind) starts on the live side")
        }
        // The blur wipe shows the incoming side on the left first.
        let wipe = TransitionLook.Mark(kind: .blur, progress: 0.5, incoming: true, otherSourceUs: 0, otherRedactions: [])
        let wiped = TransitionLook.blend(live: white, still: black, mark: wipe)
        XCTAssertGreaterThan(gray(wiped, 10, 50), 200, "the left is the incoming (live) side")
        XCTAssertLessThan(gray(wiped, 190, 50), 60, "the right is still the outgoing side")
        XCTAssertEqual(wiped.extent, extent)
    }

    func testTheLensMagnifiesUnderItsCentreAndLeavesTheRest() {
        // Black left half, white right half; the lens sits left of the edge at 4×.
        let extent = CGRect(x: 0, y: 0, width: 200, height: 100)
        let picture = CIImage(color: .white).cropped(to: CGRect(x: 100, y: 0, width: 100, height: 100))
            .composited(over: CIImage(color: .black).cropped(to: extent))
        let mark = LensLook.Mark(x: 0.45, y: 0.5, radius: 0.3, magnification: 4, ring: "#FF0000", opacity: 1)
        let drawn = LensLook.draw([mark], view: .whole, on: picture)
        XCTAssertEqual(gray(picture, 110, 50), 255)
        XCTAssertLessThan(gray(drawn, 110, 50), 40, "x 110 shows source x 95 (black) through the lens")
        XCTAssertEqual(gray(drawn, 190, 50), 255, "outside the lens the picture stays")
        XCTAssertEqual(gray(drawn, 5, 50), 0)
        XCTAssertGreaterThan(gray(drawn, 90, 50 + 29), 120, "the red ring shows at the lens's edge (red over black)")
        XCTAssertEqual(drawn.extent, extent)
        // Under a 2× zoom on the left half, the same source point lands further right.
        let zoomed = ZoomCurve.View(scale: 2, centerX: 0.25, centerY: 0.5)
        XCTAssertEqual(LensLook.pictureCenter(x: 0.25, y: 0.5, view: zoomed, picture: extent).x, 100, accuracy: 0.01)
    }

    func testTheTiltTurnsInSettlesDriftsAndTurnsOut() throws {
        let tilt = EditProject.Tilt(strength: 0.5, drift: false, tiltIn: true, tiltOut: true, inMs: 1000, outMs: 1000)
        let start = try XCTUnwrap(TiltLook.pose(atOutputUs: 0, lengthUs: 10_000_000, tilt: tilt))
        let settled = try XCTUnwrap(TiltLook.pose(atOutputUs: 5_000_000, lengthUs: 10_000_000, tilt: tilt))
        let end = try XCTUnwrap(TiltLook.pose(atOutputUs: 10_000_000, lengthUs: 10_000_000, tilt: tilt))
        XCTAssertGreaterThan(abs(start.yaw), abs(settled.yaw) * 3, "it tilts in from a stronger turn")
        XCTAssertLessThan(start.scale, settled.scale)
        XCTAssertGreaterThan(end.yaw, settled.yaw, "it tilts out the other way")
        XCTAssertNil(TiltLook.pose(atOutputUs: 5_000_000, lengthUs: 10_000_000,
                                   tilt: .init(strength: 0, drift: true, tiltIn: false, tiltOut: false)), "strength 0 is flat")
        // A white card in the middle of a 400×200 canvas: after the turn its corners moved.
        let canvas = CGSize(width: 400, height: 200)
        let rect = CGRect(x: 100, y: 50, width: 200, height: 100)
        let card = CIImage(color: .white).cropped(to: rect)
        let turned = TiltLook.apply(card, rect: rect, pose: start, canvas: canvas)
        XCTAssertNotEqual(turned.extent.integral, rect, "the perspective moves the card's corners")
        XCTAssertEqual(alpha(turned, 200, 100), 255, "the middle stays covered")
        let corners = [CGPoint(x: rect.minX, y: rect.minY), CGPoint(x: rect.maxX, y: rect.maxY)].map {
            TiltLook.project($0, pose: start, pivot: CGPoint(x: 200, y: 100), distance: 880)
        }
        XCTAssertNotEqual(corners[0], CGPoint(x: rect.minX, y: rect.minY))
    }

    func testTheFrameSplitIntoLayersDrawsWhatApplyFrameDraws() {
        let picture = CGSize(width: 160, height: 90)
        let canvas = CGSize(width: 200, height: 120)
        let white = CIImage(color: .white).cropped(to: CGRect(origin: .zero, size: picture))
        let frame = EditProject.Frame()
        let placement = Looks.framePlacement(frame, picture: picture, canvas: canvas)
        let whole = Looks.applyFrame(frame, to: white, canvas: canvas, placement: placement)
        let layers = Looks.frameLayers(frame, to: white, canvas: canvas, placement: placement)
        let joined = layers.picture.composited(over: layers.background)
        for (x, y) in [(100, 60), (4, 4), (Int(placement.inner.midX), Int(placement.inner.minY) - 2)] {
            XCTAssertEqual(gray(whole, x, y), gray(joined, x, y), "pixel \(x),\(y)")
        }
        XCTAssertEqual(layers.picture.extent, layers.rect)
    }
}

// R5 4 frame layouts and canvas zoom
final class RecorderFrameLayoutTests: XCTestCase {
    /// A phone (590×1278) in a 1920×1080 canvas: centred it fills about a quarter of the width; against the left edge
    /// it starts at the padding and leaves the right three quarters free; scale 1.2 makes it taller than the canvas.
    func testAPhoneSitsAgainstTheEdgeTheLayoutNamesAtItsScale() throws {
        let phone = CGSize(width: 590, height: 1278), canvas = CGSize(width: 1920, height: 1080)
        var frame = EditProject.Frame(aspect: .wide, padding: 0.04)
        let centred = Looks.framePlacement(frame, picture: phone, canvas: canvas).inner
        XCTAssertEqual(centred.midX, 960, accuracy: 0.5)
        XCTAssertEqual(centred.height, 1080 * 0.92, accuracy: 0.5)
        frame.layout = .init(align: .left, scale: 1)
        let left = Looks.framePlacement(frame, picture: phone, canvas: canvas).inner
        XCTAssertEqual(left.minX, 1080 * 0.04, accuracy: 0.5)
        XCTAssertGreaterThan(canvas.width - left.maxX, canvas.width * 0.7, "three quarters free for texts")
        // R7 9: scale 1.2 grows the phone inside the room (wider, the free side smaller) and crops its height to it.
        frame.layout = .init(align: .right, scale: 1.2)
        let grown = Looks.framePlacement(frame, picture: phone, canvas: canvas)
        let right = grown.inner
        XCTAssertEqual(right.maxX, 1920 - 1080 * 0.04, accuracy: 0.5)
        XCTAssertEqual(right.height, 1080 * 0.92, accuracy: 0.5, "the phone stays inside the padding")
        XCTAssertEqual(right.width, left.width * 1.2, accuracy: 0.5, "and is 1.2 times as wide")
        let crop = try XCTUnwrap(grown.crop)
        XCTAssertEqual(crop.width, phone.width, accuracy: 0.5, "the whole width shows")
        XCTAssertEqual(crop.height, phone.height / 1.2, accuracy: 0.5, "a sixth of the height is out of view")
        XCTAssertEqual(crop.midY, phone.height / 2, accuracy: 0.5, "the centre by default")
    }

    // R7 9 phone layouts: a phone at 0.36 of a 16:9 canvas, its bottom (the tab bar) kept in view by the focus.
    func testAGrownPhoneKeepsTheFocusedPartInView() throws {
        let phone = CGSize(width: 590, height: 1278), canvas = CGSize(width: 1920, height: 1080)
        var frame = EditProject.Frame(aspect: .wide, padding: 0.04)
        frame.layout = .init(align: .left, scale: 1.5, focus: .init(x: 0.5, y: 1))
        let placement = Looks.framePlacement(frame, picture: phone, canvas: canvas)
        XCTAssertEqual(placement.inner.width / canvas.width, 0.358, accuracy: 0.005)
        XCTAssertGreaterThan(canvas.width - placement.inner.maxX, canvas.width * 0.6, "the free side holds a 0.4 wide block")
        let crop = try XCTUnwrap(placement.crop)
        XCTAssertEqual(crop.minY, 0, accuracy: 0.5, "focus y 1 keeps the bottom (Core Image y 0) in view")
        // The mapping of a source point follows the crop: the phone's bottom edge lands on the box's bottom edge.
        let map = Looks.sourceToCanvas(view: .whole, frame: frame, picture: phone, canvas: canvas)
        XCTAssertEqual(map.point(CGPoint(x: 0.5, y: 1)).y, 1 - 1080 * 0.04 / 1080, accuracy: 0.002)
    }

    /// A canvas zoom never moves the picture's own view, and a picture zoom never moves the canvas.
    func testACanvasZoomZoomsTheCanvasAndNotThePicture() {
        let canvasZoom = EditProject.Zoom(id: "c", startUs: 1_000_000, endUs: 3_000_000, scale: 2, focusX: 0.25, focusY: 0.5,
                                          easeInMs: 0, easeOutMs: 0, target: .canvas)
        let pictureZoom = EditProject.Zoom(id: "p", startUs: 1_000_000, endUs: 3_000_000, scale: 1.5, easeInMs: 0, easeOutMs: 0)
        XCTAssertEqual(ZoomCurve.view(atSource: 2_000_000, zooms: [canvasZoom], cursor: nil), .whole)
        XCTAssertEqual(ZoomCurve.canvasView(atSource: 2_000_000, zooms: [canvasZoom, pictureZoom]).scale, 2)
        XCTAssertEqual(ZoomCurve.canvasView(atSource: 2_000_000, zooms: [canvasZoom]).centerX, 0.25, accuracy: 0.001)
        XCTAssertEqual(ZoomCurve.view(atSource: 2_000_000, zooms: [canvasZoom, pictureZoom], cursor: nil).scale, 1.5)
        XCTAssertEqual(ZoomCurve.canvasView(atSource: 2_000_000, zooms: [pictureZoom]), .whole)
    }

    /// The zoomed canvas shows the left half (white) over the whole output.
    func testZoomCanvasFillsTheOutputWithTheFocusedPart() {
        let size = CGSize(width: 200, height: 100)
        let canvas = CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: 100, height: 100))
            .composited(over: CIImage(color: .black).cropped(to: CGRect(origin: .zero, size: size)))
        let zoomed = Looks.zoomCanvas(canvas, view: ZoomCurve.View(scale: 2, centerX: 0.25, centerY: 0.5), size: size)
        XCTAssertEqual(zoomed.extent, CGRect(origin: .zero, size: size))
        let context = CIContext()
        var pixel = [UInt8](repeating: 0, count: 4)
        for x in [5, 100, 195] {
            context.render(zoomed, toBitmap: &pixel, rowBytes: 4, bounds: CGRect(x: x, y: 50, width: 1, height: 1),
                           format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
            XCTAssertGreaterThan(pixel[0], 200, "x \(x) shows the white left half")
        }
    }
}

// R5 10 multi-line texts
final class RecorderTextBlockTests: XCTestCase {
    /// "\n" makes a second line, a long text wraps inside the block's width and is drawn whole, never cut.
    func testATextBreaksAtNewlinesAndWrapsInsideItsBlock() throws {
        let plates = TextPlates()
        let one = try XCTUnwrap(plates.plate("Step one", fontSize: 40, maxWidth: 1500))
        let two = try XCTUnwrap(plates.plate("Step one\nStep two", fontSize: 40, maxWidth: 1500))
        XCTAssertGreaterThan(two.extent.height / one.extent.height, 1.6, "two lines")
        let callout = String(repeating: "word ", count: 60).trimmingCharacters(in: .whitespaces)
        let wrapped = try XCTUnwrap(plates.plate(callout, fontSize: 40, maxWidth: 600, alignment: .left))
        XCTAssertLessThanOrEqual(wrapped.extent.width, 600)
        XCTAssertGreaterThan(wrapped.extent.height, one.extent.height * 5, "the whole callout, wrapped")
        // Drawn with a 0.3 block on a 1920 canvas, the plate is at most 576 wide and stays inside the canvas.
        let size = CGSize(width: 1920, height: 1080)
        let note = EditProject.TextNote(id: "t", startUs: 0, endUs: 1_000_000, text: callout, x: 0.7, y: 0.5, size: 0.03,
                                        block: .init(width: 0.3, align: .left))
        let canvas = CIImage(color: .black).cropped(to: CGRect(origin: .zero, size: size))
        let drawn = Looks.drawText(note, opacity: 1, plates: plates, on: canvas, size: size)
        XCTAssertEqual(drawn.extent, canvas.extent)
        let plate = try XCTUnwrap(plates.plate(callout, fontSize: 32, maxWidth: 576, alignment: .left))
        XCTAssertLessThanOrEqual(plate.extent.width, 576)
        XCTAssertLessThan(plate.extent.height, size.height, "the callout fits the canvas's height")
    }
}
