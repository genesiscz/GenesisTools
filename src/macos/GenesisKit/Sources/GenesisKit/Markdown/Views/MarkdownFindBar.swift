//
//  MarkdownFindBar.swift
//  GenesisKit
//
//  ⌘F in the standalone markdown window: a compact panel that floats at the
//  top right of the document, over the text, the way Cursor's find widget sits
//  over the editor. It used to be a full-width strip that pushed the document
//  down. Every occurrence is marked (in the rendered page) or walked (in the
//  source); Enter / Shift+Enter, ⌘G / ⇧⌘G or the arrows move between them.
//  The toggles in the field (Aa, whole word, regex) and find in selection
//  beside it apply to both engines, and the stack button lists every open tab
//  with a match. ⌥⌘F adds the replace row in source view. The page marks live
//  in the web renderer's DOM, so the panel says so when a native engine shows.
//

import AppKit
import SwiftUI

/// Places the find panel over the document area: top right, clear of the
/// scroller and the page's match ticks, and over the editor in split view,
/// since the editor is what it searches there.
struct MarkdownFindOverlay: View {
    @ObservedObject var model: MarkdownDocumentsModel
    @GenReduceMotion private var reduceMotion

    /// Room left of the window edge: the vertical scroller and the tick lane.
    static let edgeInset: CGFloat = 20

    var body: some View {
        ZStack {
            if model.findOpen {
                GeometryReader { geo in
                    MarkdownFindBar(model: model)
                        .padding(.top, 8)
                        .padding(.leading, 12)
                        .padding(.trailing, Self.trailingInset(total: geo.size.width, mode: model.mode, ratio: model.splitRatio))
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                }
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: -6)))
            }
        }
        .animation(reduceMotion ? nil : GenAnimation.quick, value: model.findOpen)
    }

    /// In split view the preview is on the right, so the panel moves left by
    /// its width and the divider's.
    static func trailingInset(total: CGFloat, mode: MarkdownViewMode, ratio: Double) -> CGFloat {
        guard mode == .split else { return edgeInset }
        return CGFloat(MarkdownSplit.previewWidth(total: Double(total), ratio: ratio) + MarkdownSplit.dividerWidth) + edgeInset
    }
}

struct MarkdownFindBar: View {
    @ObservedObject var model: MarkdownDocumentsModel
    /// Observed so a key changed in Keyboard Shortcuts redraws these tooltips.
    @ObservedObject var keymap = MarkdownKeymap.shared
    @FocusState private var focused: Bool
    @State private var allTabsOpen = false
    /// The counter is spoken once it settles, not at every keystroke.
    @State private var counterAnnounce: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            findRow
            if model.replaceOpen, model.findsInSource {
                replaceRow
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 5)
        .background(
            RoundedRectangle(cornerRadius: 9, style: .continuous).fill(model.theme.chrome)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(model.theme.border, lineWidth: 1)
        )
        .shadow(color: .black.opacity(model.theme.isDark ? 0.35 : 0.12), radius: 12, x: 0, y: 4)
        .onAppear { focusField() }
        .onChange(of: model.findFocusToken) { _, _ in focusField() }
        .onChange(of: focused) { _, now in model.findFieldFocused = now }
        .onExitCommand { model.closeFind() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Find")
        .accessibilityIdentifier("markdown-find-panel")
    }

    private var findRow: some View {
        HStack(spacing: 3) {
            if model.findsInSource {
                // The chevron opens the replace row, the way an editor does it.
                Button {
                    model.replaceOpen.toggle()
                } label: {
                    Image(systemName: model.replaceOpen ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(model.theme.textMuted)
                        .frame(width: 22, height: 22)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.genHoverPlain())
                .hoverHighlight(color: model.theme.accent, cornerRadius: 5, fillOpacity: 0.12)
                .instantTooltip(keymap.hint("Replace", "markdown.find.replace"))
                .accessibilityLabel(model.replaceOpen ? "Hide replace" : "Show replace")
                .keymapAction("markdown.find.replace", in: MarkdownKeymap.shared) { model.replaceOpen.toggle() }
                .accessibilityIdentifier("markdown-replace-toggle")
            }

            findField

            if model.supportsFind {
                Text(counter)
                    .font(GenTypography.mono(11))
                    .monospacedDigit()
                    .foregroundColor(counterIsWarning ? model.theme.accent : model.theme.textMuted)
                    .lineLimit(1)
                    .fixedSize()
                    .frame(minWidth: 46, alignment: .center)
                    .accessibilityIdentifier("markdown-find-counter")
                    .onChange(of: counter) { _, now in announceCounter(now) }

                stepButton("chevron.up", tooltip: stepTooltip("Previous match", "⇧↩", "markdown.find.previous"),
                           id: "markdown-find-prev") {
                    model.stepFind(-1)
                }
                .keymapAction("markdown.find.previous", in: MarkdownKeymap.shared) { model.stepFind(-1) }

                stepButton("chevron.down", tooltip: stepTooltip("Next match", "↩", "markdown.find.next"),
                           id: "markdown-find-next") {
                    model.stepFind(1)
                }
                .keymapAction("markdown.find.next", in: MarkdownKeymap.shared) { model.stepFind(1) }

                iconToggle(
                    "selection.pin.in.out",
                    isOn: model.findInSelection,
                    tooltip: keymap.hint(model.findInSelection
                        ? "Finding in the selection. Click to search everything"
                        : "Find in selection: only inside the text selected now", "markdown.find.inSelection"),
                    name: "Find in selection",
                    id: "markdown-find-in-selection"
                ) {
                    model.setFindInSelection(!model.findInSelection)
                }
                .keymapAction("markdown.find.inSelection", in: MarkdownKeymap.shared) {
                    model.setFindInSelection(!model.findInSelection)
                }

                if model.docs.count > 1 {
                    allTabsButton
                }
            } else {
                // The native renderers draw no marks, so the way out is a button, not a tooltip.
                Button {
                    model.rendererRaw = MarkdownRenderer.web.rawValue
                    model.search()
                } label: {
                    Text("Use the web renderer")
                        .font(GenTypography.mono(11, weight: .medium))
                        .foregroundColor(model.theme.accent)
                        .padding(.horizontal, 6)
                        .frame(minHeight: 22)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.genHoverPlain())
                .hoverHighlight(color: model.theme.accent, cornerRadius: 5, fillOpacity: 0.12)
                .fixedSize()
                .instantTooltip("Find marks matches only in the web renderer. This switches the reading view to it")
                .accessibilityIdentifier("markdown-find-use-web")
            }

            stepButton("xmark", tooltip: "Close (Esc)", id: "markdown-find-done", enabled: true) {
                model.closeFind()
            }
        }
    }

    /// The query, with the three match options inside the field's right end,
    /// where Cursor and VS Code keep them.
    private var findField: some View {
        HStack(spacing: 1) {
            TextField("Find", text: $model.findQuery)
                .textFieldStyle(.plain)
                .font(GenTypography.mono(11))
                .foregroundColor(model.theme.text)
                .focused($focused)
                .frame(minWidth: 80, idealWidth: 180, maxWidth: 180)
                .onSubmit { model.submitFind(shift: false) }
                // Shift+Return still submits a plain field, so it is caught first.
                .onKeyPress(.return, phases: .down) { press in
                    guard press.modifiers.contains(.shift) else { return .ignored }
                    model.submitFind(shift: true)
                    return .handled
                }
                .onChange(of: model.findQuery) { _, _ in model.search() }
                .accessibilityLabel("Find")
                .accessibilityIdentifier("markdown-find-field")

            if !model.findQuery.isEmpty {
                clearButton { model.findQuery = "" }
            }

            optionToggle(
                Text("Aa"),
                isOn: model.findOptions.matchCase,
                tooltip: keymap.hint("Match case", "markdown.find.matchCase"),
                name: "Match case",
                id: "markdown-find-match-case"
            ) { model.findOptions.matchCase.toggle() }
            .keymapAction("markdown.find.matchCase", in: MarkdownKeymap.shared) { model.findOptions.matchCase.toggle() }

            optionToggle(
                Text("ab").underline(),
                isOn: model.findOptions.wholeWord,
                tooltip: keymap.hint("Whole word", "markdown.find.wholeWord"),
                name: "Whole word",
                id: "markdown-find-whole-word"
            ) { model.findOptions.wholeWord.toggle() }
            .keymapAction("markdown.find.wholeWord", in: MarkdownKeymap.shared) { model.findOptions.wholeWord.toggle() }

            optionToggle(
                Text(".*"),
                isOn: model.findOptions.regex,
                tooltip: keymap.hint("Regular expression", "markdown.find.regex"),
                name: "Regular expression",
                id: "markdown-find-regex"
            ) { model.findOptions.regex.toggle() }
            .keymapAction("markdown.find.regex", in: MarkdownKeymap.shared) { model.findOptions.regex.toggle() }
        }
        .padding(.leading, 7)
        .padding(.trailing, 2)
        .frame(height: 24)
        .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(model.theme.page))
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .strokeBorder(focused ? model.theme.accent.opacity(0.65) : model.theme.border, lineWidth: 1)
        )
    }

    /// Replace works on the source, which is the text the file actually holds.
    private var replaceRow: some View {
        HStack(spacing: 3) {
            Spacer().frame(width: 22)
            TextField(model.findOptions.regex ? "Replace ($1 = group 1)" : "Replace", text: $model.replaceText)
                .textFieldStyle(.plain)
                .font(GenTypography.mono(11))
                .foregroundColor(model.theme.text)
                // As wide as the find field with its three toggles, so the two rows line up.
                .frame(minWidth: 80, idealWidth: 238, maxWidth: 238)
                .onSubmit { model.replaceCurrent() }
                .accessibilityLabel("Replace with")
                .accessibilityIdentifier("markdown-replace-field")
                .padding(.horizontal, 7)
                .frame(height: 24)
                .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(model.theme.page))
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(model.theme.border, lineWidth: 1)
                )

            textButton("Replace", tooltip: "Replace the current match (Enter in this field)", id: "markdown-replace-one") {
                model.replaceCurrent()
            }
            textButton(
                "Replace all",
                tooltip: model.activeSourceScope == nil ? "Replace every match" : "Replace every match in the selection",
                id: "markdown-replace-all"
            ) {
                model.replaceAll()
            }
        }
    }

    /// "Find in all open tabs": a popover with each tab that has a match.
    private var allTabsButton: some View {
        Button {
            allTabsOpen.toggle()
        } label: {
            Image(systemName: "rectangle.stack")
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundColor(allTabsOpen ? model.theme.accent : model.theme.textSecondary)
                .frame(width: 22, height: 22)
                .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .hoverHighlight(color: model.theme.accent, cornerRadius: 5, fillOpacity: 0.12)
        .instantTooltip(keymap.hint("Find in all open tabs", "markdown.find.allTabs"))
        .keymapAction("markdown.find.allTabs", in: MarkdownKeymap.shared) { allTabsOpen.toggle() }
        .accessibilityLabel("Find in all open tabs")
        .accessibilityIdentifier("markdown-find-all-tabs")
        .popover(isPresented: $allTabsOpen, arrowEdge: .bottom) {
            MarkdownFindAllTabs(model: model) { allTabsOpen = false }
        }
    }

    /// Focus the field, then select its whole text, so typing replaces the old
    /// query instead of appending to it (⌘F on an open panel used to leave the
    /// caret at the end). The field is not in the responder chain yet during
    /// `onAppear`, and the button that ran ⌘F still holds focus, so each step
    /// waits one runloop.
    private func focusField() {
        DispatchQueue.main.async {
            focused = true
            DispatchQueue.main.async { selectQuery() }
        }
    }

    /// Only this panel's field: the field editor must be showing the query.
    private func selectQuery() {
        guard let window = NSApp.keyWindow,
              let editor = window.firstResponder as? NSTextView, editor.isFieldEditor,
              editor.string == model.findQuery else { return }
        editor.selectAll(nil)
    }

    private var counterIsWarning: Bool {
        !model.findQuery.isEmpty && (model.findPatternError != nil || model.findCount == 0)
    }

    /// "Next match (↩ or ⌘G)": the field's key, then the command's key in force.
    func stepTooltip(_ title: String, _ fieldKey: String, _ id: String) -> String {
        let label = keymap.label(for: id) ?? ""
        return label.isEmpty ? "\(title) (\(fieldKey))" : "\(title) (\(fieldKey) or \(label))"
    }

    private var counter: String {
        if model.findQuery.isEmpty { return "" }
        if let error = model.findPatternError { return error }
        if model.findCount == 0 { return "no match" }
        return "\(model.findIndex)/\(model.findCount)"
    }

    /// One of the three match options: a small lettered switch in the field,
    /// filled with the accent while it is on.
    private func optionToggle(
        _ label: Text,
        isOn: Bool,
        tooltip: String,
        name: String,
        id: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            label
                .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                .foregroundColor(isOn ? model.theme.accent : model.theme.textMuted)
                .frame(width: 22, height: 22)
                .background(RoundedRectangle(cornerRadius: 4).fill(isOn ? model.theme.accent.opacity(0.16) : Color.clear))
                .overlay(
                    RoundedRectangle(cornerRadius: 4)
                        .strokeBorder(isOn ? model.theme.accent.opacity(0.55) : Color.clear, lineWidth: 1)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip(tooltip)
        .accessibilityLabel(name)
        .accessibilityValue(isOn ? "on" : "off")
        .accessibilityAddTraits(isOn ? .isSelected : [])
        .accessibilityIdentifier(id)
    }

    private func iconToggle(
        _ symbol: String,
        isOn: Bool,
        tooltip: String,
        name: String,
        id: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundColor(isOn ? model.theme.accent : model.theme.textSecondary)
                .frame(width: 22, height: 22)
                .background(RoundedRectangle(cornerRadius: 5).fill(isOn ? model.theme.accent.opacity(0.16) : Color.clear))
                .overlay(
                    RoundedRectangle(cornerRadius: 5)
                        .strokeBorder(isOn ? model.theme.accent.opacity(0.55) : Color.clear, lineWidth: 1)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .hoverHighlight(color: model.theme.accent, cornerRadius: 5, fillOpacity: 0.12)
        .instantTooltip(tooltip)
        .accessibilityLabel(name)
        .accessibilityValue(isOn ? "on" : "off")
        .accessibilityAddTraits(isOn ? .isSelected : [])
        .accessibilityIdentifier(id)
    }

    private func stepButton(
        _ symbol: String,
        tooltip: String,
        id: String,
        enabled: Bool? = nil,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(model.theme.textSecondary)
                .frame(width: 22, height: 22)
                .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .disabled(!(enabled ?? (model.findCount > 0)))
        .instantTooltip(tooltip)
        .hoverHighlight(color: model.theme.accent, cornerRadius: 5, fillOpacity: 0.12)
        .accessibilityLabel(MarkdownDocumentActions.spokenLabel(tooltip))
        .accessibilityIdentifier(id)
    }

    /// Empties the find field; shown only while it holds text.
    private func clearButton(_ clear: @escaping () -> Void) -> some View {
        Button(action: clear) {
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 10.5))
                .foregroundColor(model.theme.textMuted)
                .frame(width: 22, height: 22)
                .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip("Clear")
        .accessibilityLabel("Clear the search")
        .accessibilityIdentifier("markdown-find-clear")
    }

    /// "3 of 12", "No match" or the pattern error, spoken 0.6 s after the last change of the counter.
    private func announceCounter(_ text: String) {
        counterAnnounce?.cancel()
        guard !text.isEmpty else { return }
        counterAnnounce = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled else { return }
            GenAnnounce.post(Self.spokenCounter(text), priority: .low)
        }
    }

    /// The counter in words: "3/12" reads as "Match 3 of 12".
    static func spokenCounter(_ text: String) -> String {
        let parts = text.split(separator: "/")
        if parts.count == 2, let index = Int(parts[0]), let count = Int(parts[1]) {
            return "Match \(index) of \(count)"
        }
        return text.prefix(1).uppercased() + text.dropFirst()
    }

    private func textButton(_ title: String, tooltip: String, id: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .buttonStyle(.genHoverPlain())
            .font(GenTypography.mono(11))
            .foregroundColor(model.findCount > 0 ? model.theme.accent : model.theme.textMuted)
            .padding(.horizontal, 5)
            .frame(height: 22)
            .disabled(model.findCount == 0)
            .instantTooltip(tooltip)
            .accessibilityLabel(MarkdownDocumentActions.spokenLabel(tooltip))
            .accessibilityIdentifier(id)
    }
}
