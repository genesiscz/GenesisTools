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
    /// Bold, italic, link and task, run by the dispatcher while this view is first responder.
    var onSourceCommand: ((String) -> Void)?
    private var sourceKeys: [KeymapRegistration] = []
    /// The lines that differ from HEAD, drawn as bars in the left inset (green added, blue changed, a red mark where
    /// lines were removed). A click on a bar calls `onHunk` with the bar's rect.
    var gitHunks: [GitHunk] = [] {
        didSet {
            guard gitHunks != oldValue else { return }
            needsDisplay = true
            window?.invalidateCursorRects(for: self)
            setAccessibilityCustomActions(gitHunks.isEmpty ? nil : hunkActions())
        }
    }
    var onHunk: ((GitHunk, NSRect) -> Void)?
    /// The tooltips of the bars on screen, removed before the next set is added.
    private var hunkTips: [NSView.ToolTipTag] = []
    /// AppKit keeps only a weak reference to a tooltip's owner, so the strings live here as long as their tooltips.
    private var hunkTipOwners: [NSString] = []

    override func drawBackground(in rect: NSRect) {
        super.drawBackground(in: rect)
        // Colour is not the only signal when the reader asks for that: changed lines draw as a dashed bar.
        let dashed = NSWorkspace.shared.accessibilityDisplayShouldDifferentiateWithoutColor
        for (hunk, bar) in hunkBars() where bar.intersects(rect) {
            Self.color(hunk.kind).setFill()
            if hunk.kind == .modified, dashed {
                var y = bar.minY
                while y < bar.maxY {
                    NSBezierPath(rect: NSRect(x: bar.minX, y: y, width: bar.width, height: min(3, bar.maxY - y))).fill()
                    y += 5
                }
            } else if hunk.kind == .deleted {
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


    /// The pointing hand and a tooltip over each bar on screen: the bars open the change, so they look clickable.
    override func resetCursorRects() {
        super.resetCursorRects()
        hunkTips.forEach { removeToolTip($0) }
        hunkTips = []
        hunkTipOwners = []
        guard onHunk != nil else { return }
        let visible = visibleRect
        for (hunk, bar) in hunkBars() {
            let target = bar.insetBy(dx: -4, dy: -2)
            guard target.intersects(visible) else { continue }
            addCursorRect(target, cursor: .pointingHand)
            let tip = Self.hunkTip(hunk.kind) as NSString
            hunkTipOwners.append(tip)
            hunkTips.append(addToolTip(target, owner: tip, userData: nil))
        }
    }

    /// What a bar is, in words: the tooltip and the spoken name of the change.
    static func hunkTip(_ kind: GitHunk.Kind) -> String {
        switch kind {
        case .added: return "Added lines. Click to see the change"
        case .modified: return "Changed lines. Click to see the change"
        case .deleted: return "Removed lines. Click to see what was removed"
        }
    }

    /// The bars from the keyboard and VoiceOver: Next change and Previous change move the caret to a hunk and open it,
    /// as a click on its bar does.
    private func hunkActions() -> [NSAccessibilityCustomAction] {
        [
            NSAccessibilityCustomAction(name: "Next change") { [weak self] in self?.openHunk(step: 1) ?? false },
            NSAccessibilityCustomAction(name: "Previous change") { [weak self] in self?.openHunk(step: -1) ?? false },
        ]
    }

    /// The hunk after (or before) the caret's line, wrapping at the ends; false when there is none.
    @discardableResult
    func openHunk(step: Int) -> Bool {
        let bars = hunkBars()
        let caretLine = SourceEditing.line(at: selectedRange().location, starts: SourceEditing.lineStarts(string))
        guard let index = Self.hunkIndex(bars.map(\.0), from: caretLine, step: step) else { return false }
        let (hunk, bar) = bars[index]
        let starts = SourceEditing.lineStarts(string)
        if hunk.newStart < starts.count {
            setSelectedRange(NSRange(location: starts[hunk.newStart], length: 0))
            scrollRangeToVisible(selectedRange())
        }
        GenAnnounce.post(Self.hunkTip(hunk.kind).components(separatedBy: ".").first ?? "")
        onHunk?(hunk, bar)
        return true
    }

    /// The next hunk that starts after `line` (step 1) or the last one that starts before it (step -1), wrapping.
    static func hunkIndex(_ hunks: [GitHunk], from line: Int, step: Int) -> Int? {
        guard !hunks.isEmpty else { return nil }
        if step >= 0 {
            return hunks.firstIndex { $0.newStart > line } ?? 0
        }
        return hunks.lastIndex { $0.newStart < line } ?? hunks.count - 1
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

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        sourceKeys.forEach { $0.cancel() }
        sourceKeys = []
        guard let window else { return }
        sourceKeys = MarkdownKeymap.registerSourceCommands(textView: self, window: window) { [weak self] id in
            self?.onSourceCommand?(id)
        }
    }

    deinit { sourceKeys.forEach { $0.cancel() } }

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
    /// The list opens by itself after `[[` or `#word` (the setting "Suggest links and tags while typing"). Off: only
    /// Esc (AppKit's Complete) opens it.
    /// nil: follow the setting.
    var completesWhileTyping: Bool? = nil
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
        view.onSourceCommand = { [weak coordinator = context.coordinator] id in
            _ = coordinator?.applySourceCommand(id)
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
        view.setAccessibilityLabel("Markdown source")
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
            context.coordinator.replaceFromOutside(with: text, in: view)
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

    /// The smallest replacement that turns `old` into `new`: the common start and end are kept, in UTF-16 units.
    static func changedRange(old: NSString, new: NSString) -> (range: NSRange, replacement: String) {
        let oldLength = old.length
        let newLength = new.length
        var prefix = 0
        let shorter = min(oldLength, newLength)
        while prefix < shorter, old.character(at: prefix) == new.character(at: prefix) { prefix += 1 }
        var suffix = 0
        while suffix < shorter - prefix,
              old.character(at: oldLength - 1 - suffix) == new.character(at: newLength - 1 - suffix) { suffix += 1 }
        // Never split a surrogate pair: a cut that lands before a low surrogate moves back by one.
        func splitsPair(_ text: NSString, at index: Int) -> Bool {
            index > 0 && index < text.length && UTF16.isTrailSurrogate(text.character(at: index))
        }
        while prefix > 0, splitsPair(old, at: prefix) || splitsPair(new, at: prefix) { prefix -= 1 }
        while suffix > 0, splitsPair(old, at: oldLength - suffix) || splitsPair(new, at: newLength - suffix) { suffix -= 1 }
        let range = NSRange(location: prefix, length: oldLength - prefix - suffix)
        let replacement = new.substring(with: NSRange(location: prefix, length: newLength - prefix - suffix))
        return (range, replacement)
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

        /// True while a change from outside lands, so it opens no completion list.
        private var replacingFromOutside = false

        /// Text changed from outside the editor (Replace All, Restore, Merge, Discard edits and reload): only the part
        /// that differs is replaced, through the text view, so it is one step on the editor's undo stack and ⌘Z takes
        /// it back. Assigning `string` registered nothing, so ⌘Z after Replace All undid the typing before it.
        func replaceFromOutside(with text: String, in view: NSTextView) {
            invalidateLineStarts()
            let sel = view.selectedRange()
            programmaticSelection = true
            replacingFromOutside = true
            defer {
                replacingFromOutside = false
                programmaticSelection = false
            }
            let change = MarkdownSourceEditor.changedRange(old: view.string as NSString, new: text as NSString)
            view.breakUndoCoalescing()
            if view.shouldChangeText(in: change.range, replacementString: change.replacement) {
                view.textStorage?.replaceCharacters(in: change.range, with: change.replacement)
                view.didChangeText()
            } else {
                view.string = text
            }
            view.breakUndoCoalescing()
            let end = (text as NSString).length
            view.setSelectedRange(NSRange(location: min(sel.location, end), length: 0))
        }

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
            let automatic = parent.completesWhileTyping
                ?? MainActor.assumeIsolated { GenesisKitMarkdownConfiguration.shared.completeWhileTyping }
            guard automatic, !completing, !replacingFromOutside, parent.completions != nil,
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
            // Key equivalents arrive on the main thread. The dispatcher takes the same keys first while this
            // view is first responder; this path remains for a press the dispatcher did not take.
            guard let command = MainActor.assumeIsolated({ MarkdownKeymap.sourceCommand(for: event) }) else { return false }
            return applySourceCommand(command)
        }

        func applySourceCommand(_ command: String) -> Bool {
            guard let view else { return false }
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
