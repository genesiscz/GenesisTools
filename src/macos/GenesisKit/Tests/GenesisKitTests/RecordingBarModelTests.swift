import Combine
import XCTest
@testable import GenesisKit

@MainActor
final class RecordingBarModelTests: XCTestCase {
    private let display = RecordingTarget.display(index: 1, name: "Studio")

    func testSetupEditsStayInTheDraftAndCancelRestoresTheOpeningSetup() async {
        let engine = Engine()
        let original = RecordingSetup(target: display)
        let model = RecordingBarModel(engine: engine, setup: original)
        let microphone = MicrophoneSetup(enabled: true, muted: false, deviceID: "desk")
        model.apply(.microphone(microphone))
        await model.pendingCommand?.value
        XCTAssertEqual(model.setup.microphone, microphone)
        model.cancelSetup()
        XCTAssertEqual(model.setup, original)
        XCTAssertEqual(model.phase, .setup)
        XCTAssertEqual(engine.calls, [])
    }

    func testOnlyExplicitSaveWritesTheExistingCapturePreferences() throws {
        let suite = "recording.bar.fixture.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(30, forKey: "recorder.capture.fps")
        defaults.set(true, forKey: "recorder.capture.audio.mic")
        let model = RecordingBarModel(engine: Engine(), setup: RecordingSetup.load(defaults), defaults: defaults,
                                      countdownTick: {})
        XCTAssertEqual(model.setup.frameRate, 30)
        XCTAssertTrue(model.setup.microphone.enabled)
        model.apply(.frameRate(24, still: 2))
        XCTAssertEqual(defaults.integer(forKey: "recorder.capture.fps"), 30)
        model.cancelSetup()
        XCTAssertEqual(model.setup.frameRate, 30)
        model.apply(.frameRate(60, still: 1))
        model.apply(.target(display))
        model.saveAsDefaults()

        let reopened = try XCTUnwrap(UserDefaults(suiteName: suite))
        XCTAssertEqual(reopened.integer(forKey: "recorder.capture.fps"), 60)
        XCTAssertEqual(reopened.double(forKey: "recorder.capture.idleFps"), 1)
        let saved = RecordingSetup.load(reopened)
        XCTAssertEqual(saved.frameRate, 60)
        XCTAssertEqual(saved.stillFrameRate, 1)
        XCTAssertTrue(saved.microphone.enabled)
        XCTAssertNil(saved.target)
    }

    func testCountdownStartsOnceWithTheDraftAndLatestExcludedWindows() async {
        let engine = Engine()
        let draft = RecordingSetup(target: display, frameRate: 24, countdownSeconds: 2)
        let model = RecordingBarModel(engine: engine, setup: draft, countdownTick: {})
        var phases: [RecordingBarPhase] = []
        let observation = model.$phase.sink { phases.append($0) }
        defer { observation.cancel() }
        model.record()
        XCTAssertEqual(model.phase, .countdown(2))
        model.record()
        model.excludeWindowIDs = [31, 47]
        await model.pendingCommand?.value
        XCTAssertEqual(engine.calls, [.start(draft, [31, 47])])
        XCTAssertEqual(phases, [.setup, .countdown(2), .countdown(1), .starting(take: "take-1")])
        await firstFrame(model, engine)
    }

    func testCancelledCountdownCannotStartALaterTake() async {
        let engine = Engine()
        let model = RecordingBarModel(engine: engine, setup: RecordingSetup(target: display, countdownSeconds: 1),
                                      countdownTick: {})
        model.record()
        model.discard()
        XCTAssertEqual(model.phase, .setup)
        model.record()
        await model.pendingCommand?.value
        XCTAssertEqual(engine.calls, [.start(model.setup, [])])
        XCTAssertEqual(model.phase, .starting(take: "take-1"))
    }

    func testLiveFrameRateKeepsOnlyWhatTheEngineAccepted() async {
        let (model, engine) = await recording()
        model.apply(.frameRate(24, still: 1))
        await model.pendingCommand?.value
        XCTAssertEqual(model.setup.frameRate, 24)
        XCTAssertEqual(model.setup.stillFrameRate, 1)
        XCTAssertEqual(engine.calls.suffix(1), [.apply(.frameRate(24, still: 1))])

        engine.rejection = .unsupported("This source requires 24 fps.")
        model.apply(.frameRate(60, still: 2))
        await model.pendingCommand?.value
        XCTAssertEqual(model.setup.frameRate, 24)
        XCTAssertEqual(model.setup.stillFrameRate, 1)
        XCTAssertEqual(model.notice?.message, "This source requires 24 fps.")
        XCTAssertEqual(model.notice?.controlID, "frameRate")
        XCTAssertEqual(engine.calls.count, 3)
    }

    func testWindowAudioReasonPreservesTheChoiceAndBlocksALiveCall() async {
        let source = MicrophoneSetup(enabled: true, muted: false, deviceID: "desk")
        let (model, engine) = await recording(target: .window(ids: [7], app: nil, title: nil, pid: nil), mic: source)
        XCTAssertFalse(model.capabilities.liveMicrophoneMute)
        XCTAssertFalse(model.capabilities.liveSystemAudioMute)
        model.apply(.microphone(MicrophoneSetup(enabled: true, muted: true, deviceID: "desk")))
        await model.pendingCommand?.value
        XCTAssertEqual(model.setup.microphone, source)
        XCTAssertEqual(model.notice?.message, model.capabilities.reasonUnavailable["microphone"])
        XCTAssertNotNil(model.notice?.message)
        XCTAssertEqual(engine.calls.count, 1)
    }

    func testDiscardFromManualPauseKeepsTheSetupForAnotherTake() async {
        let (model, engine) = await recording()
        let initial = model.setup
        model.apply(.frameRate(24, still: 1))
        await model.pendingCommand?.value
        let draft = model.setup
        model.pause()
        await model.pendingCommand?.value
        XCTAssertEqual(model.phase, .paused(take: "take-1", byUser: true))
        model.discard()
        await model.pendingCommand?.value
        XCTAssertEqual(model.phase, .setup)
        XCTAssertEqual(model.setup, draft)
        model.record()
        await model.pendingCommand?.value
        XCTAssertEqual(engine.calls, [.start(initial, []), .apply(.frameRate(24, still: 1)), .pause, .discard, .start(draft, [])])
    }

    func testPickerWaitsForPauseAndDoesNotPresentOnRefusal() async {
        let (model, engine) = await recording()
        engine.pauseRejection = .unsupported("Could not pause")
        model.beginTargetSelection { XCTFail("Picker must wait for an acknowledged pause") }
        await model.pendingCommand?.value
        XCTAssertEqual(model.phase, .recording(take: "take-1"))
        XCTAssertEqual(model.notice?.message, "Could not pause")
        model.endTargetSelection(.display(index: 1, name: "Second"))
        await model.pendingCommand?.value
        XCTAssertEqual(model.notice?.controlID, "target")
    }

    func testRejectedTargetResumesThePickerPauseAndKeepsItsWarning() async {
        let (model, engine) = await recording()
        let original = model.setup.target
        model.beginTargetSelection()
        await model.pendingCommand?.value
        engine.rejection = .unsupported("Window closed")
        model.endTargetSelection(.display(index: 1, name: "Second"))
        await model.pendingCommand?.value
        XCTAssertEqual(model.phase, .recording(take: "take-1"))
        XCTAssertEqual(model.setup.target, original)
        XCTAssertEqual(model.notice?.message, "Window closed")
        XCTAssertEqual(engine.calls.last, .resume)
    }

    func testQueuedRatesMergeAgainstTheLastAcknowledgedSetup() async {
        let (model, engine) = await recording()
        model.changeFrameRate(active: 24)
        model.changeFrameRate(still: 2)
        await model.pendingCommand?.value
        XCTAssertEqual(Array(engine.calls.suffix(2)), [.apply(.frameRate(24, still: 0)), .apply(.frameRate(24, still: 2))])
        XCTAssertEqual(model.setup.frameRate, 24)
    }

    func testQueuedRestartReservesStopBeforeTheQueueRuns() async {
        let (model, engine) = await recording()
        model.changeFrameRate(active: 24)
        model.restart()
        XCTAssertTrue(model.isRestartPending)
        model.stop()
        await model.pendingCommand?.value
        XCTAssertFalse(model.isRestartPending)
        XCTAssertFalse(engine.calls.contains(.stop))
        XCTAssertEqual(model.phase, .starting(take: "take-2"))
    }

    func testClosingThePickerResumesOnlyItsOwnPause() async {
        let (model, engine) = await recording()
        model.pause()
        model.beginTargetSelection()
        model.endTargetSelection(.display(index: 0, name: nil))
        await model.pendingCommand?.value
        XCTAssertEqual(model.phase, .paused(take: "take-1", byUser: true))
        XCTAssertEqual(engine.calls.suffix(2), [.pause, .apply(.target(.display(index: 0, name: nil)))])
        model.beginTargetSelection()
        model.endTargetSelection(nil)
        await model.pendingCommand?.value
        XCTAssertEqual(model.phase, .paused(take: "take-1", byUser: true))

        model.resume()
        model.beginTargetSelection()
        await model.pendingCommand?.value
        XCTAssertEqual(model.phase, .paused(take: "take-1", byUser: false))
        model.endTargetSelection(nil)
        await model.pendingCommand?.value
        XCTAssertEqual(model.phase, .recording(take: "take-1"))
        XCTAssertEqual(engine.calls.suffix(3), [.resume, .pause, .resume])
    }

    func testRestartIgnoresThePreviousTakesFirstFrameAndStop() async {
        let (model, engine) = await recording()
        model.restart()
        await model.pendingCommand?.value
        XCTAssertEqual(model.phase, .starting(take: "take-2"))
        let delivered = expectation(description: "delivered events preceding the current take's elapsed time")
        let observation = model.$elapsedMs.first(where: { $0 == 8 }).sink { _ in delivered.fulfill() }
        defer { observation.cancel() }
        engine.emit(.firstFrame, take: "take-1")
        engine.emit(.stopped(nil), take: "take-1")
        engine.emit(.elapsed(milliseconds: 8), take: "take-2")
        await fulfillment(of: [delivered], timeout: 2)
        XCTAssertEqual(model.phase, .starting(take: "take-2"))
        await firstFrame(model, engine, take: "take-2")
        XCTAssertEqual(model.phase, .recording(take: "take-2"))
    }

    func testFailedStopKeepsThePausedTakeAndRetryFinishesIt() async {
        let (model, engine) = await recording()
        model.pause()
        await model.pendingCommand?.value
        engine.rejection = .unsupported("The recorder did not acknowledge Stop.")
        model.stop()
        await model.pendingCommand?.value
        XCTAssertEqual(model.phase, .paused(take: "take-1", byUser: true))
        XCTAssertEqual(model.notice?.take, "take-1")
        XCTAssertEqual(model.notice?.actions, [.retryStop, .showControls])
        engine.rejection = nil
        model.retryStop(take: "other-take")
        await model.pendingCommand?.value
        XCTAssertEqual(model.phase, .paused(take: "take-1", byUser: true))
        model.retryStop(take: "take-1")
        await model.pendingCommand?.value
        XCTAssertEqual(model.phase, .done(engine.movie))
        XCTAssertNil(model.notice)
        XCTAssertEqual(engine.calls.suffix(2), [.stop, .stop])
    }

    func testLegacyTargetJSONAndNewTargetWireFormats() throws {
        let fixtures: [(String, RecordingTarget)] = [
            (#"{"kind":"window","windowIds":[7,8],"app":"Editor","title":"Draft","pid":42}"#,
             .window(ids: [7, 8], app: "Editor", title: "Draft", pid: 42)),
            (#"{"kind":"app","app":"42","name":"Editor"}"#, .app(app: "42", name: "Editor")),
            (#"{"kind":"display","screenIndex":1,"name":"Studio"}"#, display),
            (#"{"kind":"area","screenIndex":1,"rect":{"x":-20.5,"y":30,"width":120,"height":90}}"#,
             .area(rect: CGRect(x: -20.5, y: 30, width: 120, height: 90), display: 1)),
            (#"{"kind":"displays","indices":[2,0]}"#, .displays(indices: [2, 0])),
        ]
        for (json, target) in fixtures {
            let data = Data(json.utf8)
            XCTAssertEqual(try JSONDecoder().decode(RecordingTarget.self, from: data), target)
            let expected = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
            for bytes in [try JSONEncoder().encode(target), Data(target.json.utf8)] {
                XCTAssertEqual(try JSONSerialization.jsonObject(with: bytes) as? NSDictionary, expected)
            }
            let setup = RecordingSetup(target: target)
            XCTAssertEqual(try JSONDecoder().decode(RecordingSetup.self, from: JSONEncoder().encode(setup)), setup)
        }
    }

    private func recording(target: RecordingTarget? = nil, mic: MicrophoneSetup = .init()) async -> (RecordingBarModel, Engine) {
        let engine = Engine()
        let setup = RecordingSetup(target: target ?? display, microphone: mic, countdownSeconds: nil)
        let defaults = UserDefaults(suiteName: "recording.bar.fixture.\(UUID().uuidString)")!
        let model = RecordingBarModel(engine: engine, setup: setup, defaults: defaults, countdownTick: {})
        model.record()
        await model.pendingCommand?.value
        await firstFrame(model, engine)
        return (model, engine)
    }

    private func firstFrame(_ model: RecordingBarModel, _ engine: Engine, take: String = "take-1") async {
        let ready = expectation(description: "first frame of \(take)")
        let observation = model.$phase.first(where: { $0 == .recording(take: take) }).sink { _ in ready.fulfill() }
        defer { observation.cancel() }
        engine.emit(.firstFrame, take: take)
        await fulfillment(of: [ready], timeout: 2)
    }

    @MainActor
    private final class Engine: RecordingEngineAdapter {
        enum Call: Equatable {
            case start(RecordingSetup, [Int]), pause, resume, restart, discard, stop, apply(RecordingSetupChange)
        }

        let capabilities = RecordingCapabilities(targets: Set(RecordingTargetKind.allCases), liveTargetSwitch: true,
                                                  liveMicrophoneMute: true, liveMicrophoneDevice: true,
                                                  liveSystemAudioMute: true, liveFrameRate: true)
        let movie = URL(fileURLWithPath: "/fixture/take.mp4")
        private let stream = AsyncStream<RecordingEngineEvent>.makeStream()
        var events: AsyncStream<RecordingEngineEvent> { stream.stream }
        private var sequence = 1
        var nextTakeID: String { "take-\(sequence)" }
        var calls: [Call] = []
        var rejection: RecordingEngineError?
        var pauseRejection: RecordingEngineError?

        func emit(_ value: RecordingEngineEvent.Value, take: String) {
            stream.continuation.yield(RecordingEngineEvent(take: take, value: value))
        }

        func start(_ setup: RecordingSetup, excludeWindowIDs: [Int]) async throws {
            calls.append(.start(setup, excludeWindowIDs))
            sequence += 1
        }

        func apply(_ change: RecordingSetupChange) async throws {
            calls.append(.apply(change))
            if let rejection { throw rejection }
        }

        func pause() async throws {
            calls.append(.pause)
            if let pauseRejection { throw pauseRejection }
        }
        func resume() async throws { calls.append(.resume) }
        func restart() async throws {
            calls.append(.restart)
            sequence += 1
        }
        func discard() async throws { calls.append(.discard) }
        func stop() async throws -> URL? {
            calls.append(.stop)
            if let rejection { throw rejection }
            return movie
        }
        func audioDevices() async throws -> (inputs: [RecordingAudioDevice], outputs: [RecordingAudioDevice]) { ([], []) }
    }
}
