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

    func testOnlyFileURLsAreHandedOn() {
        XCTAssertEqual(LocalFileHandoff.open([URL(string: "https://example.org")!, URL(string: "genesis-md://open")!]), 0)
    }
}
