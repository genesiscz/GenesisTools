import XCTest
@testable import GenesisKit

/// Task boxes on the Swift side: which lines are task items, the one-byte write, a file that changed under the
/// page, and the document that decides between the file and the draft. Every file lives in a temporary folder.
@MainActor
final class MarkdownTaskListTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("genesiskit-tasks-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        // A read-only test file and folder must be writable again to be removed.
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: folder.path)
        if let names = try? FileManager.default.contentsOfDirectory(atPath: folder.path) {
            for name in names {
                try? FileManager.default.setAttributes([.posixPermissions: 0o644],
                                                       ofItemAtPath: folder.appendingPathComponent(name).path)
            }
        }
        try? FileManager.default.removeItem(at: folder)
    }

    private func file(_ text: String, name: String = "note.md") throws -> URL {
        let url = folder.appendingPathComponent(name)
        try Data(text.utf8).write(to: url)
        return url
    }

    private func bytes(_ text: String) -> [UInt8] { Array(text.utf8) }

    private func target(_ text: String, bodyLine: Int, item: String, checked: Bool) throws -> MarkdownTaskTarget {
        try XCTUnwrap(MarkdownTaskList.target(bodyLine: bodyLine, text: item, checked: checked, in: text))
    }

    // MARK: Which lines are task items

    func testTheGFMFormsAreTaskItemsAndLookalikesAreNot() {
        let note = """
        - [ ] open
        - [x] done
        - [X] done upper
        * [ ] star
        + [ ] plus
        1. [ ] ordered
        12) [x] ordered paren
          - [ ] nested
        \t- [ ] tab indented
        > - [ ] quoted
        > > * [x] twice quoted
        - [ ]
        -\t[ ]\ttabs
        - [ ] **openclaw-regenerable** · 6.4 GB · **OPEN**
        -[ ] no space after the marker
        - [ ]x no space after the box
        - [y] another state
        - [] empty box
        text with [ ] in the middle
        [ ] no list marker
        - see [x] mid-line
        """
        let items = MarkdownTaskList.items(in: bytes(note))
        XCTAssertEqual(items.map(\.line), Array(0...13))
        XCTAssertEqual(items.map(\.checked), [false, true, true, false, false, false, true, false, false, false, true, false, false, false])
        XCTAssertEqual(items.map(\.text), ["open", "done", "done upper", "star", "plus", "ordered", "ordered paren",
                                           "nested", "tab indented", "quoted", "twice quoted", "", "tabs",
                                           "**openclaw-regenerable** · 6.4 GB · **OPEN**"])
    }

    func testABoxInsideCodeOrTheFrontmatterIsText() {
        let note = """
        ---
        tags:
          - [ ] yaml
        ---
        - [ ] real one
        ````
        - [ ] fenced
        ```
        - [ ] still fenced (a shorter fence does not close a longer one)
        ````
        ~~~md
        - [x] tilde fenced
        ~~~
        - [x] real two
        """
        let items = MarkdownTaskList.items(in: bytes(note))
        XCTAssertEqual(items.map(\.text), ["real one", "real two"])
        XCTAssertEqual(items.map(\.line), [4, 13])
    }

    /// Four columns past the item a line sits in (or past the margin) is indented code or a paragraph's next line,
    /// as CommonMark reads it; the same indent under a list item is a nested task.
    func testIndentedCodeIsTextAndANestedItemUnderAListItemIsATask() {
        let items = MarkdownTaskList.items(in: bytes(Self.indentNote))
        XCTAssertEqual(items.map(\.text), ["parent", "four-space child", "tab child", "under a plain item", "ordered",
                                           "quoted parent", "quoted child", "after"])
        XCTAssertEqual(items.map(\.line), [0, 1, 2, 4, 10, 15, 16, 21])
    }

    /// Lines indented into list items, into code and into paragraphs. `MarkdownTaskWebTests` checks that the page
    /// draws boxes on exactly the lines the scanner names.
    static let indentNote = """
    - [ ] parent
        - [ ] four-space child
    \t- [ ] tab child
    - Group
        - [ ] under a plain item
    # Example

        - [ ] indented code
    A paragraph
        - [ ] its next line
    1. [ ] ordered

           - [ ] code inside the item
    -     [ ] code after the marker

    > - [ ] quoted parent
    >     - [ ] quoted child

    > Quoted text
    >
    >     - [ ] quoted code
    - [ ] after
    """

    func testLineNumbersMatchThePageForCRLFAndABOM() {
        let note = "\u{FEFF}- [ ] first\r\n\r\n- [x] third\r\n"
        let items = MarkdownTaskList.items(in: bytes(note))
        XCTAssertEqual(items.map(\.line), [0, 2])
        XCTAssertEqual(items.map(\.text), ["first", "third"], "no \\r in the text, no BOM in the first line's item")
        XCTAssertEqual(MarkdownTaskList.lines(bytes("a\nb\n")).count, 3, "a trailing newline makes an empty last line")
    }

    // MARK: The clicked item

    func testTheTargetIsFoundAtThePagesBodyLineAfterTheFrontmatter() throws {
        let note = "---\ntitle: x\n---\n# Plan\n\n- [ ] alpha\n- [ ] beta\n"
        let beta = try target(note, bodyLine: 3, item: "beta", checked: true)
        XCTAssertEqual(beta.line, 6, "body line 3 + 3 frontmatter lines")
        XCTAssertEqual(beta.lineBytes, bytes("- [ ] beta"))
        XCTAssertNil(MarkdownTaskList.target(bodyLine: 3, text: "gamma", checked: true, in: note),
                     "a text no item has: the page and the scanner disagree, nothing is changed")
    }

    // MARK: Byte-exact writes

    func testOnlyTheBoxByteChangesAndCRLFStays() throws {
        let note = "# Disk full\r\n\r\n- [ ] **openclaw-regenerable** · 6.4 GB · **OPEN**  \r\n- [x] done\r\n"
        let url = try file(note)
        let before = try Data(contentsOf: url)
        let item = try target(note, bodyLine: 2, item: "**openclaw-regenerable** · 6.4 GB · **OPEN**", checked: true)
        XCTAssertEqual(MarkdownTaskFile.apply(item, to: url), .saved(line: 2))
        let after = try Data(contentsOf: url)
        XCTAssertEqual(after.count, before.count)
        let changed = zip(before, after).enumerated().filter { $0.element.0 != $0.element.1 }.map(\.offset)
        XCTAssertEqual(changed.count, 1, "one byte, the box")
        XCTAssertEqual(after[changed[0]], UInt8(ascii: "x"))
        XCTAssertEqual(String(decoding: after, as: UTF8.self),
                       "# Disk full\r\n\r\n- [x] **openclaw-regenerable** · 6.4 GB · **OPEN**  \r\n- [x] done\r\n")

        let done = try target(String(decoding: after, as: UTF8.self), bodyLine: 3, item: "done", checked: false)
        XCTAssertEqual(MarkdownTaskFile.apply(done, to: url), .saved(line: 3))
        XCTAssertEqual(String(decoding: try Data(contentsOf: url), as: UTF8.self),
                       "# Disk full\r\n\r\n- [x] **openclaw-regenerable** · 6.4 GB · **OPEN**  \r\n- [ ] done\r\n")
        XCTAssertEqual(MarkdownTaskFile.apply(done, to: url), .unchanged(line: 3), "a second click with the same wish writes nothing")
    }

    func testTheWriteIsAtomicKeepsThePermissionsAndLeavesNoTemporaryFile() throws {
        let url = try file("- [ ] one\n")
        try FileManager.default.setAttributes([.posixPermissions: 0o640], ofItemAtPath: url.path)
        let inodeBefore = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: url.path)[.systemFileNumber] as? Int)
        let item = try target("- [ ] one\n", bodyLine: 0, item: "one", checked: true)
        XCTAssertEqual(MarkdownTaskFile.apply(item, to: url), .saved(line: 0))
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o640)
        XCTAssertNotEqual(attributes[.systemFileNumber] as? Int, inodeBefore, "a new inode: the temporary file was renamed over it")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path), ["note.md"])
    }

    func testASymlinkStaysASymlinkAndItsNoteChanges() throws {
        let real = try file("- [ ] linked\n", name: "real.md")
        let link = folder.appendingPathComponent("link.md")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
        let item = try target("- [ ] linked\n", bodyLine: 0, item: "linked", checked: true)
        XCTAssertEqual(MarkdownTaskFile.apply(item, to: link), .saved(line: 0))
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: link.path), real.path)
        XCTAssertEqual(try String(contentsOf: real, encoding: .utf8), "- [x] linked\n")
    }

    func testAWriteThatLandedMeanwhileIsNeverOverwritten() throws {
        let url = try file("- [ ] one\n")
        XCTAssertThrowsError(try MarkdownAtomicWrite.replace(url, with: bytes("- [x] one\n"), expected: bytes("- [ ] something else\n"))) {
            XCTAssertEqual($0 as? MarkdownAtomicWrite.Failure, .changed)
        }
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "- [ ] one\n")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path), ["note.md"], "the temporary file is gone")
    }

    /// The race the check alone left open: another program saves after the check and before the new bytes go in. Its
    /// save is kept, whether it wrote into the file or renamed a new file over it, and the box is set on top of it by
    /// the retry.
    func testAWriteBetweenTheCheckAndThePlacementIsKept() throws {
        for (name, options) in [("in-place.md", Data.WritingOptions()), ("renamed.md", .atomic)] {
            let url = try file("- [ ] one\n", name: name)
            let theirs = "- [ ] one\n- [ ] added by an agent\n"
            XCTAssertThrowsError(try MarkdownAtomicWrite.replace(url, with: bytes("- [x] one\n"), expected: bytes("- [ ] one\n"),
                                                                 beforePlacing: { try? Data(theirs.utf8).write(to: url, options: options) })) {
                XCTAssertEqual($0 as? MarkdownAtomicWrite.Failure, .changed, name)
            }
            XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), theirs, "\(name): the other program's save stays")

            let one = try target("- [ ] one\n", bodyLine: 0, item: "one", checked: true)
            XCTAssertEqual(MarkdownTaskFile.apply(one, to: url), .saved(line: 0))
            XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "- [x] one\n- [ ] added by an agent\n")
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path).sorted(), ["in-place.md", "renamed.md"],
                       "no temporary file and no old file left behind")
    }

    // MARK: The file changed underneath

    func testAnAgentAppendedOrInsertedAboveAndTheItemIsFoundByItsText() throws {
        let drawn = "# Todo\n\n- [ ] alpha\n- [ ] beta\n"
        let beta = try target(drawn, bodyLine: 3, item: "beta", checked: true)
        let url = try file("# Todo\nAdded by an agent.\nAnd another line.\n\n- [ ] alpha\n- [ ] beta\n- [ ] appended\n")
        XCTAssertEqual(MarkdownTaskFile.apply(beta, to: url), .saved(line: 5), "the line moved down by two")
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8),
                       "# Todo\nAdded by an agent.\nAnd another line.\n\n- [ ] alpha\n- [x] beta\n- [ ] appended\n")
    }

    func testAnItemThatIsGoneOrNoLongerOneOfAKindIsRefusedAndTheFileStays() throws {
        let drawn = "- [ ] alpha\n- [ ] beta\n"
        let beta = try target(drawn, bodyLine: 1, item: "beta", checked: true)

        let renamed = "- [ ] alpha\n- [ ] beta, renamed\n"
        let gone = try file(renamed, name: "gone.md")
        XCTAssertEqual(MarkdownTaskFile.apply(beta, to: gone), .notFound)
        XCTAssertEqual(try String(contentsOf: gone, encoding: .utf8), renamed)

        let twice = "New first line.\n- [ ] alpha\n- [ ] beta\n- [ ] beta\n"
        let ambiguous = try file(twice, name: "twice.md")
        XCTAssertEqual(MarkdownTaskFile.apply(beta, to: ambiguous), .ambiguous(2))
        XCTAssertEqual(try String(contentsOf: ambiguous, encoding: .utf8), twice)

        // The real item was deleted and only a code example with its text is left: the code is never written.
        let drawnWithExample = "- [ ] beta\n\n# Example\n\n    - [ ] beta\n"
        let realBeta = try target(drawnWithExample, bodyLine: 0, item: "beta", checked: true)
        let onlyCode = "# Example\n\n    - [ ] beta\n"
        let example = try file(onlyCode, name: "example.md")
        XCTAssertEqual(MarkdownTaskFile.apply(realBeta, to: example), .notFound)
        XCTAssertEqual(try String(contentsOf: example, encoding: .utf8), onlyCode)

        let checkedElsewhere = try file("Inserted.\n- [ ] alpha\n- [x] beta\n", name: "checked.md")
        XCTAssertEqual(MarkdownTaskFile.apply(beta, to: checkedElsewhere), .unchanged(line: 2),
                       "another writer already checked it: nothing to write")
    }

    // MARK: The document

    private func settle(_ doc: MarkdownDocument, _ target: MarkdownTaskTarget, saveAtOnce: Bool = true) async throws
        -> MarkdownDocument.TaskOutcome {
        var outcome: MarkdownDocument.TaskOutcome?
        doc.setTask(target, saveAtOnce: saveAtOnce) { outcome = $0 }
        for _ in 0..<100 where outcome == nil {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        return try XCTUnwrap(outcome)
    }

    func testACleanNoteIsSavedAndTakesTheFilesText() async throws {
        let url = try file("- [ ] alpha\n")
        let doc = MarkdownDocument(url: url)
        let alpha = try target(doc.displayText, bodyLine: 0, item: "alpha", checked: true)
        let outcome = try await settle(doc, alpha)
        XCTAssertEqual(outcome, .saved)
        XCTAssertEqual(doc.text, "- [x] alpha\n")
        XCTAssertFalse(doc.isDirty)
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "- [x] alpha\n")
    }

    func testUnsavedEditsOrTheDraftSettingKeepTheChangeInTheDraft() async throws {
        let url = try file("- [ ] alpha\n")
        let doc = MarkdownDocument(url: url)
        doc.edit("- [ ] alpha\n- [ ] typed\n")
        let typed = try target(doc.displayText, bodyLine: 1, item: "typed", checked: true)
        let first = try await settle(doc, typed)
        XCTAssertEqual(first, .drafted)
        XCTAssertEqual(doc.displayText, "- [ ] alpha\n- [x] typed\n")
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "- [ ] alpha\n", "the file waits for the save")

        let clean = MarkdownDocument(url: try file("- [ ] beta\n", name: "other.md"))
        let beta = try target(clean.displayText, bodyLine: 0, item: "beta", checked: true)
        let second = try await settle(clean, beta, saveAtOnce: false)
        XCTAssertEqual(second, .drafted)
        XCTAssertTrue(clean.isDirty)
        XCTAssertEqual(try String(contentsOf: clean.url, encoding: .utf8), "- [ ] beta\n")
    }

    func testAReadOnlyFileOrTheSettingLocksTheBoxes() throws {
        let url = try file("- [ ] alpha\n")
        XCTAssertNil(MarkdownDocument(url: url).taskLock(.saveAtOnce))
        XCTAssertNotNil(MarkdownDocument(url: url).taskLock(.readOnly))
        try FileManager.default.setAttributes([.posixPermissions: 0o444], ofItemAtPath: url.path)
        let readOnly = MarkdownDocument(url: url)
        XCTAssertFalse(readOnly.writable)
        XCTAssertEqual(readOnly.taskLock(.saveAtOnce), "This file is read-only, so its tasks cannot be checked off here.")
        XCTAssertEqual(readOnly.taskLock(.editDraft), readOnly.taskLock(.saveAtOnce))

        let missing = MarkdownDocument(url: folder.appendingPathComponent("missing.md"))
        XCTAssertNotNil(missing.taskLock(.saveAtOnce))
    }

    // MARK: The native renderer's parser

    func testTheNativeParserReadsOrderedTasksAndABoxAtTheEndOfALine() {
        let blocks = MarkdownBlocks.parse("1. [ ] ordered\n- [X] upper\n- [ ]\n- [x]y not a box")
        let tasks = blocks.compactMap { block -> String? in
            guard case .listItem(_, _, _, let text, let task, _) = block else { return nil }
            return "\(task.map { $0 ? "x" : " " } ?? "-")|\(text)"
        }
        XCTAssertEqual(tasks, [" |ordered", "x|upper", " |", "-|[x]y not a box"])
    }
}
