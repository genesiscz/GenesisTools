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

    func testTextOnlyRefreshRequiresRefreshAndRefusesImagePath() throws {
        let args = ["--app", "Fixture", "--snapshot", "token", "--element", "0", "--action", "press"]
        XCTAssertNoThrow(try WorkflowArguments(args + ["--refresh", "--no-image"], command: "act"))
        XCTAssertThrowsError(try WorkflowArguments(args + ["--no-image"], command: "act"))
        XCTAssertThrowsError(try WorkflowArguments(args + ["--refresh", "--no-image", "--path", "/tmp/after.png"], command: "act"))
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

extension WorkflowArgumentsTests {
    func testTextOnlyObservationDoesNotAcceptAnImageDestination() throws {
        let read = try WorkflowArguments(["--app", "Fixture", "--no-image"], command: "see")
        XCTAssertTrue(read.flags.contains("--no-image"))
        XCTAssertThrowsError(try WorkflowArguments(["--app", "Fixture", "--no-image", "--path", "/tmp/read.png"], command: "see"))
    }
}

final class PerceptionArgumentTests: XCTestCase {
    func testNativeOCROptionsAndExclusiveRegionTargets() throws {
        let see = try WorkflowArguments(["--app", "Fixture", "--perception", "ocr", "--perception-width", "800"], command: "see")
        XCTAssertEqual(see.values["--perception"], "ocr")
        XCTAssertThrowsError(try WorkflowArguments(["--app", "Fixture", "--perception", "icons"], command: "see"))
        XCTAssertThrowsError(try WorkflowArguments(["--app", "Fixture", "--perception", "ocr", "--no-image"], command: "see"))
        XCTAssertThrowsError(try WorkflowArguments(["--app", "Fixture", "--perception-width", "800"], command: "see"))
        let action = ["--app", "Fixture", "--snapshot", "token", "--action", "click", "--region", "v0"]
        XCTAssertNoThrow(try WorkflowArguments(action, command: "act"))
        XCTAssertThrowsError(try WorkflowArguments(action + ["--coords", "1,2"], command: "act"))
        XCTAssertThrowsError(try WorkflowArguments(action + ["--element", "1"], command: "act"))
        XCTAssertThrowsError(try WorkflowArguments(["--app", "Fixture", "--snapshot", "token", "--action", "press", "--region", "v0"], command: "act"))
    }
}
