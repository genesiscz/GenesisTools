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
        func start(_ setup: RecordingSetup, excludeWindowIDs: [Int]) async throws {
            if failStart { throw RecordingEngineError.unsupported("Capture unavailable") }
        }
        func pause() async throws { pauses += 1 }
        func resume() async throws {}
        func stop() async throws -> URL? { URL(fileURLWithPath: "/fixture/Movie.mp4") }
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
        let model = RecordingBarModel(engine: engine, setup: setup)
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

    // Walk the real, in-process AppKit accessibility children. SwiftUI nodes can be private Objective-C classes.
    // KVC calls their actual getters, including the same AXHelp and AXEnabled that a client reads off-process.
    private func nodes(_ panel: RecordingBarPanel) -> [String: NSObject] {
        panel.window.contentView?.layoutSubtreeIfNeeded()
        panel.window.displayIfNeeded()
        var result: [String: NSObject] = [:]
        var seen = Set<ObjectIdentifier>()
        func walk(_ node: NSObject) {
            guard seen.insert(ObjectIdentifier(node)).inserted else { return }
            if node.responds(to: NSSelectorFromString("accessibilityIdentifier")),
               let id = node.value(forKey: "accessibilityIdentifier") as? String {
                result[id] = node
            }
            guard node.responds(to: NSSelectorFromString("accessibilityChildren")),
                  let children = node.value(forKey: "accessibilityChildren") as? [NSObject] else { return }
            children.forEach(walk)
        }
        walk(panel.window)
        return result
    }

    private func assertBar(_ f: Fixture, shows phaseIDs: [String], file: StaticString = #filePath, line: UInt = #line) {
        let tree = nodes(f.panel)
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

    func testSetupKeepsTheFirstRowAndOffersRecord() {
        let f = fixture()
        assertBar(f, shows: ["record"])
        XCTAssertTrue(f.panel.window.styleMask.contains(.nonactivatingPanel))
        XCTAssertEqual(f.panel.window.sharingType, .none)
        XCTAssertGreaterThan(f.panel.windowID, 0)
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

    func testRecordingKeepsTheFirstRowAndOffersPauseAndStop() async {
        let f = fixture()
        await firstFrame(f)
        assertBar(f, shows: ["clock", "pause", "stop"])
    }

    func testPausedKeepsTheFirstRowAndOffersResumeAndStop() async {
        let f = fixture()
        await firstFrame(f)
        f.model.pause()
        await f.model.pendingCommand?.value
        assertBar(f, shows: ["clock", "resume", "stop"])
    }

    func testFinishingKeepsTheFirstRowAndShowsSaving() async {
        let f = fixture()
        await firstFrame(f)
        f.model.stop()
        assertBar(f, shows: ["finishing"])
        await f.model.pendingCommand?.value
    }

    func testDoneKeepsTheFirstRowAndOffersTheMovieAndAnotherTake() async {
        let f = fixture()
        await firstFrame(f)
        f.model.stop()
        await f.model.pendingCommand?.value
        assertBar(f, shows: ["use", "finder", "newRecording"])
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
        XCTAssertEqual(camera.value(forKey: "accessibilityEnabled") as? Bool, false)
        XCTAssertTrue((camera.value(forKey: "accessibilityHelp") as? String)?.contains("The camera starts with the recording.") == true)
    }

    func testExpansionButtonChangesTheModelAndGrowsTheSameWindow() async throws {
        let f = fixture()
        let height = f.panel.window.frame.height
        let button = try XCTUnwrap(nodes(f.panel)["recording.bar.expand"])
        XCTAssertEqual((button as AnyObject).accessibilityPerformPress?(), true)
        XCTAssertTrue(f.model.expanded)
        let growth = XCTNSPredicateExpectation(predicate: NSPredicate { object, _ in
            MainActor.assumeIsolated { (object as? NSWindow)?.frame.height ?? 0 > height }
        }, object: f.panel.window)
        await fulfillment(of: [growth], timeout: 3)
        assertBar(f, shows: ["quality", "stillFrameRate", "threshold", "placement"])
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
