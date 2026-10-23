import XCTest
@testable import GenesisKit

final class NotificationLedgerTests: XCTestCase {
    private var directory: URL!
    private var file: String { directory.appendingPathComponent("ledger.jsonl").path }

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("ledger-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func lines() throws -> [[String: Any]] {
        NotificationLedger.flush()
        return try String(contentsOfFile: file, encoding: .utf8)
            .split(separator: "\n")
            .map { try XCTUnwrap(JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]) }
    }

    func testEachRecordIsOneLineWithItsFieldsAndWriter() throws {
        NotificationLedger.record(source: "monitor.cache", channel: "macos", title: "Cache cooling — 10 min left",
                                  body: "0f61ecfa · col\n~/x", fields: ["sessionId": "0f61ecfa", "ctx": 169_282], file: file)
        NotificationLedger.record(source: "monitor.cache", channel: "macos", outcome: .suppressed,
                                  reason: "process exited", fields: ["bad": Date()], file: file)
        let written = try lines()
        XCTAssertEqual(written.count, 2)
        XCTAssertEqual(written[0]["source"] as? String, "monitor.cache")
        XCTAssertEqual(written[0]["outcome"] as? String, "posted")
        XCTAssertEqual(written[0]["ctx"] as? Int, 169_282)
        XCTAssertNotNil(written[0]["at"])
        XCTAssertNotNil((written[0]["writer"] as? [String: Any])?["pid"])
        XCTAssertEqual(written[1]["reason"] as? String, "process exited")
        XCTAssertNil(written[1]["bad"], "a non-JSON value is dropped, the line is still written")
    }

    func testAFullFileMovesAsideBeforeTheNextLine() throws {
        try Data(count: Int(NotificationLedger.maxBytes) + 1).write(to: URL(fileURLWithPath: file))
        NotificationLedger.record(source: "disk", channel: "macos", file: file)
        XCTAssertEqual(try lines().count, 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: file + ".1"))
    }
}
