import XCTest
@testable import GenesisToolsRecorder

/// The editor's intro and end card still has the export canvas's shape, because the export draws the card on its real
/// canvas (9:16, 1:1, a portrait source), and a still always drawn at 640 x 360 showed a 16:9 card nobody exports.
final class RecorderHuntCardStillCanvasShapeTests: XCTestCase {
    private func project(width: Int = 1920, height: Int = 1080, aspect: EditProject.CanvasAspect?) -> EditProject {
        var project = EditProject.whole(video: "/tmp/x.mp4", durationUs: 10_000_000, width: width, height: height, cursor: nil, recording: nil)
        if let aspect {
            var frame = EditProject.Frame()
            frame.aspect = aspect
            project.frame = frame
        }
        return project
    }

    func testTheStillTakesTheCanvasShape() {
        XCTAssertEqual(Looks.cardStillSize(project(aspect: .portrait)), CGSize(width: 360, height: 640))
        XCTAssertEqual(Looks.cardStillSize(project(aspect: .square)), CGSize(width: 640, height: 640))
        XCTAssertEqual(Looks.cardStillSize(project(aspect: nil)), CGSize(width: 640, height: 360))
        XCTAssertEqual(Looks.cardStillSize(project(width: 1440, height: 900, aspect: nil)), CGSize(width: 640, height: 400))
        XCTAssertEqual(Looks.cardStillSize(project(width: 1080, height: 1920, aspect: .source)), CGSize(width: 360, height: 640))
    }

}
