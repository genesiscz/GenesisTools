import AppKit
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
        panel.window.orderInForSnapshot()
        addTeardownBlock { @MainActor in
            panel.window.orderOut(nil)
            panel.window.close()
            defaults.removePersistentDomain(forName: name)
        }
        return Fixture(engine: engine, model: model, panel: panel)
    }

    // Walk the hosted controls themselves, without an external accessibility client or a privacy grant.
    private func nodes(_ panel: RecordingBarPanel) -> [String: NSAccessibilityProtocol] {
        panel.window.contentView?.layoutSubtreeIfNeeded()
        panel.window.displayIfNeeded()
        var result: [String: NSAccessibilityProtocol] = [:]
        var seen = Set<ObjectIdentifier>()
        func walk(_ node: NSAccessibilityProtocol) {
            guard seen.insert(ObjectIdentifier(node)).inserted else { return }
            if let id = node.accessibilityIdentifier() { result[id] = node }
            for child in node.accessibilityChildren() ?? [] {
                if let element = child as? NSAccessibilityProtocol { walk(element) }
            }
        }
        walk(panel.window)
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

    private func assertBar(_ f: Fixture, shows phaseIDs: [String], file: StaticString = #filePath, line: UInt = #line) {
        let tree = nodes(f.panel)
        XCTAssertEqual(f.panel.window.frame.width, 520, accuracy: 1, file: file, line: line)
        for suffix in ["target", "microphone", "systemAudio", "camera", "frameRate", "expand", "hide"] + phaseIDs {
            XCTAssertNotNil(tree["recording.bar.\(suffix)"], "Missing \(suffix); rendered IDs \(tree.keys.sorted())", file: file, line: line)
        }
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
        assertBar(f, shows: ["record"])
        XCTAssertTrue(f.panel.window.styleMask.contains(.nonactivatingPanel))
        XCTAssertEqual(f.panel.window.sharingType, .none)
        XCTAssertGreaterThan(f.panel.windowID, 0)
        XCTAssertTrue(f.model.excludeWindowIDs.contains(f.panel.windowID))
        try await snapshot(f, "setup")
    }

    func testCountdownKeepsTheFirstRowAndOffersCancel() {
        let f = fixture(countdown: 10)
        f.model.record()
        assertBar(f, shows: ["countdown", "cancel"])
        f.model.discard()
    }

    func testStartingKeepsTheFirstRowWithoutRecordingOrStop() async {
        let f = fixture()
        await start(f)
        assertBar(f, shows: ["starting", "cancel"])
        XCTAssertNil(nodes(f.panel)["recording.bar.stop"])
    }

    func testRecordingKeepsTheFirstRowAndOffersPauseAndStop() async throws {
        let f = fixture()
        await firstFrame(f)
        assertBar(f, shows: ["clock", "pause", "stop"])
        try await snapshot(f, "recording")
    }

    func testPausedKeepsTheFirstRowAndOffersResumeAndStop() async throws {
        let f = fixture()
        await firstFrame(f)
        f.model.pause()
        await f.model.pendingCommand?.value
        assertBar(f, shows: ["clock", "resume", "stop"])
        try await snapshot(f, "paused")
    }

    func testFinishingKeepsTheFirstRowAndShowsSaving() async {
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
        assertBar(f, shows: ["finishing"])
        release?.resume()
        await f.model.pendingCommand?.value
    }

    func testDoneKeepsTheFirstRowAndOffersTheMovieAndAnotherTake() async throws {
        let f = fixture()
        await firstFrame(f)
        f.model.stop()
        await f.model.pendingCommand?.value
        assertBar(f, shows: ["use", "finder", "newRecording"])
        try await snapshot(f, "done")
    }

    func testFailedKeepsTheFirstRowAndShowsTheError() async {
        let f = fixture()
        f.engine.failStart = true
        await start(f)
        assertBar(f, shows: ["failed", "newRecording"])
    }

    func testUnavailableCameraExposesTheEngineReasonAndIsDisabled() async throws {
        let f = fixture()
        await firstFrame(f)
        let camera = try XCTUnwrap(nodes(f.panel)["recording.bar.camera"])
        XCTAssertFalse(camera.isAccessibilityEnabled())
        XCTAssertTrue(camera.accessibilityHelp()?.contains("The camera starts with the recording.") == true)
    }

    func testExpansionButtonChangesTheModelAndGrowsTheSameWindow() async throws {
        let f = fixture()
        let height = f.panel.window.frame.height
        let button = try XCTUnwrap(nodes(f.panel)["recording.bar.expand"])
        let growth = expectation(description: "Expanded controls fit inside the panel")
        let resize = NotificationCenter.default.publisher(for: NSWindow.didResizeNotification, object: f.panel.window)
            .first(where: { _ in f.panel.window.frame.height > height }).sink { _ in growth.fulfill() }
        defer { resize.cancel() }
        XCTAssertTrue(button.accessibilityPerformPress())
        await fulfillment(of: [growth], timeout: 3)
        XCTAssertTrue(f.model.expanded)
        assertBar(f, shows: ["quality", "stillFrameRate", "threshold", "placement"])
        let threshold = try XCTUnwrap(nodes(f.panel)["recording.bar.threshold"])
        XCTAssertFalse(threshold.isAccessibilityEnabled())
        XCTAssertTrue(threshold.accessibilityHelp()?.contains("active and still frame rates are the same") == true)
        try await snapshot(f, "setup-expanded")
        let collapsed = expectation(description: "Original panel height restored")
        let shrink = NotificationCenter.default.publisher(for: NSWindow.didResizeNotification, object: f.panel.window)
            .first(where: { _ in abs(f.panel.window.frame.height - height) < 1 }).sink { _ in collapsed.fulfill() }
        defer { shrink.cancel() }
        let collapse = try XCTUnwrap(nodes(f.panel)["recording.bar.expand"])
        XCTAssertTrue(collapse.accessibilityPerformPress())
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
