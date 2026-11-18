import AppKit
import GenesisKit
import XCTest
@testable import GenesisToolsRecorder

@MainActor
final class RecorderPictureTests: XCTestCase {
    private var folder: URL!
    private var previousProbe = false

    override func setUp() async throws {
        _ = NSApplication.shared
        previousProbe = FrameProbe.enabled
        FrameProbe.enabled = true
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("recorder-pictures-\(UUID())")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        FrameProbe.enabled = previousProbe
        FrameProbe.reset()
        try FileManager.default.removeItem(at: folder)
    }

    func testPickerFaceDrawsSevenDistinctStatesForEachHostAtTheRequestedSize() async throws {
        var donePictures: [Data] = []
        for host in ["recorder", "widget"] {
            var pictures = Set<Data>()
            for state in ["setup", "setup-expanded", "picker", "area", "recording", "paused", "done"] {
                FrameProbe.reset()
                let png = folder.appendingPathComponent("\(host)-\(state).png")
                let request = RecorderRequest.parse(["--picker", "--bar-host", host, "--bar-state", state,
                                                     "--width", "960", "--height", "480", "--no-focus", "--snapshot", png.path])
                _ = try await RecorderRenders.snapshot(request, to: png.path)
                let data = try Data(contentsOf: png)
                let rep = try XCTUnwrap(NSBitmapImageRep(data: data))
                XCTAssertEqual(rep.pixelsWide, rep.pixelsHigh * 2, "\(host) \(state) must be 960 × 480 points at either scale")
                XCTAssertEqual(FrameProbe.frames["recording.picker.window-102"] != nil, state == "picker")
                XCTAssertEqual(FrameProbe.frames["recorder.snapshot.pulse"] != nil, state == "picker")
                XCTAssertEqual(FrameProbe.frames["recorder.snapshot.drag"] != nil, state == "area")
                pictures.insert(data)
                if state == "done" { donePictures.append(data) }
            }
            XCTAssertEqual(pictures.count, 7, "a phase fell back to another phase's picture")
        }
        XCTAssertNotEqual(donePictures.first, donePictures.last, "widget and recorder have different movie actions")
    }

    func testEditorFixtureReopensSeparateSoundAndLayerRowsAndDrawsTheirMenu() async throws {
        let fixture = folder.appendingPathComponent("example")
        let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("recorder/lib/__fixtures__/make-editor-pictures.py")
        let status = try await Task.detached {
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            proc.arguments = ["python3", source.path, fixture.path, "--mute-system"]
            try proc.run()
            proc.waitUntilExit()
            return proc.terminationStatus
        }.value
        XCTAssertEqual(status, 0)
        let project = try await ProjectStore.load(path: fixture.path).project
        XCTAssertEqual(project.audio.lanes?.map(\.id), ["mic", "system"])
        XCTAssertEqual(project.audio.lanes?.map(\.muted), [false, true])
        XCTAssertEqual(project.layerOrder().map(\.id), ["camera", "slate"])
        for file in ["camera.mov", "proxy.mp4", "audio/mic.m4a", "audio/system.m4a", "slate.png", "frames/frame-00.png"] {
            let data = try Data(contentsOf: fixture.appendingPathComponent(file))
            XCTAssertFalse(data.isEmpty, file)
        }
        let png = folder.appendingPathComponent("menu.png")
        let request = RecorderRequest.parse(["--edit", fixture.path, "--at", "2", "--layer-menu", "slate",
                                             "--width", "1440", "--height", "920", "--no-focus", "--snapshot", png.path])
        _ = try await RecorderRenders.snapshot(request, to: png.path)
        let menu = try XCTUnwrap(FrameProbe.frames["recorder.snapshot.layerMenu"])
        XCTAssertGreaterThan(menu.height, 120, "a menu with enabled and disabled layer commands occupies several rows")
        let imageRow = try XCTUnwrap(FrameProbe.frames["recorder.timeline.layer.slate"])
        let cameraRow = try XCTUnwrap(FrameProbe.frames["recorder.timeline.layer.camera"])
        XCTAssertLessThan(imageRow.minY, cameraRow.minY)
        for lane in ["mic", "system"] { XCTAssertNotNil(FrameProbe.frames["recorder.timeline.sound." + lane]) }
    }
}
