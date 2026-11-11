import XCTest
@testable import GenesisToolsRecorder

/// editor-open.json names a recording's window by its folder and a plain movie's window by the movie, as
/// editorWindowKeyOf (library.ts) does, so `tools recorder … open` resolves to a movie and two loose movies in one
/// folder are two rows.
final class RecorderHuntR2OpenStatePlainMovieTests: XCTestCase {
    func testAPlainMovieIsNamedByTheMovie() {
        let path = EditorWindows.openPath(store: URL(fileURLWithPath: "/tmp/x/demo.edit.json"), video: "/tmp/x/demo.mov")
        XCTAssertEqual(path, "/tmp/x/demo.mov")
        let other = EditorWindows.openPath(store: URL(fileURLWithPath: "/tmp/x/other.edit.json"), video: "/tmp/x/other.mov")
        XCTAssertNotEqual(path, other)
    }

    func testARecordingIsNamedByItsFolder() {
        let path = EditorWindows.openPath(store: URL(fileURLWithPath: "/tmp/rec/edit.json"), video: "/tmp/rec/screen.mp4")
        XCTAssertEqual(path, "/tmp/rec")
    }
}
