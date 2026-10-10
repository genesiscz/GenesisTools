import XCTest
@testable import GenesisTools

/// The settings window's permission list reads and asks through GenesisKit's permission module
/// (App/PermissionsModel.swift). A fake system stands in for TCC.
@MainActor
final class PermissionsModelTests: XCTestCase {
    private final class FakeSystem: PermissionSystem, @unchecked Sendable {
        var statuses: [PermissionKind: PermissionStatus] = [:]
        private(set) var requests: [PermissionKind] = []

        func status(_ kind: PermissionKind) -> PermissionStatus { statuses[kind] ?? .notDetermined }

        func request(_ kind: PermissionKind) async -> PermissionStatus {
            requests.append(kind)
            return kind == .downloadsFolder ? .denied : .granted
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
}
