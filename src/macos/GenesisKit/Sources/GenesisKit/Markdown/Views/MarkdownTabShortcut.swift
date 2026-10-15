//
//  MarkdownTabShortcut.swift
//  GenesisKit
//
//  The markdown viewer's window class and its tab keys. Its title bar strip (the toolbar) is the
//  shared `.titlebarZone(below:)` in Window/WindowTitlebar.swift since 2026-09-28; this file held a
//  window-specific double-click check before (`MarkdownTitlebarDoubleClick`, a `sendEvent`
//  intercept with a registry of toolbar control frames).
//

import AppKit

/// The viewer's window: ⌘⇧] / ⌘⇧[ switch its tabs.
final class MarkdownDocumentWindow: ConstraintSafeWindow {
    /// The tabs the shortcuts switch.
    weak var documents: MarkdownDocumentsModel?

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if let offset = MarkdownTabShortcut.offset(for: event), let documents {
            documents.selectTab(offset: offset)
            return true
        }
        return super.performKeyEquivalent(with: event)
    }
}

/// ⌘⇧] / ⌘⇧[ switch tabs by the physical bracket keys, the way browsers do.
/// SwiftUI's `.keyboardShortcut("]", modifiers: [.command, .shift])` compared
/// characters. With Shift down a US layout reports `}` and `{` on those keys
/// and the Czech layout `(` and `/`, and neither matched.
enum MarkdownTabShortcut {
    static let rightBracketKey: UInt16 = 30   // kVK_ANSI_RightBracket
    static let leftBracketKey: UInt16 = 33    // kVK_ANSI_LeftBracket

    /// +1 for the next tab, -1 for the previous one, nil for any other key.
    static func offset(for event: NSEvent) -> Int? {
        guard event.type == .keyDown,
              event.modifierFlags.intersection([.command, .shift, .option, .control]) == [.command, .shift]
        else { return nil }
        switch event.keyCode {
        case rightBracketKey: return 1
        case leftBracketKey: return -1
        default: return nil
        }
    }
}
