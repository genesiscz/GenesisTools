import XCTest
@testable import SnapshotSupport

final class WorkflowArgumentsTests: XCTestCase {
    func testActConsumesAnOptionLookingTokenAsThePrecedingValue() throws {
        let arguments = try WorkflowArguments([
            "--app", "Fixture", "--snapshot", "token", "--element", "0", "--action", "set", "--value", "--background",
        ], command: "act")

        XCTAssertEqual(arguments.values["--value"], "--background")
        XCTAssertFalse(arguments.flags.contains("--background"))
    }

    func testDuplicateOptionsAreRejected() {
        XCTAssertThrowsError(try WorkflowArguments(["--app", "Fixture", "--app", "Other"], command: "see"))
    }

    func testUnknownOptionsAreRejected() {
        XCTAssertThrowsError(try WorkflowArguments(["--app", "Fixture", "--unknown", "value"], command: "see"))
    }

    func testRefreshOwnsPath() throws {
        let refreshed = try WorkflowArguments([
            "--app", "Fixture", "--snapshot", "token", "--element", "0", "--action", "press", "--refresh", "--path", "/tmp/after.png",
        ], command: "act")
        XCTAssertTrue(refreshed.flags.contains("--refresh"))
        XCTAssertEqual(refreshed.values["--path"], "/tmp/after.png")

        XCTAssertThrowsError(try WorkflowArguments([
            "--app", "Fixture", "--snapshot", "token", "--element", "0", "--action", "press", "--path", "/tmp/after.png",
        ], command: "act")) { error in
            XCTAssertEqual(error.localizedDescription, "--path requires --refresh")
        }
    }

    func testSelectOnlyFlagsAreRejectedForPaste() {
        XCTAssertThrowsError(try WorkflowArguments([
            "--app", "Fixture", "--snapshot", "token", "--element", "0", "--action", "paste", "--range", "0,1",
        ], command: "act"))
    }

    func testTypeTextBoundaryUsesUTF16Units() throws {
        for length in [255, 256] {
            XCTAssertNoThrow(try WorkflowArguments([
                "--app", "Fixture", "--snapshot", "token", "--element", "0", "--action", "type",
                "--text", String(repeating: "x", count: length),
            ], command: "act"))
        }

        XCTAssertThrowsError(try WorkflowArguments([
            "--app", "Fixture", "--snapshot", "token", "--element", "0", "--action", "type",
            "--text", String(repeating: "x", count: 257),
        ], command: "act"))
    }
}
