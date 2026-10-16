import XCTest
@testable import GenesisKit

/// Every gate writes one line to the shared trail (Martin, 2026-10-16: "I want all permission gates to be audited").
final class GateAuditTests: XCTestCase {
    func testALineCarriesTheGateTheEventTheWriterAndWhatTheWindowShowed() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("gate-audit-\(UUID().uuidString)").path
        setenv("GENESIS_TOOLS_HOME", home, 1)
        defer {
            unsetenv("GENESIS_TOOLS_HOME")
            try? FileManager.default.removeItem(atPath: home)
        }

        let shown = GateAudit.shown(title: "“x” wants the vault key", purpose: "Why.",
                                    facts: [ApprovalFact("Folder", "~/work", help: "/Users/x/work")],
                                    warning: "Extra code may be loaded.", onceOnly: "extra code may be loaded")
        GateAudit.write(gate: "vault", event: "prompted", ["shown": shown, "optional": Optional<String>.none as Any])

        let path = GateAudit.path
        XCTAssertTrue(path.hasPrefix(home))
        let text = try String(contentsOfFile: path, encoding: .utf8)
        let line = try XCTUnwrap(text.split(separator: "\n").last)
        let entry = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
        XCTAssertEqual(entry["gate"] as? String, "vault")
        XCTAssertEqual(entry["event"] as? String, "prompted")
        XCTAssertNotNil(entry["writer"])
        let written = try XCTUnwrap(entry["shown"] as? [String: Any])
        XCTAssertEqual(written["warning"] as? String, "Extra code may be loaded.")
        XCTAssertEqual((written["facts"] as? [[String: String]])?.first?["value"], "/Users/x/work")
        let mode = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? Int)
        XCTAssertEqual(mode & 0o777, 0o600)
    }
}
