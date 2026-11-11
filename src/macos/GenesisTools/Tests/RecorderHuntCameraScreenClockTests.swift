import Foundation
import XCTest
@testable import GenesisToolsRecorder

/// The camera movie's clock: camera.json names the wall time of the movie's first frame and says the movie runs on the
/// wall clock, so the recording can cut it to the screen's spans (camera.ts `alignCameraMovie`).
final class RecorderHuntCameraScreenClockTests: XCTestCase {
    func testTheCameraStartsAtItsFirstFramesOwnTimeNotWhenTheWriterWasReady() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        // The first frame reached the camera at uptime 100.0; the writer was ready 0.4 s later.
        let startedAt = CameraMovieWriter.wallClock(ofUptime: 100.0, now: now, nowUptime: 100.4)
        XCTAssertEqual(startedAt.timeIntervalSince1970, now.timeIntervalSince1970 - 0.4, accuracy: 0.000_001)
    }

    @MainActor
    func testTheSidecarSaysTheCameraMovieRunsOnTheWallClock() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("camera-clock-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let startedAt = Date(timeIntervalSince1970: 1_800_000_000.25)
        CameraBubble.writeSidecar(folder: folder, startedAt: startedAt, screenStartedAt: Date(timeIntervalSince1970: 1_800_000_000),
                                  placement: nil)
        let data = try Data(contentsOf: folder.appendingPathComponent("camera.json"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["clock"] as? String, "wall")
        XCTAssertEqual(object["file"] as? String, "camera.mov")
        XCTAssertEqual(object["startedAt"] as? String, "2027-01-15T08:00:00.250Z")
    }
}
