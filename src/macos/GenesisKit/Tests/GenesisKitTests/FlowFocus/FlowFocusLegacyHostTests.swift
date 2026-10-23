import AppKit
import Foundation
import SwiftUI
import Vision
import XCTest
@testable import GenesisKit

/// A running Genesis.app that predates the Flow and Focus protocol must never stop this host from recording, and a
/// current Genesis started without LaunchServices must not count as older (2026-10-23: the widget's Voice Notes said
/// "An older Genesis is running its own Flow and Focus services" while that Genesis owned the runtime).
@MainActor
final class FlowFocusLegacyHostTests: XCTestCase {
    private var directory: URL!
    private var children: [Process] = []

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("flow-focus-legacy-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        for child in children where child.isRunning { child.terminate() }
        children = []
        try FileManager.default.removeItem(at: directory)
    }

    /// A stand-in for a running Genesis: a real process, so its pid and kernel start time are real.
    private func spawnPeer() throws -> (Process, FlowFocusPeerApp) {
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/sleep")
        child.arguments = ["30"]
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        try child.run()
        children.append(child)
        let pid = child.processIdentifier
        let peer = FlowFocusPeerApp(pid: pid, bundlePath: "/Applications/Genesis.app", version: "0.1.0 (1)",
                                    launchDate: nil, startedAt: FlowFocusPeerApp.processStart(pid))
        XCTAssertNotNil(peer.startedAt)
        return (child, peer)
    }

    /// The record a current Genesis writes, byte for byte the shape of one launched without LaunchServices: no launchDate.
    private func writeParticipantRecord(pid: Int32, modified: Date? = nil) throws {
        let runtimeDirectory = directory.appendingPathComponent("feature-runtime", isDirectory: true)
        try FileManager.default.createDirectory(at: runtimeDirectory, withIntermediateDirectories: true)
        let record = runtimeDirectory.appendingPathComponent("participant-\(pid).json")
        let json = #"{"hostID":"dev.foltyn.genesis","version":1,"nonce":"\#(UUID().uuidString)","pid":\#(pid)}"#
        try FlowFocusLease.writePrivate(Data(json.utf8), to: record)
        if let modified {
            try FileManager.default.setAttributes([.modificationDate: modified], ofItemAtPath: record.path)
        }
    }

    private func runtime(_ hostID: String, peers: @escaping @MainActor () -> [FlowFocusPeerApp] = { [] }) -> FlowFocusRuntime {
        let runtime = FlowFocusRuntime(dataRoot: directory, hostID: hostID, liveServices: false, presentsWindows: false)
        runtime.peerApps = peers
        return runtime
    }

    private func waitUntil(_ predicate: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(3)
        while !predicate() {
            guard Date() < deadline else { throw FlowFocusMailbox.Failure.unavailable("Timed out waiting for runtime state") }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
    }

    func testAnOlderGenesisLeavesTheRecordingPathWorkingAndTheLockFree() async throws {
        let (child, peer) = try spawnPeer()
        let host = runtime("test.legacy-host", peers: { [peer] })
        await host.start()
        XCTAssertFalse(host.role.isOwner, "an older Genesis runs the shortcut, capture and DND; owning them would run them twice")
        XCTAssertEqual(host.legacyHosts, [peer])
        XCTAssertEqual(host.role, .unavailable(FlowFocusRuntime.legacyMessage([peer])))
        // The explicit Record press: admitted without any owner, and the recorder attaches and releases as usual.
        let lease = try await host.acquireExternalAudio()
        XCTAssertTrue(lease.standalone)
        try await lease.attachRecorder(pid: child.processIdentifier)
        try await lease.release()
        // The host stepped back without holding the lock: a current host can still own Flow and Focus.
        let rival = runtime("test.rival")
        await rival.start()
        XCTAssertTrue(rival.role.isOwner)
        await rival.stop()
        await host.stop()
        XCTAssertTrue(host.legacyHosts.isEmpty)
    }

    func testWithALiveOwnerTheHostJoinsAsAClientDespiteAnOlderGenesis() async throws {
        let (_, peer) = try spawnPeer()
        let owner = runtime("test.owner")
        await owner.start()
        XCTAssertTrue(owner.role.isOwner)
        let host = runtime("test.client-beside-legacy", peers: { [peer] })
        await host.start()
        XCTAssertEqual(host.role, .client("test.owner"), "joining a live owner starts no service of its own")
        XCTAssertTrue(host.legacyHosts.isEmpty)
        let lease = try await host.acquireExternalAudio()
        XCTAssertFalse(lease.standalone, "the owner admits the recorder, as without an older Genesis")
        try await waitUntil { owner.flow.externalAudioHeld }
        try await lease.release()
        try await waitUntil { !owner.flow.externalAudioHeld }
        await host.stop()
        await owner.stop()
    }

    func testWhenTheOlderGenesisQuitsTheHostTakesItsPartBack() async throws {
        let (child, peer) = try spawnPeer()
        var legacyRunning = true
        let host = runtime("test.takes-back", peers: { legacyRunning ? [peer] : [] })
        await host.start()
        XCTAssertEqual(host.legacyHosts, [peer])
        legacyRunning = false
        child.terminate()
        try await waitUntil { host.role.isOwner }
        XCTAssertTrue(host.legacyHosts.isEmpty)
        let lease = try await host.acquireExternalAudio()
        XCTAssertFalse(lease.standalone)
        try await lease.release()
        await host.stop()
    }

    func testACurrentGenesisStartedWithoutLaunchServicesIsAParticipantNotAnOlderCopy() async throws {
        let (_, peer) = try spawnPeer()
        XCTAssertNil(peer.launchDate)
        try writeParticipantRecord(pid: peer.pid)
        let host = runtime("test.beside-current", peers: { [peer] })
        await host.start()
        XCTAssertTrue(host.role.isOwner, "a record written by the running process proves the protocol")
        XCTAssertTrue(host.legacyHosts.isEmpty)
        await host.stop()
    }

    func testARecordOlderThanTheProcessIsLeftByAnEarlierProcessWithTheSamePid() async throws {
        let (_, peer) = try spawnPeer()
        let started = try XCTUnwrap(peer.startedAt)
        try writeParticipantRecord(pid: peer.pid, modified: started.addingTimeInterval(-120))
        let host = runtime("test.stale-record", peers: { [peer] })
        await host.start()
        XCTAssertFalse(host.role.isOwner)
        XCTAssertEqual(host.legacyHosts, [peer])
        await host.stop()
    }

    func testWithoutAnyGenesisTheRecordingPathIsTheOwnersAdmission() async throws {
        let host = runtime("test.alone")
        await host.start()
        XCTAssertTrue(host.role.isOwner)
        XCTAssertTrue(host.legacyHosts.isEmpty)
        let lease = try await host.acquireExternalAudio()
        XCTAssertFalse(lease.standalone)
        XCTAssertTrue(host.flow.externalAudioHeld, "the owner records the admission, so its pre-roll stays off")
        try await lease.release()
        XCTAssertFalse(host.flow.externalAudioHeld)
        await host.stop()
    }

    func testTheLegacyNoticeNamesTheCopyAndItsQuitAsksFirst() async throws {
        let (_, peer) = try spawnPeer()
        let host = runtime("test.notice", peers: { [peer] })
        var asked: [Int32] = []
        host.terminatePeer = { asked.append($0); return true }
        await host.start()
        let notice = host.legacyNotice()
        XCTAssertTrue(notice.found.contains("pid \(peer.pid)"))
        XCTAssertTrue(notice.found.contains("/Applications/Genesis.app"))
        XCTAssertTrue(notice.found.contains("Version: 0.1.0 (1)"))
        let quit = try XCTUnwrap(notice.fixes.first { $0.label == "Quit the older Genesis (pid \(peer.pid))" })
        guard case .action(let confirm, let perform) = quit.kind else { return XCTFail("the quit fix is a button") }
        XCTAssertNotNil(confirm, "quitting another app asks first")
        perform()
        XCTAssertEqual(asked, [peer.pid])
        let command = try XCTUnwrap(notice.fixes.first { if case .command = $0.kind { return true }; return false })
        guard case .command(let text) = command.kind else { return XCTFail() }
        XCTAssertEqual(text, "kill \(peer.pid)")
        await host.stop()
    }

    func testARefusedRecordingSaysWhoHoldsAudioAndOffersTheFix() async throws {
        let owner = runtime("test.refusal")
        await owner.start()
        owner.flow.preRollEffect = { _ in }
        owner.flow.hotkeyBindingEffect = {}
        owner.flow.recognitionStartEffect = {}
        owner.flow.config.showPill = false
        owner.flow.start()
        owner.flow.beginTurn(captureCurrentTarget: false)
        XCTAssertEqual(owner.flow.phase, .listening)
        var refusal: Error?
        do { _ = try await owner.acquireExternalAudio() } catch { refusal = error }
        let message = try XCTUnwrap(refusal?.localizedDescription)
        let notice = try XCTUnwrap(FlowFocusRuntime.lastAudioRefusal)
        XCTAssertEqual(notice.text, message)
        XCTAssertTrue(notice.found.contains("Flow and Focus owner: test.refusal"))
        XCTAssertTrue(notice.found.contains("Dictation: listening"))
        // The Voice Notes module shows this notice for the store's error text, with Record again after the runtime's fixes.
        let content = WidgetVoiceNotesNotice.content(for: message, permission: .authorized, bundleID: "test.bundle",
                                                     reviewMicrophone: {}, recordAgain: {})
        XCTAssertEqual(content.more, notice.found)
        XCTAssertEqual(content.fixes.map(\.label), ["Cancel the dictation in progress", "Record again"])
        guard case .action(let confirm, let perform) = content.fixes[0].kind else { return XCTFail() }
        XCTAssertNotNil(confirm, "cancelling a dictation drops its words, so it asks first")
        perform()
        XCTAssertEqual(owner.flow.phase, .idle)
        await owner.stop()
    }

    func testTheMicrophoneNoticeOffersTheReviewAndTheTerminalReset() {
        var reviewed = 0
        let error = VoiceCommandFailure.microphonePermission.errorDescription ?? ""
        let content = WidgetVoiceNotesNotice.content(for: error, permission: .denied, bundleID: "test.bundle",
                                                     reviewMicrophone: { reviewed += 1 }, recordAgain: {})
        XCTAssertEqual(content.detail, "macOS answers \"denied\" for this app's microphone access.")
        XCTAssertEqual(content.fixes.map(\.label).first, "Review microphone access")
        guard case .action(let confirm, let perform) = content.fixes[0].kind else { return XCTFail() }
        XCTAssertNil(confirm, "opening the permission dialog changes nothing by itself")
        perform()
        XCTAssertEqual(reviewed, 1)
        guard case .command(let command) = content.fixes[1].kind else { return XCTFail() }
        XCTAssertEqual(command, "tccutil reset Microphone test.bundle")
        let capture = WidgetVoiceNotesNotice.content(for: VoiceCommandFailure.captureFailed.errorDescription ?? "",
                                                     permission: .authorized, bundleID: nil,
                                                     reviewMicrophone: {}, recordAgain: {})
        XCTAssertEqual(capture.fixes.map(\.label), ["Record again", "See why the recorder failed"])
    }

    func testTheNoticeDrawsItsFixesAndCommand() throws {
        let pill = NoticePill(
            text: "An older Genesis runs dictation and Focus", detail: "Voice Notes record as usual.", tone: .warning,
            fixes: [.button("Quit the older Genesis (pid 4321)", symbol: "power",
                            confirm: .init("Quit Genesis?", confirmLabel: "Quit Genesis")) {},
                    .command("Or quit it from a terminal", "kill 4321")])
            .frame(width: 420)
            .padding(10)
            .background(Color.black)
            .environment(\.colorScheme, .dark)
        let renderer = ImageRenderer(content: pill)
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.cgImage)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
        XCTAssertTrue(text.contains("Quit the older Genesis (pid 4321)"), text)
        XCTAssertTrue(text.contains("kill 4321"), text)
        XCTAssertTrue(text.contains("Or quit it from a terminal"), text)
    }
}
