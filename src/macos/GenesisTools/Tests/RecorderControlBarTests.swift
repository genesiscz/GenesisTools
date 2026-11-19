import AppKit
import Combine
import GenesisKit
import ImageIO
import SwiftUI
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

    private final class Recorder {
        let entry = LiveRecording(id: "owned-live", kind: "control-session", title: "Example", pid: 123,
                                  startedAt: Date(), state: "recording", folder: "/example/recording",
                                  controls: ["pause", "resume", "stop", "audio.mute", "audio.setInput", "settings.set",
                                             "target.switch", "marker.add"], socket: "/example/owned.sock")
        var starts: [[String]] = []
        var cameras: [CameraSetup] = []
        var calls: [(id: String, method: String, params: [String: Any])] = []
        var publish: (@MainActor ([String]) -> Void)?
        var frameOnStart = false

        @MainActor
        func engine() -> ToolsRecorderEngine {
            let engine = ToolsRecorderEngine(prepare: { camera in
                self.cameras.append(camera)
                return (camera.enabled ? [91] : [], {})
            }, launch: { args, lines, _ in
                self.starts.append(args)
                self.publish = lines
                lines([#"{"event":"started","id":"library-folder","liveId":"owned-live"}"#])
                if self.frameOnStart { lines([#"{"event":"state","state":"recording","elapsedMs":0}"#]) }
                return nil
            }, rpc: { entry, method, params in
                self.calls.append((entry.id, method, params))
                return nil
            }, locate: { [entry] id in entry.id == id ? entry : nil })
            engine.threshold = 0.5
            engine.shortcuts = true
            return engine
        }
    }

    private func host(_ recorder: Recorder, defaults: UserDefaults) -> CapturePicker {
        CapturePicker(engine: recorder.engine(), defaults: defaults, preview: { _ in }, listTargets: {
            RecordingTargets(windows: [], apps: [], displays: [])
        })
    }

    func testPickerShortcutOpensSetupAndAttachesPickerWithoutStarting() throws {
        _ = NSApplication.shared
        let suite = "recorder.test.shortcut.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let recorder = Recorder(), saved = CapturePicker.shared
        let host = host(recorder, defaults: defaults)
        CapturePicker.shared = host
        defer { host.dismiss(); CapturePicker.shared = saved }

        XCTAssertEqual(RecorderShortcutAction.picker.defaultChord.label, HotkeyChord(keyCode: 26, modifiers: HotkeyChord.command).label)
        RecorderShortcutActions.perform(.picker)
        let bar = try XCTUnwrap(host.bar)
        let controls = try XCTUnwrap(host.controls)
        XCTAssertEqual(bar.phase, .setup)
        XCTAssertTrue(controls.window.isVisible)
        let picker = try XCTUnwrap(controls.window.childWindows?.first { $0.identifier?.rawValue == "recording.picker" })
        XCTAssertTrue(picker.isVisible)
        XCTAssertTrue(bar.excludeWindowIDs.contains(picker.windowNumber))
        XCTAssertTrue(bar.excludeWindowIDs.contains(controls.windowID))
        XCTAssertTrue(recorder.starts.isEmpty)
    }

    func testReopeningTheSetupPickerKeepsTheEngineEventConsumer() throws {
        let suite = "recorder.test.reopen.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let host = host(Recorder(), defaults: defaults)
        defer { host.dismiss() }
        host.show(focus: false)
        let bar = try XCTUnwrap(host.bar)
        bar.setup.target = .display(index: 0, name: nil)
        host.dismiss()
        host.show(focus: false)
        XCTAssertTrue(host.bar === bar)
        XCTAssertEqual(bar.setup.target, .followDisplay, "the reopened draft starts over on the unsaved default target")
    }

    func testRecordStartsOnceWithThisDraftAndTheBarPickerOverlayAndCameraExclusions() async throws {
        let suite = "recorder.test.start.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let recorder = Recorder()
        recorder.frameOnStart = true
        let host = host(recorder, defaults: defaults)
        defer { host.dismiss() }
        host.show(focus: false)
        let bar = try XCTUnwrap(host.bar)
        let camera = CameraSetup(enabled: true, size: 260, shape: "square")
        bar.setup = RecordingSetup(target: .display(index: 0, name: "Example display"),
                                   microphone: .init(enabled: true, deviceID: "input-b"),
                                   systemAudio: .init(enabled: true), camera: camera, frameRate: 24,
                                   stillFrameRate: 2, countdownSeconds: nil, drawsCursor: false)
        let expected = Set(bar.excludeWindowIDs + [91]).filter { $0 > 0 }.sorted().map(String.init).joined(separator: ",")
        XCTAssertGreaterThanOrEqual(Set(bar.excludeWindowIDs).count, 2 + 2 * NSScreen.screens.count)
        let recording = expectation(description: "the recorder emitted this take's first frame")
        let phase = bar.$phase.sink { if case .recording = $0 { recording.fulfill() } }
        bar.record()
        bar.record()
        await fulfillment(of: [recording], timeout: 3)
        withExtendedLifetime(phase) {}
        XCTAssertEqual(recorder.starts, [[
            "recorder", "start", "--display", "0", "--fps", "24", "--idle-fps", "2",
            "--audio", "system,mic", "--system-cursor", "--camera", "--exclude-window-ids", expected,
            "--mic-device", "input-b", "--no-controls", "--json",
        ]])
        XCTAssertEqual(recorder.cameras, [camera])
    }

    func testLiveAudioUsesTheStartedRecordingsSocketAndTheRequestedSource() async throws {
        let recorder = Recorder(), setup = RecordingSetup(microphone: .init(enabled: true), systemAudio: .init(enabled: true))
        let engine = recorder.engine()
        try await engine.start(setup, excludeWindowIDs: [])
        engine.observe(LiveRecording(id: "someone-else", kind: "library", title: "Other", pid: 234, startedAt: Date(), state: "recording"))
        try await engine.apply(.microphone(.init(enabled: true, muted: true, deviceID: "input-a")))
        try await engine.apply(.systemAudio(.init(enabled: true, muted: true)))
        try await engine.apply(.systemAudio(.init(enabled: true)))
        try await engine.addMarker()
        XCTAssertEqual(recorder.calls.map(\.id), Array(repeating: "owned-live", count: 5))
        XCTAssertEqual(recorder.calls.map(\.method), ["audio.setInput", "audio.mute", "audio.mute", "audio.mute", "marker.add"])
        XCTAssertEqual(recorder.calls.first?.params["deviceId"] as? String, "input-a")
        XCTAssertEqual(recorder.calls.compactMap { $0.params["source"] as? String }, ["mic", "system", "system"])
        XCTAssertEqual(recorder.calls.compactMap { $0.params["muted"] as? Bool }, [true, true, false])
    }

    func testLiveFrameRateSendsTheRecorderSettingsPatch() async throws {
        let recorder = Recorder(), engine = recorder.engine()
        try await engine.start(RecordingSetup(), excludeWindowIDs: [])
        try await engine.apply(.frameRate(30, still: 0.5))
        let message = try XCTUnwrap(recorder.calls.first)
        XCTAssertEqual(message.id, "owned-live")
        XCTAssertEqual(message.method, "settings.set")
        XCTAssertEqual(message.params["activeFps"] as? Int, 30)
        XCTAssertEqual(message.params["idleFps"] as? Double, 0.5)
    }

    func testForeignBarRegistersAtStartupAndAttachesWithoutStartingAnotherTake() async throws {
        _ = RecorderMenu.shared
        XCTAssertNotNil(LiveRecordingBarPresentation.resolve)
        let foreign = LiveRecording(id: "foreign-live", kind: "control-session", title: "Other", pid: 234,
                                    startedAt: Date(), state: "paused", frames: 1, controls: ["settings.get", "resume"])
        var calls: [String] = []
        let engine = ToolsRecorderEngine(adopting: foreign, prepare: { _ in
            XCTFail("An existing take must not prepare capture")
            return ([], {})
        }, launch: { _, _, _ in XCTFail("An existing take must not launch another process"); return nil }, rpc: { entry, method, _ in
            XCTAssertEqual(entry.id, foreign.id)
            calls.append(method)
            return ["settings": ["activeFps": 30, "idleFps": 2], "audio": ["sources": ["system"], "muted": ["system": true]]]
        })
        let setup = try await engine.adoptedSetup()
        XCTAssertEqual(setup.frameRate, 30)
        XCTAssertEqual(setup.systemAudio, .init(enabled: true, muted: true))
        let bar = RecordingBarModel(engine: engine, setup: setup)
        let paused = expectation(description: "the existing take remains paused")
        let phases = bar.$phase.sink { phase in if case .paused(_, true) = phase { paused.fulfill() } }
        bar.record()
        await fulfillment(of: [paused], timeout: 3)
        withExtendedLifetime(phases) {}
        XCTAssertEqual(calls, ["settings.get"])
    }

    func testStartTimesOutAndDoesNotInstallAnEntryAfterExitDuringLookup() async throws {
        let noAck = ToolsRecorderEngine(prepare: { _ in ([], {}) }, launch: { _, _, _ in nil },
                                        startupTimeout: .milliseconds(20))
        do {
            try await noAck.start(.init(), excludeWindowIDs: [])
            XCTFail("A launched recorder must acknowledge startup")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("in time"))
            XCTAssertNil(noAck.entry)
        }

        let fixture = Recorder()
        var exited: (@MainActor (Int32, String) -> Void)?
        let lookup = ToolsRecorderEngine(prepare: { _ in ([], {}) }, launch: { _, lines, exit in
            exited = exit
            lines([#"{"event":"started","liveId":"owned-live"}"#])
            return nil
        }, locate: { _ in
            exited?(1, "Recorder stopped")
            return fixture.entry
        })
        do {
            try await lookup.start(.init(), excludeWindowIDs: [])
            XCTFail("A terminated take cannot install a live entry")
        } catch {
            XCTAssertNil(lookup.entry)
            XCTAssertNil(lookup.liveID)
        }
    }

    func testForeignControlSessionUsesMeasuredProgressAndValidatesStop() async throws {
        var live = Recorder().entry
        live.recordedMs = 300
        live.recordedRunning = true
        let engine = ToolsRecorderEngine(adopting: live, rpc: { _, _, _ in
            ["state": "stopped", "outcome": "failed"]
        })
        let bar = RecordingBarModel(engine: engine, setup: .init(countdownSeconds: nil))
        let take = engine.nextTakeID
        let recording = expectation(description: "the existing take already has a frame")
        let phases = bar.$phase.first(where: { $0 == .recording(take: take) }).sink { _ in recording.fulfill() }
        bar.record()
        await fulfillment(of: [recording], timeout: 1)
        withExtendedLifetime(phases) {}
        XCTAssertFalse(engine.capabilities.liveRestart)
        do {
            _ = try await engine.stop()
            XCTFail("A stopped take with failed outcome is not saved")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("saved recording"))
        }
    }

    func testOwnedRestartWaitsForTheNewFrameAfterTheStdoutBoundary() async throws {
        let live = LiveRecording(id: "owned", kind: "library", title: "Example", pid: 123,
                                 startedAt: Date(), state: "recording", frames: 1, lastFrameAt: Date(),
                                 controls: ["restart"])
        var publish: (@MainActor ([String]) -> Void)?
        let engine = ToolsRecorderEngine(prepare: { _ in ([], {}) }, launch: { _, lines, _ in
            publish = lines
            lines([#"{"event":"started","liveId":"owned"}"#, #"{"event":"state","state":"recording","elapsedMs":1}"#])
            return nil
        }, rpc: { _, _, _ in nil }, locate: { _ in live })
        try await engine.start(.init(), excludeWindowIDs: [])
        let replacement = engine.nextTakeID
        try await engine.restart()
        engine.observe(live)
        publish?([#"{"event":"state","state":"starting","elapsedMs":0}"#])
        engine.observe(live)
        publish?([#"{"event":"state","state":"recording","elapsedMs":1}"#,
                  #"{"event":"result","outcome":"discarded"}"#])

        var observed: [RecordingEngineEvent.Value] = []
        let finished = expectation(description: "replacement events through discard")
        let reader = Task {
            for await event in engine.events where event.take == replacement {
                observed.append(event.value)
                if event.value == .discarded {
                    finished.fulfill()
                    return
                }
            }
        }
        await fulfillment(of: [finished], timeout: 1)
        reader.cancel()
        XCTAssertEqual(observed, [.elapsed(milliseconds: 0), .firstFrame, .elapsed(milliseconds: 1), .discarded])
    }

    func testSwitchReconcilesTheNewTargetIfTheSecondPauseFails() async throws {
        let engine = ToolsRecorderEngine(adopting: Recorder().entry, rpc: { _, method, _ in
            if method == "pause" { throw RecordingEngineError.unsupported("Could not pause") }
            if method == "status" { return ["state": "recording"] }
            return nil
        })
        var live = Recorder().entry
        live.state = "paused"
        engine.observe(live)
        let target = RecordingTarget.display(index: 0, name: nil)
        do {
            try await engine.apply(.target(target))
            XCTFail("The second pause did not succeed")
        } catch {
            guard case let .partialTargetSwitch(actual, _) = error as? RecordingEngineError else {
                return XCTFail("Expected the new recording target despite the pause failure")
            }
            XCTAssertEqual(actual, target)
        }
    }

    func testSetupRetainsLegacyMovieRatesAndScopesFrameQuality() throws {
        let suite = "recorder.test.rates.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let setup = RecordingSetup(frameRate: 10, stillFrameRate: 10)
        setup.save(defaults)
        let options = CaptureOptions.load(defaults)
        XCTAssertEqual(options.fps, 10)
        XCTAssertEqual(options.idleFps, 10)
        RecordingSetup(target: .displays(indices: [0, 1]), quality: .max).save(defaults)
        XCTAssertEqual(RecordingSetup.load(defaults).quality, .standard)
        let frames = RecordingSetup(target: .displays(indices: [0, 1]), frameRate: 60, stillFrameRate: 0)
        let args = try CaptureOptions.barArguments(frames, threshold: 0.5, shortcuts: true, excluding: [],
                                                  screens: [], displayIDs: [1, 2])
        let still = try XCTUnwrap(args.firstIndex(of: "--idle-fps"))
        XCTAssertEqual(args[still + 1], "0.5")
    }

    func testLiveCameraHasItsDisabledReasonAndSendsNoCommand() async throws {
        let recorder = Recorder(), engine = recorder.engine()
        try await engine.start(RecordingSetup(), excludeWindowIDs: [])
        XCTAssertFalse(engine.capabilities.liveCamera)
        do {
            try await engine.apply(.camera(.init(enabled: true)))
            XCTFail("The camera starts with the take")
        } catch {
            XCTAssertEqual(error.localizedDescription, "The camera starts with the recording")
        }
        XCTAssertTrue(recorder.calls.isEmpty)
    }

    func testCameraAppearanceLastsOneTakeAndLeavesSavedSizeAndShapeIntact() throws {
        let suite = "recorder.test.camera.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(140, forKey: CameraBubble.Key.size)
        defaults.set("circle", forKey: CameraBubble.Key.shape)
        var updates = 0
        let restore = ToolsRecorderEngine.useCameraAppearance(.init(enabled: true, size: 260, shape: "square"),
                                                             defaults: defaults) { updates += 1 }
        XCTAssertEqual(defaults.integer(forKey: CameraBubble.Key.size), 260)
        XCTAssertEqual(defaults.string(forKey: CameraBubble.Key.shape), "square")
        XCTAssertEqual(defaults.persistentDomain(forName: suite)?[CameraBubble.Key.size] as? Int, 140)
        restore()
        XCTAssertEqual(defaults.integer(forKey: CameraBubble.Key.size), 140)
        XCTAssertEqual(defaults.string(forKey: CameraBubble.Key.shape), "circle")
        XCTAssertEqual(updates, 2)
    }

    func testSetupOpensWithSavedCaptureOptionsAndKeepsEditsInTheDraft() throws {
        let suite = "recorder.test.defaults.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var old = CaptureOptions()
        old.fps = 24
        old.idleFps = 0.5
        old.microphone = true
        old.camera = true
        old.drawCursor = false
        old.countdownSeconds = 7
        old.save(defaults)
        defaults.set(260, forKey: CameraBubble.Key.size)
        defaults.set("rounded", forKey: CameraBubble.Key.shape)
        let reopened = try XCTUnwrap(UserDefaults(suiteName: suite))
        let host = host(Recorder(), defaults: reopened)
        host.show(focus: false)
        let bar = try XCTUnwrap(host.bar)
        let original = bar.setup
        let saved = RecordingSetup(microphone: .init(enabled: true), camera: .init(enabled: true, size: 260, shape: "rounded"),
                                   frameRate: 24, stillFrameRate: 0.5, countdownSeconds: 7, drawsCursor: false)
        // With no saved target this recorder records the display in use; the draft names it, the saved setup does not.
        var opened = saved
        opened.target = .followDisplay
        XCTAssertEqual(original, opened)
        bar.apply(.camera(.init(enabled: false)))
        host.dismiss()
        XCTAssertEqual(RecordingSetup.load(reopened), saved)
    }

    func testAreasUseTheSelectedDisplaysOriginAndFramesUseDisplayIDs() throws {
        let screens = [CGRect(x: 0, y: 0, width: 800, height: 600), CGRect(x: -700, y: -100, width: 700, height: 500)]
        let area = CaptureChoice.target(.area(rect: CGRect(x: 10, y: 20, width: 30, height: 40), display: 1))
        XCTAssertEqual(try area.resolvedArguments(screens: screens, displayIDs: [55, 88]), ["--region", "-690,640,30,40"])
        let setup = RecordingSetup(target: .displays(indices: [1, 0]))
        let arguments = try CaptureOptions.barArguments(setup, threshold: 0.5, shortcuts: true, excluding: [72],
                                                       screens: screens, displayIDs: [55, 88])
        XCTAssertEqual(arguments, ["recorder", "start", "--frames", "--displays", "88,55", "--fps", "60",
                                   "--idle-fps", "0.5", "--exclude-window-ids", "72", "--json"])
        XCTAssertThrowsError(try CaptureOptions.barArguments(setup, threshold: 0.5, shortcuts: true, excluding: [72],
                                                            screens: screens, displayIDs: [55, nil]))
    }
}
