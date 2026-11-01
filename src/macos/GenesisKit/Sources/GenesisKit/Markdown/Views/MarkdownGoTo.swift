//
//  MarkdownGoTo.swift
//  GenesisKit
//
//  "Go to Location…" (⇧⌘G) in the markdown window, as in Finder: a typed or pasted path, with the folders and notes
//  that match it listed under the field (MarkdownPathCompletion.swift). Up and Down choose, Tab completes, Return
//  opens a file or goes into a folder, ⌘Return shows the pick in the file sidebar, Esc closes. A folder the field
//  names shows in the file sidebar on Return; a file opens as a tab and the tree stays where it is.
//

import AppKit

import SwiftUI

enum MarkdownGoTo {
    /// The path a typed or pasted text names: quotes and a trailing newline dropped, `~` expanded,
    /// a `file://` URL read as its path, a relative path taken from `base`. Nil for blank text.
    static func url(from raw: String, base: URL) -> URL? {
        let text = MarkdownPathCompletion.cleaned(raw)
        guard !text.isEmpty else { return nil }
        let expanded = (text as NSString).expandingTildeInPath
        let url = expanded.hasPrefix("/") ? URL(fileURLWithPath: expanded) : base.appendingPathComponent(expanded)
        return url.standardizedFileURL
    }
}

/// Builds the list off the main thread, one request at a time: a new text cancels the request before it, and a
/// result that arrives for an older text is dropped. Each sheet has its own, so the folders it read are read again
/// the next time it opens.
@MainActor
final class MarkdownGoToLoader: ObservableObject {
    @Published private(set) var suggestions: MarkdownPathSuggestions?
    private var task: Task<Void, Never>?
    private var generation = 0
    private let cache = MarkdownPathCache()

    func load(_ text: String, base: URL, recents: [String], options: MarkdownPathOptions) {
        task?.cancel()
        generation += 1
        let generation = generation
        let cache = cache
        task = Task.detached(priority: .userInitiated) { [weak self] in
            let result = PerfLog.span("markdown.goto.list", over: 30) {
                MarkdownPathCompletion.suggest(text, base: base, recents: recents, options: options,
                                               isCancelled: { Task.isCancelled }, read: cache.read)
            }
            guard !Task.isCancelled else { return }
            await self?.deliver(result, generation: generation)
        }
    }

    func cancel() {
        task?.cancel()
    }

    private func deliver(_ result: MarkdownPathSuggestions, generation: Int) {
        guard generation == self.generation else { return }
        suggestions = result
    }
}

/// The ⇧⌘G sheet: the path field, the list under it, and the keys that drive it.
struct MarkdownGoToSheet: View {
    @ObservedObject var model: MarkdownDocumentsModel
    @StateObject private var loader = MarkdownGoToLoader()
    @State private var text = ""
    /// What the field held when the sheet opened: while it still does, the recent files lead the list.
    @State private var prefill = ""
    /// The folder a relative path starts from: the one the field opened with.
    @State private var base = FileManager.default.homeDirectoryForCurrentUser
    /// The row the keyboard is on; nil is the field itself, above the first row.
    @State private var selection: Int?
    /// The reader moved the selection (a key or a click) since the text last changed.
    @State private var moved = false
    @State private var problem: String?
    /// A key that came while the list for the text was still being built: done once it arrives.
    @State private var pending: PendingKey?
    /// Return reaches both the field and the default button: the first one that acts in a turn of the run loop wins.
    @State private var acting = false
    @FocusState private var focused: Bool

    private enum PendingKey: Equatable {
        case tab
        case go(reveal: Bool)
    }

    private static let hints = "↑↓ choose    ⇥ complete    ↩ open    ⌘↩ show in sidebar"

    private var theme: MarkdownTheme { model.theme }

    private var options: MarkdownPathOptions {
        MarkdownPathOptions(files: model.configuration.goToFiles, showsHidden: model.configuration.goToShowsHidden)
    }

    /// The list for the text in the field, once it is built. The list on screen (`loader.suggestions`) stays the last
    /// one built until then, so it never blanks between two keystrokes, but only this one acts.
    private var current: MarkdownPathSuggestions? {
        guard let suggestions = loader.suggestions, suggestions.text == text else { return nil }
        return suggestions
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            field
                .padding(.horizontal, 16)
            if let problem {
                problemLine(problem)
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
            }
            Divider()
                .padding(.top, 12)
            list
            Divider()
            footer
        }
        .frame(width: 560)
        .background(theme.chrome)
        // The field and the buttons in the theme's light or dark look, whatever window hosts the sheet.
        .environment(\.colorScheme, theme.isDark ? .dark : .light)
        .onAppear(perform: start)
        .onDisappear { loader.cancel() }
        .onChange(of: text) { _, _ in textChanged() }
        .onChange(of: options) { _, _ in load() }
        .onChange(of: loader.suggestions) { _, now in arrived(now) }
        .onChange(of: problem) { _, now in if let now { GenAnnounce.post(now) } }
    }

    // MARK: Parts

    private var header: some View {
        HStack(spacing: 8) {
            Text("Go to Location")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(theme.text)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            // The list has filters (notes only, hidden files): its settings are one click away.
            IconButton(systemName: "gearshape", tooltip: "Go to Location settings", tint: theme.textMuted) {
                MarkdownSettingsWindow.shared.show(nil)
                NativeSettingsHighlightCenter.shared.request(MarkdownSettingsView.goToAnchor)
            }
            .accessibilityIdentifier("markdown-goto-settings")
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 10)
    }

    private var field: some View {
        TextField("~/notes or /path/to/file.md", text: $text)
            .textFieldStyle(.roundedBorder)
            .font(GenTypography.mono(12))
            .focused($focused)
            .onKeyPress(.downArrow, phases: [.down, .repeat]) { _ in move(1) }
            .onKeyPress(.upArrow, phases: [.down, .repeat]) { _ in move(-1) }
            .onKeyPress(.tab) {
                complete()
                return .handled
            }
            .onKeyPress(.return, phases: .down) { press in
                go(reveal: press.modifiers.contains(.command))
                return .handled
            }
            .onExitCommand { model.goToOpen = false }
            .accessibilityLabel("Path")
            .accessibilityHint("Type or paste a path. Up and Down choose a suggestion, Tab completes it, Return opens it, Command Return shows it in the sidebar.")
            .accessibilityIdentifier("markdown-goto-field")
    }

    private func problemLine(_ text: String) -> some View {
        Label {
            Text(text).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill").accessibilityHidden(true)
        }
        .font(.system(size: 11.5))
        .foregroundStyle(Color.genError)
        .accessibilityIdentifier("markdown-goto-problem")
    }

    @ViewBuilder
    private var list: some View {
        if let shown = loader.suggestions, !shown.rows.isEmpty {
            let open = Set(model.docs.map(\.id))
            ScrollViewReader { proxy in
                FittedScroll(maxHeight: 320) {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        if !shown.recents.isEmpty {
                            sectionTitle("Recent")
                            ForEach(Array(shown.recents.enumerated()), id: \.element.id) { index, row in
                                rowView(row, index: index, in: shown, open: open)
                            }
                            if !shown.entries.isEmpty {
                                sectionTitle("In " + MarkdownPathCompletion.display(folder: URL(fileURLWithPath: shown.query.folder)))
                            }
                        }
                        ForEach(Array(shown.entries.enumerated()), id: \.element.id) { offset, row in
                            rowView(row, index: shown.recents.count + offset, in: shown, open: open)
                        }
                        if shown.truncated {
                            Text(verbatim: "Showing \(shown.entries.count) of \(shown.total). Type more of the name to narrow the list.")
                                .font(.system(size: 11))
                                .foregroundStyle(theme.textMuted)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 6)
                                .accessibilityIdentifier("markdown-goto-truncated")
                        }
                    }
                    .padding(6)
                }
                // At once, without a glide: the keyboard's row is simply there (nothing to reduce under Reduce Motion).
                .onChange(of: selection) { _, now in
                    guard let now, shown.rows.indices.contains(now) else { return }
                    proxy.scrollTo(shown.rows[now].id)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Suggestions")
        } else if let shown = loader.suggestions {
            Text(verbatim: emptyText(shown))
                .font(.system(size: 11.5))
                .foregroundStyle(theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .accessibilityIdentifier("markdown-goto-empty")
        }
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(verbatim: title)
            .font(.system(size: 10.5, weight: .semibold))
            .foregroundStyle(theme.textMuted)
            .lineLimit(1)
            .truncationMode(.head)
            .padding(.horizontal, 8)
            .padding(.top, 6)
            .padding(.bottom, 2)
            .accessibilityAddTraits(.isHeader)
    }

    private func rowView(_ row: MarkdownPathSuggestion, index: Int, in shown: MarkdownPathSuggestions,
                         open: Set<String>) -> some View {
        let isOpen = open.contains(row.path)
        let folder = ((row.path as NSString).deletingLastPathComponent as NSString).abbreviatingWithTildeInPath
        let detail: String? = row.source == .recent
            ? folder + (isOpen ? " · open" : "")
            : (isOpen ? "open" : nil)
        return MarkdownGoToRow(row: row, detail: detail, label: Self.spoken(row, folder: folder, isOpen: isOpen),
                               selected: selection == index, theme: theme) {
            selection = index
            moved = true
            go(reveal: false, clicked: (row, shown.query))
        }
        .equatable()
        .id(row.id)
    }

    static func spoken(_ row: MarkdownPathSuggestion, folder: String, isOpen: Bool) -> String {
        if row.isFolder { return "\(row.name), folder" }
        var words = row.name
        if row.source == .recent { words += ", recent, in \(folder)" }
        if isOpen { words += ", open" }
        return words
    }

    private var footer: some View {
        HStack(spacing: 12) {
            Text(verbatim: Self.hints)
                .font(.system(size: 10.5))
                .foregroundStyle(theme.textMuted)
                .lineLimit(1)
                .accessibilityHidden(true)
            Spacer(minLength: 8)
            Button("Cancel") { model.goToOpen = false }
                .keyboardShortcut(.cancelAction)
            Button("Open") { go(reveal: false) }
                .keyboardShortcut(.defaultAction)
                .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    /// Why the list is empty, and what to do about it.
    private func emptyText(_ shown: MarkdownPathSuggestions) -> String {
        let folder = MarkdownPathCompletion.display(folder: URL(fileURLWithPath: shown.query.folder))
        switch shown.problem {
        case .missing:
            return "No folder at \(folder)."
        case .notAFolder:
            return "\(String(folder.dropLast())) is a file, not a folder."
        case .unreadable:
            return "\(folder) cannot be read. The app may need access to it in System Settings › Privacy & Security › Files and Folders."
        case nil:
            break
        }

        var sentences: [String] = []
        if shown.query.segment.isEmpty {
            sentences.append(shown.filteredOut > 0 ? "\(folder) holds no folders or notes." : "\(folder) is empty.")
        } else {
            sentences.append("Nothing in \(folder) matches \u{201C}\(shown.query.segment)\u{201D}.")
        }
        if shown.filteredOut > 0 {
            let files = Plural.count(shown.filteredOut, "other file")
            sentences.append("\(files) \(shown.filteredOut == 1 ? "is" : "are") not a note; the settings can list every file.")
        }
        if shown.hiddenOut > 0, shown.query.segment.isEmpty {
            sentences.append("Type a dot to list hidden files.")
        }
        return sentences.joined(separator: " ")
    }

    // MARK: Behaviour

    private func start() {
        base = model.goToStartFolder
        prefill = MarkdownPathCompletion.display(folder: base)
        text = prefill
        load()
        focused = true
    }

    private func textChanged() {
        problem = nil
        moved = false
        pending = nil
        load()
    }

    private func load() {
        let recents = text == prefill && model.configuration.goToRecents
            ? model.recents.entries.map(\.path).filter { $0 != model.selected?.id }
            : []
        loader.load(text, base: base, recents: recents, options: options)
    }

    private func arrived(_ suggestions: MarkdownPathSuggestions?) {
        guard let suggestions, suggestions.text == text else { return }
        if !moved {
            selection = suggestions.automaticIndex
        } else if let selection, selection >= suggestions.rows.count {
            self.selection = suggestions.rows.isEmpty ? nil : suggestions.rows.count - 1
        }
        guard let key = pending else { return }
        pending = nil
        switch key {
        case .tab: complete()
        case .go(let reveal): go(reveal: reveal)
        }
    }

    private func move(_ step: Int) -> KeyPress.Result {
        guard let rows = loader.suggestions?.rows, !rows.isEmpty else { return .handled }
        let next = (selection ?? -1) + step
        selection = next < 0 ? nil : min(next, rows.count - 1)
        moved = true
        if NSWorkspace.shared.isVoiceOverEnabled {
            if let selection {
                GenAnnounce.post("\(spokenRow(rows[selection])), \(selection + 1) of \(rows.count)", priority: .low)
            } else {
                GenAnnounce.post("The typed path", priority: .low)
            }
        }
        return .handled
    }

    private func spokenRow(_ row: MarkdownPathSuggestion) -> String {
        let folder = ((row.path as NSString).deletingLastPathComponent as NSString).abbreviatingWithTildeInPath
        return Self.spoken(row, folder: folder, isOpen: model.docs.contains { $0.id == row.path })
    }

    /// Tab: the row the keyboard is on (or the first) goes into the field; a folder keeps the list open inside it.
    private func complete() {
        guard let current else {
            pending = .tab
            return
        }
        let rows = current.rows
        let index = (moved ? selection : current.automaticIndex) ?? 0
        guard rows.indices.contains(index) else { return }
        text = MarkdownPathCompletion.completion(of: rows[index], in: current.query)
    }

    private func go(reveal: Bool, clicked: (row: MarkdownPathSuggestion, query: MarkdownPathQuery)? = nil) {
        guard !acting else { return }
        acting = true
        DispatchQueue.main.async { acting = false }

        let pick: MarkdownGoToPick
        let query: MarkdownPathQuery
        if let clicked {
            pick = .chosen(clicked.row)
            query = clicked.query
        } else {
            guard let current else {
                pending = .go(reveal: reveal)
                return
            }
            pick = self.pick(in: current)
            query = current.query
        }
        apply(MarkdownPathCompletion.action(text: text, base: base, pick: pick, query: query, reveal: reveal))
    }

    private func pick(in suggestions: MarkdownPathSuggestions) -> MarkdownGoToPick {
        let rows = suggestions.rows
        guard moved else { return .automatic(suggestions.automaticIndex.map { rows[$0] }) }
        guard let selection, rows.indices.contains(selection) else { return .text }
        return .chosen(rows[selection])
    }

    private func apply(_ action: MarkdownGoToAction) {
        switch action {
        case .complete(let next):
            text = next
            focused = true
        case .problem(let failure):
            problem = failure
        case .open, .reveal:
            if let failure = model.perform(action) {
                problem = failure
            } else {
                model.goToOpen = false
            }
        }
    }
}

/// One row of the list: a value, so a keystroke that changes another row leaves it alone.
private struct MarkdownGoToRow: View, Equatable {
    let row: MarkdownPathSuggestion
    let detail: String?
    let label: String
    let selected: Bool
    let theme: MarkdownTheme
    let action: () -> Void

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.row == rhs.row && lhs.detail == rhs.detail && lhs.label == rhs.label && lhs.selected == rhs.selected
            && lhs.theme == rhs.theme
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 11))
                    .foregroundStyle(row.isFolder ? theme.accent : theme.textMuted)
                    .frame(width: 16)
                    .accessibilityHidden(true)
                Text(title)
                    .font(GenTypography.mono(12))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 8)
                if let detail {
                    Text(verbatim: detail)
                        .font(.system(size: 11))
                        .foregroundStyle(theme.textMuted)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
            }
            .padding(.horizontal, 8)
            .frame(height: 24)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(selected ? theme.accent.opacity(0.18) : Color.clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .hoverHighlight(color: theme.accent, cornerRadius: 5, fillOpacity: 0.08, borderOpacity: 0)
        // `.help`, not an instant tooltip: one AppKit hover view per row of a long list lagged it (2026-10-13).
        .help(row.path)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("markdown-goto-row")
    }

    private var icon: String {
        if row.isFolder { return "folder.fill" }
        return row.source == .recent ? "clock.arrow.circlepath" : "doc.text"
    }

    /// The name with the letters the typed part matched in the accent; a folder ends in a muted slash.
    private var title: AttributedString {
        let marks = Set(row.matched)
        var out = AttributedString()
        var run = ""
        var runMarked = false
        func flush() {
            guard !run.isEmpty else { return }
            var piece = AttributedString(run)
            piece.foregroundColor = runMarked ? theme.accent : theme.text
            if runMarked { piece.inlinePresentationIntent = .stronglyEmphasized }
            out.append(piece)
            run = ""
        }
        for (offset, character) in row.name.enumerated() {
            let marked = marks.contains(offset)
            if marked != runMarked {
                flush()
                runMarked = marked
            }
            run.append(character)
        }
        flush()
        if row.isFolder {
            var slash = AttributedString("/")
            slash.foregroundColor = theme.textMuted
            out.append(slash)
        }
        return out
    }
}
