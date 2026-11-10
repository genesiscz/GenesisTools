import AppKit
import SwiftUI

// MARK: - The values

/// A value an `AutocompleteField` offers: a title, and optionally a detail line and an SF Symbol.
public protocol AutocompleteItem: Identifiable {
    var autocompleteTitle: String { get }
    var autocompleteDetail: String? { get }
    var autocompleteSymbol: String? { get }
}

public extension AutocompleteItem {
    var autocompleteDetail: String? { nil }
    var autocompleteSymbol: String? { nil }
}

/// A plain value: its title is its identity.
public struct AutocompleteValue: AutocompleteItem, Hashable, Sendable {
    public let title: String
    public let detail: String?
    public let symbol: String?

    public init(_ title: String, detail: String? = nil, symbol: String? = nil) {
        self.title = title
        self.detail = detail
        self.symbol = symbol
    }

    public var id: String { title }
    public var autocompleteTitle: String { title }
    public var autocompleteDetail: String? { detail }
    public var autocompleteSymbol: String? { symbol }
}

/// Where a field's values come from.
public enum AutocompleteSource<Item: AutocompleteItem> {
    /// A fixed list, filtered as the user types.
    case items([Item])
    /// Read once, the first time the field needs values, then kept and filtered like `items`.
    case lazyItems(@Sendable () async throws -> [Item])
    /// Asked for each typed text after a short pause; an older call is cancelled. Its answer is shown as it comes.
    case search(@Sendable (String) async throws -> [Item])
}

/// How a value was taken.
public enum AutocompleteKey: Sendable, Equatable {
    case returnKey, tab, click
}

/// What the user took: a row of the list (`item`), or the typed text itself when free text is allowed.
public struct AutocompleteChoice<Item: AutocompleteItem> {
    public let item: Item?
    public let text: String
    public let key: AutocompleteKey
}

/// A read the list could not make, in one sentence the list shows. A source throws it to choose its words (a folder
/// this app may not open); any other error shows its `localizedDescription`.
public struct AutocompleteFailure: LocalizedError, Sendable {
    public let sentence: String

    public init(_ sentence: String) {
        self.sentence = sentence
    }

    public var errorDescription: String? { sentence }
}

// MARK: - Matching

/// How typed text matches a title: case and accents do not count. A title that starts with it, or has a word that
/// does, comes before one that only holds it.
public enum AutocompleteMatch {
    static func fold(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil)
    }

    /// The matching items in rank order, at most `limit`. Empty text matches everything in its own order.
    public static func ranked<Item: AutocompleteItem>(_ items: [Item], query: String, limit: Int = 200) -> [Item] {
        let typed = fold(query.trimmingCharacters(in: .whitespaces))
        guard !typed.isEmpty else { return Array(items.prefix(limit)) }
        var starts: [Item] = []
        var words: [Item] = []
        var inside: [Item] = []
        for item in items {
            let title = fold(item.autocompleteTitle)
            guard let range = title.range(of: typed) else { continue }
            if range.lowerBound == title.startIndex {
                starts.append(item)
            } else if !title[title.index(before: range.lowerBound)].isLetter && !title[title.index(before: range.lowerBound)].isNumber {
                words.append(item)
            } else {
                inside.append(item)
            }
        }
        return Array((starts + words + inside).prefix(limit))
    }

    /// The first place the typed text sits in `title`, in the title's own characters; nil when it is not there.
    public static func range(in title: String, of query: String) -> Range<String.Index>? {
        let typed = query.trimmingCharacters(in: .whitespaces)
        guard !typed.isEmpty else { return nil }
        return title.range(of: typed, options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive])
    }

    /// The title with the typed part marked (semibold, full ink); the rest stays as it is.
    public static func marked(_ title: String, query: String) -> AttributedString {
        var text = AttributedString(title)
        guard let range = range(in: title, of: query),
              let lower = AttributedString.Index(range.lowerBound, within: text),
              let upper = AttributedString.Index(range.upperBound, within: text) else { return text }
        text[lower..<upper].font = .system(size: 12.5, weight: .semibold)
        return text
    }
}

// MARK: - The state

/// What a key in the field does. The field's AppKit delegate sends these, and a test can send them too.
public enum AutocompleteCommand: Sendable, Equatable {
    case down, up, returnKey, tab, escape
}

/// Where a read of the values is.
public enum AutocompletePhase: Equatable, Sendable {
    case idle
    /// A read runs; `shown` turns true after 200 ms, so a fast read never flashes a spinner.
    case loading(shown: Bool)
    case loaded
    case failed(String)
}

/// The list's state: what the source answered, which row is marked, and whether the list is open.
@MainActor
public final class AutocompleteModel<Item: AutocompleteItem>: ObservableObject {
    @Published public internal(set) var phase: AutocompletePhase = .idle
    /// The values a lazy or search source answered; nil before the first answer.
    @Published public internal(set) var answered: [Item]?
    @Published public var marked: Int?
    @Published public internal(set) var focused = false
    /// Escape closed the list; typing or Down opens it again.
    @Published public internal(set) var dismissed = false

    private var task: Task<Void, Never>?
    private var loadingTimer: Task<Void, Never>?
    /// The text the last search answered, so a search is asked once per text.
    private var answeredText: String?
    static var loadingDelay: Duration { .milliseconds(200) }
    static var searchPause: Duration { .milliseconds(150) }

    public init() {}

    var isFailed: Bool {
        if case .failed = phase { return true }
        return false
    }

    var isLoadingShown: Bool {
        if case .loading(let shown) = phase { return shown }
        return false
    }

    /// The source needs to answer for `text`: a lazy source once, a search source per text.
    func need(_ source: AutocompleteSource<Item>, text: String) {
        switch source {
        case .items:
            return
        case .lazyItems(let read):
            guard answered == nil, task == nil, !isFailed else { return }
            run { try await read() }
        case .search(let search):
            guard answeredText != text || answered == nil else { return }
            answeredText = text
            run(after: Self.searchPause) { try await search(text) }
        }
    }

    /// Reads again after a failure (the list's Retry).
    func retry(_ source: AutocompleteSource<Item>, text: String) {
        phase = .idle
        answered = nil
        answeredText = nil
        task?.cancel()
        task = nil
        need(source, text: text)
    }

    private func run(after pause: Duration = .zero, _ read: @escaping @Sendable () async throws -> [Item]) {
        task?.cancel()
        loadingTimer?.cancel()
        phase = .loading(shown: false)
        loadingTimer = Task { [weak self] in
            try? await Task.sleep(for: Self.loadingDelay)
            guard let self, !Task.isCancelled, case .loading = self.phase else { return }
            self.phase = .loading(shown: true)
        }
        task = Task { [weak self] in
            if pause > .zero {
                try? await Task.sleep(for: pause)
                guard !Task.isCancelled else { return }
            }
            do {
                let items = try await read()
                guard !Task.isCancelled, let self else { return }
                self.answered = items
                self.phase = .loaded
                self.finish()
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled, let self else { return }
                self.phase = .failed((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
                self.finish()
            }
        }
    }

    private func finish() {
        loadingTimer?.cancel()
        task = nil
    }

    func focus(_ on: Bool) {
        focused = on
        if !on { marked = nil }
        dismissed = false
    }

    func typed() {
        dismissed = false
        marked = nil
    }

    func dismiss() {
        dismissed = true
        marked = nil
    }

    /// Moves the mark over `count` rows; Down on a closed list opens it.
    func move(_ delta: Int, count: Int) {
        if dismissed {
            dismissed = false
            return
        }
        guard count > 0 else { return }
        guard let current = marked else {
            marked = delta > 0 ? 0 : count - 1
            return
        }
        marked = min(max(current + delta, 0), count - 1)
    }

    deinit {
        task?.cancel()
        loadingTimer?.cancel()
    }
}

// MARK: - The field

/// A text field that completes from values the caller gives: a fixed list (`items`), a list read once when first
/// needed (`lazyItems`), or a search per typed text (`search`). The list opens under the field while it has the
/// keyboard and something to show, and pushes what is below it down (it never covers the next field).
///
/// Keys: Down and Up move the mark, Return takes the marked row (or the typed text when `allowsFreeText` and no row is
/// marked), Tab takes the marked row (and moves on when none is), Escape closes the list first and clears the field
/// second. The pointer: hover marks a row, a click takes it. A slow read shows "Reading…" after 200 ms, no match says so
/// (with the free-text hint), a failed read shows its sentence and Retry. VoiceOver hears the count of matches and the
/// marked row. The list draws through `KitLook` (`.well` for its ground, `.plain` for a row), so a window's look
/// reaches it; the field itself is the system's rounded field, so it sits well beside the page's other fields.
public struct AutocompleteField<Item: AutocompleteItem>: View {
    @Binding private var text: String
    private let placeholder: String
    private let source: AutocompleteSource<Item>
    private let allowsFreeText: Bool
    private let hides: (Item) -> Bool
    private let maxRows: Int
    private let label: String?
    private let identifier: String?
    private let preview: AutocompletePreview?
    private let onChoose: (AutocompleteChoice<Item>) -> Void
    @StateObject private var model = AutocompleteModel<Item>()
    @Environment(\.kitLook) private var look
    @Environment(\.colorScheme) private var scheme
    @GenReduceMotion private var reduceMotion

    /// - Parameters:
    ///   - allowsFreeText: Return with no marked row takes the typed text, a value the list does not hold.
    ///   - hides: values to leave out of the list, such as those already chosen.
    ///   - preview: draws the list open as given, for a picture with no keyboard (the catalog); nil in an app.
    public init(_ placeholder: String, text: Binding<String>, source: AutocompleteSource<Item>, allowsFreeText: Bool = false,
                hides: @escaping (Item) -> Bool = { _ in false }, maxRows: Int = 7, label: String? = nil,
                identifier: String? = nil, preview: AutocompletePreview? = nil,
                onChoose: @escaping (AutocompleteChoice<Item>) -> Void) {
        _text = text
        self.placeholder = placeholder
        self.source = source
        self.allowsFreeText = allowsFreeText
        self.hides = hides
        self.maxRows = maxRows
        self.label = label
        self.identifier = identifier
        self.preview = preview
        self.onChoose = onChoose
    }

    /// A fixed list, filtered as the user types.
    public init(_ placeholder: String, text: Binding<String>, items: [Item], allowsFreeText: Bool = false,
                hides: @escaping (Item) -> Bool = { _ in false }, label: String? = nil, identifier: String? = nil,
                preview: AutocompletePreview? = nil, onChoose: @escaping (AutocompleteChoice<Item>) -> Void) {
        self.init(placeholder, text: text, source: .items(items), allowsFreeText: allowsFreeText, hides: hides, label: label,
                  identifier: identifier, preview: preview, onChoose: onChoose)
    }

    /// A list read once, when the field first needs values.
    public init(_ placeholder: String, text: Binding<String>, lazyItems: @escaping @Sendable () async throws -> [Item],
                allowsFreeText: Bool = false, hides: @escaping (Item) -> Bool = { _ in false }, label: String? = nil,
                identifier: String? = nil, onChoose: @escaping (AutocompleteChoice<Item>) -> Void) {
        self.init(placeholder, text: text, source: .lazyItems(lazyItems), allowsFreeText: allowsFreeText, hides: hides,
                  label: label, identifier: identifier, onChoose: onChoose)
    }

    /// A search per typed text.
    public init(_ placeholder: String, text: Binding<String>, search: @escaping @Sendable (String) async throws -> [Item],
                allowsFreeText: Bool = false, hides: @escaping (Item) -> Bool = { _ in false }, label: String? = nil,
                identifier: String? = nil, onChoose: @escaping (AutocompleteChoice<Item>) -> Void) {
        self.init(placeholder, text: text, source: .search(search), allowsFreeText: allowsFreeText, hides: hides,
                  label: label, identifier: identifier, onChoose: onChoose)
    }

    /// The rows the list shows for the text now.
    private var matches: [Item] {
        let base: [Item]
        switch source {
        case .items(let items): base = items
        case .lazyItems, .search: base = model.answered ?? []
        }
        let shown = base.filter { !hides($0) }
        // A search answers for its text; marking still shows where the text sits.
        if case .search = source { return shown }
        return AutocompleteMatch.ranked(shown, query: text)
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespaces) }

    private var listOpen: Bool {
        if preview != nil { return true }
        return model.focused && !model.dismissed
    }

    private var markedIndex: Int? {
        if let preview { return preview.marked }
        return model.marked.flatMap { $0 < matches.count ? $0 : nil }
    }

    public var body: some View {
        let rows = matches
        VStack(alignment: .leading, spacing: 4) {
            AutocompleteTextField(placeholder: placeholder, text: $text, label: label ?? placeholder, identifier: identifier,
                                  onFocus: focus, onType: type, onCommand: { command(rows, $0) })
                .frame(maxWidth: .infinity)
            if listOpen, let list = listContent(rows) {
                list.transition(.genReveal)
            }
        }
        .clipShape(Rectangle().inset(by: -4))
        .animation(GenMotion.animation(expanding: listOpen, reduceMotion: reduceMotion), value: listOpen)
        // A value set from outside (a Tab that filled a folder) is asked like a typed one.
        .onChange(of: text) { _, value in
            guard model.focused else { return }
            model.typed()
            model.need(source, text: value)
        }
        .onChange(of: rows.count) { _, count in
            guard model.focused, !model.dismissed else { return }
            announce(count: count)
        }
    }

    // MARK: Keys

    private func focus(_ on: Bool) {
        model.focus(on)
        if on { model.need(source, text: text) }
    }

    private func type(_ value: String) {
        model.typed()
        model.need(source, text: value)
    }

    /// Whether the field's AppKit delegate should treat the key as handled.
    private func command(_ rows: [Item], _ command: AutocompleteCommand) -> Bool {
        switch command {
        case .down, .up:
            model.move(command == .down ? 1 : -1, count: rows.count)
            if let index = model.marked, index < rows.count {
                GenAnnounce.post("\(rows[index].autocompleteTitle), \(index + 1) of \(rows.count)", priority: .low)
            }
            return true
        case .returnKey:
            if listOpen, let index = model.marked, index < rows.count {
                take(rows[index], key: .returnKey)
            } else if allowsFreeText, !trimmed.isEmpty {
                onChoose(AutocompleteChoice(item: nil, text: trimmed, key: .returnKey))
            }
            return true
        case .tab:
            guard listOpen, let index = model.marked, index < rows.count else { return false }
            take(rows[index], key: .tab)
            return true
        case .escape:
            if listOpen, !(rows.isEmpty && trimmed.isEmpty && !model.isFailed) {
                model.dismiss()
                return true
            }
            // Nothing to close or clear: the key goes on to the window (a sheet's Cancel).
            guard !text.isEmpty else { return false }
            text = ""
            model.typed()
            return true
        }
    }

    private func take(_ item: Item, key: AutocompleteKey) {
        model.marked = nil
        onChoose(AutocompleteChoice(item: item, text: item.autocompleteTitle, key: key))
    }

    private func announce(count: Int) {
        GenAnnounce.post(count == 0 ? "No match" : Plural.count(count, "match", "matches"), priority: .low)
    }

    // MARK: The list

    private func listContent(_ rows: [Item]) -> AnyView? {
        let phase = preview?.phase ?? model.phase
        if case .failed(let sentence) = phase {
            return AnyView(panel { failure(sentence) })
        }
        if case .loading(let shown) = phase, shown, rows.isEmpty {
            return AnyView(panel {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Reading the values…").font(.system(size: 12)).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 10).padding(.vertical, 8)
            })
        }
        if rows.isEmpty {
            // Nothing typed and nothing to offer: no list at all, rather than an empty box.
            if trimmed.isEmpty { return nil }
            if case .loading = phase { return nil }
            return AnyView(panel {
                Text(allowsFreeText ? "No match. Return adds “\(trimmed)”." : "No match.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .accessibilityAddTraits(.updatesFrequently)
            })
        }
        return AnyView(panel { rowList(rows) })
    }

    private func panel(@ViewBuilder _ content: () -> some View) -> some View {
        let ground = look.surface(.well, scheme: scheme)
        let radius = look.radius(.well, height: 30, legacy: 7)
        return content()
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(KitSurfaceBackground(ground, radius: radius, corners: look.corners))
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: look.corners).strokeBorder(Color.primary.opacity(0.08))
            }
            .accessibilityElement(children: .contain)
    }

    private func failure(_ sentence: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 11)).foregroundStyle(KitHue.care.ink)
                .accessibilityHidden(true)
            Text(verbatim: sentence).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 6)
            if preview == nil {
                Button("Retry") { model.retry(source, text: text) }
                    .buttonStyle(AutocompleteRowStyle(marked: false))
                    .font(.system(size: 12, weight: .medium))
            } else {
                Text("Retry").font(.system(size: 12, weight: .medium)).padding(.horizontal, 6).padding(.vertical, 3)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
    }

    private static var rowHeight: CGFloat { 26 }

    private func rowList(_ rows: [Item]) -> some View {
        let height = CGFloat(min(rows.count, maxRows)) * (Self.rowHeight + 2) + 8
        let marked = markedIndex
        return ScrollViewReader { proxy in
            ScrollView(.vertical) {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { index, item in
                        row(item, index: index, marked: marked == index)
                            .id(index)
                    }
                }
                .padding(4)
            }
            .scrollIndicators(rows.count > maxRows ? .automatic : .never)
            .frame(height: height)
            .onChange(of: model.marked) { _, index in
                guard let index else { return }
                proxy.scrollTo(index)
            }
        }
        .accessibilityLabel(Plural.count(rows.count, "match", "matches"))
    }

    private func row(_ item: Item, index: Int, marked: Bool) -> some View {
        Button {
            take(item, key: .click)
        } label: {
            HStack(spacing: 8) {
                if let symbol = item.autocompleteSymbol {
                    Image(systemName: symbol).font(.system(size: 11)).foregroundStyle(.secondary).frame(width: 14)
                        .accessibilityHidden(true)
                }
                Text(AutocompleteMatch.marked(item.autocompleteTitle, query: text))
                    .font(.system(size: 12.5)).lineLimit(1).truncationMode(.middle)
                    .layoutPriority(1)
                if let detail = item.autocompleteDetail {
                    Text(verbatim: detail).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .frame(maxWidth: .infinity, minHeight: Self.rowHeight, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(AutocompleteRowStyle(marked: marked))
        .onHover { inside in
            if inside, preview == nil, model.marked != index { model.marked = index }
        }
        .accessibilityLabel([item.autocompleteTitle, item.autocompleteDetail].compactMap { $0 }.joined(separator: ", "))
        .accessibilityAddTraits(marked ? .isSelected : [])
    }
}

/// What a picture of the field shows without a keyboard: the list open, a marked row, a state.
public struct AutocompletePreview {
    public var marked: Int?
    public var phase: AutocompletePhase?

    public init(marked: Int? = nil, loading: Bool = false, failure: String? = nil) {
        self.marked = marked
        if let failure {
            phase = .failed(failure)
        } else if loading {
            phase = .loading(shown: true)
        } else {
            phase = nil
        }
    }
}

/// A row of the list: nothing at rest, the look's `.plain` wash when marked or under the pointer, deeper when pressed.
struct AutocompleteRowStyle: ButtonStyle {
    let marked: Bool

    func makeBody(configuration: Configuration) -> some View {
        RowBody(configuration: configuration, marked: marked)
    }

    private struct RowBody: View {
        let configuration: ButtonStyleConfiguration
        let marked: Bool
        @Environment(\.kitLook) private var look
        @Environment(\.colorScheme) private var scheme
        @Environment(\.kitForcedInteraction) private var forced
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            // A picture forces the marked row's state only: the other rows stay at rest.
            let pressed = configuration.isPressed || (marked && forced == .pressed)
            let state: KitInteraction = pressed ? .pressed : (marked ? .hover : .rest)
            let surface = look.surface(.plain, state, scheme: scheme)
            let radius = look.radius(.plain, height: 26, legacy: 6)
            configuration.label
                .foregroundStyle(surface.label)
                .background(KitSurfaceBackground(surface, radius: radius, corners: look.corners))
                .contentShape(RoundedRectangle(cornerRadius: radius, style: look.corners))
                .pointerCursor(isEnabled)
        }
    }
}

// MARK: - The AppKit field

/// The system's rounded text field, with the list's keys taken before the field editor acts on them.
struct AutocompleteTextField: NSViewRepresentable {
    let placeholder: String
    @Binding var text: String
    let label: String
    let identifier: String?
    let onFocus: (Bool) -> Void
    let onType: (String) -> Void
    /// True when the key was used.
    let onCommand: (AutocompleteCommand) -> Bool

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> Field {
        let field = Field(string: text)
        field.placeholderString = placeholder
        field.setAccessibilityLabel(label)
        if let identifier { field.setAccessibilityIdentifier(identifier) }
        field.bezelStyle = .roundedBezel
        field.isBezeled = true
        field.usesSingleLineMode = true
        field.lineBreakMode = .byTruncatingTail
        field.cell?.isScrollable = true
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        field.delegate = context.coordinator
        field.onFocus = { [weak coordinator = context.coordinator] in coordinator?.parent.onFocus(true) }
        return field
    }

    func updateNSView(_ field: Field, context: Context) {
        context.coordinator.parent = self
        if field.stringValue != text {
            // While the field is edited, its editor holds the text: set it there and keep the caret at the end.
            if let editor = field.currentEditor() as? NSTextView {
                editor.string = text
                editor.setSelectedRange(NSRange(location: (text as NSString).length, length: 0))
            } else {
                field.stringValue = text
            }
        }
        if field.placeholderString != placeholder { field.placeholderString = placeholder }
        if field.accessibilityLabel() != label { field.setAccessibilityLabel(label) }
    }

    final class Field: NSTextField {
        var onFocus: () -> Void = {}

        override func becomeFirstResponder() -> Bool {
            let became = super.becomeFirstResponder()
            if became { onFocus() }
            return became
        }
    }

    final class Coordinator: NSObject, NSTextFieldDelegate {
        var parent: AutocompleteTextField

        init(_ parent: AutocompleteTextField) {
            self.parent = parent
        }

        func controlTextDidChange(_ notification: Notification) {
            guard let field = notification.object as? NSTextField else { return }
            parent.text = field.stringValue
            parent.onType(field.stringValue)
        }

        func controlTextDidEndEditing(_ notification: Notification) {
            parent.onFocus(false)
        }

        func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            switch selector {
            case #selector(NSResponder.moveDown(_:)): return parent.onCommand(.down)
            case #selector(NSResponder.moveUp(_:)): return parent.onCommand(.up)
            case #selector(NSResponder.insertNewline(_:)): return parent.onCommand(.returnKey)
            case #selector(NSResponder.insertTab(_:)): return parent.onCommand(.tab)
            case #selector(NSResponder.cancelOperation(_:)): return parent.onCommand(.escape)
            default: return false
            }
        }
    }
}
