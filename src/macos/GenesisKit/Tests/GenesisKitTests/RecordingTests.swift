import AppKit
@testable import GenesisKit
import SwiftUI
import XCTest

/// Fixture targets: invented apps and windows, no real machine state.
private enum RecordingFixture {
    static let targets = RecordingTargets(
        windows: [
            RecordingWindow(id: 501, pid: 4101, app: "Editor", title: "notes.txt",
                            bounds: .init(x: 200, y: 160, width: 900, height: 600)),
            RecordingWindow(id: 502, pid: 4101, app: "Editor", title: "",
                            bounds: .init(x: 260, y: 220, width: 700, height: 500)),
            RecordingWindow(id: 610, pid: 4202, app: "Viewer", title: "Quarterly chart",
                            bounds: .init(x: 1300, y: 300, width: 640, height: 480)),
        ],
        apps: [RecordingApp(pid: 4101, name: "Editor", windowCount: 2),
               RecordingApp(pid: 4202, name: "Viewer", windowCount: 1)],
        displays: [RecordingDisplay(index: 0, name: "Built-in Display", isPrimary: true, width: 1728, height: 1117),
                   RecordingDisplay(index: 1, name: "Studio Display", isPrimary: false, width: 2560, height: 1440)],
        frontmostPid: 4202)
}

@MainActor
private final class FakeChannel: RecordingCommandChannel {
    var sent: [String] = []
    var stopped = false
    func send(_ line: String) throws { sent.append(line.trimmingCharacters(in: .newlines)) }
    func finishInput() {}
    func stop() { stopped = true }
}

@MainActor
final class RecordingSessionControllerTests: XCTestCase {
    private func controller() -> (RecordingSessionController, FakeChannel, () -> [String],
                                  (Int32, String) -> Void, ([String]) -> Void) {
        let channel = FakeChannel()
        var arguments: [String] = []
        var exit: ((Int32, String) -> Void)?
        var lines: (([String]) -> Void)?
        let controller = RecordingSessionController { args, onLines, onExit in
            arguments = args
            lines = onLines
            exit = onExit
            return channel
        }
        return (controller, channel, { arguments }, { exit?($0, $1) }, { lines?($0) })
    }

    func testStartPassesTheTargetTheControlsToLeaveOutAndTheSettings() throws {
        let (controller, _, arguments, _, _) = controller()
        try controller.start(target: .display(index: 1, name: "Studio Display"), excludeWindowIDs: [9001],
                             frameRate: 24, showsBorder: false)
        XCTAssertEqual(controller.phase, .starting)
        XCTAssertEqual(arguments(), [
            "capture", "session", "--json", "--stop-on-stdin",
            "--target", #"{"kind":"display","name":"Studio Display","screenIndex":1}"#,
            "--fps", "24", "--exclude-window-ids", "9001", "--no-indicator",
        ])
    }

    func testCommandsGoOutAsJSONLinesAndEventsDriveThePhase() throws {
        let (controller, channel, _, _, receive) = controller()
        try controller.start(target: RecordingFixture.targets.windows[0].target, excludeWindowIDs: [], frameRate: 15,
                             showsBorder: true)
        receive([#"{"event":"state","state":"recording","reason":"user","target":{"kind":"window","windowIds":[501],"app":"Editor","title":"notes.txt"},"elapsedMs":0,"segments":0,"limitMs":600000}"#])
        XCTAssertEqual(controller.phase, .recording)
        receive([#"{"event":"elapsed","elapsedMs":4200,"limitMs":600000}"#])
        XCTAssertEqual(controller.elapsedMs, 4200)
        controller.pause()
        controller.switchTo(RecordingFixture.targets.apps[1].target)
        controller.restart()
        controller.resume()
        XCTAssertEqual(channel.sent, [
            #"{"cmd":"pause"}"#,
            #"{"cmd":"switch","target":{"app":"4202","kind":"app","name":"Viewer"}}"#,
            #"{"cmd":"restart"}"#,
            #"{"cmd":"resume"}"#,
        ])
        receive([#"{"event":"state","state":"paused","reason":"limit","target":{"kind":"app","app":"4202","name":"Viewer"},"elapsedMs":600000,"segments":3,"limitMs":600000}"#,
                 #"{"event":"error","message":"The recording reached its 10 min limit.","code":"limit","fatal":false}"#])
        XCTAssertEqual(controller.phase, .paused)
        XCTAssertEqual(controller.pauseReason, "limit")
        XCTAssertEqual(controller.target, .app(app: "4202", name: "Viewer"))
        XCTAssertEqual(controller.notice, "The recording reached its 10 min limit.")
    }

    func testDoneHandsTheMovieOverOnceAndLaterCommandsAreDropped() throws {
        let (controller, channel, _, exit, receive) = controller()
        var done: [URL] = []
        var failures = 0
        controller.onDone = { url, _ in done.append(url) }
        controller.onFailed = { _, _ in failures += 1 }
        try controller.start(target: .app(app: "4101", name: "Editor"), excludeWindowIDs: [], frameRate: 15, showsBorder: true)
        controller.stop()
        receive([#"{"event":"state","state":"finishing","reason":"user","target":{"kind":"app","app":"4101"},"elapsedMs":3000,"segments":1,"limitMs":600000}"#,
                 #"{"event":"done","path":"/tmp/recording-fixture.mp4","durationMs":3000,"segments":1}"#])
        exit(0, "")
        controller.pause()
        XCTAssertEqual(done, [URL(fileURLWithPath: "/tmp/recording-fixture.mp4")])
        XCTAssertEqual(failures, 0, "a clean exit after done is not a failure")
        XCTAssertEqual(channel.sent, [#"{"cmd":"stop"}"#], "nothing is sent after the session ended")
    }

    func testAFatalRefusalAndAnUnexpectedExitBothFail() throws {
        let (refused, _, _, _, receive) = controller()
        var codes: [String?] = []
        refused.onFailed = { _, code in codes.append(code) }
        try refused.start(target: .display(index: 0, name: nil), excludeWindowIDs: [], frameRate: 15, showsBorder: true)
        receive([#"{"event":"error","message":"[screen-recording-denied] Screen Recording is not granted","code":"screen-recording-denied","fatal":true}"#])
        XCTAssertEqual(refused.phase, .failed)
        XCTAssertEqual(codes, ["screen-recording-denied"])

        let (crashed, _, _, exit, _) = controller()
        var messages: [String] = []
        crashed.onFailed = { message, _ in messages.append(message) }
        try crashed.start(target: .display(index: 0, name: nil), excludeWindowIDs: [], frameRate: 15, showsBorder: true)
        exit(9, "bun crashed\n")
        XCTAssertEqual(messages, ["bun crashed"])
    }
}

final class RecordingModelTests: XCTestCase {
    func testTargetsDecodeTheCLIShapeAndTheDefaultIsTheFrontAppsWindow() throws {
        let json = #"""
        {"windows":[{"id":501,"pid":4101,"app":"Editor","title":"notes.txt","bounds":{"x":1,"y":2,"width":300,"height":200}}],
         "apps":[{"pid":4101,"name":"Editor","windowCount":1}],
         "displays":[{"index":0,"name":"Built-in Display","isPrimary":true,"width":1728,"height":1117,"scaleFactor":2}],
         "frontmostPid":4101}
        """#
        let targets = try JSONDecoder().decode(RecordingTargets.self, from: Data(json.utf8))
        XCTAssertEqual(targets.windows.first?.title, "notes.txt")
        XCTAssertEqual(targets.defaultTarget(), .window(ids: [501], app: "Editor", title: "notes.txt", pid: 4101))
        XCTAssertEqual(RecordingFixture.targets.defaultTarget(preferredPid: 4101),
                       .window(ids: [501], app: "Editor", title: "notes.txt", pid: 4101))
        XCTAssertEqual(RecordingFixture.targets.defaultTarget(),
                       .window(ids: [610], app: "Viewer", title: "Quarterly chart", pid: 4202), "else the frontmost app")
        XCTAssertEqual(RecordingTargets(windows: [], apps: [], displays: RecordingFixture.targets.displays).defaultTarget(),
                       .display(index: 0, name: "Built-in Display"), "no window: the main display")
        let own = RecordingFixture.targets.excluding(pids: [4101])
        XCTAssertEqual(own.windows.map(\.id), [610])
        XCTAssertEqual(own.apps.map(\.pid), [4202])
    }

    func testATargetSurvivesItsWireForm() throws {
        for target in [RecordingTarget.window(ids: [7, 8], app: "Editor", title: "a", pid: 4101),
                       .app(app: "4202", name: "Viewer"), .display(index: 2, name: nil)] {
            XCTAssertEqual(try JSONDecoder().decode(RecordingTarget.self, from: Data(target.json.utf8)), target)
        }
    }

    func testThePickerGroupsWindowsUnderTheirAppAndFilters() {
        let windows = RecordingPickerRow.rows(RecordingFixture.targets, tab: .windows, query: "")
        XCTAssertEqual(windows.map(\.title), ["Editor", "notes.txt", "Untitled window", "Viewer", "Quarterly chart"])
        XCTAssertEqual(windows.map { $0.target == nil }, [true, false, false, true, false])
        XCTAssertEqual(windows[0].detail, "2 windows")
        XCTAssertEqual(RecordingPickerRow.rows(RecordingFixture.targets, tab: .windows, query: "chart").map(\.title),
                       ["Viewer", "Quarterly chart"])
        XCTAssertEqual(RecordingPickerRow.rows(RecordingFixture.targets, tab: .windows, query: "viewer").map(\.title),
                       ["Viewer", "Quarterly chart"], "the app's name matches its windows")
        let apps = RecordingPickerRow.rows(RecordingFixture.targets, tab: .apps, query: "")
        XCTAssertEqual(apps.map(\.title), ["Editor", "Viewer"])
        XCTAssertEqual(apps.map(\.target), [.app(app: "4101", name: "Editor"), .app(app: "4202", name: "Viewer")])
        let displays = RecordingPickerRow.rows(RecordingFixture.targets, tab: .displays, query: "")
        XCTAssertEqual(displays.map(\.badge), ["Main", nil])
        XCTAssertEqual(displays.map(\.detail), ["1728 × 1117", "2560 × 1440"])
    }

    func testTheClockReadsMinutesAndHours() {
        XCTAssertEqual(RecordingClock.format(0), "0:00")
        XCTAssertEqual(RecordingClock.format(65_400), "1:05")
        XCTAssertEqual(RecordingClock.format(3_725_000), "1:02:05")
    }
}

final class RecordingPanelLayoutTests: XCTestCase {
    // Two displays: a 1728 x 1117 primary with a 25 pt menu bar and a 70 pt Dock, and one to its right.
    private let screens = [
        RecordingPanelLayout.Screen(frame: CGRect(x: 0, y: 0, width: 1728, height: 1117),
                                    visible: CGRect(x: 0, y: 70, width: 1728, height: 1022)),
        RecordingPanelLayout.Screen(frame: CGRect(x: 1728, y: 0, width: 2560, height: 1440),
                                    visible: CGRect(x: 1728, y: 0, width: 2560, height: 1415)),
    ]
    private let size = CGSize(width: 480, height: 44)

    func testNearTargetSitsCentredUnderTheWindow() {
        // CG y 160..760 is Cocoa y 357..957 on the 1117 pt primary.
        let frame = RecordingPanelLayout.frame(size: size, placement: .nearTarget,
                                               targetCG: CGRect(x: 200, y: 160, width: 900, height: 600),
                                               displayIndex: nil, screens: screens)
        XCTAssertEqual(frame, CGRect(x: 410, y: 357 - 12 - 44, width: 480, height: 44))
    }

    func testNearTargetGoesInsideTheBottomEdgeWhenTheScreenHasNoRoomBelow() {
        let frame = RecordingPanelLayout.frame(size: size, placement: .nearTarget,
                                               targetCG: CGRect(x: 0, y: 25, width: 1728, height: 1022),
                                               displayIndex: nil, screens: screens)
        XCTAssertEqual(frame.minY, 70 + 16, "inside the window's bottom edge, the screen margin above the Dock")
        XCTAssertEqual(frame.midX, 864)
    }

    func testADisplayGetsTheControlsAtItsBottomCentreAndCornersStayInside() {
        let display = RecordingPanelLayout.frame(size: size, placement: .nearTarget, targetCG: nil, displayIndex: 1,
                                                 screens: screens)
        XCTAssertEqual(display, CGRect(x: 1728 + 1280 - 240, y: 32, width: 480, height: 44))
        let corner = RecordingPanelLayout.frame(size: size, placement: .topRight,
                                                targetCG: CGRect(x: 1800, y: 100, width: 400, height: 300),
                                                displayIndex: nil, screens: screens)
        XCTAssertEqual(corner, CGRect(x: 1728 + 2560 - 16 - 480, y: 1415 - 16 - 44, width: 480, height: 44),
                       "the corner of the display the window is on")
        let offScreen = RecordingPanelLayout.frame(size: size, placement: .nearTarget,
                                                   targetCG: CGRect(x: -900, y: 160, width: 600, height: 300),
                                                   displayIndex: nil, screens: screens)
        XCTAssertGreaterThanOrEqual(offScreen.minX, 16, "clamped inside the visible frame")
    }
}

/// The controls fire their callbacks through real clicks: mouse events posted at probed frames in a hidden window,
/// hosted the way the controls panel hosts them (first click accepted). Never in a visible window.
@MainActor
final class RecordingControlsClickTests: XCTestCase {
    private var fired: [String] = []

    private func actions() -> RecordingControlsActions {
        RecordingControlsActions(
            pause: { self.fired.append("pause") }, resume: { self.fired.append("resume") },
            switchTarget: { self.fired.append("switch") }, restart: { self.fired.append("restart") },
            use: { self.fired.append("use") }, discard: { self.fired.append("discard") },
            dismissNotice: { self.fired.append("dismiss") }, moved: { self.fired.append("moved") })
    }

    private func host(_ view: some View, size: NSSize) -> NSWindow {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = FirstMouseHostingView(rootView: AnyView(
            ZStack { Color(white: 0.11); view }
                .environment(\.nativeSettingsReduceTransparency, true)
                .frame(width: size.width, height: size.height)))
        window.alphaValue = 0
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.order(.below, relativeTo: 0)
        return window
    }

    private func pump(_ seconds: TimeInterval) {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if let next = NSApp.nextEvent(matching: .any, until: deadline, inMode: .default, dequeue: true) {
                NSApp.sendEvent(next)
            }
        }
    }

    private func post(_ type: NSEvent.EventType, _ window: NSWindow, at location: NSPoint) {
        let event = NSEvent.mouseEvent(with: type, location: location, modifierFlags: [],
                                       timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                       context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        NSApp.postEvent(event, atStart: false)
    }

    private func click(_ name: String, in window: NSWindow) throws {
        let frame = try XCTUnwrap(FrameProbe.frames[name], "\(name) has a frame")
        let point = NSPoint(x: frame.midX, y: window.frame.height - frame.midY)
        post(.leftMouseDown, window, at: point)
        post(.leftMouseUp, window, at: point)
        pump(0.4)
    }

    override func setUp() {
        super.setUp()
        fired = []
        FrameProbe.enabled = true
        FrameProbe.reset()
    }

    override func tearDown() {
        FrameProbe.enabled = false
        super.tearDown()
    }

    func testEveryControlFiresItsActionAndDiscardAsksFirst() throws {
        let state = RecordingControlsState(phase: .recording, elapsedMs: 12_000,
                                           target: .window(ids: [501], app: "Editor", title: "notes.txt", pid: nil),
                                           useTitle: "Stop and paste")
        let window = host(RecordingControlsView(state: state, actions: actions()), size: NSSize(width: 640, height: 60))
        defer { window.orderOut(nil); window.close() }
        pump(0.8)
        try click("recording.use", in: window)
        XCTAssertEqual(fired, ["use"], "harness control: the primary button fires on one posted click")
        try click("recording.pause", in: window)
        try click("recording.switch", in: window)
        XCTAssertEqual(fired, ["use", "pause", "switch"])
        try click("recording.discard", in: window)
        XCTAssertEqual(fired.last, "switch", "with something recorded, discard asks before it acts")
        if let directory = ProcessInfo.processInfo.environment["RECORDING_SNAPSHOT_DIR"], let view = window.contentView,
           let rep = HostedShot.bitmap(view) {
            let url = URL(fileURLWithPath: directory).appendingPathComponent("recording-controls-confirm-discard.png")
            try rep.representation(using: .png, properties: [:])?.write(to: url)
            print("shot \(url.path)")
        }
        try click("recording.keep", in: window)
        XCTAssertEqual(fired.last, "switch", "Keep cancels")
        try click("recording.discard", in: window)
        try click("recording.confirm", in: window)
        XCTAssertEqual(fired.last, "discard")
        try click("recording.restart", in: window)
        try click("recording.confirm", in: window)
        XCTAssertEqual(fired.last, "restart")
    }

    func testPausedShowsResumeAndDiscardWithoutTheQuestionWhenAsked() throws {
        let state = RecordingControlsState(phase: .paused, elapsedMs: 30_000, target: .display(index: 0, name: "Built-in"),
                                           pauseReason: "user", useTitle: "Stop and save", confirmsDiscard: false)
        let window = host(RecordingControlsView(state: state, actions: actions()), size: NSSize(width: 640, height: 60))
        defer { window.orderOut(nil); window.close() }
        pump(0.8)
        XCTAssertNil(FrameProbe.frames["recording.pause"], "paused shows Resume, not Pause")
        try click("recording.resume", in: window)
        try click("recording.discard", in: window)
        XCTAssertEqual(fired, ["resume", "discard"])
    }

    func testDraggingTheStatusMovesTheWindow() throws {
        let state = RecordingControlsState(phase: .recording, elapsedMs: 5_000, target: .display(index: 0, name: nil),
                                           useTitle: "Stop and paste")
        let window = host(RecordingControlsView(state: state, actions: actions()), size: NSSize(width: 640, height: 60))
        defer { window.orderOut(nil); window.close() }
        window.setFrameOrigin(NSPoint(x: 100, y: 100))
        pump(0.8)
        let frame = try XCTUnwrap(FrameProbe.frames["recording.status"])
        let start = NSPoint(x: frame.midX, y: window.frame.height - frame.midY)
        post(.leftMouseDown, window, at: start)
        post(.leftMouseDragged, window, at: NSPoint(x: start.x + 40, y: start.y - 30))
        post(.leftMouseUp, window, at: NSPoint(x: start.x + 40, y: start.y - 30))
        pump(0.4)
        XCTAssertTrue(fired.contains("moved"), "the drag reached the drag area: \(fired)")
        XCTAssertNotEqual(window.frame.origin, NSPoint(x: 100, y: 100), "the window moved")
        XCTAssertFalse(fired.contains("pause") || fired.contains("use"), "a drag presses nothing")
    }
}

/// The controls and the picker rendered for review: `RECORDING_SNAPSHOT_DIR=<dir>` writes PNGs there, flattened onto
/// an opaque dark background. The picker's rows are also read back with Vision.
@MainActor
final class RecordingRenderTests: XCTestCase {
    private func render(_ view: some View, size: CGSize, name: String) throws -> NSView {
        let framed = ZStack {
            Color(white: 0.11)
            view
        }
        .environment(\.nativeSettingsReduceTransparency, true)
        let (window, host) = HostedShot.host(framed, size: size)
        addTeardownBlock { window.close() }
        RunLoop.main.run(until: Date().addingTimeInterval(0.6))
        if let directory = ProcessInfo.processInfo.environment["RECORDING_SNAPSHOT_DIR"] {
            let rep = try XCTUnwrap(HostedShot.bitmap(host))
            let url = URL(fileURLWithPath: directory).appendingPathComponent(name + ".png")
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: url)
            print("shot \(url.path)")
        }
        return host
    }

    func testThePickerListsTheFixtureTargets() throws {
        let picker = RecordingTargetPicker(load: .loaded(RecordingFixture.targets),
                                           initial: RecordingFixture.targets.windows[0].target,
                                           onChoose: { _ in }, onCancel: {})
        let host = try render(picker.padding(20), size: CGSize(width: 440, height: 420), name: "recording-picker-windows")
        let text = TreeDrawnText.lines(of: host).joined(separator: "\n")
        for expected in ["Choose what to record", "notes.txt", "Untitled window", "Quarterly chart"] {
            XCTAssertTrue(text.contains(expected), "\(expected) is drawn; read: \(text)")
        }
    }

    func testThePickerOpensOnTheTabOfItsInitialTarget() throws {
        for (initial, name, expected) in [
            (RecordingFixture.targets.apps[1].target, "apps", ["Editor", "Viewer", "2 windows"]),
            (RecordingFixture.targets.displays[1].target, "displays", ["Built-in Display", "Studio Display", "Main"]),
        ] {
            let picker = RecordingTargetPicker(load: .loaded(RecordingFixture.targets), title: "Switch to",
                                               initial: initial, onChoose: { _ in }, onCancel: {})
            let host = try render(picker.padding(20), size: CGSize(width: 440, height: 360), name: "recording-picker-\(name)")
            let text = TreeDrawnText.lines(of: host).joined(separator: "\n")
            for line in expected {
                XCTAssertTrue(text.contains(line), "\(name): \(line) is drawn; read: \(text)")
            }
        }
    }

    func testRenderTheControlsInEachPhase() throws {
        let target = RecordingTarget.window(ids: [501], app: "Editor", title: "notes.txt — Project plan", pid: nil)
        let states: [(String, RecordingControlsState)] = [
            ("starting", .init(phase: .starting, target: target, useTitle: "Stop and paste")),
            ("recording", .init(phase: .recording, elapsedMs: 83_000, target: target, useTitle: "Stop and paste")),
            ("paused", .init(phase: .paused, elapsedMs: 83_000, target: .display(index: 0, name: "Built-in Display"),
                             pauseReason: "user", useTitle: "Stop and save")),
            ("limit", .init(phase: .paused, elapsedMs: 600_000, target: target, pauseReason: "limit",
                            notice: "The recording reached its 10 min limit. Stop to keep it, or restart.",
                            useTitle: "Stop and paste")),
            ("finishing", .init(phase: .finishing, elapsedMs: 83_000, target: target, useTitle: "Stop and paste")),
        ]
        for (name, state) in states {
            let host = try render(
                RecordingControlsView(state: state, actions: RecordingControlsActions(
                    pause: {}, resume: {}, switchTarget: {}, restart: {}, use: {}, discard: {})).padding(16),
                size: CGSize(width: 700, height: name == "limit" ? 110 : 80), name: "recording-controls-\(name)")
            let text = TreeDrawnText.lines(of: host).joined(separator: " ")
            XCTAssertTrue(text.contains(state.phase == .finishing ? "Saving" : state.useTitle.components(separatedBy: " ").last ?? ""),
                          "\(name): \(text)")
        }
    }
}
