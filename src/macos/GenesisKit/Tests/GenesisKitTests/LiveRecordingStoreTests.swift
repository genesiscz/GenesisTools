import SwiftUI
import XCTest

@testable import GenesisKit

final class LiveRecordingStoreTests: XCTestCase {
    @MainActor
    func testCompactControlsKeepTheirOwnFullWarningWhenPaused() async throws {
        let probing = FrameProbe.enabled
        FrameProbe.enabled = true
        defer { FrameProbe.enabled = probing; FrameProbe.reset() }
        let ids = ["first", "second"]
        let warnings = ids.map { id in (1...8).map { "Display \($0) disconnected during \(id)." }.joined(separator: "\n") }
        var recordings = try zip(ids, warnings).map { id, warning in
            let data = try JSONSerialization.data(withJSONObject: [
                "pid": 7, "startedAt": 1762195200000, "id": id, "state": "recording", "warning": warning,
            ])
            return try XCTUnwrap(LiveRecordingStore.decode(data))
        }
        func controls() -> AnyView {
            AnyView(VStack {
                ForEach(recordings, id: \.id) { recording in
                    LiveRecordingControlsView(recording: recording, send: { _ in }, hide: {}).fixedSize()
                }
            })
        }
        FrameProbe.reset()
        let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 600, height: 520),
                              styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: controls())
        window.contentView = host
        window.orderInForSnapshot()
        defer { window.close() }
        let keys = warnings.map { "live-recording.message." + $0 }
        func verifyWarnings() async throws {
            let deadline = ContinuousClock.now + .seconds(2)
            while keys.contains(where: { FrameProbe.frames[$0] == nil }), ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(20))
            }
            for key in keys {
                let frame = try XCTUnwrap(FrameProbe.frames[key])
                XCTAssertGreaterThan(frame.height, 80, "all eight lines are visible")
            }
        }
        try await verifyWarnings()
        recordings[0].state = "paused"
        FrameProbe.reset()
        host.rootView = controls()
        try await verifyWarnings()
    }

    @MainActor
    func testCompactControlsStayVisibleUntilTheFullBarOpens() throws {
        let resolve = LiveRecordingBarPresentation.resolve
        defer { LiveRecordingBarPresentation.resolve = resolve }
        var complete: ((Bool) -> Void)?
        LiveRecordingBarPresentation.resolve = { _, _ in
            LiveRecordingBarPresentation(show: { complete = $0 }, update: { _ in }, close: {})
        }
        let recording = LiveRecording(id: "handoff", kind: "library", title: "Adoption fixture",
                                      pid: 7, startedAt: Date(), state: "recording")
        let panel = LiveRecordingPanel(recording: recording, stack: 0, send: { _ in }, hide: {})
        defer { panel.close() }

        panel.show()
        let compact = try XCTUnwrap(NSApplication.shared.windows.first { $0.title == "Recording controls: Adoption fixture" })
        XCTAssertTrue(compact.isVisible)
        try XCTUnwrap(complete)(false)
        XCTAssertTrue(compact.isVisible)

        panel.show()
        try XCTUnwrap(complete)(true)
        XCTAssertFalse(compact.isVisible)
    }

    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("live-recordings-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func write(_ name: String, _ json: String) throws {
        try Data(json.utf8).write(to: folder.appendingPathComponent(name))
    }

    func testDecodesTheContractEntry() throws {
        let json = #"""
        {"version":1,"id":"m-1","kind":"meeting","title":"Standup","pid":4242,"startedAt":"2026-11-03T18:40:00.250Z",
         "state":"paused","displays":[{"id":69733382,"name":"Built-in Retina Display"},{"id":2,"name":"DELL U2723QE"}],
         "frames":340,"lastFrameAt":"2026-11-03T18:52:00Z","warning":"display 2 went away","folder":"/tmp/m-1",
         "controls":["pause","resume","stop"],"socket":"/tmp/m-1.sock"}
        """#
        let entry = try XCTUnwrap(LiveRecordingStore.decode(Data(json.utf8)))
        XCTAssertEqual(entry.id, "m-1")
        XCTAssertEqual(entry.kind, "meeting")
        XCTAssertEqual(entry.title, "Standup")
        XCTAssertEqual(entry.pid, 4242)
        XCTAssertEqual(entry.startedAt.timeIntervalSince1970, 1_793_731_200.25, accuracy: 0.001)
        XCTAssertTrue(entry.isPaused)
        XCTAssertEqual(entry.toggleCommand, .resume)
        XCTAssertEqual(entry.displays, [.init(id: 69_733_382, name: "Built-in Retina Display"), .init(id: 2, name: "DELL U2723QE")])
        XCTAssertEqual(entry.displayNames, "Built-in Retina Display, DELL U2723QE")
        XCTAssertEqual(entry.frames, 340)
        XCTAssertNotNil(entry.lastFrameAt)
        XCTAssertEqual(entry.warning, "display 2 went away")
        XCTAssertEqual(entry.folder, "/tmp/m-1")
        XCTAssertEqual(entry.socket, "/tmp/m-1.sock")
    }

    func testMinimalEntryGetsDefaultsAndMissingRequiredFieldsAreRefused() {
        let minimal = LiveRecordingStore.decode(Data(#"{"pid":7,"startedAt":1762195200000}"#.utf8), fallbackID: "from-name")
        XCTAssertEqual(minimal?.id, "from-name")
        XCTAssertEqual(minimal?.title, "from-name")
        XCTAssertEqual(minimal?.state, "recording")
        XCTAssertEqual(minimal?.toggleCommand, .pause)
        XCTAssertEqual(minimal?.startedAt.timeIntervalSince1970, 1_762_195_200)

        XCTAssertNil(LiveRecordingStore.decode(Data(#"{"id":"x","startedAt":"2026-11-03T18:40:00Z"}"#.utf8)))
        XCTAssertNil(LiveRecordingStore.decode(Data(#"{"id":"x","pid":7}"#.utf8)))
        XCTAssertNil(LiveRecordingStore.decode(Data("not json".utf8)))
    }

    func testStoppingAndMissingControlsAllowNothing() throws {
        let stopping = try XCTUnwrap(LiveRecordingStore.decode(Data(
            #"{"id":"s","pid":7,"startedAt":"2026-11-03T18:40:00Z","state":"stopping"}"#.utf8)))
        XCTAssertNil(stopping.toggleCommand)
        XCTAssertFalse(stopping.allows(.stop))

        let stopOnly = try XCTUnwrap(LiveRecordingStore.decode(Data(
            #"{"id":"o","pid":7,"startedAt":"2026-11-03T18:40:00Z","controls":["stop"]}"#.utf8)))
        XCTAssertNil(stopOnly.toggleCommand)
        XCTAssertTrue(stopOnly.allows(.stop))
    }

    func testLoadKeepsOnlyEntriesWhoseRecorderIsAlive() throws {
        try write("alive.json", #"{"id":"alive","pid":100,"startedAt":"2026-11-03T18:41:00Z"}"#)
        try write("older.json", #"{"id":"older","pid":101,"startedAt":"2026-11-03T18:40:00Z"}"#)
        try write("dead.json", #"{"id":"dead","pid":200,"startedAt":"2026-11-03T18:39:00Z"}"#)
        try write("broken.json", "{")
        try write("alive.commands.jsonl", #"{"command":"stop"}"#)
        try write(".hidden.json", #"{"id":"hidden","pid":100,"startedAt":"2026-11-03T18:41:00Z"}"#)

        let store = LiveRecordingStore(folder: folder, isAlive: { $0.pid < 200 })
        XCTAssertEqual(store.load().map(\.id), ["older", "alive"])
    }

    func testMissingFolderIsNoRecording() {
        let store = LiveRecordingStore(folder: folder.appendingPathComponent("absent"), isAlive: { _ in true })
        XCTAssertEqual(store.load(), [])
    }

    /// A recorder that crashed leaves its entry; when its pid now belongs to a process that started after the entry
    /// was written, the entry is gone, as `tools recorder list --live` says.
    func testAnEntryWhosePidStartedLaterIsGone() throws {
        let formatter = ISO8601DateFormatter()
        let pid = getpid()
        try write("recycled.json", #"{"id":"recycled","pid":\#(pid),"startedAt":"\#(formatter.string(from: Date().addingTimeInterval(-3600)))"}"#)
        try write("own.json", #"{"id":"own","pid":\#(pid),"startedAt":"\#(formatter.string(from: Date()))"}"#)
        XCTAssertEqual(LiveRecordingStore(folder: folder).load().map(\.id), ["own"])
    }

    func testProcessLivenessUsesTheRealProcessTable() {
        XCTAssertTrue(LiveRecordingStore.processIsAlive(getpid()))
        XCTAssertFalse(LiveRecordingStore.processIsAlive(0))
        XCTAssertFalse(LiveRecordingStore.processIsAlive(-1))
    }

    func testFolderHonoursGenesisToolsHome() {
        XCTAssertEqual(LiveRecordingStore.folder(environment: ["GENESIS_TOOLS_HOME": "/sandbox"], home: "/Users/x").path,
                       "/sandbox/.genesis-tools/recordings/live")
        XCTAssertEqual(LiveRecordingStore.folder(environment: ["GENESIS_TOOLS_HOME": ""], home: "/Users/x").path,
                       "/Users/x/.genesis-tools/recordings/live")
    }

    func testMenuDetailLine() {
        let start = Date(timeIntervalSince1970: 1_000)
        let entry = LiveRecording(id: "c", kind: "control-session", title: "t", pid: 1, startedAt: start,
                                  state: "paused", frames: 1)
        XCTAssertEqual(LiveRecordingsStatusItem.detail(entry, now: start.addingTimeInterval(723)),
                       "Control session · 12:03 · 1 frame · paused")
        let movie = LiveRecording(id: "m", kind: "control-session", title: "t", pid: 1, startedAt: start,
                                  state: "recording", frames: 0)
        XCTAssertEqual(LiveRecordingsStatusItem.detail(movie, now: start.addingTimeInterval(5)),
                       "Control session · 0:05", "a movie keeps no frames, so it shows no count")
    }
}
