import SwiftUI
import XCTest
@testable import GenesisKit

/// Tab / Shift+Tab move the selected lines, Enter continues lists.
final class SourceEditingTests: XCTestCase {
    private func run(_ edit: SourceEditing.Edit, on text: String) -> (String, NSRange) {
        ((text as NSString).replacingCharacters(in: edit.range, with: edit.replacement), edit.selection)
    }

    func testTheUnitComesFromTheDocumentAndDefaultsToATab() {
        XCTAssertEqual(SourceEditing.indentUnit(for: "- a\n  - b\n    - c"), "  ")
        XCTAssertEqual(SourceEditing.indentUnit(for: "- a\n    - b"), "    ")
        XCTAssertEqual(SourceEditing.indentUnit(for: "- a\n\t- b\n  - c"), "\t")
        XCTAssertEqual(SourceEditing.indentUnit(for: "# Fresh\n\nno nesting yet"), "\t")
        // A fenced code block's indentation is not the prose's.
        XCTAssertEqual(SourceEditing.indentUnit(for: "```\n    code\n```\n- a\n  - b"), "  ")
        XCTAssertEqual(SourceEditing.indentUnit(for: "```swift\n    code\n```"), "\t")
    }

    func testTabWithACaretInsertsTheDocumentsUnit() {
        let (out, sel) = run(SourceEditing.indent("ab", selection: NSRange(location: 1, length: 0)), on: "ab")
        XCTAssertEqual(out, "a\tb")
        XCTAssertEqual(sel, NSRange(location: 2, length: 0))
        let (out2, _) = run(SourceEditing.indent("ab", selection: NSRange(location: 1, length: 0), unit: "  "), on: "ab")
        XCTAssertEqual(out2, "a  b")
    }

    func testTabIndentsEverySelectedLineAndKeepsTheSelectionOnThem() {
        let text = "one\ntwo\nthree\nfour"
        // "wo\nthree\nfo" spans lines 2..4
        let sel = NSRange(location: 5, length: 11)
        let (out, after) = run(SourceEditing.indent(text, selection: sel, unit: "  "), on: text)
        XCTAssertEqual(out, "one\n  two\n  three\n  four")
        XCTAssertEqual((out as NSString).substring(with: after), "wo\n  three\n  fo")
    }

    func testTabSkipsBlankLinesAndASelectionEndingAtALineStart() {
        let text = "a\n\nb\nc"
        // "a\n\nb\n": ends right after b's newline, so c is not part of it
        let sel = NSRange(location: 0, length: 5)
        let (out, after) = run(SourceEditing.indent(text, selection: sel, unit: "  "), on: text)
        XCTAssertEqual(out, "  a\n\n  b\nc")
        XCTAssertEqual((out as NSString).substring(with: after), "a\n\n  b\n")
    }

    func testShiftTabRemovesOneUnitOrATabOrWhateverIsThere() {
        let text = "    deep\n\tx\n y\nz"
        let sel = NSRange(location: 0, length: (text as NSString).length)
        let (out, after) = run(SourceEditing.outdent(text, selection: sel, unit: "  "), on: text)
        XCTAssertEqual(out, "  deep\nx\ny\nz")
        XCTAssertEqual(after, NSRange(location: 0, length: (out as NSString).length))
    }

    func testShiftTabWithACaretInsideTheIndentDoesNotMoveItBeforeTheLine() {
        let text = "  a"
        let (out, after) = run(SourceEditing.outdent(text, selection: NSRange(location: 1, length: 0), unit: "  "), on: text)
        XCTAssertEqual(out, "a")
        XCTAssertEqual(after, NSRange(location: 0, length: 0))
    }

    func testEnterContinuesBulletsTasksAndNumbers() {
        func next(_ line: String) -> String? {
            SourceEditing.newline(line, selection: NSRange(location: (line as NSString).length, length: 0))
                .map { (line as NSString).replacingCharacters(in: $0.range, with: $0.replacement) }
        }
        XCTAssertEqual(next("- a"), "- a\n- ")
        XCTAssertEqual(next("  * a"), "  * a\n  * ")
        XCTAssertEqual(next("- [x] done"), "- [x] done\n- [ ] ")
        XCTAssertEqual(next("3. c"), "3. c\n4. ")
        XCTAssertNil(next("plain"))
        XCTAssertNil(next("-not a list"))
    }

    func testEnterAtTheLargestNumberedListMarkerDoesNotOverflow() throws {
        for (marker, next) in [
            ("9", "10"),
            (String(Int.max - 1), String(Int.max)),
            (String(Int.max), String(Int.max)),
            (String(Int.max) + "0", String(Int.max) + "0"),
        ] {
            for delimiter in [".", ")"] {
                let text = "  \(marker)\(delimiter) item"
                let edit = try XCTUnwrap(SourceEditing.newline(
                    text, selection: NSRange(location: (text as NSString).length, length: 0)
                ))
                let (out, selection) = run(edit, on: text)
                XCTAssertEqual(out, text + "\n  \(next)\(delimiter) ")
                XCTAssertEqual(selection, NSRange(location: (out as NSString).length, length: 0))
            }
        }
    }

    func testEnterOnAnEmptyItemEndsTheList() {
        let text = "- a\n  - "
        let edit = SourceEditing.newline(text, selection: NSRange(location: 8, length: 0))!
        let (out, after) = run(edit, on: text)
        XCTAssertEqual(out, "- a\n  ")
        XCTAssertEqual(after, NSRange(location: 6, length: 0))
    }

    /// The caret right after the marker of an item that has text: Enter
    /// splits the item, it does not strip the marker from it.
    func testEnterRightAfterTheMarkerOfANonEmptyItemSplitsIt() throws {
        for (text, caret, expected) in [
            ("- text", 2, "- \n- text"),
            ("- [ ] task", 6, "- [ ] \n- [ ] task"),
            ("1. first", 3, "1. \n2. first"),
        ] {
            let edit = SourceEditing.newline(text, selection: NSRange(location: caret, length: 0))
            let (out, _) = run(try XCTUnwrap(edit), on: text)
            XCTAssertEqual(out, expected, text)
        }
        // A genuinely empty item at the end of its line still ends the list.
        let (out, _) = run(SourceEditing.newline("- a\n- \nnext", selection: NSRange(location: 6, length: 0))!, on: "- a\n- \nnext")
        XCTAssertEqual(out, "- a\n\nnext")
    }

    /// Shift+Tab takes only leading spaces: interior spaces are content.
    func testShiftTabNeverRemovesContentFromUnindentedLines() {
        let text = "hello world\n a  b"
        let sel = NSRange(location: 0, length: (text as NSString).length)
        let (out, _) = run(SourceEditing.outdent(text, selection: sel, unit: "  "), on: text)
        XCTAssertEqual(out, "hello world\na  b")
    }
}

/// The real NSTextView path: Tab and Shift+Tab arrive as commands, the edit
/// lands in the text storage, and one undo takes it back.
@MainActor
final class MarkdownSourceEditorViewTests: XCTestCase {
    func testTabCommandIndentsSelectedLinesAndUndoRevertsIt() {
        var bound = "one\ntwo"
        let editor = MarkdownSourceEditor(text: Binding(get: { bound }, set: { bound = $0 }),
                                          font: .monospacedSystemFont(ofSize: 12, weight: .regular),
                                          textColor: .white, background: .black)
        let host = NSHostingView(rootView: editor.frame(width: 400, height: 200))
        host.layoutSubtreeIfNeeded()
        func find(_ v: NSView) -> NSTextView? { (v as? NSTextView) ?? v.subviews.lazy.compactMap(find).first }
        let view = find(host)!
        let coordinator = view.delegate as! MarkdownSourceEditor.Coordinator
        view.setSelectedRange(NSRange(location: 0, length: 7))

        // No indented line yet, so the document's unit is a tab.
        XCTAssertTrue(coordinator.textView(view, doCommandBy: #selector(NSResponder.insertTab(_:))))
        XCTAssertEqual(view.string, "\tone\n\ttwo")
        XCTAssertEqual(bound, "\tone\n\ttwo")

        view.undoManager?.undo()
        XCTAssertEqual(view.string, "one\ntwo")
        XCTAssertEqual(bound, "one\ntwo")

        // A two-space document: Shift+Tab takes two spaces, or a stray tab.
        view.string = "- a\n  - b\n\t- c"
        view.setSelectedRange(NSRange(location: 4, length: 8))
        XCTAssertTrue(coordinator.textView(view, doCommandBy: #selector(NSResponder.insertBacktab(_:))))
        XCTAssertEqual(view.string, "- a\n- b\n- c")
        XCTAssertEqual(bound, "- a\n- b\n- c")
    }
}
