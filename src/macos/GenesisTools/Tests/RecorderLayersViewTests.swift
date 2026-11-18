import AppKit
import SwiftUI
import XCTest
@testable import GenesisToolsRecorder

@MainActor
final class RecorderLayersViewTests: XCTestCase {
    private var folder: URL!
    private var service: FakeServiceLink!
    private var model: EditorModel!
    private var window: NSWindow!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var project = EditProject.whole(video: folder.appendingPathComponent("screen.mp4").path, durationUs: 10_000_000,
                                        width: 1280, height: 720, cursor: nil, recording: nil)
        project.audio.lanes = [.init(id: "mic", source: .mic, file: "mic.m4a"),
                               .init(id: "system", source: .system, file: "system.m4a")]
        project.camera = .init(file: "camera.mov")
        project.layers = .init(media: [.init(id: "logo", kind: .image, file: "logo.png", startUs: 0, endUs: 5_000_000)])
        service = FakeServiceLink(project: project) { project, op in
            var next = project
            if op["op"] as? String == "audioLane", let muted = op["muted"] as? Bool {
                let i = try XCTUnwrap(next.audio.lanes?.firstIndex { $0.id == op["id"] as? String })
                next.audio.lanes?[i].muted = muted
            }
            return next
        }
        model = EditorModel.on(service, store: .init(url: folder.appendingPathComponent("edit.json")))
    }

    override func tearDown() async throws {
        window?.contentView = nil
        window = nil
        model.close()
        model = nil
        service = nil
        try FileManager.default.removeItem(at: folder)
    }

    private func hostTimeline() {
        let size = CGSize(width: 1100, height: 650)
        window = NSWindow(contentRect: CGRect(origin: .zero, size: size), styleMask: [.borderless],
                          backing: .buffered, defer: false)
        window.contentView = NSHostingView(rootView: TimelineView(model: model, viewportWidth: size.width)
            .defaultAppStorage(UserDefaults(suiteName: UUID().uuidString)!)
            .frame(width: size.width, height: size.height))
        window.contentView?.layoutSubtreeIfNeeded()
    }

    private func element(_ id: String) throws -> NSAccessibilityProtocol {
        // AppKit exposes the last committed SwiftUI transaction. Let a button's synchronous service reply draw.
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        window.contentView?.layoutSubtreeIfNeeded()
        func find(_ node: NSAccessibilityProtocol) -> NSAccessibilityProtocol? {
            if node.accessibilityIdentifier() == id { return node }
            for child in node.accessibilityChildren() ?? [] {
                if let child = child as? NSAccessibilityProtocol, let match = find(child) { return match }
            }
            return nil
        }
        return try XCTUnwrap(find(window), "Missing editor accessibility element \(id)")
    }

    func testTimelineShowsBothNamedSoundRows() throws {
        hostTimeline()
        XCTAssertEqual(try element("recorder.timeline.sound.mic").accessibilityLabel(), "Microphone")
        XCTAssertEqual(try element("recorder.timeline.sound.system").accessibilityLabel(), "System sound")
    }

    func testPressingMuteSendsOneOpAndAnnouncesMuted() throws {
        hostTimeline()
        XCTAssertTrue(try element("recorder.timeline.sound.mic.mute").accessibilityPerformPress())
        XCTAssertEqual(service.sentOps as NSArray, [["op": "audioLane", "id": "mic", "muted": true]] as NSArray)
        XCTAssertEqual(try element("recorder.timeline.sound.mic").accessibilityValue() as? String, "muted")
        XCTAssertFalse(try XCTUnwrap(model.project.audio.lanes?.last).muted)
    }

    func testLayersAppearFrontToBack() throws {
        hostTimeline()
        let logo = try element("recorder.timeline.layer.logo")
        let camera = try element("recorder.timeline.layer.camera")
        XCTAssertGreaterThan(logo.accessibilityFrame().midY, camera.accessibilityFrame().midY,
                             "AppKit accessibility coordinates increase toward the top")
    }

    func testFourOrderActionsSendTheirNamedMovesOnce() throws {
        hostTimeline()
        let row = try element("recorder.timeline.layer.logo")
        let actions = try XCTUnwrap(row.accessibilityCustomActions())
        for title in ["Bring to Front", "Bring Forward", "Send Backward", "Send to Back"] {
            let action = try XCTUnwrap(actions.first { $0.name == title }, "Missing \(title)")
            if let handler = action.handler {
                XCTAssertTrue(handler())
            } else {
                XCTAssertTrue(NSApp.sendAction(try XCTUnwrap(action.selector), to: action.target, from: action))
            }
        }
        XCTAssertEqual(service.count("edit.apply"), 4)
        XCTAssertEqual(service.sentOps as NSArray, ["top", "up", "down", "bottom"].map {
            ["op": "layerMove", "id": "logo", "to": $0]
        } as NSArray)
    }

    func testOnlyMediaOffersDelete() throws {
        hostTimeline()
        let camera = try XCTUnwrap(try element("recorder.timeline.layer.camera").accessibilityCustomActions()).map(\.name)
        XCTAssertTrue(camera.contains("Hide Camera"))
        XCTAssertFalse(camera.contains("Delete"))
        let media = try XCTUnwrap(try element("recorder.timeline.layer.logo").accessibilityCustomActions()).map(\.name)
        XCTAssertTrue(media.contains("Delete"))
        XCTAssertTrue(media.contains("Replace File…"))
    }
}
