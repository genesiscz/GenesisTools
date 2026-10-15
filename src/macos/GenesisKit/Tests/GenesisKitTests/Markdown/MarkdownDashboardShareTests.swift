import XCTest
@testable import GenesisKit

final class MarkdownDashboardShareTests: XCTestCase {
    func testBasicAuthChallengeMeansTheDashboardIsUp() {
        XCTAssertTrue(MarkdownDashboardShare.isAvailable(httpStatus: 401))
        XCTAssertTrue(MarkdownDashboardShare.isAvailable(httpStatus: 200))
        XCTAssertFalse(MarkdownDashboardShare.isAvailable(httpStatus: nil))
    }

    func testShareStdoutUrlIsTheFirstHttpLine() {
        let stdout = "\npublished ignored\nhttps://mac.example.dev/share/tok\nhttps://other.example/no\n"
        XCTAssertEqual(
            MarkdownDashboardShare.shareURL(in: stdout)?.absoluteString,
            "https://mac.example.dev/share/tok"
        )
    }

    func testSuccessfulShareKeepsTheUrlAndDropsThePublishedNote() {
        let outcome = MarkdownDashboardShare.outcome(
            exitCode: 0,
            stdout: "https://mac.example.dev/share/tok\n",
            stderr: "published Widgets/Note.md\n"
        )
        XCTAssertEqual(outcome.url?.absoluteString, "https://mac.example.dev/share/tok")
        XCTAssertNil(outcome.message)
    }

    func testFailedShareSurfacesStderr() {
        let outcome = MarkdownDashboardShare.outcome(
            exitCode: 1,
            stdout: "",
            stderr: "obsidian vault not configured\n"
        )
        XCTAssertNil(outcome.url)
        XCTAssertEqual(outcome.message, "obsidian vault not configured")
    }

    func testSuccessWithoutAUrlSaysSo() {
        let outcome = MarkdownDashboardShare.outcome(exitCode: 0, stdout: "not a url\n", stderr: "")
        XCTAssertNil(outcome.url)
        XCTAssertEqual(outcome.message, "dev-dashboard share did not print a URL")
    }
}
