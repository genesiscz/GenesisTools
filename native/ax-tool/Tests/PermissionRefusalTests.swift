import XCTest
@testable import SnapshotSupport

/// The refusal ax-tool prints when a grant is missing. It is a claim about the CALLER, and the
/// reader has one job after reading it: find the right app in the right System Settings pane.
final class PermissionRefusalTests: XCTestCase {
    private let terminal = ResponsibleProcess(
        pid: 1940, bundleId: "com.apple.Terminal",
        path: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal", localizedName: "Terminal")

    // Regression test: #447 — the app to turn on was only inside the JSON's responsible* fields
    func testAccessibilityRefusalNamesTheResponsibleAppInPlainWords() {
        let message = permissionRefusalMessage(.accessibility, responsible: terminal)

        XCTAssertTrue(message.hasPrefix("Accessibility is not granted to Terminal (com.apple.Terminal)"), message)
        XCTAssertTrue(message.contains("Turn on Terminal in System Settings > Privacy & Security > Accessibility"), message)
    }

    // Regression test: #447 — see/act said only "grant access to the responsible app/process", with no fields
    func testScreenRecordingRefusalCarriesTheSameFieldsAsTheAccessibilityOne() {
        let refusal = permissionRefusal(.screenRecording, responsible: terminal, pid: 77)

        XCTAssertEqual(refusal["ok"] as? Bool, false)
        XCTAssertEqual(refusal["reason"] as? String, "screen-recording-not-granted")
        XCTAssertEqual(refusal["refusal"] as? String, "permission")
        XCTAssertEqual(refusal["pid"] as? Int32, 77)
        XCTAssertEqual(refusal["responsible"] as? String, "com.apple.Terminal")
        XCTAssertEqual(refusal["responsiblePid"] as? Int32, 1940)
        XCTAssertEqual(refusal["responsibleBundleId"] as? String, "com.apple.Terminal")
        XCTAssertEqual(refusal["responsiblePath"] as? String, terminal.path)
        XCTAssertEqual(refusal["responsibleName"] as? String, "Terminal")
        XCTAssertEqual(refusal["viaGenesisApp"] as? Bool, false)
    }

    // Regression test: #447 — Screen Recording only takes effect after the host app restarts
    func testScreenRecordingRefusalSaysToReopenTheHostAfterGranting() {
        let message = permissionRefusalMessage(.screenRecording, responsible: terminal)

        XCTAssertTrue(message.contains("(`tools macos permissions open --pane screen-recording`)"), message)
        XCTAssertTrue(message.contains("If you just granted it, quit and reopen Terminal, then re-run."), message)
    }

    // Regression test: #447 D2 — the refusal named only the pane, though a command can ask macOS
    func testEveryRefusalNamesTheRequestCommandBeforeThePane() {
        for grant in [PermissionGrant.accessibility, .screenRecording] {
            let message = permissionRefusalMessage(grant, responsible: terminal)
            guard let request = message.range(of: "Run `tools control permissions request`"),
                  let pane = message.range(of: "System Settings") else {
                return XCTFail("missing the request command or the pane: \(message)")
            }
            XCTAssertLessThan(request.lowerBound, pane.lowerBound, message)
        }
    }

    func testAccessibilityRefusalSaysNothingAboutReopening() {
        XCTAssertFalse(permissionRefusalMessage(.accessibility, responsible: terminal).contains("reopen"))
    }

    // Regression test: #447 — a grant to Claude Code's …/2.1.286/f2326db61802/claude.app dies with the next update
    func testAHostInAVersionedFolderIsWarnedThatTheNextUpdateDropsTheGrant() {
        let agent = ResponsibleProcess(
            pid: 2172, bundleId: nil,
            path: "/Users/someone/Library/Application Support/Host/agent/2.1.286/f2326db61802/agent.app/Contents/MacOS/agent",
            localizedName: nil)
        let message = permissionRefusalMessage(.accessibility, responsible: agent)

        XCTAssertTrue(message.hasPrefix("Accessibility is not granted to agent (/Users/someone/Library/Application Support/Host/agent/2.1.286/f2326db61802/agent.app)"), message)
        XCTAssertTrue(message.contains("agent runs from a versioned folder (…/2.1.286/…), so its next update drops this grant"), message)
    }

    func testAHostAtAFixedPathGetsNoVersionWarning() {
        XCTAssertFalse(permissionRefusalMessage(.accessibility, responsible: terminal).contains("versioned folder"))
    }

    func testARunThroughGenesisToolsAsksToTurnOnGenesisTools() {
        let app = ResponsibleProcess(
            pid: 12, bundleId: genesisAppBundleIdentifier,
            path: "/Users/someone/Applications/GenesisTools.app/Contents/MacOS/GenesisTools", localizedName: "GenesisTools")
        let refusal = permissionRefusal(.accessibility, responsible: app, pid: 13)

        XCTAssertEqual(refusal["viaGenesisApp"] as? Bool, true)
        XCTAssertTrue((refusal["error"] as? String ?? "").contains("Turn on GenesisTools in System Settings"))
    }
}
