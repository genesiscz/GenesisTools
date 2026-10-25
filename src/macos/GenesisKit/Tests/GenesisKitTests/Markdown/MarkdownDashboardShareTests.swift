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
        XCTAssertEqual(outcome.message, "The dev dashboard could not share this note. Details say why.")
        XCTAssertEqual(outcome.detail, "obsidian vault not configured\nExit code 1.")
    }

    func testAFailureWithNoOutputStillNamesTheExitCode() {
        let outcome = MarkdownDashboardShare.outcome(exitCode: 3, stdout: "", stderr: "")
        XCTAssertEqual(outcome.message, "The dev dashboard could not share this note. Details say why.")
        XCTAssertEqual(outcome.detail, "Exit code 3.")
    }

    func testATimeoutAndAMissingCommandEachHaveTheirOwnSentence() {
        let timeout = MarkdownDashboardShare.failure(ToolsBridgeError.timeout(seconds: 30))
        XCTAssertEqual(timeout.message, "The dev dashboard did not answer within 30 seconds. Check that it is running, then share again.")
        XCTAssertNil(timeout.detail)
        let missing = MarkdownDashboardShare.failure(ToolsBridgeError.binaryNotFound("/nowhere/tools"))
        XCTAssertEqual(missing.message, ToolsBridgeError.binaryNotFound("/nowhere/tools").localizedDescription)
        let other = MarkdownDashboardShare.failure(CocoaError(.fileReadNoPermission))
        XCTAssertEqual(other.message, "The share could not start.")
        XCTAssertNotNil(other.detail)
    }

    func testSuccessWithoutAUrlSaysSo() {
        let outcome = MarkdownDashboardShare.outcome(exitCode: 0, stdout: "not a url\n", stderr: "")
        XCTAssertNil(outcome.url)
        XCTAssertEqual(outcome.message, "The dev dashboard answered without a share link. Try again in a moment.")
        XCTAssertEqual(outcome.detail, "not a url")
    }
}
