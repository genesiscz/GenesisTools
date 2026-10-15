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
    @FocusState private var focused: Bool
    @State private var allTabsOpen = false

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
                        .frame(width: 16, height: 22)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip("Replace (⌥⌘F)")
                .accessibilityLabel(model.replaceOpen ? "Hide replace" : "Show replace")
                .keyboardShortcut("f", modifiers: [.command, .option])
                .accessibilityIdentifier("markdown-replace-toggle")
            }

            findField

            if model.supportsFind {
                Text(counter)
                    .font(GenTypography.mono(9.5))
                    .foregroundColor(counterIsWarning ? model.theme.accent : model.theme.textMuted)
                    .lineLimit(1)
                    .fixedSize()
                    .frame(minWidth: 46, alignment: .center)
                    .accessibilityIdentifier("markdown-find-counter")

                stepButton("chevron.up", tooltip: "Previous match (⇧Enter or ⇧⌘G)", id: "markdown-find-prev") {
                    model.stepFind(-1)
                }
                .keyboardShortcut("g", modifiers: [.command, .shift])

                stepButton("chevron.down", tooltip: "Next match (Enter or ⌘G)", id: "markdown-find-next") {
                    model.stepFind(1)
                }
                .keyboardShortcut("g", modifiers: .command)

                iconToggle(
                    "selection.pin.in.out",
                    isOn: model.findInSelection,
                    tooltip: model.findInSelection
                        ? "Finding in the selection. Click to search everything (⌥⌘L)"
                        : "Find in selection: only inside the text selected now (⌥⌘L)",
                    name: "Find in selection",
                    id: "markdown-find-in-selection"
                ) {
                    model.setFindInSelection(!model.findInSelection)
                }
                .keyboardShortcut("l", modifiers: [.command, .option])

                if model.docs.count > 1 {
                    allTabsButton
                }
            } else {
                Text("Web renderer only")
                    .font(GenTypography.mono(9.5))
                    .foregroundColor(model.theme.accent)
                    .fixedSize()
                    .instantTooltip("The native renderers draw no marks. Switch to the Web renderer to search the page")
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

            optionToggle(
                Text("Aa"),
                isOn: model.findOptions.matchCase,
                tooltip: "Match case (⌥⌘C)",
                name: "Match case",
                id: "markdown-find-match-case"
            ) { model.findOptions.matchCase.toggle() }
            .keyboardShortcut("c", modifiers: [.command, .option])

            optionToggle(
                Text("ab").underline(),
                isOn: model.findOptions.wholeWord,
                tooltip: "Whole word (⌥⌘W)",
                name: "Whole word",
                id: "markdown-find-whole-word"
            ) { model.findOptions.wholeWord.toggle() }
            .keyboardShortcut("w", modifiers: [.command, .option])

            optionToggle(
                Text(".*"),
                isOn: model.findOptions.regex,
                tooltip: "Regular expression (⌥⌘R)",
                name: "Regular expression",
                id: "markdown-find-regex"
            ) { model.findOptions.regex.toggle() }
            .keyboardShortcut("r", modifiers: [.command, .option])
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
            Spacer().frame(width: 16)
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
                "All",
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
                .frame(width: 22, height: 20)
                .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .hoverHighlight(color: model.theme.accent, cornerRadius: 5, fillOpacity: 0.12)
        .instantTooltip("Find in all open tabs (⌥⌘A)")
        .keyboardShortcut("a", modifiers: [.command, .option])
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
                .frame(width: 20, height: 18)
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
                .frame(width: 22, height: 20)
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
                .frame(width: 22, height: 20)
                .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .disabled(!(enabled ?? (model.findCount > 0)))
        .instantTooltip(tooltip)
        .hoverHighlight(color: model.theme.accent, cornerRadius: 5, fillOpacity: 0.12)
        .accessibilityLabel(MarkdownDocumentActions.spokenLabel(tooltip))
        .accessibilityIdentifier(id)
    }

    private func textButton(_ title: String, tooltip: String, id: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .buttonStyle(.genHoverPlain())
            .font(GenTypography.mono(10))
            .foregroundColor(model.findCount > 0 ? model.theme.accent : model.theme.textMuted)
            .padding(.horizontal, 5)
            .frame(height: 22)
            .disabled(model.findCount == 0)
            .instantTooltip(tooltip)
            .accessibilityIdentifier(id)
    }
}
