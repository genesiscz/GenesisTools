import AppKit
import Foundation
import SwiftUI
import XCTest
@testable import GenesisToolsMeetings

/// What the user of the Meetings window meets: the menu bar, the layout at the window's smallest size, and the words
/// and states of the panes (the deep manual test of 2026-11-06, findings MU1 to MU19).
@MainActor
final class MeetingsUXTests: XCTestCase {
    // MARK: Fixtures

    static func overviewJSON() -> Data {
        Data("""
        {"generatedAt":"2026-11-05T12:00:00.000Z","days":14,"applyAbove":0.5,
         "meetings":[
          {"id":"a","title":"Weekly sync","start":"2026-11-05T08:00:00.000Z","end":"2026-11-05T09:00:00.000Z","durationSec":3600,
           "day":"2026-11-05","project":"work","labels":["Launch"],"hasTranscript":true,"hasRecording":true,"live":false,"frames":12,
           "contextCount":0,"badges":{"noProject":false,"openQuestions":2,"unclearSpeakers":0,"recordingOnly":false,
           "transcriptOnly":false,"suggestedAboveApply":3,"suggested":4}},
          {"id":"b","title":"Screen only","start":"2026-11-05T06:00:00.000Z","day":"2026-11-05","labels":[],"hasTranscript":false,
           "hasRecording":true,"live":false,"frames":1,"contextCount":0,"badges":{"noProject":true,"openQuestions":0,
           "unclearSpeakers":0,"recordingOnly":true,"transcriptOnly":false,"suggestedAboveApply":0,"suggested":0}}],
         "projects":[{"name":"work","meetings":1}],
         "needsYou":{"noProject":["b"],"questions":[{"id":"a","count":2}],"suggestions":[{"id":"a","count":3}],"total":2}}
        """.utf8)
    }

    private func defaults() throws -> (UserDefaults, String) {
        let suite = "meetings.tests.\(UUID().uuidString)"
        return (try XCTUnwrap(UserDefaults(suiteName: suite)), suite)
    }

    /// The window drawn off screen: alpha 0, below the desktop, never activated.
    private func hiddenWindow(_ model: MeetingsWindowModel, size: NSSize) -> NSWindow {
        let window = MeetingsWindow.makeWindow(model: model, size: size)
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.orderFrontRegardless()
        return window
    }

    // MARK: MU3 the menu bar

    func testTheMenuBarClosesQuitsMinimizesAndEditsText() {
        let bar = MeetingsMenu.build(appName: "GenesisTools")
        func item(_ key: String, _ mask: NSEvent.ModifierFlags = .command) -> NSMenuItem? {
            bar.items.compactMap(\.submenu).flatMap(\.items).first {
                $0.keyEquivalent == key && $0.keyEquivalentModifierMask == mask
            }
        }
        XCTAssertEqual(item("w")?.action, #selector(NSWindow.performClose(_:)), "⌘W closes the window")
        XCTAssertEqual(item("m")?.action, #selector(NSWindow.performMiniaturize(_:)), "⌘M minimizes it")
        XCTAssertEqual(item("q")?.action, #selector(NSApplication.terminate(_:)), "⌘Q quits")
        XCTAssertEqual(item("c")?.action, #selector(NSText.copy(_:)), "⌘C reaches a text field through Edit")
        XCTAssertEqual(item("v")?.action, #selector(NSText.paste(_:)), "⌘V reaches a text field through Edit")
        XCTAssertEqual(item("a")?.action, #selector(NSText.selectAll(_:)))
        XCTAssertNotNil(item("z"), "⌘Z undoes typing")
        XCTAssertEqual(item("1")?.title, "Needs You")
        XCTAssertEqual(item("2")?.title, "All Meetings")
        XCTAssertEqual(item("r")?.title, "Reload")
        XCTAssertEqual(bar.items.map(\.title), ["GenesisTools", "File", "Edit", "View", "Window"])
    }

    func testTheViewMenuMovesTheWindowsPlace() throws {
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = MeetingsWindowModel(defaults: defaults, loadDetail: { _ in })
        model.receive(try JSONDecoder().decode(MeetingsOverview.self, from: Self.overviewJSON()))
        MeetingsMenuTarget.shared.model = model
        defer { MeetingsMenuTarget.shared.model = nil }
        MeetingsMenuTarget.shared.showAll(nil)
        XCTAssertEqual(model.place, .all)
        MeetingsMenuTarget.shared.showNeeds(nil)
        XCTAssertEqual(model.place, .needs)
    }

    // MARK: MU2 nothing is cut off at the smallest size

    /// At the window's minimum size the detail column got about 438 pt and its header and tabs needed 464 or more:
    /// the split view drew it wider than the window, so Export, the last tab and the ends of lines were cut off.
    func testAtTheMinimumSizeTheDetailFitsTheWindow() throws {
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = MeetingsWindowModel(defaults: defaults, loadDetail: { _ in })
        model.receive(try JSONDecoder().decode(MeetingsOverview.self, from: Self.overviewJSON()))
        model.select("a")
        FrameProbe.enabled = true
        FrameProbe.reset()
        defer { FrameProbe.enabled = false; FrameProbe.reset() }

        let window = hiddenWindow(model, size: NSSize(width: 900, height: 560))
        defer { window.orderOut(nil); window.close() }
        RunLoop.main.run(until: Date().addingTimeInterval(0.6))

        let width = try XCTUnwrap(window.contentView).bounds.width
        XCTAssertEqual(MeetingsWindow.floored(NSSize(width: 600, height: 400)), MeetingsWindow.minimumSize,
                       "a live resize stops at the minimum")
        XCTAssertEqual(window.frame.width, MeetingsWindow.minimumSize.width, accuracy: 1, "the test runs at the window's own minimum")
        let header = try XCTUnwrap(FrameProbe.frames["meetings.detail.header"], "the detail's header is on screen")
        XCTAssertLessThanOrEqual(header.maxX, width + 1, "the header ends inside the window: \(header) in \(width) pt")
        let tabs = try XCTUnwrap(FrameProbe.frames["meetings.detail.tabs"])
        XCTAssertLessThanOrEqual(tabs.maxX, width + 1, "the last tab is inside the window: \(tabs) in \(width) pt")
    }

    // MARK: MU5 the audio plays under the window's control

    /// A real process with no sound stands in for the player.
    private func silentPlayer(seconds: String) throws -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sleep")
        process.arguments = [seconds]
        try process.run()
        return process
    }

    private func until(_ what: String, timeout: TimeInterval = 3, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            guard Date() < deadline else { return XCTFail("timed out waiting until \(what)") }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    private func isPlaying(_ playback: MeetingsPlayback) -> Bool {
        if case .playing = playback.state { return true } else { return false }
    }

    func testStopEndsThePlayerTheWindowStarted() async throws {
        let player = try silentPlayer(seconds: "30")
        defer { if player.isRunning { player.terminate() } }
        var asked: [String] = []
        let playback = MeetingsPlayback(start: { meeting, seconds, choice in
            asked.append("\(meeting) \(seconds) \(choice ?? "config")")
            return .init(audioPath: "/x/upload.ogg", startSec: seconds, player: "ffplay", pid: player.processIdentifier)
        })
        playback.play(meeting: "a", at: 20, player: "ffplay")
        XCTAssertEqual(playback.state, .starting(fromSec: 20), "the bar shows the start at once")
        try await until("it plays") { isPlaying(playback) }
        XCTAssertEqual(asked, ["a 20.0 ffplay"])
        XCTAssertEqual(playback.meeting, "a")

        playback.stop()
        XCTAssertEqual(playback.state, .idle)
        XCTAssertNil(playback.meeting)
        try await until("the player process ends") { !player.isRunning }
    }

    func testPauseAndResumeSuspendOnlyAPlayerWithNoWindow() async throws {
        let player = try silentPlayer(seconds: "30")
        defer { if player.isRunning { player.terminate() } }
        var signals: [Int32] = []
        var name = "ffplay"
        let playback = MeetingsPlayback(start: { _, seconds, _ in
            .init(audioPath: nil, startSec: seconds, player: name, pid: player.processIdentifier)
        }, signal: { _, signal in signals.append(signal) })
        playback.play(meeting: "a", at: 5, player: "ffplay")
        try await until("it plays") { isPlaying(playback) }

        playback.pause()
        guard case .paused(_, let at) = playback.state else { return XCTFail("paused, got \(playback.state)") }
        XCTAssertGreaterThanOrEqual(at, 5)
        playback.resume()
        XCTAssertTrue(isPlaying(playback))
        playback.stop()
        XCTAssertEqual(signals, [SIGSTOP, SIGCONT, SIGCONT, SIGTERM], "a stopped player is woken before it is ended")

        name = "vlc"
        signals = []
        playback.play(meeting: "a", at: 5, player: nil)
        try await until("it plays in VLC") { isPlaying(playback) }
        playback.pause()
        XCTAssertTrue(isPlaying(playback), "VLC has its own window and controls, so the bar offers no pause")
        XCTAssertEqual(signals, [])
        playback.stop()
    }

    func testThePlayerEndingByItselfClearsTheBar() async throws {
        let player = try silentPlayer(seconds: "0.3")
        let playback = MeetingsPlayback(start: { _, seconds, _ in
            .init(audioPath: nil, startSec: seconds, player: "ffplay", pid: player.processIdentifier)
        })
        playback.play(meeting: "a", at: 0, player: "ffplay")
        try await until("it plays") { isPlaying(playback) }
        try await until("the audio's end clears the bar") { playback.state == .idle }
    }

    func testAPlayerOutsideTheWindowAndAFailedStartLeaveANote() async throws {
        var calls = 0
        var fail = true
        let failure = MeetingsCLI.Failure(sentence: "No player is installed.", detail: "ffplay: not found")
        let playback = MeetingsPlayback(start: { _, _, _ in
            calls += 1
            if fail { throw failure }
            return nil
        })
        playback.play(meeting: "a", at: 12, player: "ffplay")
        try await until("the failure shows") { playback.state == .failed(failure, fromSec: 12) }
        fail = false
        playback.retry()
        try await until("an outside player shows its note") { playback.state == .outside(fromSec: 12) }
        XCTAssertEqual(calls, 2, "Retry starts the same request again")
        playback.dismiss()
        XCTAssertEqual(playback.state, .idle)
    }

    func testANewTimeEndsThePlayerOfTheTimeBefore() async throws {
        let player = try silentPlayer(seconds: "30")
        defer { if player.isRunning { player.terminate() } }
        var signals: [String] = []
        var pids: [Int32] = [424_242, player.processIdentifier]
        let playback = MeetingsPlayback(start: { _, seconds, _ in
            .init(audioPath: nil, startSec: seconds, player: "ffplay", pid: pids.removeFirst())
        }, signal: { pid, signal in signals.append("\(pid):\(signal)") })
        playback.play(meeting: "a", at: 10, player: "ffplay")
        playback.play(meeting: "a", at: 40, player: "ffplay")
        try await until("the second time plays") { isPlaying(playback) }
        guard case .playing(let session) = playback.state else { return XCTFail("playing") }
        XCTAssertEqual(session.startSec, 40)
        XCTAssertEqual(signals, ["424242:\(SIGTERM)"], "the first player ends as soon as it names itself")
        playback.stop()
    }

    func testATranscriptTimePlaysInTheWindowsPlayerByDefault() async throws {
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertEqual(MeetingsPreferences.player(defaults), .window)
        XCTAssertEqual(MeetingsPreferences.Player.window.cliPlayer, "ffplay")
        XCTAssertNil(MeetingsPreferences.Player.app.cliPlayer, "the meetings config's player")

        let model = MeetingsWindowModel(defaults: defaults, loadDetail: { _ in })
        var asked: [String] = []
        model.playback = MeetingsPlayback(start: { meeting, seconds, _ in
            asked.append("\(meeting) \(seconds)")
            return nil
        })
        model.receive(try JSONDecoder().decode(MeetingsOverview.self, from: Self.overviewJSON()))
        model.select("a")
        model.detail?.play(at: 12.7)
        try await until("the window's playback starts") { !asked.isEmpty }
        XCTAssertEqual(asked, ["a 12.7"])
    }
}
