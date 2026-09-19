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

    func testPreparationRequiresAnExplicitForegroundElementAction() throws {
        let base = ["--app","Fixture","--snapshot","token","--element","1","--action","click","--prepare"]
        XCTAssertTrue(try WorkflowArguments(base,command:"act").flags.contains("--prepare"))
        XCTAssertThrowsError(try WorkflowArguments(base+["--background"],command:"act"))
        XCTAssertThrowsError(try WorkflowArguments(["--app","Fixture","--snapshot","token","--coords","1,2","--action","click","--prepare"],command:"act"))
        XCTAssertNoThrow(try WorkflowArguments(["--app","Fixture","--snapshot","token","--element","1","--action","press","--prepare"],command:"act"))
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

    func testPasteReplacementRequiresPreparation() throws {
        let base = ["--app", "Fixture", "--snapshot", "token", "--element", "0", "--action", "paste", "--text", "value"]
        XCTAssertNoThrow(try WorkflowArguments(base + ["--replace", "--prepare"], command: "act"))
        XCTAssertThrowsError(try WorkflowArguments(base + ["--replace"], command: "act"))
        XCTAssertThrowsError(try WorkflowArguments([
            "--app", "Fixture", "--snapshot", "token", "--element", "0", "--action", "set", "--value", "value", "--replace", "--prepare",
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


extension WorkflowArgumentsTests {
    func testNativeKeyChordsCoverNavigationKeypadAndFunctionKeys() throws {
        for (name, code) in [("Home", 115), ("Page_Up", 116), ("Next", 121), ("End", 119), ("ForwardDelete", 117),
                             ("F20", 90), ("KP_Enter", 76), ("KP_0", 82), ("comma", 43), ("backslash", 42)] {
            XCTAssertEqual(try NativeKeyChord(name).code, UInt16(code), name)
        }
        let chord = try NativeKeyChord(" Super + Shift + Left ")
        XCTAssertEqual(chord.code, 123)
        XCTAssertTrue(chord.flags.contains(.maskCommand))
        XCTAssertTrue(chord.flags.contains(.maskShift))
        XCTAssertThrowsError(try NativeKeyChord("cmd,a,b"))
        XCTAssertThrowsError(try NativeKeyChord("cmd"))
        XCTAssertThrowsError(try NativeKeyChord("cmd,,a"))
        XCTAssertThrowsError(try NativeKeyChord("exec shell"))
        XCTAssertThrowsError(try WorkflowArguments(["--app", "Fixture", "--snapshot", "token", "--element", "0",
                                                   "--action", "key", "--keys", "cmd,a,b"], command: "act"))
    }
}
