//
//  MarkdownSourceEditor.swift
//  GenesisKit
//
//  The source view of the markdown window. SwiftUI's TextEditor gives no
//  say over Tab, so this is an NSTextView: Tab / Shift+Tab indent and
//  outdent the selected lines (SourceEditing), Enter continues a list item,
//  and every edit stays on the undo stack. The markdown is coloured as it is
//  edited (MarkdownSourceHighlighter, the text storage's delegate).
//

import AppKit
import SwiftUI

/// A range the find bar wants on screen. The token lets the same range be
/// re-sent after a replace.
struct MarkdownSourceSelection: Equatable {
    var range: NSRange
    var token: Int
}

/// The editor's text view. `performKeyEquivalent` is the only place a plain
/// text view sees ⌘B and friends, and `paste` is where a pasted URL can become
/// a link before AppKit inserts it as text.
final class SourceTextView: NSTextView {
    var onKeyEquivalent: ((NSEvent) -> Bool)?
    /// The lines that differ from HEAD, drawn as bars in the left inset (green added, blue changed, a red mark where
    /// lines were removed). A click on a bar calls `onHunk` with the bar's rect.
    var gitHunks: [GitHunk] = [] {
        didSet { if gitHunks != oldValue { needsDisplay = true } }
    }
    var onHunk: ((GitHunk, NSRect) -> Void)?

    override func drawBackground(in rect: NSRect) {
        super.drawBackground(in: rect)
        for (hunk, bar) in hunkBars() where bar.intersects(rect) {
            Self.color(hunk.kind).setFill()
            if hunk.kind == .deleted {
                // A small wedge on the line the removed text stood before.
                let path = NSBezierPath()
                path.move(to: NSPoint(x: bar.minX, y: bar.minY))
                path.line(to: NSPoint(x: bar.maxX, y: bar.midY))
                path.line(to: NSPoint(x: bar.minX, y: bar.maxY))
                path.close()
                path.fill()
            } else {
                NSBezierPath(roundedRect: bar, xRadius: 1.5, yRadius: 1.5).fill()
            }
        }
    }


    static func color(_ kind: GitHunk.Kind) -> NSColor {
        switch kind {
        case .added: return NSColor(GitChangeKind.added.color)
        case .modified: return NSColor(GitChangeKind.renamed.color)
        case .deleted: return NSColor(GitChangeKind.deleted.color)
        }
    }

    /// Each hunk's bar in view coordinates: x 3–6 pt in the 12 pt inset, as tall as its lines.
    private func hunkBars() -> [(GitHunk, NSRect)] {
        guard !gitHunks.isEmpty, let layout = layoutManager else { return [] }
        let text = string as NSString
        var starts = [0]
        var index = 0
        while index < text.length {
            let line = text.lineRange(for: NSRange(location: index, length: 0))
            index = NSMaxRange(line)
            if index < text.length || text.hasSuffix("\n") { starts.append(index) }
            if line.length == 0 { break }
        }
        let origin = textContainerOrigin
        func lineRect(_ line: Int) -> NSRect? {
            guard line < starts.count else { return nil }
            let char = starts[line]
            if char >= text.length {
                let extra = layout.extraLineFragmentRect
                return extra.isEmpty ? nil : extra
            }
            let glyph = layout.glyphIndexForCharacter(at: char)
            return layout.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
        }
        var bars: [(GitHunk, NSRect)] = []
        for hunk in gitHunks {
            if hunk.kind == .deleted {
                let anchor = lineRect(hunk.newStart) ?? lineRect(max(0, hunk.newStart - 1)).map { $0.offsetBy(dx: 0, dy: $0.height) }
                guard let anchor else { continue }
                bars.append((hunk, NSRect(x: 2, y: origin.y + anchor.minY - 4, width: 6, height: 8)))
                continue
            }
            guard let first = lineRect(hunk.newStart), let last = lineRect(hunk.newStart + max(0, hunk.newCount - 1)) else { continue }
            bars.append((hunk, NSRect(x: 3, y: origin.y + first.minY + 1, width: 3, height: last.maxY - first.minY - 2)))
        }
        return bars
    }
    /// Files dropped from Finder. Without this an NSTextView pastes the path
    /// into the document, which is never what dragging a note in means.
    var onDropFiles: (([URL]) -> Void)?

    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        MarkdownDrop.urls(from: sender.draggingPasteboard).isEmpty
            ? super.draggingEntered(sender)
            : .copy
    }

    override func draggingUpdated(_ sender: any NSDraggingInfo) -> NSDragOperation {
        MarkdownDrop.urls(from: sender.draggingPasteboard).isEmpty
            ? super.draggingUpdated(sender)
            : .copy
    }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        let urls = MarkdownDrop.urls(from: sender.draggingPasteboard)
        guard !urls.isEmpty, let onDropFiles else { return super.performDragOperation(sender) }
        onDropFiles(urls)
        return true
    }
    /// What the caret is completing right now, so AppKit's own completion
    /// machinery replaces the typed part rather than the whole word.
    var completionRequest: MarkdownCompletion.Request? {
        MarkdownCompletion.request(in: string, caret: selectedRange().location)
    }

    override var rangeForUserCompletion: NSRange {
        completionRequest?.range ?? super.rangeForUserCompletion
    }

    override func insertCompletion(_ word: String, forPartialWordRange charRange: NSRange, movement: Int, isFinal flag: Bool) {
        guard flag, let request = completionRequest else {
            super.insertCompletion(word, forPartialWordRange: charRange, movement: movement, isFinal: flag)
            return
        }
        let ns = string as NSString
        let tail = NSMaxRange(charRange)
        let rest = ns.substring(with: NSRange(location: tail, length: min(2, ns.length - tail)))
        let text = MarkdownCompletion.insertion(word, kind: request.kind, followedBy: rest)
        super.insertCompletion(text, forPartialWordRange: charRange, movement: movement, isFinal: flag)
    }
    /// ⌘-click on a wikilink, a markdown link or a bare URL.
    var onOpenLink: ((String) -> Void)?

    override func mouseDown(with event: NSEvent) {
        // A click on a gutter bar, in the left inset.
        let point = convert(event.locationInWindow, from: nil)
        if point.x < textContainerInset.width, let onHunk,
           let hit = hunkBars().first(where: { $0.1.insetBy(dx: -4, dy: -2).contains(point) }) {
            onHunk(hit.0, hit.1)
            return
        }
        let command = event.modifierFlags.intersection(.deviceIndependentFlagsMask).contains(.command)
        if command, let open = onOpenLink {
            let point = convert(event.locationInWindow, from: nil)
            let offset = characterIndexForInsertion(at: point)
            if let target = MarkdownSourceLinks.target(in: string, at: offset) {
                open(target)
                return
            }
        }
        super.mouseDown(with: event)
    }

    /// The pointing hand while ⌘ is held says the text is clickable.
    override func cursorUpdate(with event: NSEvent) {
        if onOpenLink != nil, NSEvent.modifierFlags.contains(.command) {
            NSCursor.pointingHand.set()
            return
        }
        super.cursorUpdate(with: event)
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if window?.firstResponder === self, onKeyEquivalent?(event) == true { return true }
        return super.performKeyEquivalent(with: event)
    }

    override func paste(_ sender: Any?) {
        guard let coordinator = delegate as? MarkdownSourceEditor.Coordinator else {
            super.paste(sender)
            return
        }
        coordinator.pasting = true
        super.paste(sender)
        coordinator.pasting = false
    }
}

struct MarkdownSourceEditor: NSViewRepresentable {
    @Binding var text: String
    var font: NSFont
    var textColor: NSColor
    var background: NSColor
    /// The palette of the markdown colours. nil: the palette whose page colour `background` is.
    var theme: MarkdownTheme? = nil
    /// Where this document was left, applied once when the editor appears.
    var restoreScroll: Double? = nil
    /// Reports the editor's scroll position as it changes.
    var onScroll: ((Double) -> Void)? = nil
    /// A match to select and scroll to, from the find bar.
    var selection: MarkdownSourceSelection? = nil
    /// The selection moved: the range, and whether the reader moved it (false
    /// for the find bar's own selections and for text replaced from outside).
    /// ⌘F takes its query from it and find in selection its scope.
    var onSelectionChange: ((NSRange, Bool) -> Void)? = nil
    /// The 0-based line at the top of the visible area, reported while the
    /// editor scrolls. Split view feeds it to the preview.
    var onTopLine: ((Int) -> Void)? = nil
    /// ⌘-click on a link in the source. nil = clicks are plain text.
    var onOpenLink: ((String) -> Void)? = nil
    /// Vault names for `[[` and tags for `#`. nil = no completion.
    var completions: ((MarkdownCompletion.Request) -> [String])? = nil
    /// Files dropped onto the editor. nil = AppKit's own handling, which
    /// pastes the path into the document.
    var onDropFiles: (([URL]) -> Void)? = nil
    /// The lines that differ from HEAD, as gutter bars. Empty: no bars.
    var gitHunks: [GitHunk] = []
    /// A click on a gutter bar: the hunk, the bar's rect and the view it is in.
    var onHunk: ((GitHunk, NSRect, NSView) -> Void)? = nil

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        // TextKit 1 from the start. The scroll handler and the scroll restore
        // read `layoutManager`, and on a TextKit 2 view that read switches the
        // text system. When the switch came from a scroll AppKit makes inside
        // the view's own `layout` (a find match applied before the first
        // layout, as entering split view does), AppKit went on to draw the
        // selection through the text layout manager it had just dropped and
        // aborted (`assert(textLayoutManager)`, 2026-10-07 18:25).
        let view = SourceTextView(usingTextLayoutManager: false)
        view.frame = NSRect(origin: .zero, size: scroll.contentSize)
        view.textContainer?.widthTracksTextView = true
        view.autoresizingMask = [.width]
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        view.minSize = NSSize(width: 0, height: 0)
        view.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        scroll.documentView = view
        view.onKeyEquivalent = { [weak coordinator = context.coordinator] event in
            coordinator?.handle(event) ?? false
        }
        view.onOpenLink = { [weak coordinator = context.coordinator] target in
            coordinator?.parent.onOpenLink?(target)
        }
        view.onDropFiles = { [weak coordinator = context.coordinator] urls in
            coordinator?.parent.onDropFiles?(urls)
        }
        view.onHunk = { [weak coordinator = context.coordinator, weak view] hunk, rect in
            guard let view else { return }
            coordinator?.parent.onHunk?(hunk, rect, view)
        }
        view.gitHunks = gitHunks
        view.registerForDraggedTypes(MarkdownDrop.draggedTypes)
        view.delegate = context.coordinator
        view.isRichText = false
        view.allowsUndo = true
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.isAutomaticDashSubstitutionEnabled = false
        view.isAutomaticTextReplacementEnabled = false
        view.isAutomaticSpellingCorrectionEnabled = false
        view.usesFindBar = true
        view.textContainerInset = NSSize(width: 12, height: 12)
        view.setAccessibilityIdentifier("markdown-source-view")
        scroll.drawsBackground = true
        context.coordinator.view = view
        context.coordinator.watchScroll(scroll)
        if let storage = view.textStorage { context.coordinator.highlighter.attach(to: storage) }
        apply(to: view, scroll: scroll, highlighter: context.coordinator.highlighter)
        view.string = text
        if let top = restoreScroll, top > 0 {
            // The text needs a layout pass before it can be scrolled.
            DispatchQueue.main.async {
                view.layoutManager?.ensureLayout(for: view.textContainer!)
                scroll.contentView.scroll(to: NSPoint(x: 0, y: top))
                scroll.reflectScrolledClipView(scroll.contentView)
            }
        }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let view = scroll.documentView as? NSTextView else { return }
        context.coordinator.parent = self
        apply(to: view, scroll: scroll, highlighter: context.coordinator.highlighter)
        if let source = view as? SourceTextView, source.gitHunks != gitHunks {
            source.gitHunks = gitHunks
        }
        if view.string != text {
            context.coordinator.invalidateLineStarts()
            let sel = view.selectedRange()
            context.coordinator.programmaticSelection = true
            view.string = text
            let end = (text as NSString).length
            view.setSelectedRange(NSRange(location: min(sel.location, end), length: 0))
            context.coordinator.programmaticSelection = false
        }
        if selection == nil { context.coordinator.lastSelection = nil }
        if let wanted = selection, context.coordinator.lastSelection != wanted {
            context.coordinator.lastSelection = wanted
            let end = (view.string as NSString).length
            guard NSMaxRange(wanted.range) <= end else { return }
            context.coordinator.programmaticSelection = true
            view.setSelectedRange(wanted.range)
            context.coordinator.programmaticSelection = false
            guard view.window == nil else {
                Self.reveal(wanted.range, in: view)
                return
            }
            // A fresh editor (entering split view) has no window or size yet,
            // so there is nothing to scroll until it is laid out.
            DispatchQueue.main.async { [weak view] in
                guard let view, NSMaxRange(wanted.range) <= (view.string as NSString).length else { return }
                Self.reveal(wanted.range, in: view)
            }
        }
    }

    private static func reveal(_ range: NSRange, in view: NSTextView) {
        view.scrollRangeToVisible(range)
        view.showFindIndicator(for: range)
    }

    /// Assign only what actually changed. Every one of these setters marks the
    /// text view for redisplay, and `updateNSView` runs on each invalidation of
    /// the pane that owns the editor — which in split view is every scroll tick.
    /// The font and the text colour are compared with what the highlighter was
    /// given, never read back from the view: the view answers with the first
    /// character's attributes, which a heading on line 1 makes bold and coloured.
    private func apply(to view: NSTextView, scroll: NSScrollView, highlighter: MarkdownSourceHighlighter) {
        let look = MarkdownSourceHighlighter.Look(font: font, textColor: textColor, theme: resolvedTheme)
        if highlighter.look != look {
            // A plain text view sets these on every character; they seed what is typed into an empty editor, and
            // the highlighter then colours every line again.
            view.font = font
            view.textColor = textColor
            highlighter.setLook(look)
        }
        if view.insertionPointColor != textColor { view.insertionPointColor = textColor }
        if view.backgroundColor != background { view.backgroundColor = background }
        if scroll.backgroundColor != background { scroll.backgroundColor = background }
    }

    /// `theme`, else the palette whose page `background` is, else Genesis on a dark background and Light on a light one.
    private var resolvedTheme: MarkdownTheme {
        if let theme { return theme }
        if let palette = MarkdownTheme.palette(forPage: background) { return MarkdownTheme(palette: palette) }
        let brightness = background.usingColorSpace(.sRGB)?.brightnessComponent ?? 0
        return brightness > 0.5 ? .light : .genesis
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: MarkdownSourceEditor
        weak var view: NSTextView?
        /// Colours the markdown; the text storage's delegate, which holds it weakly.
        let highlighter = MarkdownSourceHighlighter()
        /// Our own stack, so undo does not depend on the window's manager.
        let undo = UndoManager()
        var lastSelection: MarkdownSourceSelection?
        /// True while the editor itself moves the selection (a find match, a
        /// text change from outside), so the report says it was not the reader.
        var programmaticSelection = false
        init(_ parent: MarkdownSourceEditor) {
            self.parent = parent
            super.init()
            // An undo or redo changes the storage without a textDidChange.
            for name in [NSNotification.Name.NSUndoManagerDidUndoChange, .NSUndoManagerDidRedoChange] {
                NotificationCenter.default.addObserver(self, selector: #selector(sync), name: name, object: undo)
            }
        }

        func undoManager(for view: NSTextView) -> UndoManager? { undo }

        /// The scroll view posts bounds changes only when asked to.
        func watchScroll(_ scroll: NSScrollView) {
            scroll.contentView.postsBoundsChangedNotifications = true
            NotificationCenter.default.addObserver(
                self, selector: #selector(scrolled),
                name: NSView.boundsDidChangeNotification, object: scroll.contentView
            )
        }

        @objc private func scrolled() {
            guard parent.onTopLine != nil || parent.onScroll != nil,
                  let view, let layout = view.layoutManager,
                  let container = view.textContainer, let scroll = view.enclosingScrollView else { return }
            // The character drawn at the top of the visible rect, then the
            // line it belongs to.
            var rect = scroll.contentView.bounds
            rect.origin.y = max(0, rect.origin.y - view.textContainerInset.height)
            rect.size.height = 1
            let glyphs = layout.glyphRange(forBoundingRect: rect, in: container)
            let offset = layout.characterIndexForGlyph(at: glyphs.location)
            parent.onScroll?(Double(scroll.contentView.bounds.origin.y))
            let line = SourceEditing.line(at: offset, starts: starts)
            guard line != lastReportedLine else { return }
            lastReportedLine = line
            parent.onTopLine?(line)
        }

        private var lastReportedLine = -1
        private var cachedStarts: [Int]?
        /// `view.string` bridges the whole NSTextStorage into a fresh Swift
        /// String, so the old "compare the cached text" check paid O(document)
        /// on EVERY scroll notification — dozens per gesture, on files of tens
        /// of KB. The cache is dropped when the text changes instead.
        /// How many times the line index was actually built. The scroll path
        /// reads `starts` on every bounds change, so this must stay at one per
        /// edit, not one per tick.
        private(set) var lineStartComputations = 0
        var starts: [Int] {
            if let cachedStarts { return cachedStarts }
            lineStartComputations += 1
            let computed = SourceEditing.lineStarts(view?.string ?? "")
            cachedStarts = computed
            return computed
        }

        func invalidateLineStarts() { cachedStarts = nil }

        func textViewDidChangeSelection(_ notification: Notification) {
            guard let view, let report = parent.onSelectionChange else { return }
            report(view.selectedRange(), !programmaticSelection)
        }

        func textDidChange(_ notification: Notification) {
            invalidateLineStarts()
            sync()
            offerCompletion()
        }

        /// `[[` or `#` opens the list without a keystroke of its own. AppKit
        /// re-enters this while it inserts the chosen value, hence the guard.
        private var completing = false
        private func offerCompletion() {
            guard !completing, parent.completions != nil,
                  let view = view as? SourceTextView,
                  view.completionRequest != nil else { return }
            completing = true
            DispatchQueue.main.async { [weak self] in
                view.complete(nil)
                self?.completing = false
            }
        }

        func textView(
            _ textView: NSTextView,
            completions words: [String],
            forPartialWordRange charRange: NSRange,
            indexOfSelectedItem index: UnsafeMutablePointer<Int>?
        ) -> [String] {
            guard let source = parent.completions,
                  let request = (textView as? SourceTextView)?.completionRequest else { return [] }
            index?.pointee = 0
            return source(request)
        }

        /// Inferred once per document, so a fresh note does not flip from a
        /// tab to spaces after the first pasted line.
        private var unitFor: (text: String, unit: String)?
        private var unit: String {
            let text = view?.string ?? ""
            if let u = unitFor, u.text == text { return u.unit }
            let u = SourceEditing.indentUnit(for: text)
            unitFor = (text, u)
            return u
        }

        @objc private func sync() {
            // Also the undo/redo path, which changes the storage without a
            // `textDidChange`, so the line starts have to go here too.
            invalidateLineStarts()
            guard let view, parent.text != view.string else { return }
            parent.text = view.string
        }

        /// Bold, italic, link and task (`MarkdownKeymap`, scope `markdown.source`; ⌘B, ⌘I, ⌘K, ⇧⌘X by default). None of
        /// these are AppKit commands in a plain text view, so they arrive as key equivalents rather than through
        /// `doCommandBy`.
        func handle(_ event: NSEvent) -> Bool {
            // Key equivalents arrive on the main thread.
            guard let view, let command = MainActor.assumeIsolated({ MarkdownKeymap.sourceCommand(for: event) })
            else { return false }
            let text = view.string
            let sel = view.selectedRange()
            let edit: SourceEditing.Edit
            switch command {
            case "markdown.edit.bold": edit = SourceEditing.wrap(text, selection: sel, marks: "**")
            case "markdown.edit.italic": edit = SourceEditing.wrap(text, selection: sel, marks: "*")
            case "markdown.edit.link": edit = SourceEditing.link(text, selection: sel)
            case "markdown.edit.task": edit = SourceEditing.toggleTask(text, selection: sel)
            default: return false
            }
            Self.apply(edit, to: view)
            return true
        }

        /// A URL pasted over a selection becomes a link around it, the way
        /// Obsidian and every chat app do it.
        func textView(_ textView: NSTextView, shouldChangeTextIn range: NSRange, replacementString: String?) -> Bool {
            guard pasting, range.length > 0, let dropped = replacementString, SourceEditing.isURL(dropped) else {
                return true
            }
            let edit = SourceEditing.link(textView.string, selection: range, url: dropped)
            Self.apply(edit, to: textView)
            return false
        }

        /// True only while AppKit is delivering a paste, so ordinary typing of
        /// a URL is left alone.
        var pasting = false

        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            let text = textView.string
            let sel = textView.selectedRange()
            let edit: SourceEditing.Edit?
            switch selector {
            case #selector(NSResponder.insertTab(_:)): edit = SourceEditing.indent(text, selection: sel, unit: unit)
            case #selector(NSResponder.insertBacktab(_:)): edit = SourceEditing.outdent(text, selection: sel, unit: unit)
            case #selector(NSResponder.insertNewline(_:)): edit = SourceEditing.newline(text, selection: sel)
            default: return false
            }
            guard let edit else { return false }
            Self.apply(edit, to: textView)
            return true
        }

        /// One undoable replacement, then the selection the edit asks for.
        static func apply(_ edit: SourceEditing.Edit, to textView: NSTextView) {
            guard textView.shouldChangeText(in: edit.range, replacementString: edit.replacement) else { return }
            textView.textStorage?.replaceCharacters(in: edit.range, with: edit.replacement)
            textView.didChangeText()
            textView.setSelectedRange(edit.selection)
        }
    }
}
