import CoreImage
import XCTest
@testable import GenesisToolsRecorder

/// A joined recording, or a recording that moved to another display, has one `pw` row per part: the first row of each
/// segment and the first row after a switch. The drawn cursor is measured in the points of the part it is in.
final class RecorderHuntCursorTrackLetterboxTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("cursor-letterbox-\(UUID().uuidString)")
        let shapes = folder.appendingPathComponent("cursor-shapes")
        try FileManager.default.createDirectory(at: shapes, withIntermediateDirectories: true)
        let image = CIImage(color: CIColor(red: 1, green: 1, blue: 1)).cropped(to: CGRect(x: 0, y: 0, width: 8, height: 8))
        try CIContext().writePNGRepresentation(of: image, to: shapes.appendingPathComponent("arrow.png"), format: .RGBA8,
                                               colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
        try Data(#"{"hotX":0,"hotY":0,"width":4,"height":4}"#.utf8).write(to: shapes.appendingPathComponent("arrow.json"))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    /// Segment 1 recorded 1440 points, segment 2 (from 2 s) 1920 points, both shown 2880 pixels wide.
    private func joinedTrack() throws -> CursorTrack {
        let path = folder.appendingPathComponent("cursor.jsonl")
        try Data("""
        {"t":0.0,"x":0.5,"y":0.5,"shape":"arrow","pw":1440.0}
        {"t":1000.0,"x":0.6,"y":0.5}
        {"t":2000.0,"x":0.5,"y":0.5,"pw":1920.0}
        {"t":3000.0,"x":0.4,"y":0.5}

        """.utf8).write(to: path)
        return try XCTUnwrap(CursorTrack.load(path.path))
    }

    func testTheDrawnCursorTakesThePointWidthOfThePartItIsIn() throws {
        let track = try joinedTrack()
        let first = try XCTUnwrap(ZoomState.cursorMark(atSourceUs: 500_000, track: track, settings: .init(), videoWidth: 2880))
        let second = try XCTUnwrap(ZoomState.cursorMark(atSourceUs: 2_500_000, track: track, settings: .init(), videoWidth: 2880))
        XCTAssertEqual(first.pixelsPerPoint, 2.0, accuracy: 0.0001, "segment 1: 2880 pixels show 1440 points")
        XCTAssertEqual(second.pixelsPerPoint, 1.5, accuracy: 0.0001, "segment 2: 2880 pixels show 1920 points")
    }

    func testThePointWidthIsTheLastOneAtOrBeforeTheTime() throws {
        let track = try joinedTrack()
        XCTAssertEqual(track.pointWidths, [.init(ms: 0, width: 1440), .init(ms: 2000, width: 1920)])
        XCTAssertEqual(track.pointWidth(atMs: -50), 1440, "before the first row: the first width")
        XCTAssertEqual(track.pointWidth(atMs: 500), 1440)
        XCTAssertEqual(track.pointWidth(atMs: 2000), 1920)
        XCTAssertEqual(track.pointWidth(atMs: 2500), 1920)
        XCTAssertEqual(track.dejittered(points: 2, aspect: 9.0 / 16).pointWidths, track.pointWidths)
        let still = [CursorTrack.Sample(ms: 0, x: 0.5, y: 0.5)]
        XCTAssertNil(CursorTrack(samples: still).pointWidth(atMs: 0))
        XCTAssertEqual(CursorTrack(samples: still, pointWidth: 1440).pointWidth(atMs: 900), 1440)
    }

    func testTheSmoothCursorMeasuresJitterInThePointsOfEachPart() {
        // 2 points are 0.00139 of a 1440-point display and 0.00104 of a 1920-point one: a 0.0012 step is jitter in
        // segment 1 and a move in segment 2.
        let samples = [0.0, 100, 2000, 2100].enumerated().map { index, ms in
            CursorTrack.Sample(ms: ms, x: index % 2 == 0 ? 0.5 : 0.5012, y: 0.5)
        }
        let track = CursorTrack(samples: samples, pointWidths: [.init(ms: 0, width: 1440), .init(ms: 2000, width: 1920)])
        XCTAssertEqual(track.dejittered(points: 2, aspect: 9.0 / 16).samples.map(\.ms), [0, 2100])
    }
}
