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

    func testOnlyFileURLsAreHandedOn() {
        XCTAssertEqual(LocalFileHandoff.open([URL(string: "https://example.org")!, URL(string: "genesis-md://open")!]), 0)
    }
}
