import XCTest
@testable import GenesisToolsRecorder

/// The window names the export's file by the rule `exportTargetOf` in edit.ts has: a chosen `~/` file is the home folder,
/// an older relative one is beside the movie, the extension follows the format, and a part gets a name of its own.
final class RecorderHuntExportTargetOneRuleTests: XCTestCase {
    private func project(output: String) -> EditProject {
        var project = EditProject.whole(video: "/movies/demo/screen.mp4", durationUs: 20_000_000, width: 1920, height: 1080,
                                        cursor: nil, recording: nil)
        project.export.output = output
        return project
    }

    func testAChosenFileResolvesHomeAndMovieFolder() {
        XCTAssertEqual(EditExporter.outputURL(for: project(output: "out/demo.mp4")).path, "/movies/demo/out/demo.mp4")
        XCTAssertEqual(EditExporter.outputURL(for: project(output: "~/Movies/demo.mp4"), format: .gif).path,
                       (NSHomeDirectory() as NSString).appendingPathComponent("Movies/demo.gif"))
    }

    func testAPartIsNamedAfterTheWholeTargetInItsFolder() {
        // The same case as exportTargetOf's test in service.test.ts.
        let url = EditExporter.outputURL(for: project(output: "/exports/demo.mp4"), format: .gif,
                                         part: (fromUs: 5_000_000, toUs: 12_000_000))
        XCTAssertEqual(url.path, "/exports/demo-part-5.0-12.0.gif")
    }
}
