import XCTest
@testable import GenesisToolsRecorder

final class RecorderEditTests: XCTestCase {
    private func project(_ clips: [EditProject.Clip], zooms: [EditProject.Zoom] = []) -> EditProject {
        var project = EditProject.whole(video: "/tmp/x.mp4", durationUs: 10_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
        project.clips = clips
        project.zooms = zooms
        return project
    }

    func testOutputAndSourceTimesMapThroughACutAndASpeedUp() {
        let edit = project([
            .init(id: "a", fromUs: 0, toUs: 3_000_000),
            .init(id: "b", fromUs: 5_000_000, toUs: 9_000_000, speed: 2),
        ])

        XCTAssertEqual(edit.outputDurationUs, 5_000_000)
        XCTAssertEqual(TimelineMap.sourceTime(atOutput: 1_000_000, in: edit), 1_000_000)
        XCTAssertEqual(TimelineMap.sourceTime(atOutput: 4_000_000, in: edit), 7_000_000)
        XCTAssertEqual(TimelineMap.outputTime(ofSource: 7_000_000, in: edit), 4_000_000)
        XCTAssertNil(TimelineMap.outputTime(ofSource: 4_000_000, in: edit), "a cut moment has no output time")
        XCTAssertEqual(TimelineMap.sourceTime(atOutput: 99_000_000, in: edit), 9_000_000, "past the end is the last frame")
    }

    func testSplitMakesTwoClipsAndRefusesAtAnEdge() throws {
        let edit = project([.init(id: "a", fromUs: 0, toUs: 4_000_000, speed: 2)])
        let split = try XCTUnwrap(TimelineMap.split(edit, atOutput: 1_000_000))

        XCTAssertEqual(split.clips.map(\.fromUs), [0, 2_000_000])
        XCTAssertEqual(split.clips.map(\.toUs), [2_000_000, 4_000_000])
        XCTAssertEqual(split.clips.map(\.speed), [2, 2])
        XCTAssertNotEqual(split.clips[0].id, split.clips[1].id)
        XCTAssertEqual(split.outputDurationUs, edit.outputDurationUs, "a split changes nothing that plays")
        XCTAssertNil(TimelineMap.split(edit, atOutput: 0))
    }

    func testDeleteKeepsTheLastClipAndTrimStaysInsideTheSource() throws {
        let edit = project([.init(id: "a", fromUs: 0, toUs: 3_000_000), .init(id: "b", fromUs: 3_000_000, toUs: 10_000_000)])
        let deleted = try XCTUnwrap(TimelineMap.delete(edit, clip: "a"))

        XCTAssertEqual(deleted.clips.map(\.id), ["b"])
        XCTAssertNil(TimelineMap.delete(deleted, clip: "b"))
        let trimmed = try XCTUnwrap(TimelineMap.trim(edit, clip: "b", toUs: 99_000_000))
        XCTAssertEqual(trimmed.clips[1].toUs, 10_000_000)
        let squeezed = try XCTUnwrap(TimelineMap.trim(edit, clip: "a", fromUs: 3_500_000))
        XCTAssertEqual(squeezed.clips[0].fromUs, 3_000_000 - TimelineMap.minimumClipUs)
    }

    func testZoomsNeverOverlap() throws {
        let edit = project([.init(id: "a", fromUs: 0, toUs: 10_000_000)])
        let (first, firstID) = try XCTUnwrap(TimelineMap.addZoom(edit, startUs: 1_000_000, endUs: 3_000_000, scale: 2))
        let (second, _) = try XCTUnwrap(TimelineMap.addZoom(first, startUs: 2_000_000, endUs: 4_000_000, scale: 2))

        XCTAssertEqual(second.zooms.map(\.startUs), [1_000_000, 3_000_000], "the overlapping zoom moves after the first")
        let moved = try XCTUnwrap(TimelineMap.moveZoom(second, zoom: firstID, startUs: 2_500_000, endUs: 4_500_000))
        XCTAssertLessThanOrEqual(moved.zooms[0].endUs, moved.zooms[1].startUs)
    }

    func testTheZoomEasesInHoldsAndKeepsItsViewInsideTheFrame() {
        let zoom = EditProject.Zoom(id: "z", startUs: 1_000_000, endUs: 3_000_000, scale: 2, focusX: 0.95, focusY: 0.05,
                                    easeInMs: 500, easeOutMs: 500)
        XCTAssertEqual(ZoomCurve.view(atSource: 500_000, zooms: [zoom], cursor: nil), .whole)
        let start = ZoomCurve.view(atSource: 1_000_000, zooms: [zoom], cursor: nil)
        XCTAssertEqual(start.scale, 1, accuracy: 0.001)
        let middle = ZoomCurve.view(atSource: 1_250_000, zooms: [zoom], cursor: nil)
        XCTAssertGreaterThan(middle.scale, 1.5, "the ease-out curve passes half its way early")
        let held = ZoomCurve.view(atSource: 2_000_000, zooms: [zoom], cursor: nil)
        XCTAssertEqual(held.scale, 2, accuracy: 0.0001)
        XCTAssertEqual(held.rect.maxX, 1, accuracy: 0.0001, "a focus at the edge is held so the view stays in the frame")
        XCTAssertEqual(held.rect.minY, 0, accuracy: 0.0001)
        XCTAssertEqual(ZoomCurve.easeOut(0), 0, accuracy: 0.0001)
        XCTAssertEqual(ZoomCurve.easeOut(1), 1, accuracy: 0.0001)
    }

    func testAFollowZoomTracksTheSmoothedCursor() {
        let track = CursorTrack(samples: (0...40).map { CursorTrack.Sample(ms: Double($0) * 50, x: 0.3, y: 0.6, click: nil) })
        let zoom = EditProject.Zoom(id: "z", startUs: 0, endUs: 2_000_000, scale: 2, mode: .follow, easeInMs: 0, easeOutMs: 0)
        let view = ZoomCurve.view(atSource: 1_000_000, zooms: [zoom], cursor: track)

        XCTAssertEqual(view.centerX, 0.3, accuracy: 0.0001)
        XCTAssertEqual(view.centerY, 0.6, accuracy: 0.0001)
    }

    func testTheDrawnCursorHoldsStillThenMovesAndSitsOnAClick() {
        // Rows only on a change: still at 0.2 until one sample before 1000 ms, then at 0.8; a click at 1000 ms.
        let track = CursorTrack(samples: [
            CursorTrack.Sample(ms: 0, x: 0.2, y: 0.2),
            CursorTrack.Sample(ms: 1000, x: 0.8, y: 0.8, click: "left"),
            CursorTrack.Sample(ms: 1500, x: 0.8, y: 0.8),
        ])
        XCTAssertEqual(track.point(atMs: 500)?.x ?? 0, 0.2, accuracy: 0.0001)
        XCTAssertEqual(track.point(atMs: 991.65)?.x ?? 0, 0.5, accuracy: 0.001)
        XCTAssertEqual(track.drawnPoint(atMs: 1000, smoothing: 1)?.x ?? 0, 0.8, accuracy: 0.0001)
        // Far from the click the path is averaged: the step is softened, not jumped.
        let far = CursorTrack(samples: [CursorTrack.Sample(ms: 0, x: 0.2, y: 0.2), CursorTrack.Sample(ms: 1000, x: 0.8, y: 0.8)])
        let softened = far.drawnPoint(atMs: 1000, smoothing: 1)?.x ?? 0
        XCTAssertGreaterThan(softened, 0.3)
        XCTAssertLessThan(softened, 0.7)
        XCTAssertFalse(far.drawsCursor)
    }

    func testTheLoaderRoundTripsAndRefusesANewerVersion() throws {
        let edit = project([.init(id: "a", fromUs: 0, toUs: 10_000_000)])
        XCTAssertEqual(try EditProject.decode(edit.encoded()), edit)
        let newer = Data(#"{"version": 9, "source": {}, "clips": []}"#.utf8)
        XCTAssertThrowsError(try EditProject.decode(newer)) { error in
            XCTAssertTrue(error.localizedDescription.contains("version 9"))
        }
    }

    func testLooksAreOptionalAndRoundTripTheShapeTheCliWrites() throws {
        // The shape TypeScript's project.ts writes; a file from before the looks has neither key.
        let old = #"{"version":1,"source":{"video":"/m.mp4","durationUs":10000000,"width":1920,"height":1080},"clips":[{"id":"c1","fromUs":0,"toUs":10000000,"speed":1}],"zooms":[],"audio":{"include":true,"volume":1,"mutedTracks":[]},"export":{"codec":"h264","maxHeight":0,"output":""},"revision":3}"#
        let decoded = try EditProject.decode(Data(old.utf8))
        XCTAssertNil(decoded.clicks)
        XCTAssertNil(decoded.frame)

        var styled = decoded
        styled.clicks = EditProject.Clicks(highlight: true, color: "#FF453A", radius: 0.05, durationMs: 600)
        styled.frame = EditProject.Frame(background: .init(kind: .color, colors: ["#101010"]), padding: 0.1, cornerRadius: 0.02, shadow: false)
        XCTAssertEqual(try EditProject.decode(styled.encoded()), styled)
        XCTAssertEqual(Looks.color("#FF8000").red, 1)
        XCTAssertEqual(Looks.color("nonsense"), .white)
        XCTAssertEqual(Looks.marks(atSourceMs: 1200, clicks: [.init(ms: 1000, x: 0.2, y: 0.3, click: "left")], durationMs: 400),
                       [.init(x: 0.2, y: 0.3, progress: 0.5)])
    }

    func testExportFpsKeepsFilmRatesAndLiftsScreenRecordings() {
        XCTAssertEqual(EditRenderer.exportFps(nominal: 45.26), 60)
        XCTAssertEqual(EditRenderer.exportFps(nominal: 120), 60)
        XCTAssertEqual(EditRenderer.exportFps(nominal: 29.97), 30)
        XCTAssertEqual(EditRenderer.exportFps(nominal: 23.976), 24)
        XCTAssertEqual(EditRenderer.exportFps(nominal: 0), 30)
    }

    func testH264SizeFitsLevelLimitsAtTheExportRate() {
        let size = EditRenderer.renderSize(source: CGSize(width: 4112, height: 2570), maxHeight: 0, h264Fps: 60)
        XCTAssertLessThanOrEqual(size.width * size.height * 60, EditRenderer.h264PixelRate)
        XCTAssertGreaterThan(size.width, 2500)
        XCTAssertEqual(EditRenderer.renderSize(source: CGSize(width: 1920, height: 1080), maxHeight: 0, h264Fps: 60), CGSize(width: 1920, height: 1080))
    }

    func testRenderSizeIsEvenAndCapped() {
        XCTAssertEqual(EditRenderer.renderSize(source: CGSize(width: 4112, height: 2570), maxHeight: 1080), CGSize(width: 1728, height: 1080))
        XCTAssertEqual(EditRenderer.renderSize(source: CGSize(width: 1919, height: 1200), maxHeight: 720), CGSize(width: 1150, height: 720))
        XCTAssertEqual(EditRenderer.renderSize(source: CGSize(width: 1921, height: 1081), maxHeight: 0), CGSize(width: 1920, height: 1080))
    }
}
