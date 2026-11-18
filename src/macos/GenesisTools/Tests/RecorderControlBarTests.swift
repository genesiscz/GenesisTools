import AppKit
import GenesisKit
import ImageIO
import XCTest
@testable import GenesisToolsRecorder

@MainActor
final class RecorderControlBarTests: XCTestCase {
    func testPickerSnapshotShowsTheSetupBarBeforeATargetIsChosen() async throws {
        _ = NSApplication.shared
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("recorder-setup-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: url) }
        try await CapturePicker.snapshot(to: url.path, shortcutsOpen: false)
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        let text = try EditorShots.text(image).lowercased()
        XCTAssertTrue(text.contains("next recording"), text)
    }

    func testMarkerCommandResolvesToTheRecordersExistingMethod() {
        XCTAssertEqual(LiveRecordingCommand(rawValue: "marker.add")?.rawValue, "marker.add")
    }
}
