import AppKit
import Combine
import SwiftUI
import XCTest
@testable import GenesisKit

@MainActor
final class WidgetVideoInteractionTests: XCTestCase {
    private let initial = WidgetVideoSettings(fps: 2, framesPerImage: 16, minimumDifferencePct: 0)
    func testVideoRangeClampsCrossingHandlesAndRestoresWholeVideo() throws {
        let legacy = try JSONDecoder().decode(WidgetVideoSettings.self,
            from: Data(#"{"fps":2,"framesPerImage":16,"minimumDifferencePct":0}"#.utf8))
        XCTAssertEqual(legacy.sampleRange(durationUs: 12_000_000), 0...12_000_000)
        var settings = legacy
        settings.setSampleStart(seconds: 2.1, durationUs: 12_000_000)
        settings.setSampleEnd(seconds: 3.2, durationUs: 12_000_000)
        XCTAssertEqual(settings.sampleRange(durationUs: 12_000_000), 2_100_000...3_200_000)
        settings.setSampleStart(seconds: 9, durationUs: 12_000_000)
        XCTAssertEqual(settings.startUs, 3_190_000)
        settings.setSampleEnd(seconds: 1, durationUs: 12_000_000)
        XCTAssertEqual(settings.endUs, 3_200_000)
        settings.setSampleStart(seconds: -.infinity, durationUs: 12_000_000)
        XCTAssertEqual(settings.startUs, 3_190_000)
        settings.setSampleStart(seconds: 0, durationUs: 12_000_000)
        settings.setSampleEnd(seconds: 12, durationUs: 12_000_000)
        XCTAssertEqual(settings, legacy)
    }

    func testDoneImmediatelyAfterChangePersistsLatestExactlyOnce() {
        var committed: [WidgetVideoSettings] = []
        let editor = WidgetVideoSettingsCommitter(initial: initial) { committed.append($0) }
        let latest = WidgetVideoSettings(fps: 4, framesPerImage: 8, minimumDifferencePct: 25, startUs: 2_100_000, endUs: 3_200_000)
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

    func testStructuredFailuresNeverExposeDiagnosticStderr() async throws {
        for code in ["microphone_permission", "no_audio", "capture_interrupted", "capture_failed"] {
            let (binary, directory) = try fixture("echo '[ai-stt-capture] private fixture diagnostic' >&2; echo '{\"kind\":\"error\",\"code\":\"\(code)\",\"text\":\"untrusted raw diagnostic\"}'; exit 1\n")
            defer { try? FileManager.default.removeItem(at: directory) }
            do { _ = try await VoiceCommandTransport(binaryPath: binary).run(args: ["record"]); XCTFail("must fail") }
            catch {
                XCTAssertEqual(error as? VoiceCommandFailure, VoiceCommandFailure(rawValue: code))
                XCTAssertFalse(error.localizedDescription.contains("diagnostic"))
                XCTAssertFalse(error.localizedDescription.contains("ai-stt"))
            }
        }
    }

    func testUnexpectedTerminationIsNotPermissionDenialOrUserCancellation() async throws {
        let (binary, directory) = try fixture("echo '[ai-stt-capture] code143 bytes0' >&2; exit 143\n")
        defer { try? FileManager.default.removeItem(at: directory) }
        do { _ = try await VoiceCommandTransport(binaryPath: binary).run(args: ["record"]); XCTFail("must fail") }
        catch {
            XCTAssertEqual(error as? VoiceCommandFailure, .interrupted)
            XCTAssertFalse(error is CancellationError)
            XCTAssertFalse(error.localizedDescription.contains("permission"))
            XCTAssertFalse(error.localizedDescription.contains("143"))
        }
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
                      attach: @escaping (WidgetSession, WidgetVoiceNote) async throws -> String = { _, _ in "Draft saved" },
                      permission: @escaping () -> VoiceMicrophonePermission = { .authorized },
                      prompt: @escaping () async throws -> VoiceMicrophonePermission = { XCTFail("unexpected permission request"); return .denied },
                      activate: @escaping () -> Void = {},
                      acquire: @escaping () async throws -> any VoiceRecordingLease = { FixtureVoiceLease() },
                      openSettings: @escaping () -> Void = {},
                      recipients: [WidgetSession]? = nil) -> WidgetVoiceNotesStore {
        WidgetVoiceNotesStore(micLauncher: "/fixture/Preview.app/Contents/MacOS/launcher", request: request,
            execute: execute, finishCapture: {}, cancelCommand: {}, acquireAudio: acquire,
            settings: { WidgetVoiceNoteSettings(provider: "fixture", model: "test-model", language: "en") },
            sessions: { recipients ?? [self.recipient] }, attachDraft: attach, readMicrophonePermission: permission,
            requestMicrophonePermission: prompt, activateForMicrophone: activate, openMicrophoneSettings: openSettings)
    }

    func testOpeningVoiceNotesDoesNotBuildHundredsOfRecipientMenuItems() async throws {
        _ = NSApplication.shared
        let recipients = (0..<800).map { index in
            var session = recipient
            session.key = "fixture-\(index)"
            session.title = "Fixture \(index)"
            return session
        }
        let store = make(request: { _ in
            try self.data(["revision": 0, "notes": [self.note()], "statePath": "/fixture/widget/voice-notes/notes.json"])
        }, recipients: recipients)
        defer { store.stop() }
        store.refresh()
        await store.waitForRefresh()
        XCTAssertEqual(store.sessions.count, 800)
        XCTAssertNotNil(store.selected)
        let host = NSHostingView(rootView: store.voiceNotesModule().content(.expanded))
        host.sizingOptions = []
        let window = NSWindow(contentRect: CGRect(x: -10000, y: -10000, width: 432, height: 540),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.alphaValue = 0
        window.level = NSWindow.Level(rawValue: -1000)
        window.contentView = host
        defer { window.close() }
        window.order(.below, relativeTo: 0)
        host.layoutSubtreeIfNeeded()
        func menus(_ view: NSView) -> [NSPopUpButton] {
            if let popup = view as? NSPopUpButton { return [popup] }
            return view.subviews.flatMap(menus)
        }
        let popups = menus(host)
        XCTAssertFalse(popups.isEmpty, "The recording selector proves the native controls were instantiated")
        let itemCounts = popups.map { $0.numberOfItems }
        XCTAssertLessThanOrEqual(itemCounts.max() ?? 0, 2, "A closed recipient picker must not build the whole roster")
        print("VOICE_RECIPIENT_MENU_COUNTS recipients=800 counts=\(itemCounts)")
    }

    func testKnownDeniedAndRestrictedPermissionsNeverAcquireAudioOrSpawn() async throws {
        for state in [VoiceMicrophonePermission.denied, .restricted] {
            var activated = 0
            var settingsOpened = 0
            let store = make(request: { _ in try self.data(["revision": 0, "notes": [], "statePath": "/fixture/widget/voice-notes/notes.json"]) },
                execute: { _, _, _ in XCTFail("must not spawn capture"); throw CancellationError() },
                permission: { state }, activate: { activated += 1 },
                acquire: { XCTFail("must not acquire microphone lease"); return FixtureVoiceLease() },
                openSettings: { settingsOpened += 1 })
            XCTAssertEqual(activated, 0)
            XCTAssertEqual(settingsOpened, 0)
            store.record()
            await store.waitForOperation()
            await store.waitForRefresh()
            XCTAssertEqual(store.microphonePermission, state)
            XCTAssertTrue(store.presentsMicrophoneAlert)
            XCTAssertNotNil(store.microphonePermission.guidance)
            XCTAssertEqual(activated, 1)
            store.openMicrophoneSettings()
            XCTAssertEqual(settingsOpened, 1)
            store.stop()
        }
    }

    func testExplicitRecordPromptsOnceBeforeLeaseAndAuthorizedCaptureStillWorks() async throws {
        var calls: [String] = []
        var permission = VoiceMicrophonePermission.notDetermined
        let store = make(request: { _ in try self.data(["revision": 0, "notes": [], "statePath": "/fixture/widget/voice-notes/notes.json"]) },
            execute: { _, lease, _ in
                calls.append("capture")
                try await lease?.release()
                return try self.data(["kind": "recorded", "note": self.note()])
            }, permission: { permission }, prompt: {
                calls.append("prompt")
                permission = .authorized
                return permission
            }, activate: { calls.append("activate") }, acquire: { calls.append("lease"); return FixtureVoiceLease() })
        XCTAssertTrue(calls.isEmpty)
        store.record()
        store.record()
        await store.waitForOperation()
        XCTAssertEqual(calls, ["activate", "prompt", "lease", "capture"])
        XCTAssertEqual(store.microphonePermission, .authorized)
        XCTAssertNil(store.error)
        XCTAssertEqual(store.notes.count, 1)
        store.record()
        await store.waitForOperation()
        XCTAssertEqual(calls, ["activate", "prompt", "lease", "capture", "lease", "capture"])
        store.stop()
    }

    func testDecliningFirstUseRemainsVisibleAndDoesNotStartCapture() async throws {
        var permission = VoiceMicrophonePermission.notDetermined
        let store = make(request: { _ in try self.data(["revision": 0, "notes": [], "statePath": "/fixture/widget/voice-notes/notes.json"]) },
            permission: { permission }, prompt: { permission = .denied; return permission },
            acquire: { XCTFail("declined permission must not acquire capture"); return FixtureVoiceLease() })
        store.record()
        await store.waitForOperation()
        await store.waitForRefresh()
        XCTAssertEqual(store.microphonePermission, .denied)
        XCTAssertTrue(store.presentsMicrophoneAlert)
        XCTAssertTrue(store.microphoneGuidance?.contains("Microphone") == true)
        permission = .authorized
        store.refreshMicrophonePermission()
        XCTAssertNil(store.microphoneGuidance)
        store.stop()
    }

    func testCancellationDuringPermissionCannotStartLateCapture() async throws {
        let waiting = expectation(description: "permission request")
        var finish: CheckedContinuation<VoiceMicrophonePermission, Error>?
        let store = make(request: { _ in try self.data(["revision": 0, "notes": [], "statePath": "/fixture/widget/voice-notes/notes.json"]) },
            permission: { .notDetermined }, prompt: {
                try await withCheckedThrowingContinuation { continuation in finish = continuation; waiting.fulfill() }
            }, acquire: { XCTFail("cancelled prompt must not acquire audio"); return FixtureVoiceLease() })
        store.record()
        await fulfillment(of: [waiting], timeout: 2)
        XCTAssertEqual(store.phase, "Waiting for microphone permission")
        store.cancel()
        finish?.resume(returning: .authorized)
        await store.waitForOperation()
        XCTAssertNil(store.error)
        XCTAssertTrue(store.receipt?.contains("Stopped") == true)
        store.stop()
    }

    func testSyntheticCaptureBypassesMicrophonePermissionAndNoAudioDoesNotClaimDenial() async throws {
        let store = make(request: { _ in try self.data(["revision": 0, "notes": [], "statePath": "/fixture/widget/voice-notes/notes.json"]) },
            execute: { _, lease, _ in try await lease?.release(); throw VoiceCommandFailure.noAudio },
            permission: { .authorized }, activate: { XCTFail("no permission UI for fixture") })
        store.record(input: "/fixture/synthetic.pcm")
        await store.waitForOperation()
        XCTAssertEqual(store.microphonePermission, .authorized)
        XCTAssertFalse(store.presentsMicrophoneAlert)
        XCTAssertTrue(store.error?.contains("No audio") == true)
        store.stop()
    }

    func testRenderPersistentPermissionAndCaptureErrorStates() async throws {
        guard let directory = ProcessInfo.processInfo.environment["VOICE_PERMISSION_SCREENSHOT_DIR"] else {
            throw XCTSkip("Set VOICE_PERMISSION_SCREENSHOT_DIR for isolated rendering")
        }
        let prefix = ProcessInfo.processInfo.environment["VOICE_PERMISSION_SCREENSHOT_PREFIX"] ?? "VoiceNotes"
        for state in [VoiceMicrophonePermission.notDetermined, .denied, .authorized] {
            let store = make(request: { _ in try self.data(["revision": 0, "notes": [], "statePath": "/fixture/widget/voice-notes/notes.json"]) },
                execute: { _, lease, _ in try await lease?.release(); throw VoiceCommandFailure.noAudio }, permission: { state })
            if state == .authorized {
                store.record(input: "/fixture/synthetic.pcm")
                await store.waitForOperation()
            }
            let host = NSHostingView(rootView: store.voiceNotesModule().content(.expanded)
                .background(Color.settingsBackground).environment(\.colorScheme, .dark))
            host.frame = NSRect(x: 0, y: 0, width: 432, height: 580)
            host.layoutSubtreeIfNeeded()
            let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(prefix)-\(state).png"))
            var bright = 0
            for y in stride(from: 0, to: bitmap.pixelsHigh, by: 8) {
                for x in stride(from: 0, to: bitmap.pixelsWide, by: 8) {
                    if let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB),
                       color.redComponent + color.greenComponent + color.blueComponent > 1.5 { bright += 1 }
                }
            }
            XCTAssertGreaterThan(bright, 10)
            store.stop()
        }
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

final class ToolsLineBufferTests: XCTestCase {
    func testArbitraryChunkBoundariesPreserveUnicodeEmptyLinesAndCarriageReturns() {
        let bytes = Data("\nfirst\nŽluťoučký 🫧\r\n\nlast\nincomplete".utf8)
        for size in 1...bytes.count {
            var buffer = ToolsLineBuffer()
            var lines: [String] = []
            for offset in stride(from: 0, to: bytes.count, by: size) {
                lines += buffer.append(bytes.subdata(in: offset..<min(offset + size, bytes.count)))
            }
            XCTAssertEqual(lines, ["first", "Žluťoučký 🫧\r", "last"])
            XCTAssertEqual(buffer.append(Data(" tail\n".utf8)), ["incomplete tail"])
            XCTAssertTrue(buffer.append(Data()).isEmpty)
            XCTAssertEqual(buffer.append(Data("next\n".utf8)), ["next"])
        }
    }

    func testFragmentedLargeSnapshotDoesNotRescanPrefixes() {
        let payload = Data(repeating: 0x61, count: 512 * 1024)
        var buffer = ToolsLineBuffer()
        for offset in stride(from: 0, to: payload.count, by: 4096) {
            XCTAssertTrue(buffer.append(payload.subdata(in: offset..<min(offset + 4096, payload.count))).isEmpty)
        }
        XCTAssertEqual(buffer.append(Data([0x0A])).first?.utf8.count, payload.count)
        XCTAssertEqual(buffer.scannedBytes, payload.count + 1)
    }

    func testFragmentedSnapshotCPUCost() throws {
        guard ProcessInfo.processInfo.environment["LINE_BUFFER_BENCH"] == "1" else {
            throw XCTSkip("Set LINE_BUFFER_BENCH=1 for the fragmented 512KiB stream benchmark")
        }
        let chunks = Array(repeating: Data(repeating: 0x61, count: 4096), count: 128) + [Data([0x0A])]
        func cpu() -> Double {
            var usage = rusage()
            getrusage(RUSAGE_SELF, &usage)
            return Double(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) * 1000
                + Double(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1000
        }
        for repetition in 0..<3 {
            var buffer = ToolsLineBuffer()
            var output: [String] = []
            let start = cpu()
            for chunk in chunks { output += buffer.append(chunk) }
            let elapsed = cpu() - start
            XCTAssertEqual(output.count, 1)
            XCTAssertEqual(output[0].utf8.count, 512 * 1024)
            print("LINE_BUFFER_BENCH repetition=\(repetition) bytes=524289 scanned=\(buffer.scannedBytes) cpu-ms=\(elapsed)")
        }
    }
}
