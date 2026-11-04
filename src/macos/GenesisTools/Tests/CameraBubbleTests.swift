import CoreImage
import XCTest
@testable import GenesisToolsRecorder

final class CameraBubbleTests: XCTestCase {
    func testACameraWrittenWithOnlyItsFileDecodesWithTheDefaultsAndRoundTrips() throws {
        let camera = try JSONDecoder().decode(EditProject.Camera.self, from: Data(#"{"file":"camera.mov"}"#.utf8))
        XCTAssertEqual(camera.corner, .bottomRight)
        XCTAssertEqual(camera.shape, .circle)
        XCTAssertEqual(camera.size, 0.24)
        XCTAssertTrue(camera.mirror)
        XCTAssertEqual(try JSONDecoder().decode(EditProject.Camera.self, from: JSONEncoder().encode(camera)), camera)
    }

    func testAnEditWithACameraKeepsItThroughASave() throws {
        var project = EditProject.whole(video: "/tmp/x.mp4", durationUs: 10_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
        project.camera = EditProject.Camera(file: "camera.mov")
        let decoded = try JSONDecoder().decode(EditProject.self, from: JSONEncoder().encode(project))
        XCTAssertEqual(decoded.camera, project.camera)
    }

    func testTheBubbleRectFollowsTheSameRuleAsTheTypeScriptSide() {
        var camera = EditProject.Camera(file: "camera.mov")
        camera.size = 0.2
        let canvas = CGSize(width: 1920, height: 1080)
        let corner = camera.rect(canvas: canvas)
        XCTAssertEqual(corner.width, 216, accuracy: 0.01)
        XCTAssertEqual(corner.midX, 1920 - 0.035 * 1080 - 108, accuracy: 0.01)
        XCTAssertEqual(corner.midY, 1080 - 0.035 * 1080 - 108, accuracy: 0.01)
        camera.corner = .custom
        camera.x = 1
        camera.y = 0
        XCTAssertEqual(camera.rect(canvas: canvas).midX, 1920 - 108, accuracy: 0.01)
        XCTAssertEqual(camera.rect(canvas: canvas).midY, 108, accuracy: 0.01)
    }

    func testHiddenRangesAndTheOffsetMapASourceMomentToTheCamera() {
        var camera = EditProject.Camera(file: "camera.mov")
        camera.offsetMs = 250
        camera.hidden = [.init(startUs: 1_000_000, endUs: 2_000_000)]
        XCTAssertFalse(camera.shows(atSourceUs: 1_500_000))
        XCTAssertTrue(camera.shows(atSourceUs: 2_000_000))
        XCTAssertEqual(camera.cameraUs(atSourceUs: 3_000_000), 2_750_000)
    }

    func testTheBubbleIsDrawnInsideItsSquareOnly() {
        var camera = EditProject.Camera(file: "camera.mov")
        camera.corner = .topLeft
        let frame = CIImage(color: CIColor.red).cropped(to: CGRect(x: 0, y: 0, width: 640, height: 480))
        let canvas = CGSize(width: 1920, height: 1080)
        let bubble = CameraFeed.bubble(camera, frame: frame, canvas: canvas)
        let square = camera.rect(canvas: canvas)
        let target = CGRect(x: square.minX, y: canvas.height - square.maxY, width: square.width, height: square.height)
        // The shadow may reach a little past the square; the picture itself never leaves it.
        XCTAssertTrue(bubble.extent.insetBy(dx: -square.width * 0.2, dy: -square.width * 0.2).contains(target))
        let context = CIContext()
        var pixel = [UInt8](repeating: 0, count: 4)
        context.render(bubble, toBitmap: &pixel, rowBytes: 4, bounds: CGRect(x: target.midX, y: target.midY, width: 1, height: 1),
                       format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
        XCTAssertGreaterThan(pixel[0], 200, "the centre of the bubble shows the camera")
        context.render(bubble, toBitmap: &pixel, rowBytes: 4, bounds: CGRect(x: target.minX + 2, y: target.maxY - 2, width: 1, height: 1),
                       format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
        XCTAssertLessThan(pixel[0], 60, "a circle leaves the square's corner without the camera")
    }

    func testThePlacementIsTheBubblesCentreAndSideInWhatWasRecorded() throws {
        let placement = try XCTUnwrap(CameraBubble.placement(bubble: CGRect(x: 1600, y: 100, width: 200, height: 200),
                                                             recorded: CGRect(x: 0, y: 0, width: 2000, height: 1000), shape: .rounded))
        XCTAssertEqual(placement["x"] as? Double ?? -1, 0.85, accuracy: 0.0001)
        XCTAssertEqual(placement["y"] as? Double ?? -1, 0.8, accuracy: 0.0001)
        XCTAssertEqual(placement["size"] as? Double ?? -1, 0.2, accuracy: 0.0001)
        XCTAssertEqual(placement["shape"] as? String, "rounded")
    }

    func testCameraTimeLeavesThePausedTimeOut() {
        XCTAssertEqual(CameraMovieWriter.presentationSeconds(uptime: 110, first: 100, pausedTotal: 4), 6)
        XCTAssertEqual(CameraMovieWriter.presentationSeconds(uptime: 99, first: 100, pausedTotal: 0), 0)
    }
}
