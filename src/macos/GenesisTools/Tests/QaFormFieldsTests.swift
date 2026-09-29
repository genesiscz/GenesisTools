import XCTest
@testable import GenesisTools

/// The client-side mirror of `sanitizeFileTags` (`src/question/lib/pending/form.ts`) that gives
/// the Hub's `@file` field and browse picker inline feedback before a submit round-trips.
final class QaFormFieldsTests: XCTestCase {
    func testSplitFileTagsSplitsOnSpaceOrCommaAndStripsALeadingAt() {
        XCTAssertEqual(QaFormFields.splitFileTags("@a.ts, b.ts   c.ts"), ["a.ts", "b.ts", "c.ts"])
        XCTAssertEqual(QaFormFields.splitFileTags("  "), [])
        XCTAssertEqual(QaFormFields.splitFileTags(""), [])
    }

    func testSplitFileTagsDropsBlanksBetweenSeparators() {
        XCTAssertEqual(QaFormFields.splitFileTags("a.ts,,  ,b.ts"), ["a.ts", "b.ts"])
    }

    func testRelativeFileTagInsideCwdReturnsTheRelativePath() {
        XCTAssertEqual(QaFormFields.relativeFileTag("/tmp/proj/src/a.ts", cwd: "/tmp/proj"), "src/a.ts")
    }

    func testRelativeFileTagOutsideCwdReturnsNil() {
        // A sibling directory that merely shares a prefix with the cwd must not pass — "/tmp/proj-evil"
        // is not inside "/tmp/proj" even though the string starts the same way.
        XCTAssertNil(QaFormFields.relativeFileTag("/tmp/other/a.ts", cwd: "/tmp/proj"))
        XCTAssertNil(QaFormFields.relativeFileTag("/tmp/proj-evil/a.ts", cwd: "/tmp/proj"))
    }

    func testRelativeFileTagOfTheCwdItselfReturnsNil() {
        // The cwd is a directory, not a file to attach; an empty relative path is not a usable tag.
        XCTAssertNil(QaFormFields.relativeFileTag("/tmp/proj", cwd: "/tmp/proj"))
        XCTAssertNil(QaFormFields.relativeFileTag("/tmp/proj/", cwd: "/tmp/proj"))
    }
}
