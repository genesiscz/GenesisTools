import AppKit
import ApplicationServices
import Combine
import XCTest
@testable import GenesisKit

@MainActor
final class RecordingBarViewTests: XCTestCase {
    private final class Engine: RecordingEngineAdapter {
        let stream = AsyncStream<RecordingEngineEvent>.makeStream()
        let nextTakeID = "fixture-take"
        let capabilities = RecordingCapabilities(targets: Set(RecordingTargetKind.allCases), liveTargetSwitch: true,
                                                liveMicrophoneMute: true, liveMicrophoneDevice: true,
                                                liveSystemAudioMute: true, liveFrameRate: true,
                                                liveCamera: false, reasonUnavailable: ["camera": "The camera starts with the recording."])
        var events: AsyncStream<RecordingEngineEvent> { stream.stream }
        var failStart = false
        var pauses = 0
        var waitForSave: (() async -> Void)?
        func start(_ setup: RecordingSetup, excludeWindowIDs: [Int]) async throws {
            if failStart { throw RecordingEngineError.unsupported("Capture unavailable") }
        }
        func pause() async throws { pauses += 1 }
        func resume() async throws {}
        func stop() async throws -> URL? {
            await waitForSave?()
            return URL(fileURLWithPath: "/fixture/Movie.mp4")
        }
        func restart() async throws {}
        func discard() async throws {}
        func apply(_ change: RecordingSetupChange) async throws {}
        func audioDevices() async throws -> (inputs: [RecordingAudioDevice], outputs: [RecordingAudioDevice]) { ([], []) }
    }

    private struct Fixture {
        let engine: Engine
        let model: RecordingBarModel
        let panel: RecordingBarPanel
    }

    private func fixture(countdown: Int? = nil) -> Fixture {
        _ = NSApplication.shared
        let engine = Engine()
        let setup = RecordingSetup(target: .display(index: 0, name: "Studio"), countdownSeconds: countdown)
        let name = "test.recording.bar.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        let model = RecordingBarModel(engine: engine, setup: setup, defaults: defaults,
                                      countdownTick: { try? await Task.sleep(for: .seconds(1)) })
        model.expanded = false
        let panel = RecordingBarPanel(model: model, actions: RecordingBarActions(chooseTarget: { _ in }, useMovie: { _ in }),
                                      defaults: defaults)
        panel.window.setAccessibilityIdentifier(name)
        panel.window.orderInForSnapshot()
        addTeardownBlock { @MainActor in
            panel.window.orderOut(nil)
            panel.window.close()
            defaults.removePersistentDomain(forName: name)
        }
        return Fixture(engine: engine, model: model, panel: panel)
    }

    private func attribute(_ node: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(node, name as CFString, &value) == .success else { return nil }
        return value
    }

    // Read the fixture window as an AX client, as SnapshotViewTree does for hosted SwiftUI views.
    private func nodes(_ panel: RecordingBarPanel) async throws -> [String: AXUIElement] {
        let window = panel.window
        await withCheckedContinuation { continuation in
            RunLoop.main.perform { continuation.resume() }
        }
        window.contentView?.layoutSubtreeIfNeeded()
        window.displayIfNeeded()

        let app = AXUIElementCreateApplication(getpid())
        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value)
        let windows = try XCTUnwrap(value as? [AXUIElement], "Reading the test process's AXWindows returned \(status)")
        let id = try XCTUnwrap(window.accessibilityIdentifier())
        let root = try XCTUnwrap(windows.first { attribute($0, kAXIdentifierAttribute) as? String == id },
                                 "AXWindows did not include the recording panel \(id)")
        var result: [String: AXUIElement] = [:]
        var seen = Set<AXUIElement>()
        func walk(_ node: AXUIElement) {
            guard seen.insert(node).inserted else { return }
            if let id = attribute(node, kAXIdentifierAttribute) as? String { result[id] = node }
            for child in attribute(node, kAXChildrenAttribute) as? [AXUIElement] ?? [] { walk(child) }
        }
        walk(root)
        return result
    }

    /// Uses the recorder's offscreen --snapshot renderer. In ordinary test runs this writes nothing.
    private func snapshot(_ f: Fixture, _ name: String) async throws {
        guard let directory = ProcessInfo.processInfo.environment["RECORDING_SNAPSHOT_DIR"] else { return }
        let window = f.panel.window
        window.contentView?.layoutSubtreeIfNeeded()
        XCTAssertEqual(window.frame.width, 520, accuracy: 1)
        // Only this transparent fixture window can be sampled. The production bar remains capture-excluded.
        let sharing = window.sharingType
        defer { window.sharingType = sharing }
        window.sharingType = .readOnly
        let captured = await WindowSnapshot.capture(window)
        let shot = try XCTUnwrap(captured)
        let data = try XCTUnwrap(shot.image.representation(using: .png, properties: [:]))
        let folder = URL(fileURLWithPath: directory, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent("recording-bar-\(name).png")
        try data.write(to: file, options: .atomic)
        print("recorder snapshot: \(file.path) by \(shot.method) (\(Int(window.frame.width))×\(Int(window.frame.height)) pt)")
    }

    @discardableResult
    private func assertBar(_ f: Fixture, shows phaseIDs: [String], file: StaticString = #filePath,
                           line: UInt = #line) async throws -> [String: AXUIElement] {
        let tree = try await nodes(f.panel)
        XCTAssertEqual(f.panel.window.frame.width, 520, accuracy: 1, file: file, line: line)
        for suffix in ["target", "microphone", "systemAudio", "camera", "frameRate", "expand", "hide"] + phaseIDs {
            XCTAssertNotNil(tree["recording.bar.\(suffix)"], "Missing \(suffix); rendered IDs \(tree.keys.sorted())", file: file, line: line)
        }
        return tree
    }

    private func start(_ f: Fixture) async {
        f.model.record()
        await f.model.pendingCommand?.value
    }

    private func firstFrame(_ f: Fixture) async {
        await start(f)
        let ready = expectation(description: "Model accepted this take's first frame")
        let observation = f.model.$phase.first(where: { $0 == .recording(take: f.engine.nextTakeID) })
            .sink { _ in ready.fulfill() }
        defer { observation.cancel() }
        f.engine.stream.continuation.yield(.init(take: f.engine.nextTakeID, value: .firstFrame))
        await fulfillment(of: [ready], timeout: 2)
    }

    func testSetupKeepsTheFirstRowAndOffersRecord() async throws {
        let f = fixture()
        try await assertBar(f, shows: ["record"])
        XCTAssertTrue(f.panel.window.styleMask.contains(.nonactivatingPanel))
        XCTAssertEqual(f.panel.window.sharingType, .none)
        XCTAssertGreaterThan(f.panel.windowID, 0)
        XCTAssertTrue(f.model.excludeWindowIDs.contains(f.panel.windowID))
        try await snapshot(f, "setup")
    }

    func testCountdownKeepsTheFirstRowAndOffersCancel() async throws {
        let f = fixture(countdown: 10)
        f.model.record()
        defer { f.model.discard() }
        try await assertBar(f, shows: ["countdown", "cancel"])
    }

    func testStartingKeepsTheFirstRowWithoutRecordingOrStop() async throws {
        let f = fixture()
        await start(f)
        let tree = try await assertBar(f, shows: ["starting", "cancel"])
        XCTAssertNil(tree["recording.bar.stop"])
    }

    func testRecordingKeepsTheFirstRowAndOffersPauseAndStop() async throws {
        let f = fixture()
        await firstFrame(f)
        try await assertBar(f, shows: ["clock", "pause", "stop"])
        try await snapshot(f, "recording")
    }

    func testPausedKeepsTheFirstRowAndOffersResumeAndStop() async throws {
        let f = fixture()
        await firstFrame(f)
        f.model.pause()
        await f.model.pendingCommand?.value
        try await assertBar(f, shows: ["clock", "resume", "stop"])
        try await snapshot(f, "paused")
    }

    func testFinishingKeepsTheFirstRowAndShowsSaving() async throws {
        let f = fixture()
        await firstFrame(f)
        let saving = expectation(description: "Engine is saving the file")
        var release: CheckedContinuation<Void, Never>?
        f.engine.waitForSave = {
            await withCheckedContinuation { continuation in
                release = continuation
                saving.fulfill()
            }
        }
        f.model.stop()
        await fulfillment(of: [saving], timeout: 2)
        do {
            defer { release?.resume() }
            try await assertBar(f, shows: ["finishing"])
        }
        await f.model.pendingCommand?.value
    }

    func testDoneKeepsTheFirstRowAndOffersTheMovieAndAnotherTake() async throws {
        let f = fixture()
        await firstFrame(f)
        f.model.stop()
        await f.model.pendingCommand?.value
        try await assertBar(f, shows: ["use", "finder", "newRecording"])
        try await snapshot(f, "done")
    }

    func testFailedKeepsTheFirstRowAndShowsTheError() async throws {
        let f = fixture()
        f.engine.failStart = true
        await start(f)
        try await assertBar(f, shows: ["failed", "newRecording"])
    }

    func testUnavailableCameraExposesTheEngineReasonAndIsDisabled() async throws {
        let f = fixture()
        await firstFrame(f)
        let tree = try await nodes(f.panel)
        let camera = try XCTUnwrap(tree["recording.bar.camera"])
        XCTAssertEqual(attribute(camera, kAXEnabledAttribute) as? Bool, false)
        XCTAssertTrue((attribute(camera, kAXHelpAttribute) as? String)?.contains("The camera starts with the recording.") == true)
    }

    func testExpansionButtonChangesTheModelAndGrowsTheSameWindow() async throws {
        let f = fixture()
        let compact = try await nodes(f.panel)
        let height = f.panel.window.frame.height
        let button = try XCTUnwrap(compact["recording.bar.expand"])
        let growth = expectation(description: "Expanded controls fit inside the panel")
        let resize = NotificationCenter.default.publisher(for: NSWindow.didResizeNotification, object: f.panel.window)
            .first(where: { _ in f.panel.window.frame.height > height }).sink { _ in growth.fulfill() }
        defer { resize.cancel() }
        XCTAssertEqual(AXUIElementPerformAction(button, kAXPressAction as CFString), .success)
        await fulfillment(of: [growth], timeout: 3)
        XCTAssertTrue(f.model.expanded)
        let expanded = try await assertBar(f, shows: ["quality", "stillFrameRate", "threshold", "placement"])
        let threshold = try XCTUnwrap(expanded["recording.bar.threshold"])
        XCTAssertEqual(attribute(threshold, kAXEnabledAttribute) as? Bool, false)
        XCTAssertTrue((attribute(threshold, kAXHelpAttribute) as? String)?.contains("active and still frame rates are the same") == true)
        try await snapshot(f, "setup-expanded")
        let collapsed = expectation(description: "Original panel height restored")
        let shrink = NotificationCenter.default.publisher(for: NSWindow.didResizeNotification, object: f.panel.window)
            .first(where: { _ in abs(f.panel.window.frame.height - height) < 1 }).sink { _ in collapsed.fulfill() }
        defer { shrink.cancel() }
        let current = try await nodes(f.panel)
        let collapse = try XCTUnwrap(current["recording.bar.expand"])
        XCTAssertEqual(AXUIElementPerformAction(collapse, kAXPressAction as CFString), .success)
        await fulfillment(of: [collapsed], timeout: 3)
        XCTAssertFalse(f.model.expanded)
    }

    func testSpaceInRecordingPausesTheEngineOnce() async throws {
        let f = fixture()
        await firstFrame(f)
        let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
                                                   timestamp: 0, windowNumber: f.panel.windowID, context: nil,
                                                   characters: " ", charactersIgnoringModifiers: " ", isARepeat: false, keyCode: 49))
        f.panel.window.sendEvent(event)
        await f.model.pendingCommand?.value
        XCTAssertEqual(f.engine.pauses, 1)
        XCTAssertEqual(f.model.phase, .paused(take: f.engine.nextTakeID, byUser: true))
    }

    func testCountdownSelectsTheDisplayHoldingMostOfTheWindowBeforeUsingThePointer() {
        let screens = [CGRect(x: 0, y: 0, width: 800, height: 600), CGRect(x: 800, y: 0, width: 1200, height: 800)]
        let pointer = CGPoint(x: 10, y: 10)
        XCTAssertEqual(RecordingBarPanel.screenIndex(bounds: CGRect(x: 750, y: 0, width: 400, height: 400),
                                                    screens: screens, pointer: pointer), 1)
        XCTAssertEqual(RecordingBarPanel.screenIndex(bounds: nil, screens: screens, pointer: pointer), 0)
    }
}
