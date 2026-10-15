import XCTest
@testable import GenesisKit

/// Editing, ⌘S, and what happens when the file changes on disk under a draft.
/// Uses real files and the real watcher, so the timing is the app's timing.
@MainActor
final class MarkdownDocumentEditingTests: XCTestCase {
    private var dir: URL!
    private var file: URL!

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("md-edit-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        file = dir.appendingPathComponent("Note.md")
        try "# Title\n\nline one\nline two\n".write(to: file, atomically: true, encoding: .utf8)
    }

    /// Pumps the run loop until `condition` holds or `seconds` pass.
    private func wait(_ seconds: TimeInterval = 3, for condition: @escaping () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
        return condition()
    }

    private func writeExternally(_ text: String) throws {
        // The way other editors save: a new file renamed over the old inode.
        try text.write(to: file, atomically: true, encoding: .utf8)
    }

    func testEditingMarksDirtyAndSaveWritesTheFile() throws {
        let doc = MarkdownDocument(url: file)
        XCTAssertFalse(doc.isDirty)
        doc.edit("# Title\n\nline one\nline two\nline three\n")
        XCTAssertTrue(doc.isDirty)
        XCTAssertEqual(doc.displayText, "# Title\n\nline one\nline two\nline three\n")

        XCTAssertEqual(doc.save(), .saved)
        XCTAssertFalse(doc.isDirty)
        XCTAssertNil(doc.draft)
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "# Title\n\nline one\nline two\nline three\n")
        // The app's own write must not come back as a change on disk.
        XCTAssertFalse(wait(0.6) { doc.hasDiskChange })
        XCTAssertEqual(doc.save(), .nothingToSave)
    }

    func testEditingBackToTheDiskTextIsClean() {
        let doc = MarkdownDocument(url: file)
        doc.edit("changed")
        doc.edit("# Title\n\nline one\nline two\n")
        XCTAssertFalse(doc.isDirty)
    }

    func testCleanDocumentFollowsTheFile() throws {
        let doc = MarkdownDocument(url: file)
        try writeExternally("# New\n")
        XCTAssertTrue(wait { doc.text == "# New\n" })
        XCTAssertFalse(doc.hasDiskChange)
    }

    func testDeleteThenRecreateIsStillFollowed() throws {
        let doc = MarkdownDocument(url: file)
        try FileManager.default.removeItem(at: file)
        XCTAssertTrue(wait { doc.missing })
        // Longer than the watcher's own re-arm delay: only the folder watcher
        // can bring the file back.
        RunLoop.main.run(until: Date().addingTimeInterval(0.6))
        try "# Back\n".write(to: file, atomically: false, encoding: .utf8)
        XCTAssertTrue(wait { doc.text == "# Back\n" && !doc.missing })
        // And the re-armed watcher sees the next external change too.
        try writeExternally("# Back again\n")
        XCTAssertTrue(wait { doc.text == "# Back again\n" })
    }

    func testExternalChangeUnderADraftParksOnDiskAndBlocksSave() throws {
        let doc = MarkdownDocument(url: file)
        doc.edit("# Title\n\nline one\nline two\nmine\n")
        try writeExternally("# Title\n\nline one\nline two\ntheirs\n")
        XCTAssertTrue(wait { doc.hasDiskChange })
        // Nothing of mine moved, and the base is still what I edited from.
        XCTAssertEqual(doc.draft, "# Title\n\nline one\nline two\nmine\n")
        XCTAssertEqual(doc.text, "# Title\n\nline one\nline two\n")
        XCTAssertEqual(doc.diskChange, "# Title\n\nline one\nline two\ntheirs\n")
        XCTAssertEqual(doc.save(), .blockedByDiskChange)
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "# Title\n\nline one\nline two\ntheirs\n")
    }

    func testReloadDropsTheDraft() throws {
        let doc = MarkdownDocument(url: file)
        doc.edit("mine\n")
        try writeExternally("theirs\n")
        XCTAssertTrue(wait { doc.hasDiskChange })
        doc.takeDisk()
        XCTAssertFalse(doc.isDirty)
        XCTAssertEqual(doc.displayText, "theirs\n")
        XCTAssertFalse(doc.hasDiskChange)
    }

    func testKeepMineThenSaveOverwritesTheDiskVersion() throws {
        let doc = MarkdownDocument(url: file)
        doc.edit("mine\n")
        try writeExternally("theirs\n")
        XCTAssertTrue(wait { doc.hasDiskChange })
        doc.keepMine()
        XCTAssertTrue(doc.isDirty)
        XCTAssertFalse(doc.hasDiskChange)
        XCTAssertEqual(doc.save(), .saved)
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "mine\n")
    }

    func testMergeCombinesDisjointEditsAndSaveWritesBoth() throws {
        let doc = MarkdownDocument(url: file)
        // Mine edits line one; the other editor appends a line.
        doc.edit("# Title\n\nLINE ONE\nline two\n")
        try writeExternally("# Title\n\nline one\nline two\nline three\n")
        XCTAssertTrue(wait { doc.hasDiskChange })
        XCTAssertEqual(doc.mergeDiskChange(), 0)
        XCTAssertEqual(doc.displayText, "# Title\n\nLINE ONE\nline two\nline three\n")
        XCTAssertFalse(doc.hasDiskChange)
        XCTAssertEqual(doc.save(), .saved)
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "# Title\n\nLINE ONE\nline two\nline three\n")
    }

    func testMergeLeavesLabelledConflictMarkersInTheDraft() throws {
        let doc = MarkdownDocument(url: file)
        doc.edit("# Title\n\nmine\nline two\n")
        try writeExternally("# Title\n\ntheirs\nline two\n")
        XCTAssertTrue(wait { doc.hasDiskChange })
        XCTAssertEqual(doc.mergeDiskChange(), 1)
        XCTAssertEqual(doc.mergeConflicts, 1)
        XCTAssertEqual(doc.displayText, "# Title\n\n<<<<<<< mine\nmine\n=======\ntheirs\n>>>>>>> on disk\nline two\n")
        // Resolving by hand and saving clears the conflict count.
        doc.edit("# Title\n\nboth\nline two\n")
        XCTAssertEqual(doc.save(), .saved)
        XCTAssertEqual(doc.mergeConflicts, 0)
    }

    func testCompareDiffShowsDiskAsRemovedAndMineAsInserted() throws {
        let doc = MarkdownDocument(url: file)
        doc.edit("# Title\n\nline one\nmine\n")
        try writeExternally("# Title\n\nline one\ntheirs\n")
        XCTAssertTrue(wait { doc.hasDiskChange })
        XCTAssertEqual(doc.diskDiff, [.equal("# Title"), .equal(""), .equal("line one"), .removed("theirs"), .inserted("mine")])
    }

    func testClosingADirtyTabAsksAndCancelKeepsIt() {
        let defaults = UserDefaults(suiteName: "md-close-\(UUID().uuidString)")!
        let model = MarkdownDocumentsModel(defaults: defaults)
        model.open([file])
        let doc = model.docs[0]
        doc.edit("mine\n")

        XCTAssertFalse(model.close(doc, confirm: { _ in .cancel }))
        XCTAssertEqual(model.docs.count, 1)

        XCTAssertTrue(model.close(doc, confirm: { _ in .save }))
        XCTAssertEqual(model.docs.count, 0)
        XCTAssertEqual(try? String(contentsOf: file, encoding: .utf8), "mine\n")
    }

    // MARK: review findings (PR #80)

    /// An external write that the watcher has not reported yet must still
    /// block the save, instead of being overwritten by it.
    func testSaveRereadsTheDiskBeforeWritingEvenWithoutAWatcherCallback() throws {
        let doc = MarkdownDocument(url: file)
        doc.edit("# Title\n\nline one\nline two\nmine\n")
        // No run-loop pump between the write and the save: the watcher's
        // main-queue callback cannot have run.
        try writeExternally("# Title\n\nline one\nline two\ntheirs\n")
        XCTAssertEqual(doc.save(), .blockedByDiskChange)
        XCTAssertEqual(doc.diskChange, "# Title\n\nline one\nline two\ntheirs\n")
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "# Title\n\nline one\nline two\ntheirs\n")
    }

    /// A → B → A on disk under a draft: B is no longer on disk, so it must not
    /// stay parked for a later Reload or Merge to adopt.
    func testADiskChangeThatIsRevertedIsNoLongerParked() throws {
        let original = "# Title\n\nline one\nline two\n"
        let doc = MarkdownDocument(url: file)
        doc.edit(original + "mine\n")
        try writeExternally(original + "theirs\n")
        XCTAssertTrue(wait { doc.hasDiskChange })
        try writeExternally(original)
        XCTAssertTrue(wait { !doc.hasDiskChange })
        XCTAssertEqual(doc.draft, original + "mine\n")
        XCTAssertEqual(doc.save(), .saved)
    }

    /// After a merge with conflicts, "Reload from disk" has to drop the
    /// conflict-marked draft; the watcher's reload saw nothing new and did nothing.
    func testDiscardAfterAConflictingMergeShowsTheDiskAgain() throws {
        let doc = MarkdownDocument(url: file)
        doc.edit("# Title\n\nmine\nline two\n")
        try writeExternally("# Title\n\ntheirs\nline two\n")
        XCTAssertTrue(wait { doc.hasDiskChange })
        XCTAssertEqual(doc.mergeDiskChange(), 1)
        doc.discardDraft()
        XCTAssertFalse(doc.isDirty)
        XCTAssertEqual(doc.mergeConflicts, 0)
        XCTAssertEqual(doc.displayText, "# Title\n\ntheirs\nline two\n")
    }

    /// Base ends in a newline, the draft removed it, the disk edited another
    /// line: the merge keeps the draft's removal.
    func testMergeKeepsANewlineRemovalFromTheDraft() throws {
        try "a\nb\nc\n".write(to: file, atomically: true, encoding: .utf8)
        let doc = MarkdownDocument(url: file)
        doc.edit("a\nb\nc")
        try writeExternally("A\nb\nc\n")
        XCTAssertTrue(wait { doc.hasDiskChange })
        XCTAssertEqual(doc.mergeDiskChange(), 0)
        XCTAssertEqual(doc.displayText, "A\nb\nc")

        XCTAssertTrue(MarkdownDocument.mergedTrailingNewline(base: "x", ours: "x", theirs: "x\n"))
        XCTAssertTrue(MarkdownDocument.mergedTrailingNewline(base: "x", ours: "x\n", theirs: "x"))
        XCTAssertFalse(MarkdownDocument.mergedTrailingNewline(base: "x\n", ours: "x\n", theirs: "x"))
    }

    /// Closing the window resolves unsaved tabs but keeps every tab and the
    /// selection, so the next open restores the same session.
    func testClosingTheWindowSavesButKeepsTheTabsAndTheSelection() throws {
        let other = dir.appendingPathComponent("Other.md")
        try "# Other\n".write(to: other, atomically: true, encoding: .utf8)
        let defaults = UserDefaults(suiteName: "md-close-window-\(UUID().uuidString)")!
        let model = MarkdownDocumentsModel(defaults: defaults)
        model.open([file, other])
        model.docs[0].edit("mine\n")
        XCTAssertEqual(model.selectedId, other.standardizedFileURL.path)

        var asked: [String] = []
        XCTAssertFalse(model.resolveUnsavedForClose(confirm: { asked.append($0.title); return .cancel }))
        XCTAssertEqual(asked, ["Note"])
        XCTAssertEqual(model.docs.count, 2)
        // A cancel leaves the tab it asked about on screen.
        XCTAssertEqual(model.selectedId, file.standardizedFileURL.path)
        model.select(other.standardizedFileURL.path)

        XCTAssertTrue(model.resolveUnsavedForClose(confirm: { _ in .save }))
        XCTAssertEqual(model.docs.map(\.title), ["Note", "Other"])
        XCTAssertEqual(model.selectedId, other.standardizedFileURL.path)
        XCTAssertEqual(defaults.stringArray(forKey: "markdownWindow.tabs")?.count, 2)
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "mine\n")

        model.docs[1].edit("gone\n")
        XCTAssertTrue(model.resolveUnsavedForClose(confirm: { _ in .discard }))
        XCTAssertEqual(model.docs.count, 2)
        XCTAssertFalse(model.docs[1].isDirty)
        XCTAssertEqual(model.docs[1].displayText, "# Other\n")
    }

    /// The status bar's counts are cached per text version and follow edits.
    func testStatsFollowTheDisplayedText() {
        let doc = MarkdownDocument(url: file)
        XCTAssertEqual(doc.stats, MarkdownStats.of(doc.displayText))
        doc.edit("one two three")
        XCTAssertEqual(doc.stats.words, 3)
        doc.edit("one two three four")
        XCTAssertEqual(doc.stats.words, 4)
    }

    /// A deleted file keeps its draft, and saving writes it back.
    func testADraftSurvivesTheFileBeingDeletedAndSaveRecreatesIt() throws {
        let doc = MarkdownDocument(url: file)
        doc.edit("kept\n")
        try FileManager.default.removeItem(at: file)
        XCTAssertTrue(wait { doc.missing })
        XCTAssertTrue(doc.isDirty)
        XCTAssertEqual(doc.displayText, "kept\n")
        XCTAssertEqual(doc.save(), .saved)
        XCTAssertFalse(doc.missing)
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "kept\n")
    }
}
