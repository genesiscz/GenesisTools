import XCTest
@testable import GenesisTools

/// A local file macOS hands to GenesisTools (it is the default browser, so `.html` files come here) goes to a
/// real browser, never back to a link router.
final class LocalFileHandoffTests: XCTestCase {
    func testAnHtmlFileGoesToABrowserByItsPath() {
        let file = URL(fileURLWithPath: "/tmp/site/index.html")
        let args = LocalFileHandoff.arguments(for: file)
        XCTAssertEqual(args.last, "/tmp/site/index.html")
        XCTAssertTrue(args.first == "-a" || args.first == "-b", "open -a <browser> or -b <bundle id>: \(args)")
        XCTAssertFalse(args.contains("com.genesiscz.genesistools"), "never back to this app")
    }

    func testALinkDeliveryPutsEachWindowBackUnderItsOldNeighbour() {
        // Front to back before the click: cmux 10, Brave 20, Brave 21, our review 30, ChatGPT 40, our hub 31.
        let stack = [10, 20, 21, 30, 40, 31]
        XCTAssertEqual(BrowserURLForwarder.windowsAbove([30, 31], in: stack), [30: 21, 31: 40])
        XCTAssertEqual(BrowserURLForwarder.windowsAbove([10], in: stack), [:], "on top before: stays where it is")
        XCTAssertEqual(BrowserURLForwarder.windowsAbove([30, 31], in: [30, 31, 20]), [:], "only another app's window counts as a neighbour")
    }

    func testFailedBrowserRecordPublicationKeepsOriginalAndArchive() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let recorded = directory.appendingPathComponent("previous.json")
        let torn = Data("{\"appPath\":\"/Applications/Original".utf8)
        try torn.write(to: recorded)
        var attempted = false

        XCTAssertThrowsError(try recordPreviousBrowser(
            at: recorded, appPath: "/Applications/Replacement.app", preserveUnreadable: true,
            publish: { _, _ in
                attempted = true
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(ENOSPC))
            }
        ))
        XCTAssertTrue(attempted)
        XCTAssertEqual(try Data(contentsOf: recorded), torn)
        let copies = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasPrefix("previous.json.corrupt-") }
        XCTAssertEqual(copies.count, 1)
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(copies.first)), torn)
    }

    func testBrowserRecordArchiveFailureRefusesPublication() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let missing = directory.appendingPathComponent("previous.json")
        var published = false
        XCTAssertThrowsError(try recordPreviousBrowser(
            at: missing, appPath: "/Applications/Replacement.app", preserveUnreadable: true,
            publish: { _, _ in published = true }
        ))
        XCTAssertFalse(published)
    }

    func testBrowserRecordPublicationPreservesTornBytesAndWritesReplacement() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let recorded = directory.appendingPathComponent("previous.json")
        let torn = Data("{\"appPath\":".utf8)
        try torn.write(to: recorded)
        try recordPreviousBrowser(at: recorded, appPath: "/Applications/Replacement.app", preserveUnreadable: true)
        let data = try Data(contentsOf: recorded)
        let object = try JSONSerialization.jsonObject(with: data) as? [String: String]
        XCTAssertEqual(object?["appPath"], "/Applications/Replacement.app")
        let copies = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasPrefix("previous.json.corrupt-") }
        XCTAssertEqual(copies.count, 1)
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(copies.first)), torn)

        try recordPreviousBrowser(at: recorded, appPath: "/Applications/Next.app", preserveUnreadable: false)
        let next = try JSONSerialization.jsonObject(with: Data(contentsOf: recorded)) as? [String: String]
        XCTAssertEqual(next?["appPath"], "/Applications/Next.app")
    }

    func testOnlyFileURLsAreHandedOn() {
        XCTAssertEqual(LocalFileHandoff.open([URL(string: "https://example.org")!, URL(string: "genesis-md://open")!]), 0)
    }
}
