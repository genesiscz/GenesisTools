import XCTest
@testable import GenesisKitBase

/// The autocomplete field's matching, its list state and the folder completion behind `AutocompleteFolderField`.
@MainActor
final class AutocompleteFieldTests: XCTestCase {
    private let calendars = ["Work", "Home", "Team work", "Homework", "Žluťoučký kůň"].map { AutocompleteValue($0) }

    func testATitleThatStartsWithTheTextComesFirstThenAWordThenTheRest() {
        let ranked = AutocompleteMatch.ranked(calendars, query: "wo").map(\.title)
        XCTAssertEqual(ranked, ["Work", "Team work", "Homework"])
        XCTAssertEqual(AutocompleteMatch.ranked(calendars, query: "").count, calendars.count, "no text lists everything")
        XCTAssertEqual(AutocompleteMatch.ranked(calendars, query: "zlut").map(\.title), ["Žluťoučký kůň"], "accents do not count")
        XCTAssertEqual(AutocompleteMatch.ranked(calendars, query: "x"), [])
    }

    func testTheTypedPartIsFoundInTheTitlesOwnCharacters() throws {
        let title = "Team Work"
        let range = try XCTUnwrap(AutocompleteMatch.range(in: title, of: "wor"))
        XCTAssertEqual(String(title[range]), "Wor")
        XCTAssertNil(AutocompleteMatch.range(in: title, of: "  "))
    }

    func testDownMarksTheFirstRowAndStopsAtTheLastAndEscapeThenDownOpensAgain() {
        let model = AutocompleteModel<AutocompleteValue>()
        model.focus(true)
        model.move(1, count: 3)
        XCTAssertEqual(model.marked, 0)
        model.move(1, count: 3)
        model.move(1, count: 3)
        model.move(1, count: 3)
        XCTAssertEqual(model.marked, 2, "the mark stops at the last row")
        model.move(-1, count: 3)
        XCTAssertEqual(model.marked, 1)
        model.dismiss()
        XCTAssertTrue(model.dismissed)
        XCTAssertNil(model.marked)
        model.move(1, count: 3)
        XCTAssertFalse(model.dismissed, "Down opens a list Escape closed")
        model.move(-1, count: 3)
        XCTAssertEqual(model.marked, 2, "Up on an unmarked list marks the last row")
    }

    func testALazyListIsReadOnceAndAFailureKeepsItsSentenceUntilRetry() async throws {
        let model = AutocompleteModel<AutocompleteValue>()
        let reads = Counter()
        let source = AutocompleteSource<AutocompleteValue>.lazyItems {
            await reads.add()
            if await reads.value == 1 { throw AutocompleteFailure("The list could not be read.") }
            return [AutocompleteValue("Work")]
        }
        model.need(source, text: "")
        try await waitUntil { if case .failed = model.phase { return true } else { return false } }
        XCTAssertEqual(model.phase, .failed("The list could not be read."))
        model.need(source, text: "w")
        let afterFailure = await reads.value
        XCTAssertEqual(afterFailure, 1, "a failed read is not asked again by typing, only by Retry")
        model.retry(source, text: "")
        try await waitUntil { model.phase == .loaded }
        XCTAssertEqual(model.answered?.map(\.title), ["Work"])
        model.need(source, text: "wo")
        let total = await reads.value
        XCTAssertEqual(total, 2, "a read list is kept")
    }

    func testASearchIsAskedPerTextAndAnOlderCallIsCancelled() async throws {
        let model = AutocompleteModel<AutocompleteValue>()
        let asked = Counter()
        let source = AutocompleteSource<AutocompleteValue>.search { text in
            await asked.add()
            return [AutocompleteValue("answer for \(text)")]
        }
        model.need(source, text: "a")
        model.need(source, text: "ab")
        try await waitUntil { model.phase == .loaded }
        XCTAssertEqual(model.answered?.map(\.title), ["answer for ab"])
        let count = await asked.value
        XCTAssertEqual(count, 1, "the first text was replaced within the pause, so only the second was asked")
    }

    // MARK: Folders

    private func scratchHome() throws -> String {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("autocomplete-folder-\(UUID().uuidString)")
        for name in ["Notes/acme", "Notes/Meetings", "Projects", ".config", "Viewer.app"] {
            try FileManager.default.createDirectory(at: root.appendingPathComponent(name), withIntermediateDirectories: true)
        }
        FileManager.default.createFile(atPath: root.appendingPathComponent("notes.txt").path, contents: Data())
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root.path
    }

    func testATypedPathSplitsIntoTheFolderToListAndTheStartOfAName() {
        let home = "/Users/alice"
        XCTAssertEqual(FolderCompletion.split("", home: home), .init(folder: home + "/", prefix: "", typedParent: "~/"))
        XCTAssertEqual(FolderCompletion.split("~", home: home), .init(folder: home + "/", prefix: "", typedParent: "~/"))
        XCTAssertEqual(FolderCompletion.split("~/No", home: home), .init(folder: "/Users/alice/", prefix: "No", typedParent: "~/"))
        XCTAssertEqual(FolderCompletion.split("/tmp/x", home: home), .init(folder: "/tmp/", prefix: "x", typedParent: "/tmp/"))
        XCTAssertEqual(FolderCompletion.absolute("~/Notes/", home: home), "/Users/alice/Notes")
        XCTAssertEqual(FolderCompletion.absolute("/", home: home), "/")
    }

    func testFoldersCompleteFromTheHomeFolderAndHiddenOnesOnlyAfterADot() throws {
        let home = try scratchHome()
        XCTAssertEqual(try FolderCompletion.folders(for: "~/", home: home).map(\.title), ["~/Notes", "~/Projects"],
                       "no file, no package, no hidden folder")
        XCTAssertEqual(try FolderCompletion.folders(for: "~/no", home: home).map(\.title), ["~/Notes"])
        XCTAssertEqual(try FolderCompletion.folders(for: "~/Notes/", home: home).map(\.title), ["~/Notes/acme", "~/Notes/Meetings"])
        XCTAssertEqual(try FolderCompletion.folders(for: "~/.", home: home).map(\.title), ["~/.config"])
        XCTAssertEqual(try FolderCompletion.folders(for: "~/Missing/", home: home), [], "a folder that is not there has no folders")
    }

    func testAFolderMacOSKeepsFromTheAppIsASentenceNotAnEmptyList() {
        let denied = NSError(domain: NSCocoaErrorDomain, code: NSFileReadNoPermissionError,
                             userInfo: [NSUnderlyingErrorKey: NSError(domain: NSPOSIXErrorDomain, code: Int(EPERM))])
        let failure = FolderCompletion.failure(denied, folder: "/Users/alice/Documents", typed: "~/Documents/")
        XCTAssertTrue(failure.sentence.hasPrefix("macOS does not let this app read “Documents”."), failure.sentence)
        let other = FolderCompletion.failure(NSError(domain: NSPOSIXErrorDomain, code: Int(EIO)), folder: "/Volumes/X", typed: "/Volumes/X/")
        XCTAssertTrue(other.sentence.hasPrefix("The folders in “X” could not be read"), other.sentence)
    }

    private func waitUntil(_ condition: @MainActor () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(3)
        while !condition() {
            guard Date() < deadline else { return XCTFail("timed out") }
            try await Task.sleep(for: .milliseconds(20))
        }
    }
}

private actor Counter {
    private(set) var value = 0
    func add() { value += 1 }
}
