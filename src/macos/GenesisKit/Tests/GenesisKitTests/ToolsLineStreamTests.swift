import Combine
import XCTest
@testable import GenesisKit

@MainActor
final class WidgetVideoInteractionTests: XCTestCase {
    private let initial = WidgetVideoSettings(fps: 2, framesPerImage: 16, minimumDifferencePct: 0)
    func testDoneImmediatelyAfterChangePersistsLatestExactlyOnce() {
        var committed: [WidgetVideoSettings] = []
        let editor = WidgetVideoSettingsCommitter(initial: initial) { committed.append($0) }
        let latest = WidgetVideoSettings(fps: 4, framesPerImage: 8, minimumDifferencePct: 25)
        editor.update(WidgetVideoSettings(fps: 1, framesPerImage: 4, minimumDifferencePct: 10))
        editor.update(latest)
        editor.finish()
        editor.finish()
        XCTAssertEqual(committed, [latest])
    }
    func testOrdinaryDebounceStillCommitsAndUnchangedCloseDoesNothing() async {
        let saved = expectation(description: "debounced settings")
        var count = 0
        let editor = WidgetVideoSettingsCommitter(initial: initial) { _ in count += 1; saved.fulfill() }
        editor.finish()
        XCTAssertEqual(count, 0)
        editor.update(WidgetVideoSettings(fps: 1, framesPerImage: 4, minimumDifferencePct: 0))
        await fulfillment(of: [saved], timeout: 2)
        editor.finish()
        XCTAssertEqual(count, 1)
    }
    private func outgoing() -> WidgetOutgoing {
        WidgetOutgoing(id: "fixture-video", target: .init(hostId: "local", provider: "codex", sessionId: "fixture", sourceHome: "", cwd: "/fixture"),
            payload: ["kind": "followup", "text": "Earlier text"], assetIds: ["video"], createdAt: 1, sequence: 1, state: "preparing")
    }
    func testEditRefusesNewerLocalDraftBeforeBackendMutation() async {
        let defaults = UserDefaults(suiteName: "video-edit-\(UUID())")!
        let model = WidgetModel(binaryPath: "/fixture/no-process", defaults: defaults)
        defer { model.stop() }
        model.selectedKey = "chosen"
        model.setText("New unsaved text")
        var edits = 0
        model.actionRunner = { value in
            if case .object(let fields) = value, fields["action"] == .string("edit") { edits += 1 }
            return ["updated": true]
        }
        let finished = expectation(description: "queue drained")
        model.editOutgoing(outgoing())
        model.action(["action": "fixture-barrier"], completed: { finished.fulfill() })
        await fulfillment(of: [finished], timeout: 2)
        XCTAssertEqual(edits, 0)
        XCTAssertEqual(model.drafts["chosen"]?.text, "New unsaved text")
        XCTAssertTrue(model.error?.contains("current draft") == true)
    }
    func testEditIntoEmptyDraftStillCallsBackendAndShowsRestoreReceipt() async {
        let defaults = UserDefaults(suiteName: "video-edit-\(UUID())")!
        let model = WidgetModel(binaryPath: "/fixture/no-process", defaults: defaults)
        defer { model.stop() }
        model.selectedKey = "chosen"
        var edits = 0
        model.actionRunner = { value in
            if case .object(let fields) = value, fields["action"] == .string("edit") { edits += 1 }
            return ["updated": true]
        }
        let finished = expectation(description: "queue drained")
        model.editOutgoing(outgoing())
        model.action(["action": "fixture-barrier"], completed: { finished.fulfill() })
        await fulfillment(of: [finished], timeout: 2)
        XCTAssertEqual(edits, 1)
        XCTAssertEqual(model.notice, "Message restored as a draft.")
        XCTAssertNil(model.error)
    }
    func testTypingDuringEditRemainsRecoverableAfterStop() async {
        let defaults = UserDefaults(suiteName: "video-edit-\(UUID())")!
        let model = WidgetModel(binaryPath: "/fixture/no-process", defaults: defaults)
        model.selectedKey = "chosen"
        let began = expectation(description: "edit begins")
        let finished = expectation(description: "edit finishes")
        var release: CheckedContinuation<Void, Never>?
        model.actionRunner = { value in
            if case .object(let fields) = value, fields["action"] == .string("edit") {
                await withCheckedContinuation { continuation in release = continuation; began.fulfill() }
            }
            return ["updated": true]
        }
        let subscription = model.$notice.compactMap { $0 }.prefix(1).sink { _ in finished.fulfill() }
        model.editOutgoing(outgoing())
        await fulfillment(of: [began], timeout: 2)
        model.setText("Typed during restore")
        release?.resume()
        await fulfillment(of: [finished], timeout: 2)
        model.stop()
        XCTAssertEqual(model.drafts["chosen"]?.text, "Typed during restore")
        XCTAssertEqual(defaults.string(forKey: "widget.recovered-draft.chosen"), "Typed during restore")
        withExtendedLifetime(subscription) {}
    }
    func testQueuedMediaCanCancelUntilDeliveryBoundary() {
        for state in ["queued", "preparing", "review", "failed", "waiting-route"] {
            XCTAssertTrue(WidgetOutgoingControls.canCancel(state), state)
        }
        for state in ["dispatching", "sent", "cancelled", "unknown"] {
            XCTAssertFalse(WidgetOutgoingControls.canCancel(state), state)
        }
    }
}

@MainActor
private final class FixtureVoiceLease: VoiceRecordingLease {
    var pid: Int32?
    var releases = 0
    var reject = false
    func attachRecorder(pid: Int32) async throws {
        if reject { throw ToolsBridgeError.refused("fixture admission refused") }
        self.pid = pid
    }
    func release() async throws {
        if let pid { XCTAssertEqual(kill(pid, 0), -1, "lease released while recorder was still alive") }
        releases += 1
    }
}

@MainActor
final class VoiceCommandTransportTests: XCTestCase {
    private func fixture(_ body: String) throws -> (String, URL) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("voice-transport-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let script = directory.appendingPathComponent("tools")
        try ("#!/bin/sh\n" + body).write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        return (script.path, directory)
    }

    func testExplicitStateRootReachesRecorderCommand() async throws {
        let (binary, directory) = try fixture("echo '{\"kind\":\"transcribed\",\"args\":\"'\"$*\"'\"}'\n")
        defer { try? FileManager.default.removeItem(at: directory) }
        let transport = VoiceCommandTransport(binaryPath: binary, stateRoot: "/fixture/isolated")
        let result = try await transport.run(args: ["transcribe", "fixture"])
        XCTAssertTrue(String(decoding: result, as: UTF8.self).contains("widget --state-root /fixture/isolated voice-notes transcribe fixture"))
    }

    func testAdmissionPrecedesGateAndReleaseFollowsRealExit() async throws {
        let (binary, directory) = try fixture("echo '{\"kind\":\"ready\",\"pid\":'$$'}'; read gate; [ \"$gate\" = start ] || exit 4; echo '{\"kind\":\"recorded\",\"note\":{}}'\n")
        defer { try? FileManager.default.removeItem(at: directory) }
        let lease = FixtureVoiceLease()
        let transport = VoiceCommandTransport(binaryPath: binary)
        let data = try await transport.run(args: ["record"], lease: lease)
        XCTAssertTrue(String(decoding: data, as: UTF8.self).contains("recorded"))
        XCTAssertNotNil(lease.pid)
        XCTAssertEqual(lease.releases, 1)
    }

    func testRejectedAdmissionNeverOpensStartGate() async throws {
        let (binary, directory) = try fixture("echo '{\"kind\":\"ready\",\"pid\":'$$'}'; read gate; [ \"$gate\" = start ] && touch started; exit 0\n")
        defer { try? FileManager.default.removeItem(at: directory) }
        let lease = FixtureVoiceLease()
        lease.reject = true
        let transport = VoiceCommandTransport(binaryPath: binary)
        do { _ = try await transport.run(args: ["record"], lease: lease); XCTFail("must refuse") }
        catch { XCTAssertTrue(error.localizedDescription.contains("fixture admission refused")) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("started").path))
        XCTAssertEqual(lease.releases, 1)
    }

    func testCancellationStopsRecorderBeforeRelease() async throws {
        let (binary, directory) = try fixture("echo '{\"kind\":\"ready\",\"pid\":'$$'}'; read gate; echo '{\"kind\":\"recording\"}'; cat >/dev/null\n")
        defer { try? FileManager.default.removeItem(at: directory) }
        let lease = FixtureVoiceLease()
        let transport = VoiceCommandTransport(binaryPath: binary)
        let started = expectation(description: "recording")
        let task = Task { try await transport.run(args: ["record"], lease: lease) { event in
            if event.kind == "recording" { started.fulfill() }
        } }
        await fulfillment(of: [started], timeout: 5)
        task.cancel()
        do { _ = try await task.value; XCTFail("must cancel") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertEqual(lease.releases, 1)
    }
}

@MainActor
final class WidgetVoiceNotesStoreTests: XCTestCase {
    private let noteID = "12345678-1234-4234-8234-123456789abc"
    private func note(_ text: String = "Saved words", revision: Int = 1) -> [String: Any] {
        ["id": noteID, "revision": revision, "createdAt": 1, "text": text, "recognizedText": text,
         "transcription": "ready", "clip": ["path": "/fixture/note.pcm", "bytes": 3200, "durationMs": 100]]
    }
    private func data(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value) }
    private var recipient: WidgetSession {
        WidgetSession(key: "fixture-codex", target: .init(hostId: "local", provider: "codex", sessionId: "fixture", sourceHome: "", cwd: "/fixture"),
            title: "Fixture session", project: "Fixture", activityAt: 0, status: "recent", pinned: false, visible: true, hiddenByFilter: false)
    }
    private func make(request: @escaping ([String]) async throws -> Data,
                      execute: @escaping ([String], (any VoiceRecordingLease)?, @escaping (VoiceCommandEvent) -> Void) async throws -> Data = { _, _, _ in throw ToolsBridgeError.refused("unexpected provider") },
                      attach: @escaping (WidgetSession, WidgetVoiceNote) async throws -> String = { _, _ in "Draft saved" }) -> WidgetVoiceNotesStore {
        WidgetVoiceNotesStore(micLauncher: "/fixture/Preview.app/Contents/MacOS/launcher", request: request,
            execute: execute, finishCapture: {}, cancelCommand: {}, acquireAudio: { FixtureVoiceLease() },
            settings: { WidgetVoiceNoteSettings(provider: "fixture", model: "test-model", language: "en") },
            sessions: { [self.recipient] }, attachDraft: attach)
    }

    func testWarmCacheAndReadOnlyEmptyView() async throws {
        var requests = 0
        let store = make(request: { _ in
            requests += 1
            return try self.data(["revision": 0, "notes": [], "statePath": "/fixture/widget/voice-notes/notes.json"])
        })
        store.refresh()
        await store.waitForRefresh()
        store.refresh()
        await store.waitForRefresh()
        XCTAssertEqual(requests, 1)
        XCTAssertTrue(store.notes.isEmpty)
        XCTAssertNil(store.phase)
        XCTAssertNil(store.error)
        store.stop()
        store.refresh(force: true)
        XCTAssertEqual(requests, 1)
    }

    func testEditBeforeExplicitAttachPinsRecipientAndNeverTranscribes() async throws {
        var attached = 0
        var edited = ""
        let store = make(request: { args in
            switch args[0] {
            case "list": return try self.data(["revision": 1, "notes": [self.note()], "statePath": "/fixture/widget/voice-notes/notes.json"])
            case "edit":
                edited = try String(contentsOfFile: args.last!, encoding: .utf8)
                XCTAssertEqual(args[1], self.noteID)
                XCTAssertEqual(args[3], "1")
                return try self.data(self.note(edited, revision: 2))
            default: throw ToolsBridgeError.refused("unexpected command")
            }
        }, attach: { session, note in
            attached += 1
            XCTAssertEqual(session.key, self.recipient.key)
            XCTAssertEqual(note.text, "Reviewed words")
            XCTAssertEqual(note.revision, 2)
            return "Attached to fixture draft"
        })
        store.refresh()
        await store.waitForRefresh()
        store.text = "Reviewed words"
        XCTAssertEqual(attached, 0)
        store.recipientKey = recipient.key
        store.attach()
        await store.waitForOperation()
        XCTAssertEqual(edited, "Reviewed words")
        XCTAssertEqual(attached, 1)
        XCTAssertEqual(store.receipt, "Attached to fixture draft")
        store.stop()
    }

    func testStaleRevisionRefusesAttachAndPreservesLocalEdit() async throws {
        var attached = false
        let store = make(request: { args in
            if args[0] == "list" { return try self.data(["revision": 1, "notes": [self.note()], "statePath": "/fixture/widget/voice-notes/notes.json"]) }
            throw ToolsBridgeError.refused("Voice note changed; reload before saving this revision")
        }, attach: { _, _ in attached = true; return "wrong" })
        store.refresh()
        await store.waitForRefresh()
        store.text = "Unsaved review"
        store.recipientKey = recipient.key
        store.attach()
        await store.waitForOperation()
        await store.waitForRefresh()
        XCTAssertFalse(attached)
        XCTAssertTrue(store.error?.contains("changed") == true)
        XCTAssertEqual(store.text, "Unsaved review")
        store.stop()
    }

    func testLateListCannotReplaceNewRecording() async throws {
        var complete: CheckedContinuation<Data, Error>?
        let started = expectation(description: "list started")
        let store = make(request: { _ in
            try await withCheckedThrowingContinuation { continuation in
                complete = continuation
                started.fulfill()
            }
        }, execute: { _, lease, _ in
            try await lease?.release()
            return try self.data(["kind": "recorded", "note": self.note("New recording")])
        })
        store.refresh()
        await fulfillment(of: [started], timeout: 2)
        store.record(input: "/fixture/synthetic.pcm")
        await store.waitForOperation()
        complete?.resume(returning: try data(["revision": 0, "notes": [], "statePath": "/fixture/widget/voice-notes/notes.json"]))
        await store.waitForRefresh()
        XCTAssertEqual(store.notes.count, 1)
        XCTAssertEqual(store.text, "New recording")
        store.stop()
    }

    func testFailedTranscriptionCanRetryWithSameSettings() async throws {
        var attempts = 0
        let store = make(request: { args in
            if args[0] == "show" { return try self.data(self.note("")) }
            return try self.data(["revision": 1, "notes": [self.note("")], "statePath": "/fixture/widget/voice-notes/notes.json"])
        }, execute: { args, lease, _ in
            XCTAssertNil(lease)
            XCTAssertTrue(args.contains("test-model"))
            XCTAssertTrue(args.contains("en"))
            attempts += 1
            if attempts == 1 { throw ToolsBridgeError.refused("fixture speech failure") }
            return try self.data(["kind": "transcribed", "note": self.note("Recovered words", revision: 2)])
        })
        store.refresh()
        await store.waitForRefresh()
        store.transcribe()
        await store.waitForOperation()
        await store.waitForRefresh()
        XCTAssertTrue(store.error?.contains("fixture speech failure") == true)
        store.transcribe()
        await store.waitForOperation()
        XCTAssertEqual(store.text, "Recovered words")
        XCTAssertEqual(attempts, 2)
        XCTAssertNil(store.error)
        store.stop()
    }
}

@MainActor
final class ToolsLineStreamTests: XCTestCase {
    private func script(_ body: String) throws -> (ToolsBridge, URL) {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("line-stream-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("tools")
        try "#!/bin/sh\n\(body)\n".write(to: file, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
        return (ToolsBridge(binaryPath: file.path), dir)
    }

    func testDeliversWholeLinesThenTheExit() throws {
        let (bridge, dir) = try script("printf 'one\\ntw'; printf 'o\\nthree\\n'; echo oops >&2; exit 3")
        defer { try? FileManager.default.removeItem(at: dir) }
        var lines: [String] = []
        let exited = expectation(description: "exit")
        var report: ToolsLineStream.Exit?
        let stream = try ToolsLineStream(bridge: bridge, subcommand: "x", args: [], onLines: { lines += $0 }, onExit: {
            report = $0
            exited.fulfill()
        })
        wait(for: [exited], timeout: 5)
        XCTAssertEqual(lines, ["one", "two", "three"])
        XCTAssertEqual(report?.status, 3)
        XCTAssertEqual(report?.stopped, false)
        XCTAssertEqual(report?.stderr, "oops\n")
        _ = stream
    }

    func testGracefulInputEndStillDeliversTheFinalTranscript() throws {
        let (bridge, dir) = try script("echo ready; cat >/dev/null; echo final")
        defer { try? FileManager.default.removeItem(at: dir) }
        let ready = expectation(description: "ready")
        let exited = expectation(description: "exit")
        var lines: [String] = []
        var report: ToolsLineStream.Exit?
        let stream = try ToolsLineStream(bridge: bridge, subcommand: "x", args: [], onLines: {
            lines += $0
            if $0.contains("ready") { ready.fulfill() }
        }, onExit: {
            report = $0
            exited.fulfill()
        })
        wait(for: [ready], timeout: 5)
        stream.finishInput()
        wait(for: [exited], timeout: 5)
        XCTAssertEqual(lines, ["ready", "final"])
        XCTAssertEqual(report?.status, 0)
        XCTAssertEqual(report?.stopped, false)
    }

    func testStartGateDeliveryAndClosedInputRefusal() throws {
        let (bridge, dir) = try script("read gate; echo received-$gate; cat >/dev/null")
        defer { try? FileManager.default.removeItem(at: dir) }
        let received = expectation(description: "gate delivered")
        let exited = expectation(description: "exit")
        let stream = try ToolsLineStream(bridge: bridge, subcommand: "x", args: [], onLines: {
            XCTAssertEqual($0, ["received-start"])
            received.fulfill()
        }, onExit: { _ in exited.fulfill() })
        try stream.sendInput("start\n")
        wait(for: [received], timeout: 5)
        stream.finishInput()
        XCTAssertThrowsError(try stream.sendInput("start\n"))
        wait(for: [exited], timeout: 5)
        XCTAssertThrowsError(try stream.sendInput("start\n"))
    }

    func testClosedReaderThrowsWithoutSIGPIPE() throws {
        let (bridge, dir) = try script("exec 0<&-; echo closed; sleep 1")
        defer { try? FileManager.default.removeItem(at: dir) }
        let closed = expectation(description: "reader closed")
        let exited = expectation(description: "exit")
        let stream = try ToolsLineStream(bridge: bridge, subcommand: "x", args: [], onLines: { _ in closed.fulfill() },
                                         onExit: { _ in exited.fulfill() })
        wait(for: [closed], timeout: 5)
        XCTAssertThrowsError(try stream.sendInput("start\n"))
        stream.stop()
        wait(for: [exited], timeout: 5)
    }

    func testStopClosesStdinSoAStdinWatcherEnds() throws {
        // `cat` stands in for a `--live` follow: it runs until its stdin closes.
        let (bridge, dir) = try script("echo ready; exec cat")
        defer { try? FileManager.default.removeItem(at: dir) }
        let ready = expectation(description: "ready")
        let exited = expectation(description: "exit")
        var report: ToolsLineStream.Exit?
        let stream = try ToolsLineStream(bridge: bridge, subcommand: "x", args: [], onLines: { _ in ready.fulfill() }, onExit: {
            report = $0
            exited.fulfill()
        })
        wait(for: [ready], timeout: 5)
        stream.stop()
        wait(for: [exited], timeout: 5)
        XCTAssertEqual(report?.stopped, true)
    }
}
