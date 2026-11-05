import AppKit
import CoreImage
import SwiftUI
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

    func testAHiddenPartSavedBeforeTheLanesGetsAnIDFromItsStart() throws {
        let json = #"{"file":"camera.mov","hidden":[{"startUs":1000000,"endUs":2000000}]}"#
        let camera = try JSONDecoder().decode(EditProject.Camera.self, from: Data(json.utf8))
        XCTAssertEqual(camera.hidden, [.init(id: "k" + String(1_000_000, radix: 36), startUs: 1_000_000, endUs: 2_000_000)])
    }

    func testHiddenPartsAreCameraItemsOnTheirOwnLane() {
        var project = EditProject.whole(video: "/tmp/x.mp4", durationUs: 10_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
        var camera = EditProject.Camera(file: "camera.mov")
        camera.hidden = [.init(id: "k1", startUs: 1_000_000, endUs: 2_000_000)]
        project.camera = camera
        let item = EffectLanes.items(project).first { $0.id == "k1" }
        XCTAssertEqual(item?.kind, .cameraHide)
        // No saved lane holds camera parts: an automatic lane of their own follows the zoom lane.
        XCTAssertEqual(EffectLanes.resolve(project).map(\.lane.id), ["zooms", "auto-cameraHide"])
        // A part on a lane the CLI's lane ops made (lanes.ts) shows there; the lane ops are the service's.
        project.lanes = [EffectLane(id: "zooms", kinds: [.zoom]), EffectLane(id: "lane2", kinds: [.cameraHide], name: "Camera")]
        project.camera?.hidden[0].lane = "lane2"
        XCTAssertEqual(EffectLanes.resolve(project).map { "\($0.lane.title):\($0.items.map(\.id))" }, ["Zooms:[]", "Camera:[\"k1\"]"])
    }

    func testCameraTimeLeavesThePausedTimeOut() {
        XCTAssertEqual(CameraMovieWriter.presentationSeconds(uptime: 110, first: 100, pausedTotal: 4), 6)
        XCTAssertEqual(CameraMovieWriter.presentationSeconds(uptime: 99, first: 100, pausedTotal: 0), 0)
    }

    /// The bubbles the TypeScript camera op writes for camera-ops.json's cases (recording-editor.test.ts applies them)
    /// read here and write back unchanged, so a window that draws them keeps every field.
    func testTheBubblesOfTheSharedCameraCasesReadAndWriteBackUnchanged() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("utils/recording-editor/__fixtures__/camera-ops.json")
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let cases = try XCTUnwrap(root["cases"] as? [[String: Any]])
        XCTAssertEqual(cases.count, 6)
        var bubbles = 0
        for item in cases {
            let name = try XCTUnwrap(item["name"] as? String)
            guard let after = item["after"] as? NSDictionary else { continue }
            let camera = try JSONDecoder().decode(EditProject.Camera.self, from: JSONSerialization.data(withJSONObject: after))
            let written = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(camera)) as? NSDictionary)
            XCTAssertEqual(written, after, name)
            bubbles += 1
        }
        XCTAssertGreaterThan(bubbles, 3, "most cases end with a bubble")
    }

    func testADragPutsTheCentreInsideTheCanvasAndAResizeKeepsTheOpRange() {
        let camera = EditProject.Camera(file: "camera.mov")
        let view = CGSize(width: 800, height: 450)
        let moved = CameraPlacement.moved(camera, center: CGPoint(x: 400, y: 90), in: view)
        XCTAssertEqual(moved.x ?? 0, 0.5, accuracy: 0.0001)
        XCTAssertEqual(moved.y ?? 0, 0.2, accuracy: 0.0001)
        // Past the edge the centre stops where the whole bubble still shows, the place the renderer draws it.
        let edge = CameraPlacement.moved(camera, center: CGPoint(x: 900, y: -40), in: view)
        let half = 0.24 * 450 / 2
        XCTAssertEqual(edge.x ?? 0, (800 - half) / 800, accuracy: 0.0001)
        XCTAssertEqual(edge.y ?? 0, half / 450, accuracy: 0.0001)
        XCTAssertEqual(CameraPlacement.resized(camera, side: 180, in: view).size ?? 0, 0.4, accuracy: 0.0001)
        XCTAssertEqual(CameraPlacement.resized(camera, side: 5, in: view).size, 0.08)
        XCTAssertEqual(CameraPlacement.resized(camera, side: 900, in: view).size, 0.6)
    }

    func testTheSizeGripFacesIntoTheCanvasAndFollowsThePointer() {
        // A bottom-right bubble: its grip is the top left; dragging it 20 pt up and left grows the side by 20.
        XCTAssertEqual(CameraPlacement.side(start: 100, translation: CGSize(width: -20, height: -20), corner: .bottomRight), 120)
        XCTAssertEqual(CameraPlacement.side(start: 100, translation: CGSize(width: 20, height: 20), corner: .bottomRight), 80)
        XCTAssertEqual(CameraPlacement.side(start: 100, translation: CGSize(width: 10, height: -10), corner: .bottomLeft), 110)
        // Placed by its centre it grows both ways, so the grip moves half the side change.
        XCTAssertEqual(CameraPlacement.side(start: 100, translation: CGSize(width: 10, height: 10), corner: .custom), 120)
    }

    @MainActor
    func testADragOfTheBubbleIsOneUndoStep() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("camera-undo-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        var project = EditProject.whole(video: folder.appendingPathComponent("none.mp4").path, durationUs: 10_000_000,
                                        width: 1920, height: 1080, cursor: nil, recording: nil)
        project.camera = EditProject.Camera(file: "camera.mov")
        let service = FakeServiceLink(project: project, rules: FakeRules.basic)
        let model = EditorModel.on(service, store: ProjectStore(url: folder.appendingPathComponent("edit.json")))
        for step in 1...5 { model.changeCamera(.init(x: 0.5 - Double(step) * 0.05, y: 0.5)) }
        XCTAssertEqual(model.project.camera?.corner, .custom)
        XCTAssertEqual(model.project.camera?.x ?? 0, 0.25, accuracy: 0.0001)
        XCTAssertEqual(service.count("gesture.begin"), 1, "the drag is one gesture on the service")
        XCTAssertEqual(service.count("gesture.preview"), 5, "with a preview per step")
        XCTAssertEqual(service.count("edit.apply"), 0, "and nothing saved while it moves")
        model.undo()
        XCTAssertEqual(service.count("gesture.commit"), 1)
        XCTAssertEqual(service.sentOps.map { $0["x"] as? Double }, [0.25], "the commit is the last step's op from the drag's start")
        XCTAssertEqual(model.project.camera, project.camera, "one undo takes back the whole drag")
        model.redo()
        model.changeCamera(.init(enabled: false))
        XCTAssertNil(model.project.camera)
        model.undo()
        XCTAssertEqual(model.project.camera?.x ?? 0, 0.25, accuracy: 0.0001, "removing the bubble is its own step")
    }

    /// A ⌘Z right after a drag, before the service has answered its commit, takes back that drag (the service takes
    /// the commit, then the undo), and the Edit menu names it.
    @MainActor
    func testAnUndoRightAfterADragTakesBackTheDragBeforeItsCommitIsAnswered() throws {
        var project = EditProject.whole(video: "/tmp/none.mp4", durationUs: 10_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
        project.camera = EditProject.Camera(file: "camera.mov")
        let service = FakeServiceLink(project: project, rules: FakeRules.basic)
        let model = EditorModel.on(service, store: ProjectStore(url: FileManager.default.temporaryDirectory.appendingPathComponent("camera-\(UUID().uuidString).json")))
        model.changeCamera(.init(x: 0.3, y: 0.5))
        XCTAssertEqual(model.project.camera?.x ?? 0, 0.3, accuracy: 0.0001)
        service.holdAnswers = true
        model.undo()
        XCTAssertEqual(service.calls.suffix(2).map(\.method), ["gesture.commit", "edit.undo"], "the commit goes before the undo")
        service.deliver()
        XCTAssertEqual(model.project.camera, project.camera)
        XCTAssertTrue(model.canRedo)
        XCTAssertFalse(model.canUndo, "the drag was the only step")
    }
}

/// The bubble's handle on the preview driven by real mouse events in an off-screen window: a drag moves the bubble, the
/// grip sizes it, and each drag is one undo step.
@MainActor
final class CameraBubbleHandleTests: XCTestCase {
    private var folder: URL!
    private var windows: [NSWindow] = []

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("camera-handle-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        for window in windows { window.orderOut(nil) }
        windows.removeAll()
        try? FileManager.default.removeItem(at: folder)
    }

    private func pump(_ seconds: TimeInterval) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    /// The handle alone over a view of the canvas, 800 × 450, in a borderless window that is never shown or key.
    private func host(_ model: EditorModel) -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 450), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: CameraBubbleHandle(model: model, clock: model.clock).frame(width: 800, height: 450))
        window.alphaValue = 0
        window.orderBack(nil)
        window.contentView?.layoutSubtreeIfNeeded()
        windows.append(window)
        pump(0.2)
        return window
    }

    /// A press, three drag steps and a release; points from the window's top left.
    private func drag(_ window: NSWindow, from: CGPoint, to: CGPoint) throws {
        let steps = [from] + (1...3).map { CGPoint(x: from.x + (to.x - from.x) * CGFloat($0) / 3, y: from.y + (to.y - from.y) * CGFloat($0) / 3) }
        for (index, point) in steps.enumerated() {
            let type: NSEvent.EventType = index == 0 ? .leftMouseDown : .leftMouseDragged
            let event = NSEvent.mouseEvent(with: type, location: NSPoint(x: point.x, y: window.frame.height - point.y), modifierFlags: [],
                                           timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                           context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
            window.sendEvent(try XCTUnwrap(event))
            pump(0.03)
        }
        let up = NSEvent.mouseEvent(with: .leftMouseUp, location: NSPoint(x: to.x, y: window.frame.height - to.y), modifierFlags: [],
                                    timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                    context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
        window.sendEvent(try XCTUnwrap(up))
        pump(0.2)
    }

    func testADragMovesTheBubbleTheGripSizesItAndUndoTakesEachBack() throws {
        var project = EditProject.whole(video: folder.appendingPathComponent("none.mp4").path, durationUs: 10_000_000,
                                        width: 1920, height: 1080, cursor: nil, recording: nil)
        project.camera = EditProject.Camera(file: "camera.mov")
        let model = EditorModel.on(FakeServiceLink(project: project, rules: FakeRules.basic), store: ProjectStore(url: folder.appendingPathComponent("edit.json")))
        let window = host(model)
        let start = try XCTUnwrap(project.camera).rect(canvas: CGSize(width: 800, height: 450))

        try drag(window, from: CGPoint(x: start.midX, y: start.midY), to: CGPoint(x: 400, y: 225))
        let moved = try XCTUnwrap(model.project.camera)
        XCTAssertEqual(moved.corner, .custom)
        XCTAssertEqual(moved.x, 0.5, accuracy: 0.002)
        XCTAssertEqual(moved.y, 0.5, accuracy: 0.002)

        // Placed by its centre, the grip is the bottom right; 10 pt out grows the side by 20.
        let placed = moved.rect(canvas: CGSize(width: 800, height: 450))
        pump(0.7)
        try drag(window, from: CGPoint(x: placed.maxX, y: placed.maxY), to: CGPoint(x: placed.maxX + 10, y: placed.maxY + 10))
        XCTAssertEqual(model.project.camera?.size ?? 0, (placed.width + 20) / 450, accuracy: 0.003)

        model.undo()
        XCTAssertEqual(model.project.camera?.size ?? 0, 0.24, accuracy: 0.0001, "undo takes back the resize alone")
        XCTAssertEqual(model.project.camera?.x ?? 0, 0.5, accuracy: 0.002)
        model.undo()
        XCTAssertEqual(model.project.camera, project.camera, "a second undo takes back the move")
    }
}
