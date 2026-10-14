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

/// The viewer's window. A `ConstraintSafeWindow`, so an animated zoom from its own `setFrame` is not dropped.
final class MarkdownDocumentWindow: ConstraintSafeWindow {}
