import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import XCTest
@testable import GenesisToolsRecorder

/// fx B (round 4): the smooth cursor, the speed badge, and how the window names their changes as ops.
final class RecorderFxAnalysisTests: XCTestCase {
    private func sample(_ ms: Double, _ x: Double, _ y: Double, click: String? = nil) -> CursorTrack.Sample {
        CursorTrack.Sample(ms: ms, x: x, y: y, click: click)
    }

    func testDejitterDropsTremblesButKeepsClicksAndRealMoves() {
        // 1440-point display: 3 points is 0.0021 of the width.
        let track = CursorTrack(samples: [
            sample(0, 0.5, 0.5), sample(16, 0.5005, 0.5), sample(33, 0.4995, 0.5003),
            sample(50, 0.5004, 0.5, click: "left"), sample(66, 0.6, 0.5),
        ], pointWidth: 1440)
        let steady = track.dejittered(points: 3, aspect: 0.5625)
        XCTAssertEqual(steady.samples.map(\.ms), [0, 50, 66])
        XCTAssertTrue(steady === track.dejittered(points: 3, aspect: 0.5625), "built once per threshold")
        XCTAssertTrue(track.dejittered(points: 0, aspect: 0.5625) === track)
    }

    func testSmoothCursorSitsExactlyOnAClickAndGlidesElsewhere() throws {
        var samples: [CursorTrack.Sample] = []
        for step in 0...60 {
            let ms = Double(step) * 16.7
            // A zigzag path; a click at step 30.
            samples.append(sample(ms, 0.2 + Double(step) * 0.005, step.isMultiple(of: 2) ? 0.4 : 0.42, click: step == 30 ? "left" : nil))
        }
        let track = CursorTrack(samples: samples, pointWidth: 1440)
        let settings = EditProject.CursorSmooth(strength: 1, jitterPx: 0, idleFadeSeconds: 2)
        let click = samples[30]
        let atClick = try XCTUnwrap(track.smoothMark(atMs: click.ms, settings: settings, aspect: 0.5625))
        XCTAssertEqual(atClick.x, click.x, accuracy: 1e-9)
        XCTAssertEqual(atClick.y, click.y, accuracy: 1e-9)
        // Far from the click the zigzag averages out near its middle line.
        let away = try XCTUnwrap(track.smoothMark(atMs: samples[8].ms, settings: settings, aspect: 0.5625))
        XCTAssertEqual(away.y, 0.41, accuracy: 0.004)
    }

    func testSmoothCursorFadesAfterItsIdleTime() throws {
        let track = CursorTrack(samples: [sample(0, 0.1, 0.1), sample(100, 0.3, 0.3)], pointWidth: 1440)
        let settings = EditProject.CursorSmooth(strength: 0, jitterPx: 3, idleFadeSeconds: 2)
        XCTAssertEqual(try XCTUnwrap(track.smoothMark(atMs: 1000, settings: settings, aspect: 0.5625)).opacity, 1)
        XCTAssertEqual(try XCTUnwrap(track.smoothMark(atMs: 3000, settings: settings, aspect: 0.5625)).opacity, 0)
        let never = EditProject.CursorSmooth(strength: 0, jitterPx: 3, idleFadeSeconds: 0)
        XCTAssertEqual(try XCTUnwrap(track.smoothMark(atMs: 30_000, settings: never, aspect: 0.5625)).opacity, 1)
    }

    private func project(speeds: [Double], badge: EditProject.AutoSpeed?) -> EditProject {
        var project = EditProject.whole(video: "/movies/screen.mp4", durationUs: 30_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
        project.clips = [
            EditProject.Clip(id: "c1", fromUs: 0, toUs: 10_000_000, speed: speeds[0]),
            EditProject.Clip(id: "c2", fromUs: 10_000_000, toUs: 20_000_000, speed: speeds[1]),
            EditProject.Clip(id: "c3", fromUs: 20_000_000, toUs: 30_000_000, speed: speeds[2]),
        ]
        project.autoSpeed = badge
        return project
    }

    func testSpeedBadgeShowsOnFastClipsOnlyAndFadesAtTheirEdges() {
        let edit = project(speeds: [1, 4, 1.25], badge: EditProject.AutoSpeed())
        // c2 plays from 10 s to 12.5 s of the output.
        XCTAssertNil(SpeedBadge.badge(atOutput: 5_000_000, project: edit))
        XCTAssertEqual(SpeedBadge.badge(atOutput: 11_000_000, project: edit), SpeedBadge.Mark(speed: 4, position: .topRight, opacity: 1))
        XCTAssertEqual(SpeedBadge.badge(atOutput: 10_075_000, project: edit)?.opacity ?? 0, 0.5, accuracy: 0.01)
        XCTAssertNil(SpeedBadge.badge(atOutput: 13_000_000, project: edit), "1.25x gets no badge")
        XCTAssertNil(SpeedBadge.badge(atOutput: 11_000_000, project: project(speeds: [1, 4, 1], badge: nil)))
        XCTAssertNil(SpeedBadge.badge(atOutput: 11_000_000, project: project(speeds: [1, 4, 1], badge: EditProject.AutoSpeed(badge: false))))
        XCTAssertEqual(SpeedBadge.label(6), "⏩ 6x")
        XCTAssertEqual(SpeedBadge.label(2.5), "⏩ 2.5x")
    }

    func testSpeedBadgeStaysOnAcrossASplitBetweenTwoClipsOfOneSpeed() {
        // A 4x clip split in two: c1 plays 0 to 2.5 s of the output, c2 2.5 to 5 s, at the same speed.
        let split = project(speeds: [4, 4, 1], badge: EditProject.AutoSpeed())
        for outUs in stride(from: Int64(2_350_000), through: 2_650_000, by: 25_000) {
            XCTAssertEqual(SpeedBadge.badge(atOutput: outUs, project: split)?.opacity, 1, "at \(outUs) µs the speed does not change")
        }
        XCTAssertEqual(SpeedBadge.badge(atOutput: 75_000, project: split)?.opacity ?? 0, 0.5, accuracy: 0.01, "it fades in at the span's start")
        XCTAssertEqual(SpeedBadge.badge(atOutput: 4_925_000, project: split)?.opacity ?? 0, 0.5, accuracy: 0.01, "it fades out at the span's end")
        // Another speed at the join still fades out and in.
        let change = project(speeds: [4, 6, 1], badge: EditProject.AutoSpeed())
        XCTAssertEqual(SpeedBadge.badge(atOutput: 2_500_000 - 75_000, project: change)?.opacity ?? 0, 0.5, accuracy: 0.01)
    }

    func testSpeedBadgeDrawsInItsCorner() throws {
        let size = CGSize(width: 640, height: 360)
        let black = CIImage(color: CIColor(red: 0, green: 0, blue: 0)).cropped(to: CGRect(origin: .zero, size: size))
        let drawn = SpeedBadge.draw(SpeedBadge.Mark(speed: 6, position: .topRight, opacity: 1), plates: TextPlates(), on: black, size: size)
        let context = CIContext()
        let cg = try XCTUnwrap(context.createCGImage(drawn, from: CGRect(origin: .zero, size: size)))
        let rep = NSBitmapImageRep(cgImage: cg)
        func bright(_ x0: Int, _ y0: Int, _ x1: Int, _ y1: Int) -> Int {
            var count = 0
            for y in stride(from: y0, to: y1, by: 2) {
                for x in stride(from: x0, to: x1, by: 2) where (rep.colorAt(x: x, y: y)?.brightnessComponent ?? 0) > 0.5 {
                    count += 1
                }
            }
            return count
        }
        // NSBitmapImageRep counts y from the top: the badge is in the top-right quarter and nowhere else.
        XCTAssertGreaterThan(bright(320, 0, 640, 180), 20)
        XCTAssertEqual(bright(0, 180, 640, 360), 0)
        XCTAssertEqual(bright(0, 0, 320, 180), 0)
        if let folder = ProcessInfo.processInfo.environment["RECORDER_EDITOR_SHOTS"] {
            try rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: folder).appendingPathComponent("speed-badge.png"))
        }
    }

    func testTheWindowNamesSmoothCursorAndBadgeChangesAsOps() throws {
        let before = project(speeds: [1, 1, 1], badge: nil)
        var after = before
        after.cursorSmooth = EditProject.CursorSmooth(strength: 0.8)
        after.autoSpeed = EditProject.AutoSpeed(badge: true, position: .bottomLeft)
        let ops = try XCTUnwrap(EditOpDiff.ops(from: before, to: after))
        XCTAssertEqual(ops, [
            .cursorSmooth(EditOp.CursorSmooth(enabled: true, strength: 0.8, jitterPx: 3, idleFadeSeconds: 2)),
            .autoSpeed(EditOp.AutoSpeed(badge: true, position: .bottomLeft)),
        ])
        let off = try XCTUnwrap(EditOpDiff.ops(from: after, to: before))
        XCTAssertEqual(off, [.cursorSmooth(EditOp.CursorSmooth(enabled: false)), .autoSpeed(EditOp.AutoSpeed(badge: false, position: .topRight))])
        XCTAssertEqual(EditOp.json([.hidePrivate(EditOp.HidePrivate(ids: ["p1"]))]), #"[{"ids":["p1"],"op":"hidePrivate"}]"#)
        XCTAssertEqual(EditOp.json([.hideText(EditOp.HideText(text: "alice@example.com", excludeFixed: true))]),
                       #"[{"excludeFixed":true,"op":"hideText","text":"alice@example.com"}]"#)
    }

    // Regression test: PR #507 review — with every checkbox unticked the button said "All Hidden" while every hit still
    // showed in the movie.
    @MainActor
    func testTheHideButtonSaysAllHiddenOnlyWhenEveryHitIs() {
        func hit(_ id: String, hidden: Bool) -> PrivateHitRow {
            PrivateHitRow(id: id, kind: "email", label: "Email", masked: "al…om", from: 1, to: 2, plays: 1,
                          box: .init(x: 0.1, y: 0.1, width: 0.2, height: 0.05), hidden: hidden)
        }
        let hits = [hit("p1", hidden: false), hit("p2", hidden: false)]
        XCTAssertEqual(PrivateDataSection.hideTitle(hits: hits, picked: ["p1", "p2"]), "Hide 2 Hits")
        XCTAssertEqual(PrivateDataSection.hideTitle(hits: hits, picked: []), "Pick a Hit", "nothing ticked is not hidden")
        XCTAssertEqual(PrivateDataSection.hideTitle(hits: [hit("p1", hidden: true), hit("p2", hidden: false)], picked: ["p1"]),
                       "Pick a Hit", "a hidden hit's tick hides nothing more")
        XCTAssertEqual(PrivateDataSection.hideTitle(hits: hits.map { hit($0.id, hidden: true) }, picked: []), "All Hidden")
    }

    private func trackedRedaction() -> EditProject.Redaction {
        EditProject.Redaction(id: "r1", startUs: 0, endUs: 4_000_000, x: 0.1, y: 0.8, width: 0.4, height: 0.1,
                              track: [EditProject.TrackKey(atUs: 1_000_000, x: 0.1, y: 0.8, width: 0.4, height: 0.1),
                                      EditProject.TrackKey(atUs: 3_000_000, x: 0.1, y: 0.2, width: 0.4, height: 0.1)])
    }

    func testATrackedPartMovesBetweenItsKeyframesAndKeepsItsSpeedOutsideThem() {
        let part = trackedRedaction()
        // 0.3 of the picture a second upwards: before the first key it was lower, after the last higher.
        XCTAssertEqual(ZoomState.placed(part, atSourceUs: 500_000, track: nil, pointer: CursorTrack.Pointer()).y, 0.95, accuracy: 1e-9)
        XCTAssertEqual(ZoomState.placed(part, atSourceUs: 2_000_000, track: nil, pointer: CursorTrack.Pointer()).y, 0.5, accuracy: 1e-9)
        XCTAssertEqual(ZoomState.placed(part, atSourceUs: 3_500_000, track: nil, pointer: CursorTrack.Pointer()).y, 0.05, accuracy: 1e-9)
        var single = part
        single.track = [EditProject.TrackKey(atUs: 1_000_000, x: 0.1, y: 0.6, width: 0.4, height: 0.1)]
        XCTAssertEqual(ZoomState.placed(single, atSourceUs: 3_000_000, track: nil, pointer: CursorTrack.Pointer()).y, 0.6, accuracy: 1e-9)
        var still = part
        still.track = nil
        XCTAssertEqual(ZoomState.placed(still, atSourceUs: 2_000_000, track: nil, pointer: CursorTrack.Pointer()).y, 0.8)
    }

    func testAnExcludedAreaShowsThePictureInsideTheHiddenPart() throws {
        let size = CGSize(width: 200, height: 100)
        // A white picture; the part hides its middle in black, and leaves its left half visible.
        let white = CIImage(color: CIColor(red: 1, green: 1, blue: 1)).cropped(to: CGRect(origin: .zero, size: size))
        var part = EditProject.Redaction(id: "r1", startUs: 0, endUs: 1, x: 0.2, y: 0.2, width: 0.6, height: 0.6, style: .black)
        part.exclude = [EditProject.Box(x: 0, y: 0, width: 0.5, height: 1)]
        let hidden = Looks.redact([part], on: white)
        let drawn = RedactionTrack.leaveVisible([part], original: white, on: hidden)
        let cg = try XCTUnwrap(CIContext().createCGImage(drawn, from: CGRect(origin: .zero, size: size)))
        let rep = NSBitmapImageRep(cgImage: cg)
        XCTAssertGreaterThan(rep.colorAt(x: 70, y: 50)?.brightnessComponent ?? 0, 0.9, "the excluded half shows the picture")
        XCTAssertLessThan(rep.colorAt(x: 130, y: 50)?.brightnessComponent ?? 1, 0.1, "the rest stays hidden")
    }

    // R8 9: r4a saw sharp text inside a whole-screen blur where hidden parts overlapped. Overlapping blurs alone keep
    // the text hidden; the cause was one part's excluded area (a fixed bar) put back over another part that hides it.
    private func stripes(_ size: CGSize) -> CIImage {
        let generator = CIFilter.stripesGenerator()
        generator.color0 = CIColor(red: 1, green: 1, blue: 1)
        generator.color1 = CIColor(red: 0, green: 0, blue: 0)
        generator.width = 2
        generator.center = .zero
        return generator.outputImage!.cropped(to: CGRect(origin: .zero, size: size))
    }

    /// The spread of brightness in a square of 9 px around (x, y): about 0.5 on sharp stripes, near 0 on a blur.
    private func spread(_ rep: NSBitmapImageRep, x: Int, y: Int) -> Double {
        let values = (x - 4 ... x + 4).compactMap { rep.colorAt(x: $0, y: y)?.brightnessComponent }.map(Double.init)
        let mean = values.reduce(0, +) / Double(values.count)
        return (values.map { ($0 - mean) * ($0 - mean) }.reduce(0, +) / Double(values.count)).squareRoot()
    }

    func testOverlappingBlursKeepTheirOverlapBlurred() throws {
        let size = CGSize(width: 400, height: 200)
        let picture = stripes(size)
        let parts = [
            EditProject.Redaction(id: "a", startUs: 0, endUs: 1, x: 0, y: 0, width: 1, height: 1, style: .blur),
            EditProject.Redaction(id: "b", startUs: 0, endUs: 1, x: 0.2, y: 0.2, width: 0.5, height: 0.5, style: .blur),
            EditProject.Redaction(id: "c", startUs: 0, endUs: 1, x: 0.4, y: 0.3, width: 0.4, height: 0.4, style: .blur),
        ]
        let hidden = RedactionTrack.leaveVisible(parts, original: picture, on: Looks.redact(parts, on: picture))
        let cg = try XCTUnwrap(CIContext().createCGImage(hidden, from: CGRect(origin: .zero, size: size)))
        let rep = NSBitmapImageRep(cgImage: cg)
        let sharp = NSBitmapImageRep(cgImage: try XCTUnwrap(CIContext().createCGImage(picture, from: CGRect(origin: .zero, size: size))))
        XCTAssertGreaterThan(spread(sharp, x: 200, y: 100), 0.3, "the stripes are sharp before")
        for (x, y) in [(50, 50), (120, 80), (200, 100), (260, 100), (300, 140)] {
            XCTAssertLessThan(spread(rep, x: x, y: y), 0.1, "blurred at \(x), \(y), in one, two and three parts")
        }
    }

    func testAnExcludedAreaOfOnePartStaysHiddenUnderAnotherPart() throws {
        let size = CGSize(width: 200, height: 100)
        let white = CIImage(color: CIColor(red: 1, green: 1, blue: 1)).cropped(to: CGRect(origin: .zero, size: size))
        // A tracked line that leaves a fixed bar at the top visible, inside a band that hides the whole picture.
        var line = EditProject.Redaction(id: "line", startUs: 0, endUs: 1, x: 0, y: 0, width: 1, height: 0.5, style: .black)
        line.exclude = [EditProject.Box(x: 0, y: 0, width: 1, height: 0.2)]
        let band = EditProject.Redaction(id: "band", startUs: 0, endUs: 1, x: 0, y: 0, width: 1, height: 1, style: .black)
        let parts = [line, band]
        let drawn = RedactionTrack.leaveVisible(parts, original: white, on: Looks.redact(parts, on: white))
        let rep = NSBitmapImageRep(cgImage: try XCTUnwrap(CIContext().createCGImage(drawn, from: CGRect(origin: .zero, size: size))))
        // The bitmap's rows count from the top: the bar is rows 0 to 20.
        XCTAssertLessThan(rep.colorAt(x: 100, y: 10)?.brightnessComponent ?? 1, 0.1, "the band hides the line's excluded bar")

        // The control: when every part that covers the bar excludes it, the bar shows.
        var wide = band
        wide.exclude = [EditProject.Box(x: 0, y: 0, width: 1, height: 0.1)]
        let both = [line, wide]
        let shown = RedactionTrack.leaveVisible(both, original: white, on: Looks.redact(both, on: white))
        let shownRep = NSBitmapImageRep(cgImage: try XCTUnwrap(CIContext().createCGImage(shown, from: CGRect(origin: .zero, size: size))))
        XCTAssertGreaterThan(shownRep.colorAt(x: 100, y: 5)?.brightnessComponent ?? 0, 0.9, "excluded by both: shown")
        XCTAssertLessThan(shownRep.colorAt(x: 100, y: 15)?.brightnessComponent ?? 1, 0.1, "excluded by one only: hidden")
    }

    // R8 11: a spotlight's dim greyed the whole screen (0.7). The default is softer, and dimAround fades the dim in
    // from the lit shape, so the frame around it stays readable.
    private func spotGray(_ image: CIImage, _ x: Int, _ yFromTop: Int, height: Int) -> UInt8 {
        var pixel = [UInt8](repeating: 0, count: 4)
        CIContext().render(image, toBitmap: &pixel, rowBytes: 4, bounds: CGRect(x: x, y: height - 1 - yFromTop, width: 1, height: 1),
                           format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
        return pixel[0]
    }

    func testTheDefaultSpotlightDimLeavesTheRestReadable() {
        let white = CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: 200, height: 100))
        let spot = EditProject.Redaction(id: "s", startUs: 0, endUs: 1, x: 0.25, y: 0.25, width: 0.5, height: 0.5, style: .spotlight)
        let dimmed = spotGray(Looks.redact([spot], on: white), 10, 10, height: 100)
        XCTAssertGreaterThan(dimmed, 170, "white around the spotlight stays light enough to read")
        XCTAssertLessThan(dimmed, 215, "and still reads as dimmed")
    }

    func testDimAroundFadesTheDimInFromTheLitShape() {
        let size = 400
        let white = CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: size, height: size))
        var spot = EditProject.Redaction(id: "s", startUs: 0, endUs: 1, x: 0.4, y: 0.4, width: 0.2, height: 0.2, style: .spotlight)
        spot.cutout = .rect
        let sharp = Looks.redact([spot], on: white)
        spot.dimAround = 0.1
        let soft = Looks.redact([spot], on: white)
        // The shape spans 160 to 240; dimAround 0.1 of 400 is 40 px.
        XCTAssertGreaterThan(spotGray(soft, 200, 200, height: size), 240, "inside stays lit")
        XCTAssertGreaterThan(spotGray(soft, 248, 200, height: size), spotGray(sharp, 248, 200, height: size) + 20,
                             "8 px outside the shape the soft edge is clearly lighter than the sharp one")
        XCTAssertEqual(Int(spotGray(soft, 380, 200, height: size)), Int(spotGray(sharp, 380, 200, height: size)), accuracy: 2,
                       "far away both dim the same")
    }
}
