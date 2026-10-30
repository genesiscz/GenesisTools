//
//  MarkdownTreeTable.swift
//  GenesisKit
//
//  The markdown viewer's names for the shared tree table (Files/Tree, 2026-10-30). The viewer's file tree, the git
//  panel's table and their tests use them; a new caller uses the Gen* names.
//

import AppKit

typealias MarkdownTreeTable<Revision: Equatable> = GenTreeTable<FileTreeRow, Revision>
typealias MarkdownTreeTableView = GenTreeTableView
typealias MarkdownTreeTableCell = GenTreeTableCell
typealias MarkdownTreeCellHost = GenTreeCellHost
typealias MarkdownTreeKeyTarget = GenTreeKeyTarget
typealias MarkdownTreeKey = GenTreeKey
typealias MarkdownTreeKeyAction = GenTreeKeyAction
typealias MarkdownTreeKeys = GenTreeKeys<FileTreeRow>
typealias MarkdownTreeScrollBox = GenTreeScrollBox
typealias MarkdownTreeGlide = GenTreeGlide
typealias MarkdownTreeScroll = GenTreeScroll
typealias MarkdownOverlaySlot = GenOverlaySlot
typealias MarkdownWindowContentView = GenOverlayContentView
typealias MarkdownRootHostingView = GenRootHostingView
