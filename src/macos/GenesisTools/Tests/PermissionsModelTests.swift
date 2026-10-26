import XCTest
@testable import GenesisToolsHost
@testable import GenesisToolsHub

/// The settings window's permission list reads and asks through GenesisKit's permission module
/// (App/PermissionsModel.swift). A fake system stands in for TCC.
@MainActor
final class PermissionsModelTests: XCTestCase {
    private final class FakeSystem: PermissionSystem, @unchecked Sendable {
        var statuses: [PermissionKind: PermissionStatus] = [:]
        /// What a request answers; unset is a refusal for Downloads and a grant for the rest.
        var answers: [PermissionKind: PermissionStatus] = [:]
        private(set) var requests: [PermissionKind] = []

        func status(_ kind: PermissionKind) -> PermissionStatus { statuses[kind] ?? .notDetermined }

        func request(_ kind: PermissionKind) async -> PermissionStatus {
            requests.append(kind)
            return answers[kind] ?? (kind == .downloadsFolder ? .denied : .granted)
        }

        func openSettings(_ kind: PermissionKind) -> Bool { true }
    }

    func testRowsCoverEveryKindWithItsActionAndStatus() throws {
        let system = FakeSystem()
        system.statuses = [.inputMonitoring: .needsRelaunch, .microphone: .granted]
        let model = PermissionsModel(access: PermissionAccess(system: system))
        model.refresh()
        XCTAssertEqual(Set(model.rows.map(\.kind)), Set(PermissionKind.allCases), "Input Monitoring is listed too")
        func row(_ kind: PermissionKind) throws -> PermissionRow { try XCTUnwrap(model.rows.first { $0.kind == kind }) }
        XCTAssertEqual(try row(.fullDiskAccess).action, .openPane("Privacy_AllFiles"))
        XCTAssertEqual(try row(.inputMonitoring).action, .prompt)
        XCTAssertEqual(try row(.inputMonitoring).state, .needsRelaunch)
        XCTAssertEqual(try row(.inputMonitoring).pane, "Privacy_ListenEvent")
        XCTAssertEqual(try row(.microphone).state, .granted)
        XCTAssertEqual(try row(.automation).action, .probe)
        XCTAssertEqual(try row(.automation).title, "Automation (System Events)")
        XCTAssertFalse(try row(.screenRecording).usedBy.isEmpty)
    }

    func testRefreshRechecksADenialRememberedBeforeTheWindowOpened() async throws {
        let system = FakeSystem()
        system.statuses[.downloadsFolder] = .unknown("asks on first use")
        let access = PermissionAccess(system: system)
        let first = await access.request(.downloadsFolder)
        XCTAssertEqual(first, .denied)
        system.answers[.downloadsFolder] = .granted

        let model = PermissionsModel(access: access)
        model.refresh()
        for _ in 0 ..< 200 where model.rows.first(where: { $0.kind == .downloadsFolder })?.state != .granted {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(model.rows.first { $0.kind == .downloadsFolder }?.state, .granted)
        XCTAssertEqual(system.requests, [.downloadsFolder, .downloadsFolder])
    }

    func testAProbeAnswerIsRememberedBecauseMacOSHasNoStatusForIt() async throws {
        let system = FakeSystem()
        system.statuses[.downloadsFolder] = .unknown("asks on first use")
        let model = PermissionsModel(access: PermissionAccess(system: system))
        model.refresh()
        let downloads = try XCTUnwrap(model.rows.first { $0.kind == .downloadsFolder })
        model.request(downloads)
        XCTAssertEqual(model.busy, downloads.id)
        for _ in 0 ..< 200 where model.busy != nil {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertNil(model.busy)
        XCTAssertEqual(system.requests, [.downloadsFolder])
        XCTAssertEqual(model.rows.first { $0.kind == .downloadsFolder }?.state, .denied)
        XCTAssertTrue(model.lastMessage?.contains("Downloads folder") == true)
    }

    /// The window refreshes when the user comes back from System Settings: the answered probe runs again (macOS
    /// answered it before, so it does not prompt) and the "macOS refused" line goes once the grant is fixed.
    func testARefreshAfterTheGrantIsFixedClearsTheRefusal() async throws {
        let system = FakeSystem()
        system.statuses[.downloadsFolder] = .unknown("asks on first use")
        let model = PermissionsModel(access: PermissionAccess(system: system))
        model.refresh()
        let downloads = try XCTUnwrap(model.rows.first { $0.kind == .downloadsFolder })
        model.request(downloads)
        for _ in 0 ..< 200 where model.busy != nil {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertNotNil(model.lastMessage)
        XCTAssertNil(model.busyTitle)

        system.answers[.downloadsFolder] = .granted
        model.refresh()
        for _ in 0 ..< 200 where model.lastMessage != nil {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertNil(model.lastMessage)
        XCTAssertEqual(model.rows.first { $0.kind == .downloadsFolder }?.state, .granted)
        XCTAssertEqual(system.requests, [.downloadsFolder, .downloadsFolder])
    }

    /// Coming back to the app reads the rows every time, but runs the answered probes again at most every 10 s, as the
    /// permission center does (`PermissionAccess.activationRecheckInterval`).
    func testActivationRerunsTheAnsweredProbesAtMostEvery10Seconds() async throws {
        let system = FakeSystem()
        system.statuses[.downloadsFolder] = .unknown("asks on first use")
        let model = PermissionsModel(access: PermissionAccess(system: system))
        model.refresh()
        model.request(try XCTUnwrap(model.rows.first { $0.kind == .downloadsFolder }))
        for _ in 0 ..< 200 where model.busy != nil {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(system.requests.count, 1)

        let start = Date()
        model.refreshOnActivation(now: start)
        for _ in 0 ..< 200 where system.requests.count < 2 {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(system.requests.count, 2, "the first activation reruns the answered probe")
        try await Task.sleep(for: .milliseconds(50))

        model.refreshOnActivation(now: start.addingTimeInterval(3))
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(system.requests.count, 2, "a second activation within 10 s runs no probe")

        model.refreshOnActivation(now: start.addingTimeInterval(11))
        for _ in 0 ..< 200 where system.requests.count < 3 {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(system.requests.count, 3, "after 10 s the next activation runs it again")
    }
}
