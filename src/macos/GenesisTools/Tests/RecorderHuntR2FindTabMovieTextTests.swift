import Foundation
import XCTest
@testable import GenesisToolsRecorder

/// The Find tab on a movie recording: find-screen reads the movie's screen text as findText and the Hide tab do, so
/// the tab keeps its search box, and a movie's hit (no frame file, no display) decodes with an id of its own.
final class RecorderHuntR2FindTabMovieTextTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("find-movie-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    func testAMovieRecordingWhoseMovieIsThereHasScreenTextToSearch() throws {
        let movie = folder.appendingPathComponent("screen.mp4")
        try Data(#"{"settings":{"kind":"video"},"frames":[]}"#.utf8).write(to: folder.appendingPathComponent("recording.json"))
        XCTAssertEqual(EditorModel.hasScreenText(recordingFolder: folder, movie: movie), false, "no movie and no frames: nothing to read")
        try Data([0]).write(to: movie)
        XCTAssertEqual(EditorModel.hasScreenText(recordingFolder: folder, movie: movie), true, "the movie is read with Vision")
    }

    func testAMovieHitWithoutAFrameFileDecodesAndKeysOnItsTime() throws {
        let json = #"""
        [{"sec":1.5,"untilSec":3,"lines":["Notification sound"],"shown":true,
          "boxes":[{"text":"Notification sound","x":0,"y":0.19,"width":0.06,"height":0.02,"untilSec":3}],
          "ops":{"hide":[],"mark":[],"cut":[]}}]
        """#
        let hits = try JSONDecoder().decode([ScreenHit].self, from: Data(json.utf8))
        XCTAssertEqual(hits.count, 1)
        XCTAssertNil(hits[0].file)
        XCTAssertNil(hits[0].displayId)
        XCTAssertEqual(hits[0].id, "movie@1500000")
    }
}
