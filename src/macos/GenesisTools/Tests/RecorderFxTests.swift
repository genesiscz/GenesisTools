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

    /// A lens op may name the window's id for the new lens; without one the service makes the id, as for an old client.
    func testALensOpCarriesItsIdOnlyWhenItNamesOne() throws {
        let named = try XCTUnwrap(String(data: JSONEncoder().encode(EditOp.lens(EditOp.Lens(id: "l1", from: 1, to: 3))), encoding: .utf8))
        XCTAssertTrue(named.contains("\"id\":\"l1\""), named)
        let plain = try XCTUnwrap(String(data: JSONEncoder().encode(EditOp.lens(EditOp.Lens(from: 1, to: 2))), encoding: .utf8))
        XCTAssertFalse(plain.contains("\"id\""), "no id: the service makes one, as for an old client")
    }

    /// R7 5: a blended frame hides what the other side's still shows, by the parts as they are drawn there. A part that
    /// ends 200 ms before the cut, or starts 150 ms after the incoming clip's start, is drawn up to the cut (snapMs), so
    /// the still of that side must be covered by it too.
    func testATransitionStillIsHiddenByThePartsAsDrawnAtItsSide() throws {
        var project = cutProject(EditProject.Transitions(default: .init(kind: .crossfade, ms: 400)))
        let part = { (id: String, from: Int64, to: Int64) in
            EditProject.Redaction(id: id, startUs: from, endUs: to, x: 0.1, y: 0.1, width: 0.3, height: 0.2, style: .black)
        }
        project.redactions = [part("outgoing", 2_000_000, 3_800_000), part("incoming", 5_150_000, 6_000_000)]
        let zoom = ZoomState(project: project, cursor: nil)
        let before = try XCTUnwrap(zoom.look(atOutput: 3_900_000).transition)
        XCTAssertEqual(before.otherRedactions.map(\.id), ["incoming"], "the incoming clip's first frame is hidden on the blend")
        let after = try XCTUnwrap(zoom.look(atOutput: 4_100_000).transition)
        XCTAssertEqual(after.otherRedactions.map(\.id), ["outgoing"], "the outgoing clip's last frame is hidden on the blend")
    }

    /// A zoom that runs into a crossfade keeps its view on the outgoing still after the join, where the live side is the
    /// unzoomed incoming clip (v29 at 13.2 s jumped to the whole frame mid-fade).
    func testATransitionStillKeepsItsOwnZoomAcrossTheJoin() throws {
        var project = cutProject(EditProject.Transitions(default: .init(kind: .crossfade, ms: 400)))
        project.zooms = [.init(id: "z", startUs: 2_000_000, endUs: 4_800_000, scale: 2, focusX: 0.75, focusY: 0.5)]
        let zoom = ZoomState(project: project, cursor: nil)
        let after = zoom.look(atOutput: 4_100_000)
        XCTAssertEqual(after.view.scale, 1, accuracy: 0.001, "the live side is the incoming clip, not zoomed")
        let mark = try XCTUnwrap(after.transition)
        XCTAssertGreaterThan(mark.otherView.scale, 1.5, "the outgoing still keeps the zoom it ran into the cut with")

        // Black left half, white right half: the still's own view (2× on the right half) shows only white, and the
        // live side's whole-frame crop must show that too.
        let extent = CGRect(x: 0, y: 0, width: 200, height: 100)
        let picture = CIImage(color: .white).cropped(to: CGRect(x: 100, y: 0, width: 100, height: 100))
            .composited(over: CIImage(color: .black).cropped(to: extent))
        let own = ZoomCurve.View(scale: 2, centerX: 0.75, centerY: 0.5)
        let framed = TransitionLook.reframe(picture, from: own, to: .whole, extent: extent)
        XCTAssertEqual(framed.extent, extent)
        XCTAssertEqual(gray(framed, 10, 50), 255, "the left edge shows source x 100, the zoomed view's left edge")
        // Both sides zoomed alike: nothing moves.
        XCTAssertEqual(gray(TransitionLook.reframe(picture, from: own, to: own, extent: extent), 10, 50), 0)
        // The live side zoomed in on the left half: its crop (source x 0...100) shows the still's own view.
        let left = ZoomCurve.View(scale: 2, centerX: 0.25, centerY: 0.5)
        XCTAssertEqual(gray(TransitionLook.reframe(picture, from: own, to: left, extent: extent), 10, 50), 255)
        XCTAssertEqual(gray(TransitionLook.reframe(picture, from: .whole, to: left, extent: extent), 90, 50), 255,
                       "a whole-frame still under a zoomed live crop: source x 90 shows the still's x 180")
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

    /// The Style tab's controls reach the recorder service: a transition, the tilt and a lens's fields as the ops
    /// EditOpDiff names, adding and deleting a lens as their own ops. Before, they changed only the window's copy, the
    /// service's answer put the old edit back, and nothing was saved.
    @MainActor
    func testTheStyleControlsSendTransitionsTiltAndLensesToTheService() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("render-fx-ops-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let project = EditProject.whole(video: folder.appendingPathComponent("none.mp4").path, durationUs: 10_000_000,
                                        width: 1920, height: 1080, cursor: nil, recording: nil)
        let service = FakeServiceLink(project: project, rules: FakeRules.basic)
        let model = EditorModel.on(service, store: ProjectStore(url: folder.appendingPathComponent("edit.json")))

        model.setTransitionKind(.crossfade)
        model.setTransitionLength(600)
        model.finishGesture()
        XCTAssertEqual(service.project.transitions?.default, EditProject.Transition(kind: .crossfade, ms: 600))
        model.setTilt(true)
        model.finishGesture()
        model.changeTilt { $0.strength = 0.8 }
        model.finishGesture()
        XCTAssertEqual(service.project.tilt?.strength, 0.8)
        model.addLensAtPlayhead()
        let lens = try XCTUnwrap(service.project.lens?.items.first, "the service makes the lens and names it")
        XCTAssertEqual(model.project.lens?.items.map(\.id), [lens.id], "the window draws the service's lens")
        XCTAssertEqual(lens.startUs, 0)
        XCTAssertEqual(lens.endUs, 2_000_000)
        XCTAssertFalse(lens.follow, "no cursor track: the lens stays put")
        model.changeLens(lens.id) { $0.magnification = 3 }
        model.finishGesture()
        XCTAssertEqual(service.project.lens?.items.first?.magnification, 3)
        model.removeLens(lens.id)
        XCTAssertNil(service.project.lens)
        XCTAssertEqual(service.sentTags, ["transition", "tilt", "tilt", "lens", "setLens", "unlens"])
        XCTAssertEqual(model.project.transitions, service.project.transitions, "the window keeps what the service saved")
        XCTAssertEqual(model.project.tilt, service.project.tilt)
        XCTAssertNil(model.project.lens)
    }

    func testTheDiffNamesAJoinsTransitionTheTiltAndAMovedLens() throws {
        var before = cutProject(EditProject.Transitions(default: .init(kind: .crossfade, ms: 400), joins: ["c2": .init(kind: .blur, ms: 600)]))
        before.lens = EditProject.Lens(items: [EditProject.LensItem(id: "l1", startUs: 1_000_000, endUs: 3_000_000)])
        var after = before
        after.transitions?.joins = nil
        after.transitions?.default.kind = .zoom
        after.lens?.items[0].x = 0.2
        after.lens?.items[0].y = 0.8
        after.lens?.items[0].endUs = 3_500_000
        XCTAssertEqual(EditOpDiff.ops(from: before, to: after), [
            .transition(EditOp.Transition(kind: .zoom, ms: 400)),
            .transition(EditOp.Transition(kind: .default, clip: "c2")),
            // `at` alone would stop the lens following the cursor on the service, so `follow` goes with it.
            .setLens(EditOp.SetLens(id: "l1", to: 3.5, follow: true, at: EditOp.Point(x: 0.2, y: 0.8))),
        ])
        var tilted = before
        tilted.tilt = EditProject.Tilt(strength: 0.7)
        XCTAssertEqual(EditOpDiff.ops(from: before, to: tilted), [
            .tilt(EditOp.Tilt(enabled: true, strength: 0.7, drift: true, tiltIn: true, tiltOut: true, inMs: 1200, outMs: 1200)),
        ])
        XCTAssertEqual(EditOpDiff.ops(from: tilted, to: before), [.tilt(EditOp.Tilt(enabled: false))])
        var added = before
        added.lens?.items.append(EditProject.LensItem(id: "l2", startUs: 0, endUs: 1_000_000))
        XCTAssertNil(EditOpDiff.ops(from: before, to: added), "a new lens is its own op: the service names it")
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

    /// x is the block's centre. A left-aligned plate starts at the block's left edge and a right-aligned one ends at its
    /// right edge, whatever its own width; a centred one (and one without a block) is centred on x. All stay inside.
    func testAnAlignedPlateSitsAgainstItsBlocksEdge() {
        let size = CGSize(width: 1920, height: 1080)
        func note(_ align: EditProject.TextAlign?, x: Double = 0.62) -> EditProject.TextNote {
            EditProject.TextNote(id: "t", startUs: 0, endUs: 1_000_000, text: "t", x: x, y: 0.5,
                                 block: align.map { EditProject.TextBlock(width: 0.4, align: $0) })
        }
        for width: CGFloat in [200, 500] {
            let plate = CGSize(width: width, height: 80)
            XCTAssertEqual(Looks.textOrigin(note(.left), plate: plate, size: size).x, (0.62 - 0.2) * 1920, accuracy: 0.001)
            XCTAssertEqual(Looks.textOrigin(note(.right), plate: plate, size: size).x + width, (0.62 + 0.2) * 1920, accuracy: 0.001)
            XCTAssertEqual(Looks.textOrigin(note(.center), plate: plate, size: size).x + width / 2, 0.62 * 1920, accuracy: 0.001)
            XCTAssertEqual(Looks.textOrigin(note(nil), plate: plate, size: size).x + width / 2, 0.62 * 1920, accuracy: 0.001)
            XCTAssertEqual(Looks.textOrigin(note(.left), plate: plate, size: size).y, 540 - 40, accuracy: 0.001)
        }
        let plate = CGSize(width: 300, height: 80)
        XCTAssertEqual(Looks.textOrigin(note(.left, x: 0.1), plate: plate, size: size).x, 0, "kept inside on the left")
        XCTAssertEqual(Looks.textOrigin(note(.right, x: 0.95), plate: plate, size: size).x, 1920 - 300, "kept inside on the right")
    }

    /// Drawn, a short title and a longer subtitle with one x and one left-aligned block start at the same column: the
    /// block's left edge. Before 2026-11-08 each was centred on x, so their left edges did not line up.
    func testLeftAlignedTextsWithOneBlockStartAtTheSameColumn() throws {
        let size = CGSize(width: 1920, height: 1080)
        let plates = TextPlates()
        let white = CIImage(color: .white).cropped(to: CGRect(origin: .zero, size: size))
        let context = CIContext()
        var starts: [Int] = []
        for text in ["Invoices", "Send, track and get paid"] {
            let note = EditProject.TextNote(id: "t", startUs: 0, endUs: 1_000_000, text: text, x: 0.62, y: 0.5, size: 0.05,
                                            block: .init(width: 0.4, align: .left))
            let drawn = Looks.drawText(note, opacity: 1, plates: plates, on: white, size: size)
            var row = [UInt8](repeating: 0, count: 4 * Int(size.width))
            context.render(drawn, toBitmap: &row, rowBytes: 4 * Int(size.width), bounds: CGRect(x: 0, y: 540, width: size.width, height: 1),
                           format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
            // The plate darkens the white canvas (to about 145: Core Image blends in linear light): its first column.
            starts.append(try XCTUnwrap(stride(from: 0, to: row.count, by: 4).first { row[$0] < 200 }) / 4)
        }
        let blockLeft = Int(((0.62 - 0.2) * 1920).rounded())
        for start in starts {
            XCTAssertEqual(Double(start), Double(blockLeft), accuracy: 1, "the plate starts at the block's left edge")
        }
    }
}
