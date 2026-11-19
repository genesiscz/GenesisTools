import Foundation
@testable import GenesisKit
import XCTest

@MainActor
private final class WidgetSessionPipe: RecordingCommandChannel {
    var arguments: [String] = []
    var writes: [String] = []
    var receive: (@MainActor ([String]) -> Void)?
    var exit: (@MainActor (Int32, String) -> Void)?
    var respond: (String) throws -> Void = { _ in }
    let screens = [CGRect(x: 0, y: 0, width: 1000, height: 800), CGRect(x: -600, y: 200, width: 600, height: 400)]

    func makeController() -> RecordingSessionController {
        RecordingSessionController(screenFrames: { self.screens }, displayIDs: { [51, 52] }) { args, lines, exit in
            self.arguments = args
            self.receive = lines
            self.exit = exit
            return self
        }
    }

    func send(_ line: String) throws {
        XCTAssertTrue(line.hasSuffix("\n"))
        let json = String(line.dropLast())
        writes.append(json)
        try respond(json)
    }

    func finishInput() {}
    func stop() {}
    func state(_ phase: String) {
        receive?([#"{"event":"state","state":"\#(phase)","reason":"user","segments":0,"elapsedMs":0}"#])
    }
}

@MainActor
final class WidgetSessionEngineTests: XCTestCase {
    private let window = RecordingTarget.window(ids: [17], app: nil, title: nil, pid: nil)

    private func makeEngine(_ pipe: WidgetSessionPipe, border: Bool = true) -> WidgetSessionEngine {
        WidgetSessionEngine(makeController: pipe.makeController, showsBorder: { border })
    }

    func testStartUsesTheDraftRatesBorderAndExcludedWindows() async throws {
        let pipe = WidgetSessionPipe()
        let engine = makeEngine(pipe, border: false)
        let draft = RecordingSetup(target: window, frameRate: 24, stillFrameRate: 0.5)
        try await engine.start(draft, excludeWindowIDs: [41, 42])
        XCTAssertEqual(pipe.arguments, [
            "capture", "session", "--json", "--stop-on-stdin", "--target", #"{"kind":"window","windowIds":[17]}"#,
            "--fps", "24", "--idle-fps", "0.5", "--exclude-window-ids", "41,42", "--no-indicator",
        ])
    }

    func testCapabilitiesAndUnsupportedChangesNeverWriteToTheSession() async throws {
        let pipe = WidgetSessionPipe()
        let engine = makeEngine(pipe)
        let caps = engine.capabilities
        XCTAssertEqual(caps.targets, [.window, .app, .display, .area])
        XCTAssertEqual(caps.maxDurationMs, 600_000)
        XCTAssertTrue(caps.liveFrameRate)
        XCTAssertTrue(caps.liveTargetSwitch)
        XCTAssertFalse(caps.liveMicrophoneMute)
        XCTAssertFalse(caps.liveMicrophoneDevice)
        XCTAssertFalse(caps.liveSystemAudioMute)
        XCTAssertFalse(caps.liveCamera)
        XCTAssertFalse(caps.liveDisplaysAddRemove)
        let several = RecordingTarget.displays(indices: [0, 1])
        do {
            try await engine.start(.init(target: several), excludeWindowIDs: [])
            XCTFail("Several displays should be refused before launch")
        } catch RecordingEngineError.unsupported(let reason) {
            XCTAssertEqual(reason, caps.reasonUnavailable["displays"])
        }
        XCTAssertTrue(pipe.arguments.isEmpty)
        try await engine.start(.init(target: window), excludeWindowIDs: [])
        let changes: [RecordingSetupChange] = [.microphone(.init(muted: true)), .microphone(.init(deviceID: "input")),
                                                .systemAudio(.init(muted: true)), .camera(.init(enabled: true)),
                                                .target(several), .quality(.high), .drawsCursor(false)]
        for change in changes {
            do {
                try await engine.apply(change)
                XCTFail("Unexpectedly accepted \(change)")
            } catch RecordingEngineError.unsupported(let reason) {
                XCTAssertFalse(reason.isEmpty)
            }
        }
        XCTAssertTrue(pipe.writes.isEmpty)
    }

    func testLifecycleCommandsConfirmTheSavedMovieAndDiscardATake() async throws {
        let pipe = WidgetSessionPipe()
        let engine = makeEngine(pipe)
        try await engine.start(.init(target: window), excludeWindowIDs: [])
        pipe.state("recording")
        pipe.respond = { line in
            switch line {
            case #"{"cmd":"pause"}"#: pipe.state("paused")
            case #"{"cmd":"resume"}"#, #"{"cmd":"restart"}"#:
                pipe.state("starting")
                pipe.state("recording")
            case #"{"cmd":"stop"}"#: pipe.receive?([#"{"event":"done","path":"/tmp/widget-fixture.mp4"}"#])
            case #"{"cmd":"discard"}"#: pipe.receive?([#"{"event":"discarded"}"#])
            default: throw POSIXError(.EINVAL)
            }
        }
        defer { pipe.respond = { _ in } }
        try await engine.pause()
        try await engine.resume()
        try await engine.restart()
        let result = try await engine.stop()
        XCTAssertEqual(result?.path, "/tmp/widget-fixture.mp4")
        try await engine.start(.init(target: window), excludeWindowIDs: [])
        try await engine.discard()
        XCTAssertEqual(pipe.writes, [
            #"{"cmd":"pause"}"#, #"{"cmd":"resume"}"#, #"{"cmd":"restart"}"#, #"{"cmd":"stop"}"#, #"{"cmd":"discard"}"#,
        ])
    }

    func testOnlyTheRestartBoundaryTransfersEventsToTheReservedTake() async throws {
        let pipe = WidgetSessionPipe()
        let engine = makeEngine(pipe)
        let first = engine.nextTakeID
        try await engine.start(.init(target: window), excludeWindowIDs: [])
        pipe.state("recording")
        let second = engine.nextTakeID
        XCTAssertNotEqual(first, second)
        pipe.respond = { _ in
            pipe.receive?([#"{"event":"elapsed","elapsedMs":340}"#])
            pipe.state("starting")
            pipe.state("recording")
        }
        defer { pipe.respond = { _ in } }
        try await engine.restart()
        XCTAssertNotEqual(second, engine.nextTakeID)
        pipe.receive?([#"{"event":"discarded"}"#])
        let expected: [RecordingEngineEvent] = [
            .init(take: first, value: .firstFrame), .init(take: first, value: .elapsed(milliseconds: 0)),
            .init(take: first, value: .elapsed(milliseconds: 340)), .init(take: second, value: .elapsed(milliseconds: 0)),
            .init(take: second, value: .firstFrame), .init(take: second, value: .elapsed(milliseconds: 0)),
            .init(take: second, value: .discarded),
        ]
        var observed: [RecordingEngineEvent] = []
        let finished = expectation(description: "events through discard")
        let reader = Task {
            for await event in engine.events {
                observed.append(event)
                if event.value == .discarded {
                    finished.fulfill()
                    return
                }
            }
        }
        await fulfillment(of: [finished], timeout: 2)
        reader.cancel()
        XCTAssertEqual(observed, expected)
    }

    func testAreaOnSecondaryDisplayConvertsBothWaysAndPauseSurvivesAChoice() async throws {
        let pipe = WidgetSessionPipe()
        let engine = makeEngine(pipe)
        let area = RecordingTarget.area(rect: CGRect(x: 50, y: 40, width: 90, height: 70), display: 1)
        let region = #"{"height":70,"kind":"region","width":90,"x":-550,"y":490}"#
        try await engine.start(.init(target: area), excludeWindowIDs: [])
        XCTAssertEqual(pipe.arguments.dropFirst(5).first, region)
        pipe.receive?([#"{"event":"state","state":"paused","target":\#(region),"reason":"user"}"#])
        let next = RecordingTarget.area(rect: CGRect(x: 50, y: 60, width: 90, height: 70), display: 0, displayID: 52)
        try await engine.apply(.target(next))
        XCTAssertTrue(pipe.writes.isEmpty, "the existing switch command would start capturing immediately")
        let switched = #"{"height":70,"kind":"region","width":90,"x":-550,"y":470}"#
        pipe.respond = { _ in
            pipe.receive?([#"{"event":"state","state":"starting","target":\#(switched),"reason":"user"}"#])
        }
        defer { pipe.respond = { _ in } }
        try await engine.resume()
        XCTAssertEqual(pipe.writes, [#"{"cmd":"switch","target":\#(switched)}"#])
    }

    func testRestartSendsThePendingTargetAndIgnoresAnOldWarning() async throws {
        let pipe = WidgetSessionPipe()
        let engine = makeEngine(pipe)
        try await engine.start(.init(target: window), excludeWindowIDs: [])
        pipe.state("paused")
        let target = RecordingTarget.display(index: 1, name: nil)
        try await engine.apply(.target(target))
        pipe.respond = { _ in
            pipe.receive?([#"{"event":"error","message":"Old segment warning","fatal":false}"#,
                           #"{"event":"state","state":"starting","reason":"user","elapsedMs":0,"segments":0}"#])
        }
        try await engine.restart()
        XCTAssertEqual(pipe.writes, [#"{"cmd":"restart","target":{"kind":"display","screenIndex":1}}"#])
    }

    func testTerminalFailureDuringRestartIsDifferentFromACommandRefusal() async throws {
        let pipe = WidgetSessionPipe()
        let engine = makeEngine(pipe)
        try await engine.start(.init(target: window), excludeWindowIDs: [])
        pipe.state("paused")
        pipe.respond = { _ in
            pipe.receive?([#"{"event":"error","code":"command-refused","message":"Refused","fatal":false}"#])
        }
        do {
            try await engine.restart()
            XCTFail("A refusal cannot confirm Restart")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Refused")
        }
        pipe.respond = { _ in pipe.exit?(1, "Recorder stopped") }
        do {
            try await engine.restart()
            XCTFail("A terminal event cannot confirm Restart")
        } catch {
            guard case .restartEnded(.failed) = error as? RecordingEngineError else {
                return XCTFail("Expected a terminal restart failure, got \(error)")
            }
        }
        try await engine.start(.init(target: window), excludeWindowIDs: [])
    }

    func testFinishDeadlineDoesNotReportAnUnconfirmedSave() async throws {
        let pipe = WidgetSessionPipe()
        let engine = WidgetSessionEngine(makeController: { pipe.makeController() }, showsBorder: { false },
                                         finishTimeout: .milliseconds(20))
        try await engine.start(.init(target: window), excludeWindowIDs: [])
        do {
            _ = try await engine.stop()
            XCTFail("Only a confirmed stop can return a saved file")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("did not confirm"))
        }
        pipe.respond = { _ in pipe.receive?([#"{"event":"discarded"}"#]) }
        try await engine.discard()
        XCTAssertEqual(pipe.writes, [#"{"cmd":"stop"}"#, #"{"cmd":"discard"}"#])
    }

    func testRatesWaitForTheSessionReplyAndKeepSingleRateOnTheWire() async throws {
        let pipe = WidgetSessionPipe()
        let engine = makeEngine(pipe)
        try await engine.start(.init(target: window), excludeWindowIDs: [])
        pipe.state("paused")
        pipe.respond = { _ in pipe.receive?([#"{"event":"rates","activeFps":30,"idleFps":30,"threshold":0.5}"#]) }
        defer { pipe.respond = { _ in } }
        try await engine.apply(.frameRate(30, still: 0))
        pipe.respond = { _ in pipe.receive?([#"{"event":"rates","activeFps":30,"idleFps":1,"threshold":0.5}"#]) }
        do {
            try await engine.apply(.frameRate(24, still: 1))
            XCTFail("A different effective rate cannot acknowledge the draft")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("30"))
        }
        XCTAssertEqual(pipe.writes, [#"{"activeFps":30,"cmd":"rates","idleFps":0}"#, #"{"activeFps":24,"cmd":"rates","idleFps":1}"#])
    }

    func testStopCanRetryAfterASaveFailureAndWriteErrorsReachTheBar() async throws {
        let pipe = WidgetSessionPipe()
        let engine = makeEngine(pipe)
        try await engine.start(.init(target: window), excludeWindowIDs: [])
        pipe.state("recording")
        pipe.respond = { _ in throw POSIXError(.EPIPE) }
        do {
            try await engine.pause()
            XCTFail("A failed write should throw")
        } catch { XCTAssertEqual((error as NSError).code, Int(POSIXErrorCode.EPIPE.rawValue)) }

        pipe.respond = { _ in
            pipe.state("finishing")
            pipe.state("paused")
            pipe.receive?([#"{"event":"error","message":"Could not save the movie","fatal":false}"#])
        }
        defer { pipe.respond = { _ in } }
        do {
            _ = try await engine.stop()
            XCTFail("A failed join should leave Stop available")
        } catch { XCTAssertEqual(error.localizedDescription, "Could not save the movie") }
        pipe.respond = { _ in pipe.receive?([#"{"event":"done","path":"/tmp/retry-fixture.mp4"}"#]) }
        let saved = try await engine.stop()
        XCTAssertEqual(saved?.path, "/tmp/retry-fixture.mp4")
        XCTAssertEqual(pipe.writes, [#"{"cmd":"pause"}"#, #"{"cmd":"stop"}"#, #"{"cmd":"stop"}"#])
    }

    func testUnexpectedExitFailsStopAndLateCallbacksCannotFinishANewSession() async throws {
        let pipe = WidgetSessionPipe()
        let engine = makeEngine(pipe)
        try await engine.start(.init(target: window), excludeWindowIDs: [])
        let oldLines = pipe.receive
        let oldExit = pipe.exit
        pipe.respond = { _ in oldExit?(1, "fixture exit") }
        do {
            _ = try await engine.stop()
            XCTFail("Process exit cannot confirm a saved movie")
        } catch { XCTAssertTrue(error.localizedDescription.contains("unexpectedly")) }

        try await engine.start(.init(target: window), excludeWindowIDs: [])
        oldLines?([#"{"event":"discarded"}"#])
        oldExit?(1, "")
        pipe.respond = { _ in pipe.receive?([#"{"event":"done","path":"/tmp/new-take.mp4"}"#]) }
        defer { pipe.respond = { _ in } }
        let saved = try await engine.stop()
        XCTAssertEqual(saved?.path, "/tmp/new-take.mp4")
    }
}
