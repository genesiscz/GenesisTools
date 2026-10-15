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
