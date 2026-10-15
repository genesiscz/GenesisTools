//
//  MarkdownTabShortcut.swift
//  GenesisKit
//
//  The markdown viewer's window class. Its title bar strip (the toolbar) is the shared
//  `.titlebarZone(below:)` in Window/WindowTitlebar.swift since 2026-09-28. Its keys (⇧⌘ with the two keys right
//  of P for the tabs, ⌘W for the tab) moved to `MarkdownKeymap` on 2026-10-15, where they are matched by position
//  and the user can change them.
//

import AppKit
import os

/// The viewer's window. A `ConstraintSafeWindow`, so an animated zoom from its own `setFrame` is not dropped.
final class MarkdownDocumentWindow: ConstraintSafeWindow {
    /// Mouse presses here, tab actions from `MarkdownDocumentsView`: a press that arrives with no action after it is a
    /// click SwiftUI dropped.
    static let input = Logger(subsystem: "genesiskit", category: "markdown.input")
}

/// A tab-bar log line: the action, the tab's index, and the gesture. The title and the path stay out of it.
/// Both are the file name or the path, and this log is `privacy: .public`.
enum MarkdownTabLog {
    static func note(action: String, index: Int, gesture: String? = nil) -> String {
        var note = "tab action \(action) index=\(index)"
        if let gesture {
            note += " via=\(gesture)"
        }
        return note
    }
}

extension MarkdownDocumentWindow {

    /// Every mouse press, with what it hits and the app's modal state, so a window whose clicks stop working can be
    /// read afterwards: `log show --predicate 'subsystem == "genesiskit" && category == "markdown.input"'`.
    /// (2026-10-14: every click in the viewer did nothing while accessibility presses worked; a restart cleared it.)
    override func sendEvent(_ event: NSEvent) {
        if event.type == .leftMouseDown || event.type == .leftMouseUp {
            let hit = contentView?.superview?.hitTest(event.locationInWindow).map { String(describing: type(of: $0)) } ?? "nil"
            Self.input.notice("""
                \(event.type == .leftMouseDown ? "down" : "up", privacy: .public) clicks=\(event.clickCount) \
                hit=\(hit, privacy: .public) key=\(self.isKeyWindow) active=\(NSApp.isActive) \
                modal=\(NSApp.modalWindow.map { String(describing: type(of: $0)) } ?? "nil", privacy: .public) \
                sheet=\(self.attachedSheet != nil) \
                buttons=\(NSEvent.pressedMouseButtons)
                """)
        }
        super.sendEvent(event)
    }
}
