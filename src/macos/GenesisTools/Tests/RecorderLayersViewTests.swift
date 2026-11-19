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
    private var probeWasEnabled = false
    private var soundReadings: [String: SoundRowProbe.Reading] = [:]

    override func setUp() async throws {
        _ = NSApplication.shared
        probeWasEnabled = FrameProbe.enabled
        FrameProbe.reset()
        FrameProbe.enabled = true
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
        window?.orderOut(nil)
        window?.contentView = nil
        window?.close()
        window = nil
        FrameProbe.enabled = probeWasEnabled
        FrameProbe.reset()
        model.close()
        model = nil
        service = nil
        try FileManager.default.removeItem(at: folder)
    }

    func testLayerDropDefaultsRoundTripInTheChosenStore() throws {
        let suite = "recorder.layers.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var stored = EditorModel.DropDefaults(defaults: defaults)
        stored.width = 0.42
        stored.atPointer = true
        stored.save()
        let reopened = EditorModel.DropDefaults(defaults: defaults)
        XCTAssertEqual(reopened.width, 0.42)
        XCTAssertTrue(reopened.atPointer)
    }

    func testLosingProxySidecarFactsRebuildsThePreview() async throws {
        var project = model.project
        project.audio.lanes = nil
        model.adopt(project, rebuild: false)
        hostTimeline()
        let video = project.source.video
        let separate = EditProject.AudioFacts(movieTracks: 1, mixedFrom: [.init(source: .mic, file: "mic.m4a", offsetMs: 0)])
        model.adoptSourceAudioFacts(separate, for: video)
        XCTAssertEqual(model.soundRows.map(\.id), ["mic"])
        _ = try await waitFor("first rebuild attempted to open the fixture movie") { model.previewProblem }
        model.previewProblem = nil
        model.adoptSourceAudioFacts(.init(movieTracks: 1, mixedFrom: []), for: video)
        XCTAssertEqual(model.soundRows.map(\.id), ["movie-0"])
        _ = try await waitFor("removing sidecars must also rebuild") { model.previewProblem }
    }

    private func hostTimeline(height: CGFloat = 650) {
        let size = CGSize(width: 1100, height: height)
        window = NSWindow(contentRect: CGRect(origin: .zero, size: size), styleMask: [.borderless],
                          backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.alphaValue = 0
        window.level = .init(rawValue: -1000)
        window.contentView = NSHostingView(rootView: TimelineView(model: model, viewportWidth: size.width)
            .defaultAppStorage(UserDefaults(suiteName: UUID().uuidString)!)
            .onPreferenceChange(SoundRowProbe.self) { [weak self] in self?.soundReadings = $0 }
            .frame(width: size.width, height: size.height))
        window.orderFrontRegardless()
        XCTAssertFalse(window.isKeyWindow)
    }

    private func waitFor<T>(_ description: String, file: StaticString = #filePath, line: UInt = #line,
                            _ read: () -> T?) async throws -> T {
        let deadline = ContinuousClock.now + .seconds(3)
        repeat {
            window.contentView?.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            if let value = read() { return value }
            try await Task.sleep(for: .milliseconds(100))
        } while ContinuousClock.now < deadline
        return try XCTUnwrap(read(), description, file: file, line: line)
    }

    private func centerInWindow(_ frame: CGRect) -> CGPoint {
        CGPoint(x: frame.midX, y: window.frame.height - frame.midY)
    }

    private func visibleFrame(_ id: String, in viewport: CGRect? = nil,
                              file: StaticString = #filePath, line: UInt = #line) async throws -> CGRect {
        let bounds = viewport ?? CGRect(origin: .zero, size: window.frame.size)
        return try await waitFor("Missing visible frame for \(id)", file: file, line: line) {
            guard let frame = FrameProbe.frames[id], !frame.isEmpty, bounds.contains(centerInWindow(frame)) else { return nil }
            return frame
        }
    }

    private func sound(_ suffix: String, changedFrom oldValue: String? = nil) async throws -> SoundRowProbe.Reading {
        let id = "recorder.timeline.sound." + suffix
        _ = try await visibleFrame(id)
        return try await waitFor("Missing updated label and value for \(id)") {
            guard let reading = soundReadings[id], reading.value != oldValue else { return nil }
            return reading
        }
    }

    private func mouse(_ type: NSEvent.EventType, at point: CGPoint) throws -> NSEvent {
        try XCTUnwrap(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
            context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseUp ? 0 : 1))
    }

    private func press(_ id: String) async throws {
        let point = centerInWindow(try await visibleFrame(id))
        let down = try mouse(.leftMouseDown, at: point), up = try mouse(.leftMouseUp, at: point)
        // A native button can consume the release inside mouseDown's tracking loop.
        NSApp.postEvent(up, atStart: true)
        window.sendEvent(down)
        if let next = NSApp.nextEvent(matching: .leftMouseUp, until: .distantPast, inMode: .default, dequeue: false),
           next.windowNumber == window.windowNumber,
           let release = NSApp.nextEvent(matching: .leftMouseUp, until: .distantPast, inMode: .default, dequeue: true) {
            window.sendEvent(release)
        }
        XCTAssertFalse(window.isKeyWindow)
    }

    /// Ask the hit view or its hosting ancestor for the real context menu without presenting it.
    private func menu(for layer: String) async throws -> NSMenu {
        let point = centerInWindow(try await visibleFrame("recorder.timeline.layer." + layer))
        let event = try mouse(.rightMouseDown, at: point)
        let content = try XCTUnwrap(window.contentView)
        var target: NSView? = content.hitTest(content.superview?.convert(point, from: nil) ?? point) ?? content
        var found: NSMenu?
        while let view = target {
            if let menu = view.menu(for: event) { found = menu; break }
            target = view === content ? nil : view.superview
        }
        let menu = try XCTUnwrap(found, "Missing context menu for layer \(layer)")
        menu.update()
        return menu
    }

    func testTimelineShowsBothNamedSoundRows() async throws {
        hostTimeline()
        let mic = try await sound("mic")
        let system = try await sound("system")
        XCTAssertEqual(mic.label, "Microphone")
        XCTAssertEqual(system.label, "System sound")
    }

    func testPressingMuteSendsOneOpAndAnnouncesMuted() async throws {
        hostTimeline()
        let before = try await sound("mic")
        XCTAssertEqual(before.value, "100%")
        // The hidden test window has no pointer hover. Focus the lane to mount its pointer control.
        let mic = EditorRowFocus(area: .timelineSound, id: "mic")
        model.requestedRowFocus = mic
        _ = try await waitFor("timeline microphone has focus") { model.focusedEditorRow == mic ? mic : nil }
        try await press("recorder.timeline.sound.mic.mute")
        let after = try await sound("mic", changedFrom: before.value)
        XCTAssertEqual(service.sentOps as NSArray, [["op": "audioLane", "id": "mic", "muted": true]] as NSArray)
        XCTAssertEqual(after.value, "muted")
        XCTAssertFalse(try XCTUnwrap(model.project.audio.lanes?.last).muted)
    }

    func testLayersAppearFrontToBack() async throws {
        hostTimeline()
        let logo = try await visibleFrame("recorder.timeline.layer.logo")
        let art = try await visibleFrame("recorder.timeline.layer.art")
        let camera = try await visibleFrame("recorder.timeline.layer.camera")
        XCTAssertLessThan(logo.midY, art.midY, "SwiftUI global coordinates increase toward the bottom")
        XCTAssertLessThan(art.midY, camera.midY)
    }

    func testFourOrderActionsSendTheirNamedMovesOnce() async throws {
        hostTimeline()
        let actions = try await menu(for: "art")
        for title in ["Bring to Front", "Bring Forward", "Send Backward", "Send to Back"] {
            let index = try XCTUnwrap(actions.items.firstIndex { $0.title == title }, "Missing \(title)")
            XCTAssertTrue(actions.items[index].isEnabled, title)
            actions.performActionForItem(at: index)
        }
        let calls = try await waitFor("The four order commands must reach edit.apply") {
            let count = service.count("edit.apply")
            return count >= 4 ? count : nil
        }
        XCTAssertEqual(calls, 4)
        XCTAssertEqual(service.sentOps as NSArray, ["top", "up", "down", "bottom"].map {
            ["op": "layerMove", "id": "art", "to": $0]
        } as NSArray)
    }

    func testOnlyMediaOffersDelete() async throws {
        hostTimeline()
        let camera = try await menu(for: "camera").items.map(\.title)
        XCTAssertTrue(camera.contains("Hide Camera"))
        XCTAssertFalse(camera.contains("Delete"))
        let media = try await menu(for: "logo").items.map(\.title)
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
        let camera = try await dropTarget("camera")
        XCTAssertTrue(model.dropLayer(.row(window: model.session.holder, id: "logo"), on: camera))
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
        let logo = try await dropTarget("logo")
        model.seek(1_500_000)
        XCTAssertTrue(model.dropLayer(.file(image), on: logo))
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
        let layerIDs = project.layerOrder().map { "recorder.timeline.layer." + $0.id }
        let soundIDs = try XCTUnwrap(project.audio.lanes).map { "recorder.timeline.sound." + $0.id }
        _ = try await visibleFrame(try XCTUnwrap(layerIDs.last))
        func scrollView(in view: NSView) -> NSScrollView? {
            if let scroll = view as? NSScrollView { return scroll }
            return view.subviews.lazy.compactMap { scrollView(in: $0) }.first
        }
        let scroll = try XCTUnwrap(scrollView(in: try XCTUnwrap(window.contentView)))
        let clip = scroll.contentView
        let viewport = clip.convert(clip.bounds, to: nil)
        for id in layerIDs {
            _ = try await visibleFrame(id, in: viewport)
        }
        let end = try XCTUnwrap(scroll.documentView).frame.height - clip.bounds.height
        XCTAssertGreaterThan(end, 0)
        let initialY = clip.bounds.minY
        let bottomSound = try XCTUnwrap(soundIDs.last)
        if let frame = FrameProbe.frames[bottomSound], !frame.isEmpty {
            XCTAssertFalse(viewport.contains(centerInWindow(frame)), "The last sound row should start below the viewport")
        }
        func scrollTo(_ y: CGFloat) {
            clip.scroll(to: CGPoint(x: 0, y: y))
            scroll.reflectScrolledClipView(clip)
            window.contentView?.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
        }
        scrollTo(clip.isFlipped ? end : 0)
        XCTAssertNotEqual(clip.bounds.minY, initialY)
        for id in soundIDs {
            _ = try await visibleFrame(id, in: viewport)
        }
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

    private func dropTarget(_ id: String) async throws -> EditorLayerRow {
        _ = try await visibleFrame("recorder.timeline.layer." + id)
        return try XCTUnwrap(model.layersByID[id])
    }
}
