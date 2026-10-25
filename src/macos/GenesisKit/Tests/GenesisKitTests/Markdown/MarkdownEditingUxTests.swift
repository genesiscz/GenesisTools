import AppKit
@testable import GenesisKit
import SwiftUI
import XCTest

/// The UX audit of 2026-10-25 (editing and sidebar): a change from outside is one undo step, discarding edits names
/// the loss, the gutter bars are reachable without the mouse.
@MainActor
final class MarkdownEditingUxTests: XCTestCase {
    // MARK: A change from outside the editor is one undo step

    func testTheChangedRangeKeepsTheCommonStartAndEnd() {
        let change = MarkdownSourceEditor.changedRange(old: "one two three", new: "one 2 three")
        XCTAssertEqual(change.range, NSRange(location: 4, length: 3))
        XCTAssertEqual(change.replacement, "2")

        let same = MarkdownSourceEditor.changedRange(old: "abc", new: "abc")
        XCTAssertEqual(same.range.length, 0)
        XCTAssertEqual(same.replacement, "")

        let appended = MarkdownSourceEditor.changedRange(old: "abc", new: "abcd")
        XCTAssertEqual(appended.range, NSRange(location: 3, length: 0))
        XCTAssertEqual(appended.replacement, "d")
    }

    func testTheChangedRangeNeverSplitsASurrogatePair() {
        // 😀 and 😃 share their high surrogate: a cut between the two halves would leave half a character.
        let old: NSString = "a😀b"
        let new: NSString = "a😃b"
        let change = MarkdownSourceEditor.changedRange(old: old, new: new)
        XCTAssertEqual(change.range, NSRange(location: 1, length: 2))
        XCTAssertEqual(change.replacement, "😃")
        XCTAssertEqual(old.replacingCharacters(in: change.range, with: change.replacement), new as String)
    }

    func testReplaceAllFromOutsideIsOneUndoStep() {
        var bound = "alpha beta alpha"
        let editor = MarkdownSourceEditor(text: Binding(get: { bound }, set: { bound = $0 }),
                                          font: .monospacedSystemFont(ofSize: 12, weight: .regular),
                                          textColor: .white, background: .black, completesWhileTyping: false)
        let host = NSHostingView(rootView: editor.frame(width: 400, height: 200))
        host.layoutSubtreeIfNeeded()
        func find(_ v: NSView) -> NSTextView? { (v as? NSTextView) ?? v.subviews.lazy.compactMap(find).first }
        let view = try! XCTUnwrap(find(host))
        let coordinator = try! XCTUnwrap(view.delegate as? MarkdownSourceEditor.Coordinator)

        // The model replaced every "alpha" (Replace All), and the binding already holds the result.
        bound = "omega beta omega"
        coordinator.replaceFromOutside(with: bound, in: view)
        XCTAssertEqual(view.string, "omega beta omega")
        XCTAssertEqual(view.undoManager?.canUndo, true, "the outside change is on the editor's undo stack")

        view.undoManager?.undo()
        XCTAssertEqual(view.string, "alpha beta alpha")
        XCTAssertEqual(bound, "alpha beta alpha", "the undo reaches the document through the binding")

        view.undoManager?.redo()
        XCTAssertEqual(view.string, "omega beta omega")
        XCTAssertEqual(bound, "omega beta omega")
    }

    // MARK: Discarding edits asks, and names the loss

    func testTheDiscardAlertCountsTheChangedLines() {
        let diff = TextMerge.diff(old: "a\nb\nc\n", new: "a\nB\nc\nd\n")
        XCTAssertEqual(MarkdownDiscardEdits.changedLines(diff), 3, "b removed, B and d added")
        XCTAssertEqual(MarkdownDiscardEdits.message(changedLines: 1, missing: false),
                       "Your unsaved edits (1 changed line) are thrown away and the file is read from disk again.")
        XCTAssertTrue(MarkdownDiscardEdits.message(changedLines: 4, missing: true).contains("4 changed lines"))
        XCTAssertEqual(MarkdownDiscardEdits.confirmTitle(missing: false), "Discard edits and reload")
        XCTAssertEqual(MarkdownDiscardEdits.confirmTitle(missing: true), "Discard edits")
    }

    func testAskingToDiscardChangesNothingUntilConfirmed() {
        var state = MarkdownDiscardEdits()
        state.ask(.takeDisk)
        XCTAssertEqual(state.pending, .takeDisk)
    }

    // MARK: Gutter bars without the mouse

    func testNextAndPreviousChangeWrapAtTheEnds() {
        let hunks = [
            GitHunk(kind: .added, newStart: 2, newCount: 1, oldStart: 2, oldLines: []),
            GitHunk(kind: .modified, newStart: 10, newCount: 2, oldStart: 10, oldLines: ["x"]),
        ]
        XCTAssertEqual(SourceTextView.hunkIndex(hunks, from: 0, step: 1), 0)
        XCTAssertEqual(SourceTextView.hunkIndex(hunks, from: 2, step: 1), 1)
        XCTAssertEqual(SourceTextView.hunkIndex(hunks, from: 12, step: 1), 0, "past the last change: back to the first")
        XCTAssertEqual(SourceTextView.hunkIndex(hunks, from: 12, step: -1), 1)
        XCTAssertEqual(SourceTextView.hunkIndex(hunks, from: 1, step: -1), 1, "before the first change: the last")
        XCTAssertNil(SourceTextView.hunkIndex([], from: 0, step: 1))
        XCTAssertEqual(SourceTextView.hunkTip(.deleted), "Removed lines. Click to see what was removed")
    }

    func testTheSourceViewHasASpokenName() {
        let editor = MarkdownSourceEditor(text: .constant("x"), font: .systemFont(ofSize: 12), textColor: .white, background: .black)
        let host = NSHostingView(rootView: editor.frame(width: 200, height: 100))
        host.layoutSubtreeIfNeeded()
        func find(_ v: NSView) -> NSTextView? { (v as? NSTextView) ?? v.subviews.lazy.compactMap(find).first }
        XCTAssertEqual(find(host)?.accessibilityLabel(), "Markdown source")
    }
}
