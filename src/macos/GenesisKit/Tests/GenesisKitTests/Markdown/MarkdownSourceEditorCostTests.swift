import AppKit
import SwiftUI
import XCTest
@testable import GenesisKit

/// The editor's scroll handler runs on every bounds change — dozens per
/// gesture. What it does per tick decides whether scrolling a 41 KB note is
/// free or is the fuel for a main-thread wedge.
@MainActor
final class MarkdownSourceEditorCostTests: XCTestCase {
    private func coordinator(text: String) -> (MarkdownSourceEditor.Coordinator, NSTextView) {
        let editor = MarkdownSourceEditor(
            text: .constant(text),
            font: .monospacedSystemFont(ofSize: 12, weight: .regular),
            textColor: .white,
            background: .black
        )
        let coordinator = editor.makeCoordinator()
        let view = NSTextView(frame: NSRect(x: 0, y: 0, width: 400, height: 400))
        view.string = text
        coordinator.view = view
        return (coordinator, view)
    }

    func testClearedFindSelectionCanBeRequestedAgainWithTheSameToken() throws {
        let match = MarkdownSourceSelection(range: NSRange(location: 6, length: 4), token: 1)
        func editor(_ selection: MarkdownSourceSelection?) -> MarkdownSourceEditor {
            MarkdownSourceEditor(text: .constant("alpha beta gamma"),
                                 font: .monospacedSystemFont(ofSize: 12, weight: .regular),
                                 textColor: .white, background: .black, selection: selection)
        }
        let host = NSHostingView(rootView: editor(match))
        host.frame = NSRect(x: 0, y: 0, width: 400, height: 300)
        func settle() {
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
            host.layoutSubtreeIfNeeded()
        }
        func textView(in view: NSView) -> NSTextView? {
            if let text = view as? NSTextView { return text }
            return view.subviews.lazy.compactMap { textView(in: $0) }.first
        }
        settle()
        let view = try XCTUnwrap(textView(in: host))
        XCTAssertEqual(view.selectedRange(), match.range)
        host.rootView = editor(nil)
        settle()
        view.setSelectedRange(NSRange(location: 0, length: 0))
        host.rootView = editor(match)
        settle()
        XCTAssertTrue(view === textView(in: host), "the editor is updated, not recreated")
        XCTAssertEqual(view.selectedRange(), match.range)
    }

    func testTheLineIndexIsBuiltOncePerEditNotOncePerScrollTick() {
        let body = (0..<2000).map { "line \($0) with some text on it" }.joined(separator: "\n")
        let (coordinator, view) = coordinator(text: body)

        // A scroll gesture: many reads, one index.
        for _ in 0..<200 { _ = coordinator.starts }
        XCTAssertEqual(coordinator.lineStartComputations, 1)

        // An edit invalidates it, and the new index reflects the new text.
        view.string = "one\ntwo\n"
        coordinator.invalidateLineStarts()
        XCTAssertEqual(coordinator.starts, SourceEditing.lineStarts("one\ntwo\n"))
        XCTAssertEqual(coordinator.lineStartComputations, 2)

        for _ in 0..<50 { _ = coordinator.starts }
        XCTAssertEqual(coordinator.lineStartComputations, 2, "still cached after the edit")
    }

    func testTheIndexIsCorrectForTheTextItWasBuiltFrom() {
        let (coordinator, _) = coordinator(text: "alpha\nbeta\ngamma")
        XCTAssertEqual(coordinator.starts, [0, 6, 11])
        XCTAssertEqual(SourceEditing.line(at: 7, starts: coordinator.starts), 1)
    }
}
