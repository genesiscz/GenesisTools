import AppKit
import GenesisKit
import QuartzCore
import SwiftUI
import XCTest
@testable import GenesisToolsRecorder

@MainActor
final class RecorderLayersViewTests: XCTestCase {
    private var folder: URL!
    private var service: FakeServiceLink!
    private var model: EditorModel!
    private var window: NSWindow!
    private var pasteboards: [NSPasteboard] = []

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var project = EditProject.whole(video: folder.appendingPathComponent("screen.mp4").path, durationUs: 10_000_000,
                                        width: 1280, height: 720, cursor: nil, recording: nil)
        project.audio.lanes = [.init(id: "mic", source: .mic, file: "mic.m4a"),
                               .init(id: "system", source: .system, file: "system.m4a")]
        project.camera = .init(file: "camera.mov")
        project.layers = .init(media: [.init(id: "art", kind: .image, file: "art.png", startUs: 0, endUs: 5_000_000),
                                       .init(id: "logo", kind: .image, file: "logo.png", startUs: 0, endUs: 5_000_000)])
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
        pasteboards.forEach { $0.releaseGlobally() }
        pasteboards.removeAll()
        window?.orderOut(nil)
        window?.contentView = nil
        window?.close()
        window = nil
        model.close()
        model = nil
        service = nil
        try FileManager.default.removeItem(at: folder)
    }

    private func hostTimeline(height: CGFloat = 650) {
        let size = CGSize(width: 1100, height: height)
        window = NSWindow(contentRect: CGRect(origin: .zero, size: size), styleMask: [.borderless],
                          backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: TimelineView(model: model, viewportWidth: size.width)
            .defaultAppStorage(UserDefaults(suiteName: UUID().uuidString)!)
            .frame(width: size.width, height: size.height))
        window.orderInForSnapshot()
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
        let row = try element("recorder.timeline.layer.art")
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
            ["op": "layerMove", "id": "art", "to": $0]
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

    func testDropOnBottomRowSendsStackIndexZero() async throws {
        hostTimeline()
        let applied = expectation(description: "the stack receives the drop")
        service.rules = { project, op in
            let id = try XCTUnwrap(op["id"] as? String), index = try XCTUnwrap(op["to"] as? Int)
            let moved = try project.movingLayer(id, to: .index(index))
            applied.fulfill()
            return moved
        }
        let item = NSPasteboardItem()
        item.setData(try JSONSerialization.data(withJSONObject: ["row": ["window": model.session.holder, "id": "logo"]]),
                     forType: .init("tools.genesis.recorder.layer-row"))
        try drop(item, on: "recorder.timeline.layer.camera")
        await fulfillment(of: [applied], timeout: 3)
        XCTAssertEqual(service.sentOps as NSArray, [["op": "layerMove", "id": "logo", "to": 0]] as NSArray)
        XCTAssertEqual(model.project.layerOrder().first?.id, "logo")
        XCTAssertEqual(model.undoStack.count, 1)
        model.undo()
        XCTAssertEqual(model.project.layerOrder().first?.id, "camera")
    }

    func testDroppedImageIsCopiedAndAddedAtSourcePlayhead() async throws {
        let elsewhere = folder.appendingPathComponent("input", isDirectory: true)
        try FileManager.default.createDirectory(at: elsewhere, withIntermediateDirectories: true)
        let image = elsewhere.appendingPathComponent("logo.png")
        let original = folder.appendingPathComponent("logo.png")
        let bytes = try XCTUnwrap(Data(base64Encoded:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="))
        try bytes.write(to: image)
        try Data("already in the recording".utf8).write(to: original)
        var cut = model.project
        cut.clips[0].fromUs = 2_000_000
        model.adopt(cut, rebuild: false)
        let applied = expectation(description: "the service receives the copied image")
        service.rules = { project, op in
            let name = try XCTUnwrap(op["file"] as? String)
            let start = try XCTUnwrap(op["startUs"] as? Int64)
            var next = project
            next.layers?.media.append(.init(id: "new-image", kind: .image, file: name,
                                            startUs: start, endUs: start + 5_000_000))
            applied.fulfill()
            return next
        }
        hostTimeline()
        try drop(image as NSURL, on: "recorder.timeline.layer.logo", atOutput: 1_500_000)
        await fulfillment(of: [applied], timeout: 3)
        XCTAssertEqual(service.sentTags, ["layerAdd"])
        XCTAssertNil(service.sentOps.first?["endUs"], "an image uses the service's five-second span")
        let added = try XCTUnwrap(model.project.layers?.media.last)
        XCTAssertEqual(added.file, "logo 2.png")
        XCTAssertEqual(added.startUs, 3_500_000)
        XCTAssertEqual(model.project.layers?.media.count, 3)
        XCTAssertEqual(try Data(contentsOf: folder.appendingPathComponent(added.file)), bytes)
        XCTAssertEqual(try Data(contentsOf: original), Data("already in the recording".utf8))
        XCTAssertEqual(try Data(contentsOf: image), bytes)
        XCTAssertEqual(model.tab, .style)
    }

    /// With a prepared six-lane/four-layer recording, also print the cost of 120 off-screen scroll redraws.
    /// This measures the view's work per scroll step. The window server does not present this window to a display.
    func testScrollingKeepsSixSoundRowsAndFourLayersReachable() async throws {
        let fixture = ProcessInfo.processInfo.environment["RECORDER_P5_SCROLL_EDIT"]
        var project = model.project
        if let fixture {
            project = try await ProjectStore.load(path: fixture).project
            model.close()
            service = FakeServiceLink(project: project)
            model = EditorModel.on(service, store: .init(url: folder.appendingPathComponent("perf-edit.json")))
        }
        else {
            for index in 1...4 { project.audio.lanes?.append(.init(id: "voice\(index)", source: .voiceover)) }
            project.layers?.media.append(.init(id: "image", kind: .image, file: "image.png", startUs: 0, endUs: 3_000_000))
        }
        XCTAssertEqual(project.audio.lanes?.count, 6)
        XCTAssertEqual(project.layerOrder().count, 4)
        model.adopt(project, rebuild: false)
        hostTimeline(height: 250)
        let top = try XCTUnwrap(project.layerOrder().last).id
        _ = try element("recorder.timeline.layer." + top)
        let bottom = try XCTUnwrap(project.audio.lanes?.last).id
        func scrollView(in view: NSView) -> NSScrollView? {
            if let scroll = view as? NSScrollView { return scroll }
            return view.subviews.lazy.compactMap { scrollView(in: $0) }.first
        }
        let scroll = try XCTUnwrap(scrollView(in: try XCTUnwrap(window.contentView)))
        let clip = scroll.contentView
        let end = try XCTUnwrap(scroll.documentView).frame.height - clip.bounds.height
        XCTAssertGreaterThan(end, 0)
        func scrollTo(_ y: CGFloat) {
            clip.scroll(to: CGPoint(x: 0, y: y))
            scroll.reflectScrolledClipView(clip)
            window.contentView?.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
        }
        scrollTo(end)
        _ = try element("recorder.timeline.sound." + bottom)
        if fixture != nil {
            var times: [Double] = []
            for step in 0..<120 {
                let y = end * CGFloat(abs(30 - step % 60)) / 30
                let start = CACurrentMediaTime()
                scrollTo(y)
                times.append((CACurrentMediaTime() - start) * 1000)
                try await Task.sleep(for: .milliseconds(16))
            }
            times.sort()
            print(String(format: "recorder.layer-scroll n=120 p50=%.2f ms p95=%.2f ms above16.67=%d",
                         times[60], times[113], times.filter { $0 > 1000 / 60 }.count))
        }
    }

    /// Deliver the pasteboard to the hosting view's registered drop destination. A base without rows fails at
    /// the same lookup as a user trying to drop there. No mouse event or active window is needed.
    private func drop(_ item: NSPasteboardWriting, on id: String, atOutput: Int64? = nil) throws {
        let frame = try element(id).accessibilityFrame()
        if let atOutput { model.seek(atOutput) }
        let point = window.convertPoint(fromScreen: NSPoint(x: frame.midX, y: frame.midY))
        let drag = LayerTestDrag(item, window: window, at: point)
        pasteboards.append(drag.draggingPasteboard)
        let content = try XCTUnwrap(window.contentView)
        var view = content.hitTest(content.convert(point, from: nil))
        while let target = view {
            let destination: NSDraggingDestination = target
            if !target.registeredDraggedTypes.isEmpty, let entered = destination.draggingEntered?(drag), !entered.isEmpty {
                _ = destination.draggingUpdated?(drag)
                XCTAssertTrue(destination.prepareForDragOperation?(drag) ?? true)
                XCTAssertEqual(destination.performDragOperation?(drag), true)
                destination.concludeDragOperation?(drag)
                return
            }
            view = target.superview
        }
        XCTFail("No drop destination accepted the pasteboard at \(id)")
    }
}

@MainActor
private final class LayerTestDrag: NSObject, NSDraggingInfo {
    let draggingPasteboard = NSPasteboard(name: .init("layer-drop-\(UUID().uuidString)"))
    let draggingDestinationWindow: NSWindow?
    let draggingLocation: NSPoint
    let draggingSourceOperationMask: NSDragOperation = [.copy, .move]
    var draggingSource: Any? { nil }
    var draggedImage: NSImage? { nil }
    var draggedImageLocation: NSPoint { draggingLocation }
    let draggingSequenceNumber = 1
    var draggingFormation: NSDraggingFormation = .default
    var animatesToDestination = false
    var numberOfValidItemsForDrop = 1
    var springLoadingHighlight: NSSpringLoadingHighlight { .none }

    init(_ item: NSPasteboardWriting, window: NSWindow, at location: NSPoint) {
        draggingDestinationWindow = window
        draggingLocation = location
        super.init()
        draggingPasteboard.writeObjects([item])
    }

    func slideDraggedImage(to screenPoint: NSPoint) {}
    func resetSpringLoading() {}
    func enumerateDraggingItems(options: NSDraggingItemEnumerationOptions = [], for view: NSView?, classes: [AnyClass],
                                searchOptions: [NSPasteboard.ReadingOptionKey: Any] = [:],
                                using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void) {
        var stop = ObjCBool(false)
        for (index, object) in (draggingPasteboard.readObjects(forClasses: classes, options: searchOptions) ?? []).enumerated() {
            guard let writer = object as? NSPasteboardWriting else { continue }
            block(NSDraggingItem(pasteboardWriter: writer), index, &stop)
            if stop.boolValue { return }
        }
    }
}
