import Foundation
import Darwin
import XCTest
@testable import GenesisKit

@MainActor
final class FlowFocusRuntimeTests: XCTestCase {
    private var directory: URL!

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("flow-focus-runtime-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try FileManager.default.removeItem(at: directory)
    }

    func testExplicitDataRootCannotReuseProductionConfigurationOrModels() async throws {
        let flowRoot = directory.appendingPathComponent("flow")
        try FileManager.default.createDirectory(at: flowRoot, withIntermediateDirectories: true)
        var config = FlowConfig()
        config.localeIdentifier = "en-GB"
        try JSONEncoder().encode(config).write(to: flowRoot.appendingPathComponent("config.json"))
        let runtime = FlowFocusRuntime(dataRoot: directory, hostID: "test.isolated", liveServices: false,
                                       presentsWindows: false, sharedModels: true)
        XCTAssertEqual(runtime.configuration.directory, directory)
        XCTAssertEqual(runtime.flow.config.localeIdentifier, "en-GB")
        XCTAssertFalse(runtime.flow === FlowSession.shared)
        XCTAssertFalse(runtime.focus === FocusController.shared)
        await runtime.start()
        runtime.configuration.setAppValue(false, forKey: "focusWhileListening")
        await runtime.stop()
        let data = try Data(contentsOf: directory.appendingPathComponent("client.json"))
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual((raw["app"] as? [String: Any])?["focusWhileListening"] as? Bool, false)
    }

    func testOwnerReplaysPendingHistoryBeforeStartingAnyServices() async throws {
        let root = directory.appendingPathComponent("flow")
        let store = FlowStore(directory: root)
        let entry = FlowEntry(text: "Recovery fixture", rawText: "Recovery fixture", targetBundleId: nil,
                              targetAppName: nil, durationSeconds: 2, injected: false, wordCount: 2)
        store.saveHistory([entry])
        store.saveStats(FlowStats(totalWords: 2, totalSeconds: 2, sessionCount: 1))
        let statsURL = root.appendingPathComponent("stats.json")
        store.beforeOwnedWrite = { name in
            guard name == "stats.json" else { return }
            try FileManager.default.removeItem(at: statsURL)
            try FileManager.default.createDirectory(at: statsURL, withIntermediateDirectories: false)
        }
        XCTAssertFalse(store.saveHistoryAndStats(history: [], stats: FlowStats()))
        let blocked = FlowFocusRuntime(dataRoot: directory, hostID: "test.blocked-recovery", liveServices: false, presentsWindows: false)
        await blocked.start()
        XCTAssertFalse(blocked.role.isOwner)
        XCTAssertNil(blocked.focus.engine, "failed recovery must precede timer and recorder construction")
        XCTAssertNotNil(blocked.lastError)
        await blocked.stop()
        try FileManager.default.removeItem(at: statsURL)
        let recovered = FlowFocusRuntime(dataRoot: directory, hostID: "test.recovered", liveServices: false, presentsWindows: false)
        await recovered.start()
        XCTAssertTrue(recovered.role.isOwner)
        XCTAssertTrue(recovered.flow.history.isEmpty)
        XCTAssertEqual(recovered.flow.stats, FlowStats())
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("history-pending.json").path))
        await recovered.stop()
    }

    func testExternalAudioAdmissionSuspendsPreRollAndSurvivesOwnerHandoffUntilRecorderExit() async throws {
        let owner = FlowFocusRuntime(dataRoot: directory, hostID: "test.audio-owner", liveServices: false, presentsWindows: false)
        let client = FlowFocusRuntime(dataRoot: directory, hostID: "test.audio-client", liveServices: false, presentsWindows: false)
        await owner.start()
        await client.start()
        var rolling = false
        var recognitionStarts = 0
        owner.flow.preRollEffect = { rolling = $0 }
        owner.flow.hotkeyBindingEffect = {}
        owner.flow.recognitionStartEffect = { recognitionStarts += 1 }
        owner.flow.config.showPill = false
        owner.flow.config.preRoll = true
        owner.flow.start()
        XCTAssertTrue(rolling)
        owner.flow.beginTurn(captureCurrentTarget: false)
        do {
            _ = try await client.acquireExternalAudio()
            XCTFail("active dictation must retain audio")
        } catch { XCTAssertEqual(owner.flow.phase, .listening) }
        owner.flow.cancelTurn()
        XCTAssertTrue(rolling)
        let input = Pipe()
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/cat")
        child.environment = ["PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"]
        child.standardInput = input
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        let exited = expectation(description: "gated recorder child exited")
        child.terminationHandler = { _ in exited.fulfill() }
        do {
            let audio = try await client.acquireExternalAudio()
            XCTAssertFalse(rolling)
            XCTAssertTrue(owner.flow.externalAudioHeld)
            owner.flow.beginTurn(captureCurrentTarget: false)
            XCTAssertEqual(recognitionStarts, 1, "native dictation cannot race an admitted recorder")
            do {
                _ = try await owner.acquireExternalAudio()
                XCTFail("a second recorder must be refused")
            } catch { XCTAssertTrue(owner.flow.externalAudioHeld) }
            do {
                try await audio.attachRecorder(pid: ProcessInfo.processInfo.processIdentifier)
                XCTFail("the admitted host is not its recorder child")
            } catch { XCTAssertTrue(owner.flow.externalAudioHeld) }
            try child.run()
            try await audio.attachRecorder(pid: child.processIdentifier)
            do {
                try await audio.release()
                XCTFail("audio cannot be returned before the recorder exits")
            } catch { XCTAssertFalse(rolling) }
            await owner.stop()
            try await waitUntil { client.role.isOwner }
            XCTAssertTrue(client.flow.externalAudioHeld, "new owner restores admission before starting services")
            try input.fileHandleForWriting.close()
            await fulfillment(of: [exited], timeout: 2)
            try await waitUntil { !client.flow.externalAudioHeld }
            try await audio.release()
            let next = try await client.acquireExternalAudio()
            try await next.release()
            XCTAssertFalse(client.flow.externalAudioHeld)
        } catch {
            try? input.fileHandleForWriting.close()
            if child.isRunning { child.terminate() }
            await client.stop()
            await owner.stop()
            throw error
        }
        await client.stop()
        await owner.stop()
    }

    func testRecorderExitReleasesAdmissionBeforeItsParentReapsTheChild() async throws {
        let owner = FlowFocusRuntime(dataRoot: directory, hostID: "test.unreaped-recorder", liveServices: false, presentsWindows: false)
        await owner.start()
        let lease = try await owner.acquireExternalAudio()
        var pid: pid_t = 0
        var arguments = [strdup("/bin/sleep"), strdup("0.2"), nil]
        var environment: [UnsafeMutablePointer<CChar>?] = [nil]
        defer { for argument in arguments { free(argument) } }
        let spawned = arguments.withUnsafeMutableBufferPointer { args in
            environment.withUnsafeMutableBufferPointer { env in
                posix_spawn(&pid, "/bin/sleep", nil, nil, args.baseAddress!, env.baseAddress!)
            }
        }
        XCTAssertEqual(spawned, 0)
        var reaped = false
        defer {
            if !reaped, pid > 0 {
                kill(pid, SIGTERM)
                var status: Int32 = 0
                _ = waitpid(pid, &status, WNOHANG)
            }
        }
        do {
            try await lease.attachRecorder(pid: pid)
            try await waitUntil { !owner.flow.externalAudioHeld }
            var status: Int32 = 0
            let waited = waitpid(pid, &status, WNOHANG)
            reaped = waited == pid
            XCTAssertEqual(waited, pid, "the exit event released audio while the child was still unreaped")
            try await lease.release()
        } catch {
            await owner.stop()
            throw error
        }
        await owner.stop()
    }

    func testExpiredUnattachedAdmissionCannotSurviveOwnerStartup() async throws {
        let runtimeDirectory = directory.appendingPathComponent("feature-runtime")
        try FileManager.default.createDirectory(at: runtimeDirectory, withIntermediateDirectories: true)
        let identity = try XCTUnwrap(FlowAudioProcess.read(pid: ProcessInfo.processInfo.processIdentifier))
        let record = FlowAudioAdmission(token: UUID(), holder: identity, recorder: nil, attachBefore: Date.distantPast)
        let file = runtimeDirectory.appendingPathComponent("audio-admission.json")
        try FlowFocusLease.writePrivate(JSONEncoder().encode(record), to: file)
        let owner = FlowFocusRuntime(dataRoot: directory, hostID: "test.expired-admission", liveServices: false, presentsWindows: false)
        await owner.start()
        XCTAssertTrue(owner.role.isOwner)
        XCTAssertFalse(owner.flow.externalAudioHeld)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        await owner.stop()
    }

    func testPermissionActionRunsOnlyInTheStartedElectedHost() async throws {
        let owner = FlowFocusRuntime(dataRoot: directory, hostID: "test.permission-owner", liveServices: false, presentsWindows: false)
        let client = FlowFocusRuntime(dataRoot: directory, hostID: "test.permission-client", liveServices: false, presentsWindows: false)
        await owner.start()
        await client.start()
        var ownerRequests = 0
        owner.flow.permissionRequestEffect = { ownerRequests += 1; return (false, false) }
        client.flow.permissionRequestEffect = { XCTFail("passive client cannot request system access"); return (false, false) }
        do {
            client.flow.requestDictationPermissions()
            try await waitUntil { owner.flow.lastError?.contains("owner is running") == true }
            XCTAssertEqual(ownerRequests, 0, "isolated Preview cannot request live permissions")
            owner.flow.hotkeyBindingEffect = {}
            owner.flow.config.showPill = false
            owner.flow.start()
            let prompted = expectation(description: "owner received explicit permission request")
            owner.flow.permissionRequestEffect = {
                ownerRequests += 1
                prompted.fulfill()
                return (false, false)
            }
            client.flow.requestDictationPermissions()
            await fulfillment(of: [prompted], timeout: 2)
            XCTAssertEqual(ownerRequests, 1)
        } catch {
            await client.stop()
            await owner.stop()
            throw error
        }
        await client.stop()
        await owner.stop()
    }

    func testTwoHostsShareOneClockAndClientCommandsReachItsOwner() async throws {
        let owner = FlowFocusRuntime(dataRoot: directory, hostID: "test.owner", liveServices: false, presentsWindows: false)
        let client = FlowFocusRuntime(dataRoot: directory, hostID: "test.client", liveServices: false, presentsWindows: false)
        await owner.start()
        await client.start()
        XCTAssertTrue(owner.role.isOwner)
        XCTAssertEqual(client.role, .client("test.owner"))
        XCTAssertFalse(client.focus.ownsRuntime)
        XCTAssertFalse(client.focus.recorder?.isCapturing ?? true)
        do {
            let payload = try JSONEncoder().encode(FocusStartCommand(phase: .flow, seconds: 600, tag: "Shared fixture"))
            _ = try await client.send(action: "focus.start", payload: payload)
            try await waitUntil { client.focus.engine?.state == .running }
            XCTAssertTrue(owner.focus.engine?.isTicking ?? false, "normal owner path really starts its clock")
            XCTAssertFalse(client.focus.engine?.isTicking ?? true, "a mirrored running state must never create a second clock")
            XCTAssertEqual(client.focus.engine?.tag, "Shared fixture")
            let sessions = try owner.focus.store?.sessions(from: 0, to: Int64.max)
            XCTAssertEqual(sessions?.count, 1)
            XCTAssertThrowsError(try client.focus.store?.pushIntent(kind: "start"), "client ledger connection is SQLite READONLY")
            let rules = try JSONEncoder().encode(["recognised phrase", "Canonical phrase"])
            _ = try await client.send(action: "flow.rule.add", payload: rules)
            try await waitUntil { client.flow.dictionary.count == 1 }
            let persisted = FlowStore(directory: directory.appendingPathComponent("flow"), writesEnabled: false)
            XCTAssertEqual(persisted.loadDictionary(), client.flow.dictionary, "client mirrors the existing ISO-8601 on-disk schema")
            XCTAssertEqual(owner.flow.dictionary.map(\.id), client.flow.dictionary.map(\.id))
            XCTAssertEqual(owner.flow.dictionary.first?.to, "Canonical phrase")
        } catch {
            await client.stop()
            await owner.stop()
            throw error
        }
        await client.stop()
        await owner.stop()
    }

    func testAClientSavesTheTransformModelThroughItsOwner() async throws {
        let owner = FlowFocusRuntime(dataRoot: directory, hostID: "test.transform-owner", liveServices: false, presentsWindows: false)
        let client = FlowFocusRuntime(dataRoot: directory, hostID: "test.transform-client", liveServices: false, presentsWindows: false)
        await owner.start()
        await client.start()
        do {
            FlowTransformTools(bridge: ToolsBridge(binaryPath: "/usr/bin/false"), configuration: client.configuration).save(accountID: "work", model: "fixture-model")
            try await waitUntil {
                (owner.configuration.app["flowTransforms"] as? [String: Any])?["modelRef"] as? String == "@account/work:fixture-model"
            }
            let bad = try JSONSerialization.data(withJSONObject: ["flowTransforms": ["modelRef": "fixture", "extra": true]])
            do {
                _ = try await client.send(action: "configuration.patch", payload: bad)
                XCTFail("a malformed transform setting must be refused")
            } catch {
                XCTAssertFalse(error.localizedDescription.isEmpty)
            }
        } catch {
            await client.stop()
            await owner.stop()
            throw error
        }
        await client.stop()
        await owner.stop()
    }

    func testClientVoiceReleaseKeepsTheOwnersTimerMuteUntilItsPhaseEnds() async throws {
        let owner = FlowFocusRuntime(dataRoot: directory, hostID: "test.timer", liveServices: false, presentsWindows: false)
        let client = FlowFocusRuntime(dataRoot: directory, hostID: "test.voice", liveServices: false, presentsWindows: false)
        await owner.start()
        await client.start()
        owner.focus.orchestrator.openURL = { _ in XCTFail("fixture must not invoke a system shortcut") }
        do {
            owner.focus.engine?.start(.flow, seconds: 600)
            XCTAssertTrue(owner.focus.orchestrator.isActive)
            _ = try await client.send(action: "focus.dnd.begin", payload: Data("genesis-voice".utf8))
            _ = try await client.send(action: "focus.dnd.end", payload: Data("genesis-voice".utf8))
            XCTAssertTrue(owner.focus.orchestrator.isActive)
            owner.focus.engine?.stop()
            XCTAssertFalse(owner.focus.orchestrator.isActive)
        } catch {
            await client.stop()
            await owner.stop()
            throw error
        }
        await client.stop()
        await owner.stop()
    }

    func testGracefulTakeoverResumesTheSameSessionAfterTheOldClockStops() async throws {
        let first = FlowFocusRuntime(dataRoot: directory, hostID: "test.first", liveServices: false, presentsWindows: false)
        let next = FlowFocusRuntime(dataRoot: directory, hostID: "test.next", liveServices: false, presentsWindows: false)
        await first.start()
        await next.start()
        first.focus.engine?.start(.flow, seconds: 600, tag: "Continue this session")
        let firstEngine = first.focus.engine
        let sessionID = try first.focus.store?.openSession()?.id
        XCTAssertTrue(firstEngine?.isTicking ?? false)
        await first.stop()
        XCTAssertFalse(firstEngine?.isTicking ?? true, "the actual old ticker is gone before the lease is reused")
        do {
            try await waitUntil { next.role.isOwner }
            XCTAssertEqual(try next.focus.store?.openSession()?.id, sessionID)
            XCTAssertTrue(next.focus.engine?.isTicking ?? false)
            XCTAssertEqual(try next.focus.store?.sessions(from: 0, to: Int64.max).count, 1)
            XCTAssertEqual(next.focus.engine?.tag, "Continue this session")
        } catch {
            await next.stop()
            throw error
        }
        await next.stop()
    }

    func testStoreFirstWriteWorksAndPassiveStoreDoesNotCreateOrQuarantineFiles() throws {
        let root = directory.appendingPathComponent("flow", isDirectory: true)
        let passive = FlowStore(directory: root, writesEnabled: false)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
        passive.saveScratchpad("Must not write")
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
        let writer = FlowStore(directory: root)
        writer.saveScratchpad("First durable note")
        XCTAssertEqual(writer.loadScratchpad(), "First durable note")
        writer.saveScratchpad("Atomic replacement")
        XCTAssertEqual(passive.loadScratchpad(), "Atomic replacement")
        let file = root.appendingPathComponent("config.json")
        let corrupt = Data("{broken".utf8)
        try corrupt.write(to: file)
        _ = passive.loadConfig()
        XCTAssertEqual(try Data(contentsOf: file), corrupt)
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: root.path).contains { $0.contains("corrupt-") })
    }

    func testRemoteBeginPreservesTheInitiatingTargetsIdentityWithoutStartingCapture() throws {
        let session = FlowSession(store: FlowStore(directory: directory.appendingPathComponent("flow"), writesEnabled: false))
        var actions: [String] = []
        var received: FlowFocusTarget?
        session.remoteCommand = { action, payload in
            actions.append(action)
            received = try? JSONDecoder().decode(FlowFocusTarget?.self, from: payload)
        }
        let target = FlowFocusTarget(bundleIdentifier: "test.editor", localizedName: "Fixture editor", processIdentifier: 42)
        session.beginTurn(target: target, captureCurrentTarget: false)
        XCTAssertEqual(actions, ["flow.begin"])
        XCTAssertEqual(received, target)
        XCTAssertEqual(session.phase, .idle)
        XCTAssertEqual(session.hotkeyStatus, .off)
    }

    func testStartupFailureStopsServicesBeforeReleasingTheLease() async throws {
        let runtimeDirectory = directory.appendingPathComponent("feature-runtime", isDirectory: true)
        try FileManager.default.createDirectory(at: runtimeDirectory, withIntermediateDirectories: true)
        try Data("blocks the request directory".utf8).write(to: runtimeDirectory.appendingPathComponent("requests"))
        let runtime = FlowFocusRuntime(dataRoot: directory, hostID: "test.failure", liveServices: false, presentsWindows: false)
        await runtime.start()
        XCTAssertFalse(runtime.role.isOwner)
        XCTAssertNil(runtime.focus.engine)
        XCTAssertFalse(runtime.focus.ownsRuntime)
        let lease = try XCTUnwrap(FlowFocusLease.acquire(directory: runtimeDirectory, hostID: "test.replacement"))
        lease.release()
        await runtime.stop()
    }

    func testInitialSnapshotFailureDoesNotAdvertiseOrRetainAnOwner() async throws {
        let root = directory.appendingPathComponent("feature-runtime", isDirectory: true)
        let state = root.appendingPathComponent("state.json", isDirectory: true)
        try FileManager.default.createDirectory(at: state, withIntermediateDirectories: true)
        let runtime = FlowFocusRuntime(dataRoot: directory, hostID: "test.snapshot-failure", liveServices: false, presentsWindows: false)
        await runtime.start()
        XCTAssertFalse(runtime.role.isOwner)
        XCTAssertNil(runtime.focus.engine)
        XCTAssertFalse(runtime.focus.ownsRuntime)
        XCTAssertNotNil(runtime.lastError)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("owner.json").path))
        XCTAssertEqual(runtime.publicationAttempts, 1)
        let lease = try XCTUnwrap(FlowFocusLease.acquire(directory: root, hostID: "test.replacement"))
        lease.release()
        await runtime.stop()
    }

    func testPublicationFailureDoesNotRescheduleItselfAndLaterChangesCanRecover() async throws {
        let runtime = FlowFocusRuntime(dataRoot: directory, hostID: "test.snapshot-recovery", liveServices: false, presentsWindows: false)
        await runtime.start()
        XCTAssertTrue(runtime.role.isOwner)
        let state = runtime.directory.appendingPathComponent("state.json")
        try FileManager.default.moveItem(at: state, to: runtime.directory.appendingPathComponent("state.saved"))
        try FileManager.default.createDirectory(at: state, withIntermediateDirectories: false)
        runtime.flow.reportFailure("Trigger a changed snapshot")
        try await waitUntil { runtime.lastError != nil }
        let attempts = runtime.publicationAttempts
        try await Task.sleep(nanoseconds: 450_000_000)
        XCTAssertEqual(runtime.publicationAttempts, attempts, "reporting a disk error must not create a 100 ms retry loop")
        try FileManager.default.removeItem(at: state)
        runtime.flow.reportFailure("Trigger recovery after the path is repaired")
        try await waitUntil { (try? Data(contentsOf: state)) != nil }
        XCTAssertEqual(runtime.publicationAttempts, attempts + 1)
        await runtime.stop()
    }

    func testForwardedWritesFailBeforeAcknowledgementAndConfigurationRollsBack() async throws {
        let runtime = FlowFocusRuntime(dataRoot: directory, hostID: "test.write-failure", liveServices: false, presentsWindows: false)
        await runtime.start()
        let flowRoot = directory.appendingPathComponent("flow", isDirectory: true)
        let scratchpad = flowRoot.appendingPathComponent("scratchpad.md")
        let configFile = flowRoot.appendingPathComponent("config.json")
        runtime.flow.config.localeIdentifier = "fr-FR"
        let original = runtime.flow.config
        try FileManager.default.moveItem(at: configFile, to: flowRoot.appendingPathComponent("config.saved"))
        try FileManager.default.createDirectory(at: scratchpad, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: configFile, withIntermediateDirectories: false)
        let payload = try JSONEncoder().encode(FlowStoreWrite(name: "scratchpad.md", data: Data("A durable note".utf8)))
        do {
            _ = try await runtime.send(action: "flow.file", payload: payload)
            XCTFail("a failed rename must not be acknowledged as a saved note")
        } catch {
            XCTAssertFalse(error.localizedDescription.isEmpty)
        }
        let patch = try JSONSerialization.data(withJSONObject: ["enabled": !original.enabled])
        do {
            _ = try await runtime.send(action: "flow.config", payload: patch)
            XCTFail("failed config persistence must not be acknowledged")
        } catch {
            XCTAssertEqual(runtime.flow.config, original)
        }
        var changed = original
        changed.enabled.toggle()
        runtime.flow.config = changed
        XCTAssertEqual(runtime.flow.config, original, "direct settings bindings also roll back")
        XCTAssertNotNil(runtime.flow.lastError)
        XCTAssertEqual(runtime.flow.hotkeyStatus, .off)
        let dictionaryFile = flowRoot.appendingPathComponent("dictionary.json")
        try FileManager.default.createDirectory(at: dictionaryFile, withIntermediateDirectories: false)
        let rule = try JSONEncoder().encode(["spoken phrase", "Written phrase"])
        do {
            _ = try await runtime.send(action: "flow.rule.add", payload: rule)
            XCTFail("legacy nonthrowing saves must still fail at the owner command boundary")
        } catch {
            XCTAssertTrue(runtime.flow.dictionary.isEmpty, "failed optimistic mutations reload durable state")
        }
        try FileManager.default.removeItem(at: dictionaryFile)
        _ = try await runtime.send(action: "flow.rule.add", payload: rule)
        XCTAssertEqual(runtime.flow.dictionary.first?.to, "Written phrase")
        try FileManager.default.removeItem(at: scratchpad)
        try FileManager.default.removeItem(at: configFile)
        _ = try await runtime.send(action: "flow.file", payload: payload)
        XCTAssertEqual(try String(contentsOf: scratchpad, encoding: .utf8), "A durable note")
        _ = try await runtime.send(action: "flow.config", payload: patch)
        XCTAssertEqual(runtime.flow.config, changed)
        let reader = FlowStore(directory: flowRoot, writesEnabled: false)
        XCTAssertEqual(reader.loadConfig(), changed, "normal owner persistence still reaches disk")
        await runtime.stop()
    }

    func testShutdownFlushesAnAcceptedSettingsWriteBeforeUnlocking() async throws {
        let runtime = FlowFocusRuntime(dataRoot: directory, hostID: "test.flush", liveServices: false, presentsWindows: false)
        await runtime.start()
        runtime.configuration.setAppValue(false, forKey: "focusWhileListening")
        await runtime.stop()
        let data = try Data(contentsOf: directory.appendingPathComponent("client.json"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual((json["app"] as? [String: Any])?["focusWhileListening"] as? Bool, false)
        let lease = try XCTUnwrap(FlowFocusLease.acquire(directory: runtime.directory, hostID: "test.after-flush"))
        lease.release()
    }

    private func waitUntil(_ predicate: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(3)
        while !predicate() {
            guard Date() < deadline else { throw FlowFocusMailbox.Failure.unavailable("Timed out waiting for runtime state") }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    func testOnlyOneHostOwnsTheStableLockAndReleaseAllowsTakeover() throws {
        let first = try XCTUnwrap(FlowFocusLease.acquire(directory: directory, hostID: "test.host.one"))
        try first.advertise()
        let lock = directory.appendingPathComponent("owner.lock")
        let initial = try FileManager.default.attributesOfItem(atPath: lock.path)[.systemFileNumber] as? NSNumber
        XCTAssertNil(try FlowFocusLease.acquire(directory: directory, hostID: "test.host.two"))
        XCTAssertEqual(try FlowFocusLease.readOwner(directory: directory), first.owner)
        first.release()
        let second = try XCTUnwrap(FlowFocusLease.acquire(directory: directory, hostID: "test.host.two"))
        defer { second.release() }
        try second.advertise()
        let final = try FileManager.default.attributesOfItem(atPath: lock.path)[.systemFileNumber] as? NSNumber
        XCTAssertEqual(initial, final, "lock file is never atomically replaced")
        XCTAssertNotEqual(first.owner.nonce, second.owner.nonce)
        first.release()
        XCTAssertEqual(try FlowFocusLease.readOwner(directory: directory), second.owner)
    }

    func testAStaleAdvertisementDoesNotConferOwnershipOrBlockANewOwner() throws {
        let stale = FlowFocusLease.Owner(hostID: "test.stale", pid: 999_999)
        try FlowFocusLease.writePrivate(try JSONEncoder().encode(stale),
                                       to: directory.appendingPathComponent("owner.json"))
        let owner = try XCTUnwrap(FlowFocusLease.acquire(directory: directory, hostID: "test.current"))
        defer { owner.release() }
        try owner.advertise()
        XCTAssertNotEqual(try FlowFocusLease.readOwner(directory: directory).nonce, stale.nonce)
        let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o700)
        let record = try FileManager.default.attributesOfItem(atPath: directory.appendingPathComponent("owner.json").path)
        XCTAssertEqual((record[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }

    func testDuplicateCommandsReturnTheFirstResultWithoutRepeatingTheEffect() async throws {
        let lease = try XCTUnwrap(FlowFocusLease.acquire(directory: directory, hostID: "test.owner"))
        defer { lease.release() }
        try lease.advertise()
        var calls = 0
        let owner = try FlowFocusMailbox(directory: directory, owner: lease.owner) { command in
            calls += 1
            return command.payload
        }
        defer { owner.stop() }
        let id = UUID()
        let payload = Data("exact destination".utf8)
        let first = try await owner.request(action: "flow.begin", payload: payload, id: id)
        let retry = try await owner.request(action: "flow.begin", payload: Data("ignored retry".utf8), id: id)
        XCTAssertEqual(first, payload)
        XCTAssertEqual(retry, payload)
        XCTAssertEqual(calls, 1)
    }

    func testClientForwardsPayloadAndNeverRunsAnOwnerHandler() async throws {
        let lease = try XCTUnwrap(FlowFocusLease.acquire(directory: directory, hostID: "test.owner"))
        defer { lease.release() }
        try lease.advertise()
        var received: [String] = []
        let owner = try FlowFocusMailbox(directory: directory, owner: lease.owner) { command in
            received.append(command.action)
            return command.payload
        }
        let client = try FlowFocusMailbox(directory: directory, owner: lease.owner)
        owner.start()
        client.start()
        defer { client.stop(); owner.stop() }
        let payload = Data("targetPID:42".utf8)
        let reply = try await client.request(action: "flow.begin", payload: payload, timeout: 2)
        XCTAssertEqual(reply, payload)
        XCTAssertEqual(received, ["flow.begin"])
    }

    func testClientRefusesAReplacementOwnerBeforeWritingACommand() async throws {
        let first = try XCTUnwrap(FlowFocusLease.acquire(directory: directory, hostID: "test.one"))
        try first.advertise()
        let client = try FlowFocusMailbox(directory: directory, owner: first.owner)
        first.release()
        let second = try XCTUnwrap(FlowFocusLease.acquire(directory: directory, hostID: "test.two"))
        defer { second.release(); client.stop() }
        try second.advertise()
        do {
            _ = try await client.request(action: "focus.start")
            XCTFail("stale client must not execute against another ownership epoch")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("owner changed"))
        }
    }

    func testACancelledQueuedRequestNeverReachesTheOwner() async throws {
        let lease = try XCTUnwrap(FlowFocusLease.acquire(directory: directory, hostID: "test.owner"))
        defer { lease.release() }
        try lease.advertise()
        var received: [String] = []
        let owner = try FlowFocusMailbox(directory: directory, owner: lease.owner) { command in
            received.append(command.action)
            return Data()
        }
        let client = try FlowFocusMailbox(directory: directory, owner: lease.owner)
        defer { client.stop(); owner.stop() }
        // The owner is not started, so the command waits in the queue until the caller is cancelled.
        let request = Task { try await client.request(action: "focus.start", timeout: 5) }
        try await Task.sleep(nanoseconds: 100_000_000)
        request.cancel()
        do {
            _ = try await request.value
            XCTFail("a cancelled request must not report success")
        } catch {
            XCTAssertTrue(error is CancellationError, "withdrawn before the owner took it: \(error)")
        }
        owner.start()
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(received, [], "the withdrawn command never runs")
    }

    func testATimedOutRequestIsWithdrawnAndNeverRunsLater() async throws {
        let lease = try XCTUnwrap(FlowFocusLease.acquire(directory: directory, hostID: "test.owner"))
        defer { lease.release() }
        try lease.advertise()
        var received: [String] = []
        let owner = try FlowFocusMailbox(directory: directory, owner: lease.owner) { command in
            received.append(command.action)
            return Data()
        }
        let client = try FlowFocusMailbox(directory: directory, owner: lease.owner)
        defer { client.stop(); owner.stop() }
        do {
            _ = try await client.request(action: "focus.start", timeout: 0.2)
            XCTFail("an owner that never drains the queue cannot acknowledge a command")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("did not answer"))
        }
        owner.start()
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(received, [], "the caller was told it timed out, so the command must not run afterwards")
    }

    func testMissingReplyHasABoundedVisibleFailure() async throws {
        let lease = try XCTUnwrap(FlowFocusLease.acquire(directory: directory, hostID: "test.owner"))
        defer { lease.release() }
        try lease.advertise()
        let owner = try FlowFocusMailbox(directory: directory, owner: lease.owner) { _ in Data() }
        let client = try FlowFocusMailbox(directory: directory, owner: lease.owner)
        defer { client.stop(); owner.stop() }
        do {
            _ = try await client.request(action: "focus.start", timeout: 0.1)
            XCTFail("an owner that never drains the queue cannot acknowledge a command")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("did not answer"))
        }
    }
}
