import AppKit
import CoreImage
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

    private func trackedRedaction() -> EditProject.Redaction {
        EditProject.Redaction(id: "r1", startUs: 0, endUs: 4_000_000, x: 0.1, y: 0.8, width: 0.4, height: 0.1,
                              track: [EditProject.TrackKey(atUs: 1_000_000, x: 0.1, y: 0.8, width: 0.4, height: 0.1),
                                      EditProject.TrackKey(atUs: 3_000_000, x: 0.1, y: 0.2, width: 0.4, height: 0.1)])
    }

    func testATrackedPartMovesBetweenItsKeyframesAndKeepsItsSpeedOutsideThem() {
        let part = trackedRedaction()
        // 0.3 of the picture a second upwards: before the first key it was lower, after the last higher.
        XCTAssertEqual(ZoomState.placed(part, atSourceUs: 500_000, track: nil).y, 0.95, accuracy: 1e-9)
        XCTAssertEqual(ZoomState.placed(part, atSourceUs: 2_000_000, track: nil).y, 0.5, accuracy: 1e-9)
        XCTAssertEqual(ZoomState.placed(part, atSourceUs: 3_500_000, track: nil).y, 0.05, accuracy: 1e-9)
        var single = part
        single.track = [EditProject.TrackKey(atUs: 1_000_000, x: 0.1, y: 0.6, width: 0.4, height: 0.1)]
        XCTAssertEqual(ZoomState.placed(single, atSourceUs: 3_000_000, track: nil).y, 0.6, accuracy: 1e-9)
        var still = part
        still.track = nil
        XCTAssertEqual(ZoomState.placed(still, atSourceUs: 2_000_000, track: nil).y, 0.8)
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
}
