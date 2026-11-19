import AppKit
import Combine
import SwiftUI
import XCTest
@testable import GenesisKit

/// Drives the host's actual borderless panel without taking focus or sending events to another window.
@MainActor
final class RecordingBarTestHost {
    private let window: NSWindow
    private(set) var controls: [String: RecordingBarProbe.State] = [:]

    init(_ window: NSWindow, probing suffixes: [String], test: XCTestCase) throws {
        let host = try XCTUnwrap(window.contentView as? NSHostingView<AnyView>, "The recording bar's hosting view")
        self.window = window
        let previouslyEnabled = FrameProbe.enabled
        FrameProbe.reset()
        FrameProbe.enabled = true
        test.addTeardownBlock { @MainActor in
            FrameProbe.enabled = previouslyEnabled
            FrameProbe.reset()
        }
        let ids = Set(suffixes.map { "recording.bar.\($0)" })
        host.rootView = AnyView(host.rootView.environment(\.recordingBarProbeIDs, ids)
            .onPreferenceChange(RecordingBarProbe.Controls.self) { [weak self] in self?.controls = $0 })
        window.alphaValue = 0
        window.level = .init(rawValue: -1000)
        (window as? NSPanel)?.becomesKeyOnlyIfNeeded = true
        if !window.isVisible { window.orderInForSnapshot() }
        XCTAssertFalse(window.isKeyWindow)
    }

    /// A state change can arrive before SwiftUI has placed the new controls. Yield to the main run loop between layouts.
    func wait(for suffixes: [String], enabled: Bool? = nil, file: StaticString = #filePath, line: UInt = #line) async throws {
        let ids = suffixes.map { "recording.bar.\($0)" }
        let deadline = ContinuousClock.now + .seconds(3)
        repeat {
            try await Task.sleep(for: .milliseconds(100))
            window.contentView?.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            if ids.allSatisfy({ id in
                guard let state = controls[id], let frame = FrameProbe.frames[id], !frame.isEmpty else { return false }
                return enabled == nil || state.isEnabled == enabled
            }) { return }
        } while ContinuousClock.now < deadline
        throw ToolsBridgeError.refused("Missing laid-out controls at \(file):\(line). Expected \(ids) with enabled " +
            "\(String(describing: enabled)). Rendered: \(controls). Frames: \(FrameProbe.frames)")
    }

    func press(_ suffix: String, file: StaticString = #filePath, line: UInt = #line) async throws {
        try await wait(for: [suffix], enabled: true, file: file, line: line)
        let id = "recording.bar.\(suffix)"
        let frame = try XCTUnwrap(FrameProbe.frames[id], file: file, line: line)
        let point = CGPoint(x: frame.midX, y: window.frame.height - frame.midY)
        func mouse(_ type: NSEvent.EventType) throws -> NSEvent {
            try XCTUnwrap(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: 0, clickCount: 1, pressure: 1), file: file, line: line)
        }
        let down = try mouse(.leftMouseDown)
        let up = try mouse(.leftMouseUp)
        let ignoredMouse = window.ignoresMouseEvents
        window.ignoresMouseEvents = false
        defer { window.ignoresMouseEvents = ignoredMouse }
        // AppKit can consume the release inside mouseDown's tracking loop. Deliver it ourselves if it is still queued.
        NSApp.postEvent(up, atStart: true)
        window.sendEvent(down)
        if let next = NSApp.nextEvent(matching: .leftMouseUp, until: .distantPast, inMode: .default, dequeue: false),
           next.windowNumber == up.windowNumber,
           let release = NSApp.nextEvent(matching: .leftMouseUp, until: .distantPast, inMode: .default, dequeue: true) {
            window.sendEvent(release)
        }
        XCTAssertFalse(window.isKeyWindow, file: file, line: line)
    }
}

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
        let host: RecordingBarTestHost
    }

    private let firstRow = ["target", "microphone", "systemAudio", "camera", "frameRate", "expand", "hide"]
    private let phaseControls = ["record", "countdown", "cancel", "starting", "clock", "pause", "resume", "stop",
                                 "finishing", "use", "finder", "newRecording", "failed"]
    private let expandedControls = ["quality", "stillFrameRate", "threshold", "placement"]
    /// While a take runs the drawer holds what applies to it; the setup-only choices wait for the next recording.
    private let liveExpandedControls = ["stillFrameRate", "placement"]

    private func fixture(countdown: Int? = nil, expanded: Bool = false) throws -> Fixture {
        _ = NSApplication.shared
        let engine = Engine()
        let setup = RecordingSetup(target: .display(index: 0, name: "Studio"), countdownSeconds: countdown)
        let name = "test.recording.bar.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        let model = RecordingBarModel(engine: engine, setup: setup, defaults: defaults,
                                      countdownTick: { try? await Task.sleep(for: .seconds(1)) })
        model.expanded = expanded
        let panel = RecordingBarPanel(model: model, actions: RecordingBarActions(chooseTarget: { _ in }, useMovie: { _ in }),
                                      defaults: defaults)
        addTeardownBlock { @MainActor in
            panel.window.orderOut(nil)
            panel.window.close()
            defaults.removePersistentDomain(forName: name)
        }
        let host = try RecordingBarTestHost(panel.window, probing: firstRow + phaseControls + expandedControls, test: self)
        return Fixture(engine: engine, model: model, panel: panel, host: host)
    }

    /// Uses the recorder's offscreen --snapshot renderer. In ordinary test runs this writes nothing.
    private func snapshot(_ f: Fixture, _ name: String) async throws {
        guard let directory = ProcessInfo.processInfo.environment["RECORDING_SNAPSHOT_DIR"] else { return }
        let window = f.panel.window
        window.contentView?.layoutSubtreeIfNeeded()
        XCTAssertEqual(window.frame.width, RecordingBarView.width, accuracy: 1)
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

    private func assertBar(_ f: Fixture, shows phaseIDs: [String], file: StaticString = #filePath,
                           line: UInt = #line) async throws {
        let expected = firstRow + phaseIDs
        try await f.host.wait(for: expected, file: file, line: line)
        XCTAssertEqual(f.panel.window.frame.width, RecordingBarView.width, accuracy: 1, file: file, line: line)
        XCTAssertEqual(Set(f.host.controls.keys), Set(expected.map { "recording.bar.\($0)" }), file: file, line: line)
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
        let f = try fixture()
        try await assertBar(f, shows: ["record"])
        XCTAssertTrue(f.panel.window.styleMask.contains(.nonactivatingPanel))
        XCTAssertEqual(f.panel.window.sharingType, .none)
        XCTAssertGreaterThan(f.panel.windowID, 0)
        XCTAssertTrue(f.model.excludeWindowIDs.contains(f.panel.windowID))
        try await snapshot(f, "setup")
    }

    func testCountdownKeepsTheFirstRowAndOffersCancel() async throws {
        let f = try fixture(countdown: 10)
        f.model.record()
        defer { f.model.discard() }
        try await assertBar(f, shows: ["countdown", "cancel"])
    }

    func testStartingKeepsTheFirstRowWithoutRecordingOrStop() async throws {
        let f = try fixture()
        await start(f)
        try await assertBar(f, shows: ["starting", "cancel"])
        XCTAssertNil(f.host.controls["recording.bar.stop"])
    }

    func testRecordingKeepsTheFirstRowAndOffersPauseAndStop() async throws {
        let f = try fixture()
        await firstFrame(f)
        try await assertBar(f, shows: ["clock", "pause", "stop"])
        try await snapshot(f, "recording")
    }

    func testPausedKeepsTheFirstRowAndOffersResumeAndStop() async throws {
        let f = try fixture()
        await firstFrame(f)
        f.model.pause()
        await f.model.pendingCommand?.value
        try await assertBar(f, shows: ["clock", "resume", "stop"])
        try await snapshot(f, "paused")
    }

    func testFinishingKeepsTheFirstRowAndShowsSaving() async throws {
        let f = try fixture()
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
        let f = try fixture()
        await firstFrame(f)
        f.model.stop()
        await f.model.pendingCommand?.value
        try await assertBar(f, shows: ["use", "finder", "newRecording"])
        XCTAssertEqual(f.host.controls["recording.bar.use"]?.label, "Open in editor")
        try await snapshot(f, "done")
    }

    func testFailedKeepsTheFirstRowAndShowsTheError() async throws {
        let f = try fixture()
        f.engine.failStart = true
        await start(f)
        XCTAssertEqual(f.model.phase, .failed("Capture unavailable"))
        try await assertBar(f, shows: ["failed", "newRecording"])
        XCTAssertEqual(f.host.controls["recording.bar.failed"]?.label, "Capture unavailable")
    }

    func testUnavailableCameraExposesTheEngineReasonAndIsDisabled() async throws {
        let f = try fixture()
        await firstFrame(f)
        try await assertBar(f, shows: ["clock", "pause", "stop"])
        let camera = try XCTUnwrap(f.host.controls["recording.bar.camera"])
        XCTAssertFalse(camera.isEnabled)
        XCTAssertEqual(camera.label, "Camera")
        let reason = try XCTUnwrap(f.model.capabilities.reasonUnavailable["camera"])
        XCTAssertEqual(reason, "The camera starts with the recording.")
        XCTAssertTrue(camera.hint.contains(reason), camera.hint)
    }

    func testExpandedSetupShowsEveryOptionAndExplainsADisabledOne() async throws {
        let f = try fixture(expanded: true)
        try await assertBar(f, shows: ["record"] + expandedControls)
        let threshold = try XCTUnwrap(f.host.controls["recording.bar.threshold"])
        XCTAssertFalse(threshold.isEnabled)
        XCTAssertEqual(threshold.label, "Change needed")
        XCTAssertTrue(threshold.hint.contains("active and still frame rates are the same"), threshold.hint)
        try await snapshot(f, "setup-expanded")
    }

    func testOptionsOpenTheDrawerWhileRecordingAndGrowTheSameWindow() async throws {
        let f = try fixture()
        await firstFrame(f)
        try await assertBar(f, shows: ["clock", "pause", "stop"])
        let height = f.panel.window.frame.height
        let growth = expectation(description: "The drawer fits inside the panel")
        let resize = NotificationCenter.default.publisher(for: NSWindow.didResizeNotification, object: f.panel.window)
            .first(where: { _ in f.panel.window.frame.height > height }).sink { _ in growth.fulfill() }
        defer { resize.cancel() }
        try await f.host.press("expand")
        await fulfillment(of: [growth], timeout: 3)
        XCTAssertTrue(f.model.expanded)
        try await assertBar(f, shows: ["clock", "pause", "stop"] + liveExpandedControls)
        XCTAssertNil(f.host.controls["recording.bar.quality"], "a choice for the next recording waits for its setup")
        try await snapshot(f, "recording-expanded")
        let collapsed = expectation(description: "Original panel height restored")
        let shrink = NotificationCenter.default.publisher(for: NSWindow.didResizeNotification, object: f.panel.window)
            .first(where: { _ in abs(f.panel.window.frame.height - height) < 1 }).sink { _ in collapsed.fulfill() }
        defer { shrink.cancel() }
        try await f.host.press("expand")
        await fulfillment(of: [collapsed], timeout: 3)
        XCTAssertFalse(f.model.expanded)
        try await assertBar(f, shows: ["clock", "pause", "stop"])
    }

    /// The owner saw the first row jump while "…" opened and closed the extra rows. Samples the first row's place on
    /// the screen through a real expand and collapse: it must hold still, and the window resizes once per change.
    func testExpansionKeepsTheFirstRowStillAndResizesTheWindowOncePerChange() async throws {
        let f = try fixture()
        await firstFrame(f)
        try await assertBar(f, shows: ["clock", "pause", "stop"])
        // Drawn (an alpha-0 window skips the animation) but still below the desktop, so never on screen.
        f.panel.window.alphaValue = 0.01
        let window = f.panel.window
        func firstRowTop() throws -> CGFloat {
            let frame = try XCTUnwrap(FrameProbe.frames["recording.bar.target"])
            return window.frame.maxY - frame.minY
        }
        var resizes = 0
        let counter = NotificationCenter.default.publisher(for: NSWindow.didResizeNotification, object: window)
            .sink { _ in resizes += 1 }
        defer { counter.cancel() }
        for expanding in [true, false] {
            let start = try firstRowTop()
            let height = window.frame.height
            resizes = 0
            var drift: CGFloat = 0
            try await f.host.press("expand")
            let deadline = ContinuousClock.now + .milliseconds(700)
            while ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(8))
                window.contentView?.layoutSubtreeIfNeeded()
                drift = max(drift, abs(try firstRowTop() - start))
            }
            XCTAssertEqual(f.model.expanded, expanding)
            XCTAssertLessThanOrEqual(drift, 1, "the first row moved \(drift) pt while the bar \(expanding ? "opened" : "closed")")
            XCTAssertEqual(resizes, 1, "one window resize per change, \(expanding ? "at the start" : "at the end")")
            if expanding { XCTAssertGreaterThan(window.frame.height, height + 40) } else { XCTAssertLessThan(window.frame.height, height - 40) }
        }
    }

    /// Pictures of the drawer's motion for review: the real panel at the points of the GenMotion curve a 60 Hz
    /// display shows (0, 17, 33, 67, 117 and 240 ms of the opening). Writes only with RECORDING_SNAPSHOT_DIR set.
    func testDrawerMotionFramesForReview() async throws {
        guard ProcessInfo.processInfo.environment["RECORDING_SNAPSHOT_DIR"] != nil else { return }
        let f = try fixture()
        await firstFrame(f)
        try await f.host.press("expand")
        try await f.host.wait(for: liveExpandedControls)
        try await Task.sleep(for: .milliseconds(400))
        for ms in [0, 17, 33, 67, 117, 240] {
            f.panel.motion.stillFraction = Self.curveProgress(Double(ms) / (GenMotion.expandDuration * 1000))
            try await Task.sleep(for: .milliseconds(150))
            try await snapshot(f, String(format: "motion-open-%03d", ms))
        }
        f.panel.motion.stillFraction = nil
    }

    /// The GenMotion curve's progress at a fraction of its time (the cubic Bézier solved for x).
    static func curveProgress(_ time: Double) -> CGFloat {
        let (x1, y1, x2, y2) = (Double(GenMotion.curve.0), Double(GenMotion.curve.1), Double(GenMotion.curve.2),
                                Double(GenMotion.curve.3))
        func bezier(_ s: Double, _ a: Double, _ b: Double) -> Double {
            3 * a * s * (1 - s) * (1 - s) + 3 * b * s * s * (1 - s) + s * s * s
        }
        var low = 0.0
        var high = 1.0
        for _ in 0..<40 {
            let mid = (low + high) / 2
            if bezier(mid, x1, x2) < time { low = mid } else { high = mid }
        }
        return CGFloat(bezier((low + high) / 2, y1, y2))
    }

    func testSpaceInRecordingPausesTheEngineOnce() async throws {
        let f = try fixture()
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
