import AVFoundation
import SwiftUI
import Vision
import XCTest
@testable import GenesisToolsRecorder

final class RecorderEditTests: XCTestCase {
    private func project(_ clips: [EditProject.Clip], zooms: [EditProject.Zoom] = []) -> EditProject {
        var project = EditProject.whole(video: "/tmp/x.mp4", durationUs: 10_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
        project.clips = clips
        project.zooms = zooms
        return project
    }

    func testTheExportsNoiseReductionSurvivesADecodeAndEncode() throws {
        let json = #"{"include":true,"volume":1,"mutedTracks":[],"denoise":{"method":"afftdn","reductionDb":20,"tracks":[1]}}"#
        let audio = try JSONDecoder().decode(EditProject.AudioSettings.self, from: Data(json.utf8))
        XCTAssertEqual(audio.denoise, EditProject.Denoise(method: "afftdn", reductionDb: 20, tracks: [1]))
        let again = try JSONDecoder().decode(EditProject.AudioSettings.self, from: JSONEncoder().encode(audio))
        XCTAssertEqual(again, audio, "a save from the editor keeps the setting")
        let older = try JSONDecoder().decode(EditProject.AudioSettings.self, from: Data(#"{"include":true,"volume":1,"mutedTracks":[]}"#.utf8))
        XCTAssertNil(older.denoise)
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

    func testAFollowingPartCentresOnTheCursorInsideThePicture() {
        let track = CursorTrack(samples: [
            CursorTrack.Sample(ms: 0, x: 0.5, y: 0.5),
            CursorTrack.Sample(ms: 1000, x: 0.5, y: 0.5),
            CursorTrack.Sample(ms: 2000, x: 0.98, y: 0.02),
            CursorTrack.Sample(ms: 3000, x: 0.98, y: 0.02),
        ])
        var part = EditProject.Redaction(id: "s", startUs: 0, endUs: 3_000_000, x: 0, y: 0, width: 0.2, height: 0.2, style: .spotlight)
        XCTAssertEqual(ZoomState.placed(part, atSourceUs: 500_000, track: track).x, 0, "not following: it stays")
        part.follow = true
        let centred = ZoomState.placed(part, atSourceUs: 500_000, track: track)
        XCTAssertEqual(centred.x, 0.4, accuracy: 0.001)
        XCTAssertEqual(centred.y, 0.4, accuracy: 0.001)
        let corner = ZoomState.placed(part, atSourceUs: 2_800_000, track: track)
        XCTAssertEqual(corner.x, 0.8, accuracy: 0.001, "kept inside the picture")
        XCTAssertEqual(corner.y, 0, accuracy: 0.001)
    }

    func testChangedPartsTellADragFromAnAdd() {
        let edit = project([.init(id: "a", fromUs: 0, toUs: 4_000_000)])
        var louder = edit
        louder.audio.volume = 0.8
        XCTAssertEqual(EditorModel.changedParts(edit, louder), ["audio"])
        var titled = edit
        titled.texts = [EditProject.TextNote(id: "t", startUs: 0, endUs: 1_000_000, text: "A")]
        XCTAssertEqual(EditorModel.changedParts(edit, titled), ["texts", "count"], "an add is its own undo step")
        var moved = titled
        moved.texts?[0].x = 0.3
        XCTAssertEqual(EditorModel.changedParts(titled, moved), ["texts"], "a move continues a drag")
    }

    func testCutsDipTheSoundButASplitDoesNot() {
        let edit = project([.init(id: "a", fromUs: 0, toUs: 2_000_000), .init(id: "b", fromUs: 2_000_000, toUs: 3_000_000),
                            .init(id: "c", fromUs: 5_000_000, toUs: 6_000_000), .init(id: "d", fromUs: 6_000_000, toUs: 8_000_000, speed: 2)])
        XCTAssertEqual(Declick.cuts(in: edit), [3_000_000, 4_000_000], "a split joins nothing; a cut and a speed change do")
        let ramps = Declick.ramps(at: [3_000_000], lengthUs: 5_000_000)
        XCTAssertEqual(ramps.map(\.startUs), [2_975_000, 3_000_000])
        XCTAssertEqual(ramps.map(\.endUs), [3_000_000, 3_025_000])
        XCTAssertEqual(ramps.map(\.from), [1, 0])
        XCTAssertEqual(ramps.map(\.to), [0, 1])
    }

    func testMusicFadesAtBothEndsAndDucksUnderSpeech() {
        let music = EditProject.Music(file: "/m.mp3", volume: 0.5, duck: 0.6, fadeMs: 1000)
        let speech: [(fromUs: Int64, toUs: Int64)] = [(4_000_000, 6_000_000)]
        let length: Int64 = 10_000_000
        XCTAssertEqual(MusicMix.gain(atUs: 0, music: music, speech: speech, lengthUs: length), 0, accuracy: 0.001)
        XCTAssertEqual(MusicMix.gain(atUs: 500_000, music: music, speech: speech, lengthUs: length), 0.25, accuracy: 0.001, "half way into the fade")
        XCTAssertEqual(MusicMix.gain(atUs: 2_000_000, music: music, speech: speech, lengthUs: length), 0.5, accuracy: 0.001)
        XCTAssertEqual(MusicMix.gain(atUs: 5_000_000, music: music, speech: speech, lengthUs: length), 0.2, accuracy: 0.001, "40 % under speech")
        XCTAssertEqual(MusicMix.gain(atUs: 6_150_000, music: music, speech: speech, lengthUs: length), 0.35, accuracy: 0.001, "half way back up")
        XCTAssertEqual(MusicMix.gain(atUs: length, music: music, speech: speech, lengthUs: length), 0, accuracy: 0.001)
        let frames = MusicMix.keyframes(music: music, speech: speech, lengthUs: length)
        XCTAssertEqual(frames.map(\.us), [0, 1_000_000, 3_700_000, 4_000_000, 6_000_000, 6_300_000, 9_000_000, 10_000_000])
    }

    func testSpokenPartsFollowCutsAndMergeWhenClose() {
        let edit = project([.init(id: "a", fromUs: 0, toUs: 3_000_000), .init(id: "b", fromUs: 5_000_000, toUs: 10_000_000)])
        let lines = [CaptionTrack.Line(fromUs: 1_000_000, toUs: 2_000_000, text: "one"),
                     CaptionTrack.Line(fromUs: 2_100_000, toUs: 2_900_000, text: "two"),
                     CaptionTrack.Line(fromUs: 3_500_000, toUs: 4_500_000, text: "cut"),
                     CaptionTrack.Line(fromUs: 6_000_000, toUs: 7_000_000, text: "after")]
        let speech = MusicMix.speech(lines: lines, project: edit)
        XCTAssertEqual(speech.map(\.fromUs), [1_000_000, 4_000_000])
        XCTAssertEqual(speech.map(\.toUs), [2_900_000, 5_000_000])
    }

    func testSnapPicksTheNearestTargetInsideTheTolerance() {
        XCTAssertEqual(TimelineMap.snap(1_040_000, to: [0, 1_000_000, 1_100_000], toleranceUs: 70_000), 1_000_000)
        XCTAssertEqual(TimelineMap.snap(1_060_000, to: [1_000_000, 1_100_000], toleranceUs: 70_000), 1_100_000)
        XCTAssertNil(TimelineMap.snap(1_500_000, to: [1_000_000], toleranceUs: 70_000), "too far: the drag stays under the pointer")
        XCTAssertNil(TimelineMap.snap(0, to: [], toleranceUs: 70_000))
    }

    func testCuttingAPartSplitsTheClipItFallsInAndKeepsSpeeds() throws {
        let edit = project([.init(id: "a", fromUs: 0, toUs: 4_000_000), .init(id: "b", fromUs: 6_000_000, toUs: 10_000_000, speed: 2)])
        // 1 s to 5 s of output: the end of a (1-4 s) and the first second of b (source 6-8 s at 2x).
        let cut = try XCTUnwrap(TimelineMap.cut(edit, fromOut: 1_000_000, toOut: 5_000_000))
        XCTAssertEqual(cut.clips.map(\.fromUs), [0, 8_000_000])
        XCTAssertEqual(cut.clips.map(\.toUs), [1_000_000, 10_000_000])
        XCTAssertEqual(cut.clips.map(\.speed), [1, 2])
        XCTAssertEqual(cut.outputDurationUs, edit.outputDurationUs - 4_000_000)
        let inside = try XCTUnwrap(TimelineMap.cut(edit, fromOut: 1_000_000, toOut: 2_000_000))
        XCTAssertEqual(inside.clips.count, 3, "a part inside a clip makes it two")
        XCTAssertEqual(Set(inside.clips.map(\.id)).count, 3, "the new piece has its own id")
        XCTAssertNil(TimelineMap.cut(edit, fromOut: 0, toOut: edit.outputDurationUs), "something has to stay")
    }

    func testTrimToPlayheadCutsOneSideAndKeepsTheFrame() throws {
        let edit = project([.init(id: "a", fromUs: 0, toUs: 2_000_000), .init(id: "b", fromUs: 4_000_000, toUs: 8_000_000, speed: 2)])
        let (start, startPlayhead) = try XCTUnwrap(TimelineMap.trimToPlayhead(edit, atOutput: 3_000_000, side: .start))

        XCTAssertEqual(start.clips[1].fromUs, 6_000_000)
        XCTAssertEqual(startPlayhead, 2_000_000, "the frame under the playhead now plays where the clip starts")
        XCTAssertEqual(TimelineMap.sourceTime(atOutput: startPlayhead, in: start), 6_000_000)
        let (end, endPlayhead) = try XCTUnwrap(TimelineMap.trimToPlayhead(edit, atOutput: 1_000_000, side: .end))
        XCTAssertEqual(end.clips[0].toUs, 1_000_000)
        XCTAssertEqual(endPlayhead, 1_000_000)
        XCTAssertEqual(end.clips[1], edit.clips[1], "the other clip stays")
        XCTAssertNil(TimelineMap.trimToPlayhead(edit, atOutput: 2_000_000, side: .start), "a clip's edge trims nothing")
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

    func testAFollowZoomGlidesOverAMoveInsteadOfJumping() {
        // The pointer stands at 0.2 for 2 s, moves to 0.8 in one sample, then stands again: rows only on a change.
        let track = CursorTrack(samples: [
            CursorTrack.Sample(ms: 0, x: 0.2, y: 0.5), CursorTrack.Sample(ms: 500, x: 0.2, y: 0.5),
            CursorTrack.Sample(ms: 2000, x: 0.8, y: 0.5), CursorTrack.Sample(ms: 2500, x: 0.8, y: 0.5),
            CursorTrack.Sample(ms: 4000, x: 0.8, y: 0.5),
        ])
        let zoom = EditProject.Zoom(id: "z", startUs: 0, endUs: 4_000_000, scale: 1.5, mode: .follow, easeInMs: 0, easeOutMs: 0)
        let centers = stride(from: 1_600_000, through: 2_400_000, by: 100_000).map {
            ZoomCurve.view(atSource: Int64($0), zooms: [zoom], cursor: track).centerX
        }
        // It moves a little every step, never more than a fifth of the way at once.
        for (a, b) in zip(centers, centers.dropFirst()) {
            XCTAssertGreaterThanOrEqual(b, a - 0.0001)
            XCTAssertLessThan(b - a, 0.12)
        }
        XCTAssertGreaterThan(centers.last! - centers.first!, 0.2)
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

    func testAnIdleCursorFadesOutAndComesBackWhenItMoves() {
        // Still from 0 to 3000 ms (the 500 ms keep-alive rows do not count as moves), then it moves.
        let track = CursorTrack(samples: [0, 500, 1000, 1500, 2000, 2500, 3000].map { CursorTrack.Sample(ms: $0, x: 0.5, y: 0.5) }
            + [CursorTrack.Sample(ms: 3200, x: 0.6, y: 0.5)])
        XCTAssertEqual(track.visibility(atMs: 900, hideAfterMs: 1000), 1)
        XCTAssertEqual(track.visibility(atMs: 1150, hideAfterMs: 1000), 0.5, accuracy: 0.001)
        XCTAssertEqual(track.visibility(atMs: 2000, hideAfterMs: 1000), 0)
        XCTAssertEqual(track.visibility(atMs: 3190, hideAfterMs: 1000), 1)
        XCTAssertEqual(track.visibility(atMs: 2000, hideAfterMs: 0), 1)
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

    func testACanvasAspectKeepsThePictureHeightAsItsShortSideAndFitsTheH264Budget() {
        let source = CGSize(width: 1728, height: 1080)
        XCTAssertEqual(EditRenderer.outputSizes(source: source, maxHeight: 0, aspect: .wide).canvas, CGSize(width: 1920, height: 1080))
        XCTAssertEqual(EditRenderer.outputSizes(source: source, maxHeight: 0, aspect: .square).canvas, CGSize(width: 1080, height: 1080))
        XCTAssertEqual(EditRenderer.outputSizes(source: source, maxHeight: 0, aspect: .portrait).canvas, CGSize(width: 1080, height: 1920))
        XCTAssertEqual(EditRenderer.outputSizes(source: source, maxHeight: 0, aspect: .portrait).picture, source)
        // A 4K portrait canvas would be 2570 × 4568: H.264 at 60 fps fits it into 2560 × 1600 worth of pixels.
        let fitted = EditRenderer.outputSizes(source: CGSize(width: 4112, height: 2570), maxHeight: 0, aspect: .portrait, h264Fps: 60)
        XCTAssertLessThanOrEqual(fitted.canvas.width * fitted.canvas.height, 2560 * 1600)
        XCTAssertEqual(fitted.canvas.height / fitted.canvas.width, 16.0 / 9, accuracy: 0.01)
        XCTAssertEqual(fitted.picture.height, fitted.canvas.width, accuracy: 2)
    }

    func testACoverCropHasTheRoomsShapeFollowsTheFocusAndStaysInsideThePicture() {
        let picture = CGSize(width: 1728, height: 1080)
        let room = CGSize(width: 900, height: 1600)
        let centred = Looks.coverCrop(picture: picture, room: room, focus: CGPoint(x: 0.5, y: 0.5))
        XCTAssertEqual(centred.height, 1080)
        XCTAssertEqual(centred.width / centred.height, 900.0 / 1600, accuracy: 0.001)
        XCTAssertEqual(centred.midX, 864, accuracy: 0.5)
        let right = Looks.coverCrop(picture: picture, room: room, focus: CGPoint(x: 0.99, y: 0.2))
        XCTAssertEqual(right.maxX, 1728, accuracy: 0.5)
        XCTAssertEqual(right.minY, 0, accuracy: 0.5)
    }

    func testTheSourceToCanvasMapFollowsTheZoomAndTheFrameAndMatchesWhatTheFrameDraws() throws {
        let picture = CGSize(width: 160, height: 100), square = CGSize(width: 100, height: 100)
        let whole = Looks.sourceToCanvas(view: .whole, frame: nil, picture: picture, canvas: picture)
        XCTAssertEqual(whole, Looks.SourceToCanvas())
        let zoomed = Looks.sourceToCanvas(view: ZoomCurve.View(scale: 2, centerX: 0.5, centerY: 0.5), frame: nil, picture: picture, canvas: picture)
        XCTAssertEqual(zoomed.point(CGPoint(x: 0.25, y: 0.25)).x, 0, accuracy: 1e-9)
        XCTAssertEqual(zoomed.point(CGPoint(x: 0.75, y: 0.75)).y, 1, accuracy: 1e-9)

        var frame = EditProject.Frame()
        frame.padding = 0.1
        frame.cornerRadius = 0
        frame.shadow = false
        let map = Looks.sourceToCanvas(view: .whole, frame: frame, picture: picture, canvas: square)
        let rect = CGRect(x: 0.2, y: 0.3, width: 0.4, height: 0.5)
        let back = map.sourceRect(ofCanvas: map.rect(rect))
        XCTAssertEqual(back.minX, rect.minX, accuracy: 1e-9)
        XCTAssertEqual(back.height, rect.height, accuracy: 1e-9)

        // A white picture framed on a black background: the map's edges are where the white starts and stops.
        let white = CIImage(color: .white).cropped(to: CGRect(origin: .zero, size: picture))
        frame.background = EditProject.Background(kind: .color, colors: ["#000000"])
        let drawn = Looks.applyFrame(frame, to: white, picture: picture, canvas: square)
        let shown = map.rect(CGRect(x: 0, y: 0, width: 1, height: 1))
        XCTAssertEqual(map.shown.minX, shown.minX, accuracy: 1e-9)
        XCTAssertEqual(map.shown.maxY, shown.maxY, accuracy: 1e-9)
        var pixels = [UInt8](repeating: 0, count: 100 * 100 * 4)
        CIContext().render(drawn, toBitmap: &pixels, rowBytes: 400, bounds: CGRect(origin: .zero, size: square), format: .RGBA8, colorSpace: nil)
        // The bitmap's first row is the canvas's top; probe just inside and just outside each edge of the map.
        func lum(_ x: Double, _ y: Double) -> UInt8 { pixels[(Int(y * 100) * 100 + Int(x * 100)) * 4] }
        XCTAssertGreaterThan(lum(shown.minX + 0.02, shown.midY), 200)
        XCTAssertLessThan(lum(shown.minX - 0.02, shown.midY), 50)
        XCTAssertGreaterThan(lum(shown.midX, shown.minY + 0.02), 200)
        XCTAssertLessThan(lum(shown.midX, shown.minY - 0.02), 50)
        XCTAssertGreaterThan(lum(shown.midX, shown.maxY - 0.02), 200)
        XCTAssertLessThan(lum(shown.midX, shown.maxY + 0.02), 50)

        // A cover crop off centre: the picture's left half is white, so x 0.5 of the source must land where it turns.
        frame.fit = .cover
        let focus = CGPoint(x: 0.35, y: 0.5)
        let cover = Looks.sourceToCanvas(view: .whole, frame: frame, picture: picture, canvas: square, coverFocus: focus)
        let half = CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: 80, height: 100))
            .composited(over: CIImage(color: .black).cropped(to: CGRect(origin: .zero, size: picture)))
        let covered = Looks.applyFrame(frame, to: half, picture: picture, canvas: square, focus: focus)
        CIContext().render(covered, toBitmap: &pixels, rowBytes: 400, bounds: CGRect(origin: .zero, size: square), format: .RGBA8, colorSpace: nil)
        let turn = cover.point(CGPoint(x: 0.5, y: 0.5))
        XCTAssertGreaterThan(lum(turn.x - 0.03, turn.y), 200)
        XCTAssertLessThan(lum(turn.x + 0.03, turn.y), 50)
    }

    func testATranscriptFixUsesTheSameMillisecondKeyAsTheCLIAndHidesALineWithNoWords() throws {
        // The CLI keys a fix by Math.round(start * 1000); a line read from 1.8 s holds 1799999 µs after the cast.
        let settings = try JSONDecoder().decode(EditProject.TranscriptSettings.self,
                                                from: Data(#"{"fixes":{"1800":"Fixed words","3000":""}}"#.utf8))
        let line = CaptionTrack.Line(fromUs: Int64(1.8 * 1_000_000), toUs: 2_500_000, text: "Raw words")
        XCTAssertEqual(EditProject.TranscriptSettings.key(line), "1800")
        XCTAssertEqual(settings.apply(line)?.text, "Fixed words")
        XCTAssertNil(settings.apply(CaptionTrack.Line(fromUs: 3_000_000, toUs: 4_000_000, text: "gone")))
        XCTAssertEqual(settings.apply(CaptionTrack.Line(fromUs: 5_000_000, toUs: 6_000_000, text: "kept"))?.text, "kept")
    }

    func testCaptionsReadTheTranscriptCacheAndFindTheLineSpokenAtASourceTime() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("captions-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let video = folder.appendingPathComponent("screen.mp4").path
        let json = #"{"text":"","segments":[{"text":" Hello there. ","start":0.5,"end":1.5},{"text":"  ","start":2,"end":3},{"text":"Second line","start":3,"end":4.25}]}"#
        try Data(json.utf8).write(to: CaptionTrack.cacheURL(video: video))
        let track = try XCTUnwrap(CaptionTrack.load(video: video))

        XCTAssertEqual(track.lines.count, 2)
        XCTAssertEqual(track.line(atSourceUs: 1_000_000)?.text, "Hello there.")
        XCTAssertNil(track.line(atSourceUs: 2_000_000))
        XCTAssertEqual(track.line(atSourceUs: 4_000_000)?.text, "Second line")
        XCTAssertNil(track.line(atSourceUs: 4_300_000))
        let plate = try XCTUnwrap(track.image(for: track.lines[0], fontSize: 40, maxWidth: 800))
        XCTAssertGreaterThan(plate.extent.width, 100)
        XCTAssertLessThan(plate.extent.width, 800)
    }

    func testAShortcutShowsForItsDurationFadesAndGivesWayToTheNextPress() {
        let track = CursorTrack(samples: [
            CursorTrack.Sample(ms: 0, x: 0.5, y: 0.5),
            CursorTrack.Sample(ms: 1000, x: 0.5, y: 0.5, key: "⌘C"),
            CursorTrack.Sample(ms: 1500, x: 0.5, y: 0.5, key: "⌘V"),
        ])
        XCTAssertNil(track.key(atMs: 900, durationMs: 1200))
        XCTAssertEqual(track.key(atMs: 1200, durationMs: 1200)?.label, "⌘C")
        XCTAssertEqual(track.key(atMs: 1600, durationMs: 1200)?.label, "⌘V")
        XCTAssertEqual(track.key(atMs: 2575, durationMs: 1200)?.opacity ?? 0, 0.5, accuracy: 0.001)
        XCTAssertNil(track.key(atMs: 2700, durationMs: 1200))
    }

    func testMotionBlurSmearsOnlyAMovingZoom() {
        // A sharp edge: black left half, white right half.
        let size = CGRect(x: 0, y: 0, width: 200, height: 100)
        let image = CIImage(color: .white).cropped(to: CGRect(x: 100, y: 0, width: 100, height: 100))
            .composited(over: CIImage(color: .black).cropped(to: size))
        let context = CIContext()
        func gray(_ result: CIImage, _ x: Int) -> UInt8 {
            var pixel = [UInt8](repeating: 0, count: 4)
            context.render(result, toBitmap: &pixel, rowBytes: 4, bounds: CGRect(x: x, y: 50, width: 1, height: 1),
                           format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
            return pixel[0]
        }
        let still = ZoomCurve.View(scale: 2, centerX: 0.5, centerY: 0.5)
        XCTAssertEqual(gray(Looks.motionBlur(from: still, to: still, amount: 0.5, on: image), 96), 0, "a still zoom stays sharp")
        let panned = ZoomCurve.View(scale: 2, centerX: 0.55, centerY: 0.5)
        let blurred = Looks.motionBlur(from: still, to: panned, amount: 0.5, on: image)
        XCTAssertGreaterThan(gray(blurred, 96), 20, "a pan smears the edge sideways")
        XCTAssertEqual(blurred.extent, size, "the picture keeps its size")
        XCTAssertEqual(gray(Looks.motionBlur(from: still, to: panned, amount: 0, on: image), 96), 0, "0 is off")
    }

    func testASpotlightDimsEverythingButItsRectangle() {
        let white = CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: 200, height: 100))
        let spot = EditProject.Redaction(id: "s", startUs: 0, endUs: 1, x: 0.25, y: 0, width: 0.5, height: 0.5, style: .spotlight)
        let output = Looks.redact([spot], on: white)
        let context = CIContext()
        func gray(_ x: Int, _ yFromTop: Int) -> UInt8 {
            var pixel = [UInt8](repeating: 0, count: 4)
            context.render(output, toBitmap: &pixel, rowBytes: 4, bounds: CGRect(x: x, y: 100 - 1 - yFromTop, width: 1, height: 1),
                           format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
            return pixel[0]
        }
        XCTAssertGreaterThan(gray(100, 10), 240, "inside the spotlight stays as it was")
        XCTAssertLessThan(gray(20, 10), 160, "outside it is dimmed")
        XCTAssertGreaterThan(gray(20, 10), 60, "dimmed, not black")
        XCTAssertLessThan(gray(100, 80), 160)
    }

    func testTwoSpotlightsBothStayLitAndTheRestDimsOnce() {
        let white = CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: 200, height: 100))
        let left = EditProject.Redaction(id: "a", startUs: 0, endUs: 1, x: 0, y: 0, width: 0.2, height: 0.5, style: .spotlight)
        let right = EditProject.Redaction(id: "b", startUs: 0, endUs: 1, x: 0.8, y: 0, width: 0.2, height: 0.5, style: .spotlight)
        let context = CIContext()
        func gray(_ image: CIImage, _ x: Int, _ yFromTop: Int) -> UInt8 {
            var pixel = [UInt8](repeating: 0, count: 4)
            context.render(image, toBitmap: &pixel, rowBytes: 4, bounds: CGRect(x: x, y: 100 - 1 - yFromTop, width: 1, height: 1),
                           format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
            return pixel[0]
        }
        let both = Looks.redact([left, right], on: white)
        let one = Looks.redact([left], on: white)
        XCTAssertGreaterThan(gray(both, 20, 10), 240, "the first stays lit")
        XCTAssertGreaterThan(gray(both, 180, 10), 240, "the second is lit too")
        XCTAssertEqual(Int(gray(both, 100, 80)), Int(gray(one, 100, 80)), accuracy: 1, "the rest is dimmed once, not twice")
        let fading = Looks.redact([left], on: white, spotlightFade: 0.5)
        XCTAssertGreaterThan(gray(fading, 100, 80), gray(one, 100, 80), "half way into its fade it dims less")
    }

    /// A 2 s, 320 × 200 movie of grey frames, for an export to chew on.
    private func makeMovie(at url: URL) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264,
                                                                          AVVideoWidthKey: 320, AVVideoHeightKey: 200])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        writer.add(input)
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)
        for frame in 0..<60 {
            while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(5)) }
            var buffer: CVPixelBuffer?
            CVPixelBufferCreate(nil, 320, 200, kCVPixelFormatType_32BGRA, nil, &buffer)
            guard let buffer else { continue }
            CVPixelBufferLockBaseAddress(buffer, [])
            memset(CVPixelBufferGetBaseAddress(buffer), Int32(60 + frame), CVPixelBufferGetDataSize(buffer))
            CVPixelBufferUnlockBaseAddress(buffer, [])
            adaptor.append(buffer, withPresentationTime: CMTime(value: Int64(frame), timescale: 30))
        }
        input.markAsFinished()
        await writer.finishWriting()
    }

    func testACancelledExportStopsAndLeavesNoFile() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("cancel-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let movie = folder.appendingPathComponent("screen.mp4")
        try await makeMovie(at: movie)
        let project = EditProject.whole(video: movie.path, durationUs: 2_000_000, width: 320, height: 200, cursor: nil, recording: nil)
        let out = folder.appendingPathComponent("out.mp4")
        do {
            _ = try await EditExporter.export(project: project, to: out, isCancelled: { true }) { _ in }
            XCTFail("a cancelled export finished")
        } catch is CancellationError {
            XCTAssertFalse(FileManager.default.fileExists(atPath: out.path), "a cancelled export writes no file")
            XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appendingPathComponent("out.partial.mp4").path), "nor a partial one")
        }
        let whole = try await EditExporter.export(project: project, to: folder.appendingPathComponent("whole.mp4")) { _ in }
        XCTAssertGreaterThan(whole.bytes, 0, "the same export, not cancelled, writes the movie")
    }

    func testAChangeIsNamedForTheUndoMenuAndOpensItsTab() {
        let base = project([EditProject.Clip(id: "a", fromUs: 0, toUs: 10_000_000)])
        var withText = base
        withText.texts = [EditProject.TextNote(id: "t1", startUs: 0, endUs: 1_000_000, text: "Hello")]
        XCTAssertEqual(EditorModel.changeName(from: base, to: withText).name, "Add Text")
        XCTAssertEqual(EditorModel.changeName(from: withText, to: base).name, "Delete Text")
        var moved = withText
        moved.texts?[0].x = 0.3
        XCTAssertEqual(EditorModel.changeName(from: withText, to: moved).name, "Text Change")
        XCTAssertEqual(EditorModel.changeName(from: withText, to: moved).tab, .text)
        var louder = base
        louder.audio.volume = 1.5
        XCTAssertEqual(EditorModel.changeName(from: base, to: louder).tab, .audio)
        var both = louder
        both.texts = withText.texts
        XCTAssertEqual(EditorModel.changeName(from: base, to: both).name, "Changes")
    }

    func testTheSizeEstimateMatchesAMeasuredExport() {
        let bytes = EditExporter.estimatedBytes(size: CGSize(width: 1152, height: 720), lengthUs: 20_000_000, codec: .h264)
        XCTAssertEqual(Double(bytes), 10_300_000, accuracy: 600_000, "the export measured at 10.3 MB")
        XCTAssertLessThan(EditExporter.estimatedBytes(size: CGSize(width: 1152, height: 720), lengthUs: 20_000_000, codec: .hevc), bytes)
    }

    /// The tag over a dragged segment names its start in the movie (after the cut) and its length.
    @MainActor
    func testTheDragTagShowsTheOutputStartAndTheLength() throws {
        let cut = project([EditProject.Clip(id: "a", fromUs: 0, toUs: 2_000_000), EditProject.Clip(id: "b", fromUs: 4_000_000, toUs: 10_000_000)])
        let view = DragTimeTag(project: cut, startUs: 5_000_000, endUs: 6_500_000)
            .padding(.top, 24).padding(8)
            .background(Color.gray)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.cgImage)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
        XCTAssertTrue(text.contains("00:03.0"), text)
        // OCR reads a small "s" as "S" at this size.
        XCTAssertTrue(text.lowercased().contains("1.5 s"), text)
    }

    func testACheckIssueKeepsItsFixOpsForApply() throws {
        let answer = #"{"ok":false,"issues":[{"severity":"check","item":"text t2","message":"overlap","fix":"movie.retime({ id: \"t2\", at: 5 })","at":4,"target":{"list":"texts","id":"t2"},"action":{"label":"Move After","ops":[{"op":"retime","id":"t2","at":5}]}},{"severity":"fix","item":"music","message":"missing"}]}"#
        let issues = try XCTUnwrap(EditorModel.issues(fromCheck: Data(answer.utf8)))
        XCTAssertEqual(issues.count, 2)
        XCTAssertEqual(issues[0].action?.label, "Move After")
        XCTAssertEqual(issues[0].actionOps, #"[{"at":5,"id":"t2","op":"retime"}]"#)
        XCTAssertEqual(issues[0].selection, .text("t2"))
        XCTAssertNil(issues[1].actionOps)
        XCTAssertNil(EditorModel.issues(fromCheck: Data("not json".utf8)))
    }

    func testAnOutsideEditIsSaidInWordsWithWhatToFlashAndWhere() throws {
        let before = project([.init(id: "c", fromUs: 0, toUs: 10_000_000)])
        var after = before
        after.texts = [EditProject.TextNote(id: "t1", startUs: 200_000, endUs: 3_200_000, text: "Hello")]
        after.frame = EditProject.Frame()
        after.revision = 7
        after.updatedBy = "agent"

        let added = try XCTUnwrap(EditDiff.describe(old: before, new: after, by: "agent", at: Date()))
        XCTAssertEqual(added.lines.map(\.text), ["Added the text “Hello”, 00:00.2 to 00:03.2", "Turned the frame on (gradient)"])
        XCTAssertEqual(added.itemIDs, ["t1"])
        XCTAssertEqual(added.startUs, 200_000)
        XCTAssertTrue(added.touchesPicture)

        var moved = after
        moved.texts = [EditProject.TextNote(id: "t1", startUs: 1_200_000, endUs: 4_200_000, text: "Hello")]
        let move = try XCTUnwrap(EditDiff.describe(old: after, new: moved, by: "agent", at: Date()))
        XCTAssertEqual(move.lines.map(\.text), ["Moved the text “Hello” to 00:01.2 to 00:04.2"])
        XCTAssertFalse(move.touchesPicture)

        var removed = moved
        removed.texts = []
        XCTAssertEqual(EditDiff.describe(old: moved, new: removed, by: "agent", at: Date())?.lines.map(\.text), ["Removed the text “Hello”"])
        XCTAssertNil(EditDiff.describe(old: removed, new: removed, by: "agent", at: Date()))
    }

    func testSelectNextAndPreviousWalkTheItemsInTimeOrder() {
        let items: [EditorModel.TimelineItem] = [
            .init(selection: .zoom("z1"), startUs: 1_000_000),
            .init(selection: .text("t1"), startUs: 2_000_000),
            .init(selection: .shape("s1"), startUs: 5_000_000),
        ]
        // With nothing selected, forward takes the first item at or after the playhead, back the last one before it.
        XCTAssertEqual(EditorModel.adjacent(in: items, current: .none, playheadUs: 2_000_000, forward: true)?.selection, .text("t1"))
        XCTAssertEqual(EditorModel.adjacent(in: items, current: .none, playheadUs: 2_000_000, forward: false)?.selection, .zoom("z1"))
        XCTAssertEqual(EditorModel.adjacent(in: items, current: .clip("c1"), playheadUs: 6_000_000, forward: true)?.selection, nil)
        // With an item selected, the keys step through the list and stop at both ends.
        XCTAssertEqual(EditorModel.adjacent(in: items, current: .text("t1"), playheadUs: 0, forward: true)?.selection, .shape("s1"))
        XCTAssertEqual(EditorModel.adjacent(in: items, current: .text("t1"), playheadUs: 0, forward: false)?.selection, .zoom("z1"))
        XCTAssertNil(EditorModel.adjacent(in: items, current: .shape("s1"), playheadUs: 0, forward: true))
        XCTAssertNil(EditorModel.adjacent(in: items, current: .zoom("z1"), playheadUs: 0, forward: false))
    }

    func testTrimmingASelectionToThePlayheadNeedsThePlayheadInsideIt() {
        XCTAssertEqual(EditorModel.trimmed(start: 1_000_000, end: 4_000_000, at: 2_000_000, side: .start)?.start, 2_000_000)
        XCTAssertEqual(EditorModel.trimmed(start: 1_000_000, end: 4_000_000, at: 2_000_000, side: .end)?.end, 2_000_000)
        XCTAssertNil(EditorModel.trimmed(start: 1_000_000, end: 4_000_000, at: 5_000_000, side: .end))
        XCTAssertNil(EditorModel.trimmed(start: 1_000_000, end: 4_000_000, at: 3_950_000, side: .start))
    }

    func testMovingASelectionInTimeKeepsItsLengthInsideTheRecording() {
        XCTAssertEqual(EditorModel.shifted(start: 1_000_000, end: 3_000_000, by: 500_000, durationUs: 10_000_000).start, 1_500_000)
        let atStart = EditorModel.shifted(start: 200_000, end: 1_200_000, by: -1_000_000, durationUs: 10_000_000)
        XCTAssertEqual(atStart.start, 0)
        XCTAssertEqual(atStart.end, 1_000_000)
        let atEnd = EditorModel.shifted(start: 8_000_000, end: 9_500_000, by: 1_000_000, durationUs: 10_000_000)
        XCTAssertEqual(atEnd.start, 8_500_000)
        XCTAssertEqual(atEnd.end, 10_000_000)
    }

    func testClickTicksPlayAtTheirOutputTimesOneTickApart() {
        var project = EditProject.whole(video: "/tmp/x.mp4", durationUs: 10_000_000, width: 100, height: 100, cursor: nil, recording: nil)
        project.clips = [EditProject.Clip(id: "a", fromUs: 0, toUs: 4_000_000), EditProject.Clip(id: "b", fromUs: 6_000_000, toUs: 10_000_000)]
        let times = ClickSound.times(clicks: [1_000_000, 1_020_000, 5_000_000, 7_000_000], project: project)
        XCTAssertEqual(times, [1_000_000, 5_000_000], "a click 20 ms after another, and one in the cut, play no tick")
        XCTAssertEqual(ClickSound.tick().count, 2160, "45 ms at 48 kHz")
    }

    func testACopiedRecordingFolderReadsItsOwnMovie() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("copied-\(UUID().uuidString)")
        let original = root.appendingPathComponent("original"), copy = root.appendingPathComponent("copy")
        for folder in [original, copy] {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try Data("movie bytes".utf8).write(to: folder.appendingPathComponent("screen.mp4"))
            try Data("{}\n".utf8).write(to: folder.appendingPathComponent("cursor.jsonl"))
        }
        defer { try? FileManager.default.removeItem(at: root) }
        let project = EditProject.whole(video: original.appendingPathComponent("screen.mp4").path, durationUs: 1_000_000, width: 100, height: 100,
                                         cursor: original.appendingPathComponent("cursor.jsonl").path, recording: nil)
        let moved = project.inItsFolder(copy)
        XCTAssertEqual(moved.source.video, copy.appendingPathComponent("screen.mp4").path)
        XCTAssertEqual(moved.source.cursor, copy.appendingPathComponent("cursor.jsonl").path)
        XCTAssertEqual(project.inItsFolder(original), project, "the original stays as it is")
        try Data("another, longer movie".utf8).write(to: copy.appendingPathComponent("screen.mp4"))
        XCTAssertEqual(project.inItsFolder(copy).source.video, project.source.video, "a different movie is not taken for the copy")
    }

    func testEveryCutoutLeavesItsInsideExactlyAsItWas() {
        let dark = CIImage(color: CIColor(red: 0.1, green: 0.1, blue: 0.1)).cropped(to: CGRect(x: 0, y: 0, width: 200, height: 100))
        let context = CIContext()
        func gray(_ image: CIImage, _ x: Int, _ yFromTop: Int) -> Int {
            var pixel = [UInt8](repeating: 0, count: 4)
            context.render(image, toBitmap: &pixel, rowBytes: 4, bounds: CGRect(x: x, y: 100 - 1 - yFromTop, width: 1, height: 1),
                           format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
            return Int(pixel[0])
        }
        let original = gray(dark, 100, 50)
        for cutout in EditProject.SpotlightCutout.allCases {
            let spot = EditProject.Redaction(id: "a", startUs: 0, endUs: 1, x: 0.25, y: 0.2, width: 0.5, height: 0.6, style: .spotlight,
                                             cutout: cutout)
            let lit = Looks.redact([spot], on: dark)
            XCTAssertEqual(gray(lit, 100, 50), original, accuracy: 1, "\(cutout): the middle is untouched")
            XCTAssertLessThan(gray(lit, 5, 5), original, "\(cutout): outside is dimmed")
        }
        let rounded = Looks.redact([EditProject.Redaction(id: "a", startUs: 0, endUs: 1, x: 0.25, y: 0.2, width: 0.5, height: 0.6,
                                                          style: .spotlight)], on: dark)
        XCTAssertLessThan(gray(rounded, 51, 21), original, "a rounded cutout's corner is dimmed")
        let deeper = Looks.redact([EditProject.Redaction(id: "a", startUs: 0, endUs: 1, x: 0.25, y: 0.2, width: 0.5, height: 0.6,
                                                         style: .spotlight, dim: 0.9)], on: dark)
        XCTAssertLessThan(gray(deeper, 5, 5), gray(rounded, 5, 5), "a higher dim is darker")
    }

    func testARedactionCoversOnlyItsRectangleOfTheSource() throws {
        let white = CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: 200, height: 100))
        let redaction = EditProject.Redaction(id: "r", startUs: 0, endUs: 1, x: 0.25, y: 0, width: 0.5, height: 0.5, style: .black)
        let output = Looks.redact([redaction], on: white)
        let context = CIContext()
        func gray(_ x: Int, _ yFromTop: Int) -> UInt8 {
            var pixel = [UInt8](repeating: 0, count: 4)
            context.render(output, toBitmap: &pixel, rowBytes: 4, bounds: CGRect(x: x, y: 100 - 1 - yFromTop, width: 1, height: 1),
                           format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
            return pixel[0]
        }
        XCTAssertLessThan(gray(100, 10), 30)
        XCTAssertGreaterThan(gray(20, 10), 240)
        XCTAssertGreaterThan(gray(100, 80), 240)
        var project = EditProject(source: .init(video: "/m.mp4", durationUs: 1_000_000, width: 200, height: 100),
                                  clips: [.init(id: "c", fromUs: 0, toUs: 1_000_000)])
        project.redactions = [EditProject.Redaction(id: "r1", startUs: 0, endUs: 500_000, x: 0.1, y: 0.1, width: 0.2, height: 0.2, style: .pixelate)]
        let decoded = try EditProject.decode(JSONEncoder().encode(project))
        XCTAssertEqual(decoded.redactions, project.redactions)
    }

    func testAPartKeepsWhatPlaysBetweenTwoOutputTimesAtEachClipsSpeed() throws {
        // Output 0–2 plays source 0–2, 2–5 plays 3–6, 5–6 plays 6–8 at 2×.
        let project = EditProject(source: .init(video: "/m.mp4", durationUs: 8_000_000, width: 100, height: 100),
                                  clips: [.init(id: "a", fromUs: 0, toUs: 2_000_000), .init(id: "b", fromUs: 3_000_000, toUs: 6_000_000),
                                          .init(id: "c", fromUs: 6_000_000, toUs: 8_000_000, speed: 2)])
        let part = try XCTUnwrap(TimelineMap.part(project, fromOut: 1_000_000, toOut: 5_500_000))
        XCTAssertEqual(part.clips.map { [$0.fromUs, $0.toUs] }, [[1_000_000, 2_000_000], [3_000_000, 6_000_000], [6_000_000, 7_000_000]])
        XCTAssertEqual(part.outputDurationUs, 4_500_000)
        XCTAssertNil(TimelineMap.part(project, fromOut: 7_000_000, toOut: 9_000_000))
    }

    func testRenderSizeIsEvenAndCapped() {
        XCTAssertEqual(EditRenderer.renderSize(source: CGSize(width: 4112, height: 2570), maxHeight: 1080), CGSize(width: 1728, height: 1080))
        XCTAssertEqual(EditRenderer.renderSize(source: CGSize(width: 1919, height: 1200), maxHeight: 720), CGSize(width: 1150, height: 720))
        XCTAssertEqual(EditRenderer.renderSize(source: CGSize(width: 1921, height: 1081), maxHeight: 0), CGSize(width: 1920, height: 1080))
    }
}
