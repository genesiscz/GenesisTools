import AppKit
import SwiftUI

// ⌘F in every hub panel that has no find of its own (Inbox, Today, Decisions, worktree cleanup, the PR
// overview, the PR threads list, the notification settings). One shared bar: match count, next and
// previous (⌘G, ⇧⌘G, Enter, ⇧Enter), every match highlighted, the current one scrolled into view, Esc
// closes. The transcript's search and the diff's find stay theirs.
//
// A panel owns a `PanelFindModel` as `@State` (not `@StateObject`: the panel itself must not redraw on
// every typed letter; the bar and the rows observe the find) and wires three things:
//   - `.panelFind(find, revision:rows:)` on its root: the text it can search, as rows of fields;
//   - `PanelFindBar(find:)` under its header (draws nothing while closed);
//   - `.findRow(id)` on each row, and `FindText(text, field:)` where the row shows a field.
//     A `MarkdownContentView` inside a row highlights by itself under `.findField(key)`.
//
// ⌘F goes to the panel the keyboard is in (`PanelFindRouter`): the panel of the last click, else the
// one holding the first responder, else the one used last, else the largest. The transcript, the
// diff and the file list register as native panels, so a click there keeps ⌘F on their own search
// (the file list: its "Filter files…" field). A panel wired from outside (the Inbox) puts
// `PanelFindBarSlot()` under its header instead of holding the model.

// MARK: - Matching (pure, off the main thread)

struct PanelFindField: Sendable, Equatable {
    let key: String
    let text: String
    /// Matched block by block, as `MarkdownContentView` draws it (each match names its block).
    var markdown = false

    init(_ key: String, _ text: String, markdown: Bool = false) {
        self.key = key
        self.text = text
        self.markdown = markdown
    }
}

struct PanelFindRow: Sendable, Equatable {
    let id: String
    let fields: [PanelFindField]
    /// The lazy stack element that holds this row when the row is nested inside one (an Inbox
    /// session section): the bar scrolls there first, so a row that was never drawn gets drawn.
    var container: String?

    init(id: String, fields: [PanelFindField], container: String? = nil) {
        self.id = id
        self.fields = fields.filter { !$0.text.isEmpty }
        self.container = container
    }
}

struct PanelFindMatch: Sendable, Hashable {
    let row: String
    let field: String
    /// The paragraph of a markdown field; nil for plain text.
    var block: Int?
    /// Which occurrence inside that field (or block), from 0.
    let occurrence: Int
    var container: String?

    init(row: String, field: String, block: Int? = nil, occurrence: Int, container: String? = nil) {
        self.row = row
        self.field = field
        self.block = block
        self.occurrence = occurrence
        self.container = container
    }

    /// The field's (or markdown paragraph's) own scroll anchor: a tall row scrolls to the text that
    /// matched, not to its middle.
    var anchor: String { PanelFind.anchorID(row: row, field: field, block: block) }
}

enum PanelFind {
    /// Off: ignores case and accents ("cez" finds "ČEZ"). On: exact.
    nonisolated static func options(caseSensitive: Bool) -> String.CompareOptions {
        caseSensitive ? [] : [.caseInsensitive, .diacriticInsensitive]
    }

    nonisolated static func ranges(of query: String, in text: String, caseSensitive: Bool) -> [Range<String.Index>] {
        guard !query.trimmingCharacters(in: .whitespaces).isEmpty, !text.isEmpty else { return [] }
        let options = options(caseSensitive: caseSensitive)
        var found: [Range<String.Index>] = []
        var start = text.startIndex
        while start < text.endIndex, let range = text.range(of: query, options: options, range: start..<text.endIndex) {
            found.append(range)
            // Never an empty range: a composed character can match a zero-width tail.
            start = range.upperBound > range.lowerBound ? range.upperBound : text.index(after: range.lowerBound)
        }
        return found
    }

    /// Every occurrence in every field, in row order, then field order, then text order.
    nonisolated static func matches(of query: String, in rows: [PanelFindRow], caseSensitive: Bool) -> [PanelFindMatch] {
        guard !query.trimmingCharacters(in: .whitespaces).isEmpty else { return [] }
        var out: [PanelFindMatch] = []
        for row in rows {
            for field in row.fields {
                let parts: [(block: Int?, text: String)] = field.markdown
                    ? MarkdownContentView.searchBlocks(field.text).enumerated().map { ($0.offset, $0.element) }
                    : [(nil, field.text)]
                for part in parts {
                    let count = ranges(of: query, in: part.text, caseSensitive: caseSensitive).count
                    for occurrence in 0..<count {
                        out.append(PanelFindMatch(row: row.id, field: field.key, block: part.block, occurrence: occurrence, container: row.container))
                    }
                }
            }
        }
        return out
    }

    /// Next or previous, wrapping at both ends. With no current match, forward starts at the first.
    nonisolated static func step(_ current: Int?, count: Int, forward: Bool) -> Int? {
        guard count > 0 else { return nil }
        guard let current, current < count else { return forward ? 0 : count - 1 }
        return forward ? (current + 1) % count : (current - 1 + count) % count
    }

    /// The current match after the matches were computed again. `sameMatch` (the data changed):
    /// the same occurrence if it is still there. Otherwise, and when the query changed, the first
    /// match in the same row; else the first match (query) or the same position (data).
    nonisolated static func carry(_ previous: PanelFindMatch?, previousIndex: Int?, into matches: [PanelFindMatch], sameMatch: Bool) -> Int? {
        guard !matches.isEmpty else { return nil }
        if sameMatch, let previous, let same = matches.firstIndex(of: previous) {
            return same
        }
        if let previous, let row = matches.firstIndex(where: { $0.row == previous.row }) {
            return row
        }
        return sameMatch ? min(previousIndex ?? 0, matches.count - 1) : 0
    }

    nonisolated static func anchorID(row: String, field: String, block: Int?) -> String {
        block.map { "\(row)|\(field)#\($0)" } ?? "\(row)|\(field)"
    }
}

// MARK: - Routing (pure)

/// Which registered panel a find key belongs to. Rects are in window coordinates.
enum PanelFindRouting {
    struct Candidate: Equatable {
        let rect: CGRect
        /// When a click last landed in it or its find opened.
        let activeAt: TimeInterval?
    }

    /// The panel of the last click; else the panel around the first responder (only when the
    /// responder is not larger than the panel: the window's own hosting view says nothing, the
    /// diff's web view is exactly its panel); else the one used last; else the largest.
    static func pick(_ candidates: [Candidate], click: CGPoint?, responder: CGRect?) -> Int? {
        guard !candidates.isEmpty else { return nil }
        func area(_ rect: CGRect) -> CGFloat { rect.width * rect.height }
        func innermost(_ inside: (CGRect) -> Bool) -> Int? {
            candidates.indices.filter { inside(candidates[$0].rect) }.min { area(candidates[$0].rect) < area(candidates[$1].rect) }
        }

        if let click, let hit = innermost({ $0.contains(click) }) {
            return hit
        }

        if let responder, responder.width > 0, responder.height > 0,
           let hit = innermost({ $0.contains(CGPoint(x: responder.midX, y: responder.midY)) && area(responder) <= area($0) }) {
            return hit
        }

        let used = candidates.indices.filter { candidates[$0].activeAt != nil }
        if let recent = used.max(by: { (candidates[$0].activeAt ?? 0) < (candidates[$1].activeAt ?? 0) }) {
            return recent
        }

        return candidates.indices.max { area(candidates[$0].rect) < area(candidates[$1].rect) }
    }
}

// MARK: - Model

@MainActor
final class PanelFindModel: ObservableObject {
    let scope: String
    /// "Find in <title>" in the field.
    let title: String
    @Published private(set) var isOpen = false
    @Published var query = "" {
        didSet { if query != oldValue { search(sameMatch: false, reveal: true) } }
    }
    @Published var caseSensitive = false {
        didSet { if caseSensitive != oldValue { search(sameMatch: false, reveal: true) } }
    }
    @Published private(set) var matches: [PanelFindMatch] = []
    @Published private(set) var currentIndex: Int?
    @Published private(set) var searching = false
    /// The bar focuses its field (and selects the text) when this changes.
    @Published private(set) var focusToken = 0
    /// The host scrolls to `current` when this changes.
    @Published private(set) var revealToken = 0

    /// What the panel can search, set by `.panelFind` on every render (the latest data).
    var rows: () -> [PanelFindRow] = { [] }
    /// The bar's field has the keyboard (Esc then closes even though a text field is focused).
    var fieldFocused = false
    /// `--panel-find-next <n>`: the match to show once the first non-empty result lands.
    var stepsAfterSearch = 0
    private var generation = 0

    init(scope: String, title: String) {
        self.scope = scope
        self.title = title
    }

    var current: PanelFindMatch? {
        guard let currentIndex, matches.indices.contains(currentIndex) else { return nil }
        return matches[currentIndex]
    }

    var highlight: PanelFindHighlight? {
        guard isOpen, !query.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return PanelFindHighlight(query: query, caseSensitive: caseSensitive, current: current)
    }

    var countLabel: String {
        if query.trimmingCharacters(in: .whitespaces).isEmpty { return "" }
        if searching && matches.isEmpty { return "…" }
        if matches.isEmpty { return "No matches" }
        return "\(currentIndex.map { $0 + 1 } ?? 0) of \(matches.count)"
    }

    /// ⌘F: opens the bar (or focuses it again with the text selected).
    func open(query text: String? = nil) {
        let wasOpen = isOpen
        isOpen = true
        focusToken += 1
        if let text, text != query {
            query = text
        } else if !wasOpen {
            search(sameMatch: false, reveal: true)
        }
        HubPerf.log("find.panel.open \(scope)\(wasOpen ? " again" : "")")
    }

    func close() {
        guard isOpen else { return }
        isOpen = false
        generation += 1
        matches = []
        currentIndex = nil
        searching = false
        fieldFocused = false
    }

    func next() { move(forward: true) }

    func previous() { move(forward: false) }

    /// The panel's data changed while the bar is open: same query, the current match kept.
    func refresh() {
        search(sameMatch: true, reveal: false)
    }

    private func move(forward: Bool) {
        guard isOpen, !matches.isEmpty else { return }
        currentIndex = PanelFind.step(currentIndex, count: matches.count, forward: forward)
        revealToken += 1
    }

    private func search(sameMatch: Bool, reveal: Bool) {
        guard isOpen else { return }
        generation += 1
        let token = generation
        let needle = query
        let exact = caseSensitive
        guard !needle.trimmingCharacters(in: .whitespaces).isEmpty else {
            matches = []
            currentIndex = nil
            searching = false
            return
        }

        let snapshot = HubPerf.measure("find.panel.rows", scope) { rows() }
        let previous = current
        let previousIndex = currentIndex
        let scope = scope
        searching = true
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let span = HubPerf.begin("find.panel.match", "\(scope) \(snapshot.count) rows")
            let found = PanelFind.matches(of: needle, in: snapshot, caseSensitive: exact)
            span.end("\(found.count) matches")
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self, self.generation == token else { return }
                    self.searching = false
                    self.matches = found
                    self.currentIndex = PanelFind.carry(previous, previousIndex: previousIndex, into: found, sameMatch: sameMatch)
                    if self.stepsAfterSearch > 0, !found.isEmpty {
                        self.currentIndex = self.stepsAfterSearch % found.count
                        self.stepsAfterSearch = 0
                        self.revealToken += 1
                        return
                    }
                    // A new query, or the first match at all (the panel's data landed after the
                    // find opened). The host skips the scroll when the row did not change.
                    if self.current != nil, reveal || previous == nil {
                        self.revealToken += 1
                    }
                }
            }
        }
    }
}

// MARK: - Highlight

/// What the rows of an open find draw: every match tinted, the current one solid.
struct PanelFindHighlight: Equatable {
    let query: String
    let caseSensitive: Bool
    let current: PanelFindMatch?

    static let matchBackground = Color(red: 1, green: 0.85, blue: 0.25).opacity(0.32)
    static let currentBackground = Color(red: 1, green: 0.63, blue: 0.12)

    func isCurrentRow(_ row: String?) -> Bool {
        row != nil && current?.row == row
    }

    /// Characters kept before the current match when a one-line text starts with "…" instead.
    static let singleLineLead = 12

    /// `text` with the matches marked; `row` and `field` say which occurrence is the current one.
    /// `singleLine`: the text is cut to one line, so when the current match sits past its start the
    /// text is shown from shortly before the match ("…" first), or the tail would hide it.
    func attributed(_ text: String, row: String?, field: String?, singleLine: Bool = false) -> AttributedString {
        var shown = text
        var skipped = 0
        if singleLine, let occurrence = currentOccurrence(row: row, field: field, block: nil) {
            let ranges = PanelFind.ranges(of: query, in: text, caseSensitive: caseSensitive)
            if occurrence < ranges.count, text.distance(from: text.startIndex, to: ranges[occurrence].lowerBound) > Self.singleLineLead {
                let cut = text.index(ranges[occurrence].lowerBound, offsetBy: -Self.singleLineLead)
                skipped = ranges.prefix { $0.lowerBound < cut }.count
                shown = "…" + text[cut...]
            }
        }
        var attributed = AttributedString(shown)
        mark(&attributed, row: row, field: field, block: nil, skipped: skipped)
        return attributed
    }

    func currentOccurrence(row: String?, field: String?, block: Int?) -> Int? {
        guard row != nil, let current, current.row == row, current.field == field, current.block == block else { return nil }
        return current.occurrence
    }

    /// Marks the matches in already styled text (inline markdown). The ranges are found in the
    /// plain characters and walked once, so a long reply costs one pass.
    /// `skipped`: occurrences cut off before this text (a one-line text shown from its match).
    func mark(_ attributed: inout AttributedString, row: String?, field: String?, block: Int?, skipped: Int = 0) {
        let plain = String(attributed.characters)
        let ranges = PanelFind.ranges(of: query, in: plain, caseSensitive: caseSensitive)
        guard !ranges.isEmpty else { return }
        let currentOccurrence = currentOccurrence(row: row, field: field, block: block).map { $0 - skipped }
        var plainCursor = plain.startIndex
        var cursor = attributed.startIndex
        for (index, range) in ranges.enumerated() {
            let lower = attributed.characters.index(cursor, offsetBy: plain.distance(from: plainCursor, to: range.lowerBound))
            let upper = attributed.characters.index(lower, offsetBy: plain.distance(from: range.lowerBound, to: range.upperBound))
            if index == currentOccurrence {
                attributed[lower..<upper][AttributeScopes.SwiftUIAttributes.BackgroundColorAttribute.self] = Self.currentBackground
                attributed[lower..<upper][AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute.self] = .black
            } else {
                attributed[lower..<upper][AttributeScopes.SwiftUIAttributes.BackgroundColorAttribute.self] = Self.matchBackground
            }
            plainCursor = range.upperBound
            cursor = upper
        }
    }
}

private struct PanelFindHighlightKey: EnvironmentKey {
    static let defaultValue: PanelFindHighlight? = nil
}

private struct PanelFindRowKey: EnvironmentKey {
    static let defaultValue: String? = nil
}

private struct PanelFindFieldKey: EnvironmentKey {
    static let defaultValue: String? = nil
}

private struct PanelFindModelKey: EnvironmentKey {
    static let defaultValue: PanelFindModel? = nil
}

extension EnvironmentValues {
    var panelFindHighlight: PanelFindHighlight? {
        get { self[PanelFindHighlightKey.self] }
        set { self[PanelFindHighlightKey.self] = newValue }
    }

    var panelFindRow: String? {
        get { self[PanelFindRowKey.self] }
        set { self[PanelFindRowKey.self] = newValue }
    }

    var panelFindField: String? {
        get { self[PanelFindFieldKey.self] }
        set { self[PanelFindFieldKey.self] = newValue }
    }

    /// The find of the enclosing `.panelFind`, for `PanelFindBarSlot`.
    var panelFindModel: PanelFindModel? {
        get { self[PanelFindModelKey.self] }
        set { self[PanelFindModelKey.self] = newValue }
    }
}

/// `Text(text)` that marks the matches of the open find. Outside a find it is plain `Text`.
struct FindText: View {
    let text: String
    /// Styled text (inline markdown): matched on its shown characters, so its row field is
    /// `String(styled.characters)`.
    private let styled: AttributedString?
    let field: String
    @Environment(\.panelFindHighlight) private var highlight
    @Environment(\.panelFindRow) private var row
    @Environment(\.lineLimit) private var lineLimit

    init(_ text: String, field: String) {
        self.text = text
        styled = nil
        self.field = field
    }

    init(_ styled: AttributedString, field: String) {
        text = String(styled.characters)
        self.styled = styled
        self.field = field
    }

    var body: some View {
        if let highlight, let row, highlight.currentOccurrence(row: row, field: field, block: nil) != nil {
            // The scroll target of the current match.
            current(highlight).id(PanelFind.anchorID(row: row, field: field, block: nil))
        } else if let highlight {
            Text(marked(highlight))
        } else if let styled {
            Text(styled)
        } else {
            Text(verbatim: text)
        }
    }

    private func marked(_ highlight: PanelFindHighlight, singleLine: Bool = false) -> AttributedString {
        guard var styled else { return highlight.attributed(text, row: row, field: field, singleLine: singleLine) }
        highlight.mark(&styled, row: row, field: field, block: nil)
        return styled
    }

    /// One line: the whole line when it fits, else from shortly before the current match, which the
    /// tail truncation would hide.
    @ViewBuilder
    private func current(_ highlight: PanelFindHighlight) -> some View {
        if lineLimit == 1, styled == nil {
            ViewThatFits(in: .horizontal) {
                Text(marked(highlight))
                Text(marked(highlight, singleLine: true))
            }
        } else {
            Text(marked(highlight))
        }
    }
}

/// The find bar of the enclosing `.panelFind`, for a panel whose find is wired from outside it
/// (the Inbox): put it under the panel's header. Draws nothing outside a find or while closed.
struct PanelFindBarSlot: View {
    @Environment(\.panelFindModel) private var find

    var body: some View {
        if let find {
            PanelFindBar(find: find)
        }
    }
}

private struct FindRowModifier: ViewModifier {
    let id: String
    var cornerRadius: CGFloat
    @Environment(\.panelFindHighlight) private var highlight

    func body(content: Content) -> some View {
        content
            .environment(\.panelFindRow, id)
            .overlay {
                if highlight?.isCurrentRow(id) == true {
                    RoundedRectangle(cornerRadius: cornerRadius)
                        .stroke(PanelFindHighlight.currentBackground.opacity(0.85), lineWidth: 1.5)
                        // Just outside the row, so the ring never covers its first letters.
                        .padding(-2)
                        .allowsHitTesting(false)
                }
            }
            .id(id)
    }
}

extension View {
    /// A row of a find panel: its id (the same as in the panel's `rows`) is the scroll target, and
    /// the current match's row gets a ring.
    func findRow(_ id: String, cornerRadius: CGFloat = 7) -> some View {
        modifier(FindRowModifier(id: id, cornerRadius: cornerRadius))
    }

    /// The field key of a `MarkdownContentView` (or any `FindText` that reads it) under a find row.
    func findField(_ key: String) -> some View {
        environment(\.panelFindField, key)
    }

    /// The panel's find: searches `rows()`, highlights, scrolls to the current match, and takes ⌘F
    /// while the keyboard is in this panel. `revision` changes when the rows' content changes.
    func panelFind<Revision: Equatable>(_ find: PanelFindModel, revision: Revision, onReveal: ((PanelFindMatch) -> Void)? = nil,
                                        rows: @escaping () -> [PanelFindRow]) -> some View {
        modifier(PanelFindHost(find: find, revision: revision, onReveal: onReveal, rows: rows))
    }

    /// A panel with a find of its own (the transcript's search, the diff's page find). A click in it
    /// keeps ⌘F there: `onFind` runs, or with nil the key goes on to the panel's own shortcut.
    func panelFindNative(_ scope: String, onFind: (() -> Void)? = nil) -> some View {
        background(PanelFindAnchor(target: .native(scope: scope, onFind: onFind)))
    }

    /// An overlay that owns the keyboard while shown (find in files, the palette): no panel find
    /// key fires under it.
    func panelFindModal() -> some View {
        modifier(PanelFindModalModifier())
    }
}

private struct PanelFindModalModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .onAppear { PanelFindRouter.shared.modalShown(true) }
            .onDisappear { PanelFindRouter.shared.modalShown(false) }
    }
}

private struct PanelFindHost<Revision: Equatable>: ViewModifier {
    @ObservedObject var find: PanelFindModel
    let revision: Revision
    let onReveal: ((PanelFindMatch) -> Void)?
    let rows: () -> [PanelFindRow]
    @State private var revealed: PanelFindMatch?

    func body(content: Content) -> some View {
        find.rows = rows
        return ScrollViewReader { proxy in
            content
                .environment(\.panelFindHighlight, find.highlight)
                .environment(\.panelFindModel, find)
                .onChange(of: revision) { find.refresh() }
                .onChange(of: find.revealToken) { reveal(proxy) }
                .onChange(of: find.isOpen) { _, open in
                    if !open { revealed = nil }
                }
        }
        .background(PanelFindAnchor(target: .panel(find)))
    }

    /// Container first when the row sits in another lazy element than last time (it may never have
    /// been drawn), then the row, then a markdown paragraph's own anchor. A step inside the row that
    /// is already in view does not scroll.
    private func reveal(_ proxy: ScrollViewProxy) {
        guard let match = find.current else { return }
        onReveal?(match)
        let previous = revealed
        revealed = match
        var targets: [String] = []
        if let container = match.container, container != previous?.container {
            targets.append(container)
        }
        if match.row != previous?.row || !targets.isEmpty {
            targets.append(match.row)
        }
        if match.anchor != previous?.anchor {
            targets.append(match.anchor)
        }
        HubPerf.log("find.panel.reveal \(find.scope) \(match.row.prefix(40)) \(match.field.prefix(40)) block \(match.block.map(String.init) ?? "-") #\(match.occurrence)")
        for (step, target) in targets.enumerated() {
            let anchor: UnitPoint = step == 0 && targets.count > 1 && target == match.container ? .top : .center
            if step == 0 {
                proxy.scrollTo(target, anchor: anchor)
            } else {
                // The earlier step draws the rows this one scrolls to.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.06 * Double(step)) {
                    proxy.scrollTo(target, anchor: anchor)
                }
            }
        }
    }
}

extension View {
    /// A markdown paragraph's scroll anchor under a find row, applied only while a find is open.
    @ViewBuilder
    func panelFindAnchor(_ id: String?) -> some View {
        if let id {
            self.id(id)
        } else {
            self
        }
    }
}

// MARK: - Bar

/// The find bar: put it under the panel's header. It draws nothing while the find is closed.
struct PanelFindBar: View {
    @ObservedObject var find: PanelFindModel
    @FocusState private var focused: Bool

    var body: some View {
        if find.isOpen {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.dim)
                    .accessibilityHidden(true)
                TextField("Find in \(find.title)", text: $find.query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12.5))
                    .focused($focused)
                    .onSubmit { find.next() }
                    .onKeyPress(.return, phases: .down) { press in
                        guard press.modifiers.contains(.shift) else { return .ignored }
                        find.previous()
                        return .handled
                    }
                    .accessibilityIdentifier("panel-find-\(find.scope)")
                Text(verbatim: find.countLabel)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(find.countLabel == "No matches" ? ReviewPalette.removed : ReviewPalette.dim)
                    .fixedSize()
                    .accessibilityIdentifier("panel-find-count-\(find.scope)")
                IconButton(systemName: "chevron.up", tooltip: "Previous match (⇧⌘G or ⇧Enter)", size: 11) { find.previous() }
                    .disabled(find.matches.isEmpty)
                IconButton(systemName: "chevron.down", tooltip: "Next match (⌘G or Enter)", size: 11) { find.next() }
                    .disabled(find.matches.isEmpty)
                Button {
                    find.caseSensitive.toggle()
                } label: {
                    Text("Aa")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(find.caseSensitive ? Color.black : ReviewPalette.dim)
                        .padding(.horizontal, 5)
                        .frame(height: 18)
                        .background(RoundedRectangle(cornerRadius: 4).fill(find.caseSensitive ? PanelFindHighlight.currentBackground : Color.white.opacity(0.06)))
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip(find.caseSensitive ? "Matching case and accents exactly. Click to ignore them" : "Ignoring case and accents (\"cez\" finds \"ČEZ\"). Click to match them exactly")
                .accessibilityLabel(Text("Match case"))
                .accessibilityValue(Text(find.caseSensitive ? "on" : "off"))
                IconButton(systemName: "xmark", tooltip: "Close the find (Esc)", size: 10) { find.close() }
            }
            .padding(.horizontal, 12)
            .frame(height: 32)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.05)))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(PanelFindHighlight.currentBackground.opacity(0.35)))
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            // Its own row above the panel's scroll view, never a `.safeAreaInset` over it: selectable
            // text under an inset drew through this background (the PR overview, 2026-09-25).
            .hubSurface(.content)
            .onChange(of: find.focusToken, initial: true) { focusField() }
            .onChange(of: focused) { _, now in find.fieldFocused = now }
            .onExitCommand { find.close() }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(Text("Find in \(find.title)"))
        }
    }

    /// Focus, then select the whole query so typing replaces it (⌘F on an open bar).
    private func focusField() {
        focused = true
        DispatchQueue.main.async {
            guard let window = NSApp.keyWindow, let editor = window.firstResponder as? NSTextView, editor.isFieldEditor else { return }
            editor.selectAll(nil)
        }
    }
}

// MARK: - Anchor and router

enum PanelFindTarget {
    case panel(PanelFindModel)
    /// nil `onFind`: let the key through to the panel's own shortcut.
    case native(scope: String, onFind: (() -> Void)?)

    var scope: String {
        switch self {
        case .panel(let find): return find.scope
        case .native(let scope, _): return scope
        }
    }
}

/// An invisible view behind a panel: its frame is the panel's frame in the window.
private struct PanelFindAnchor: NSViewRepresentable {
    let target: PanelFindTarget

    func makeNSView(context: Context) -> PanelFindAnchorView {
        let view = PanelFindAnchorView()
        view.target = target
        return view
    }

    func updateNSView(_ view: PanelFindAnchorView, context: Context) {
        view.target = target
    }
}

final class PanelFindAnchorView: NSView {
    var target: PanelFindTarget?
    /// When a click last landed in this panel or its find opened.
    var activeAt: TimeInterval?

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        MainActor.assumeIsolated {
            if window == nil {
                PanelFindRouter.shared.unregister(self)
            } else {
                PanelFindRouter.shared.register(self)
            }
        }
    }

    override func isAccessibilityElement() -> Bool { false }
}

/// One key monitor for every panel find in the process. ⌘F opens the find of the panel the keyboard
/// is in; ⌘G and ⇧⌘G step its matches while its bar is open (else ⇧⌘G stays glass); Esc closes it
/// unless another text field has the keyboard. A key the panels do not take goes on untouched.
@MainActor
final class PanelFindRouter {
    static let shared = PanelFindRouter()

    private let anchors = NSHashTable<PanelFindAnchorView>.weakObjects()
    private var keyMonitor: Any?
    private var mouseMonitor: Any?
    private var lastClick: [ObjectIdentifier: CGPoint] = [:]
    private var modals = 0
    /// `--panel-find <scope>:<text>` (a `--snapshot` run shows a panel's find): opened as soon as
    /// that panel is on screen; `--panel-find-next <n>` then shows the match n + 1.
    private var pending: (scope: String, query: String, steps: Int)?

    private init() {
        let args = ProcessInfo.processInfo.arguments
        let steps = args.firstIndex(of: "--panel-find-next").flatMap { $0 + 1 < args.count ? Int(args[$0 + 1]) : nil } ?? 0
        if let flag = args.firstIndex(of: "--panel-find"), flag + 1 < args.count {
            request(args[flag + 1], steps: steps)
        }
    }

    /// An AppKit view with its own find (the diff's web view): `onFind` runs when ⌘F belongs to it.
    func registerNative(_ view: NSView, scope: String, onFind: @escaping () -> Void) {
        let anchor = PanelFindAnchorView(frame: view.bounds)
        anchor.autoresizingMask = [.width, .height]
        anchor.target = .native(scope: scope, onFind: onFind)
        view.addSubview(anchor)
    }

    func register(_ anchor: PanelFindAnchorView) {
        anchors.add(anchor)
        install()
        if let request = pending, anchor.target?.scope == request.scope, case .panel(let find) = anchor.target {
            pending = nil
            // After the panel's first render, so its rows are set.
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    anchor.activeAt = Date().timeIntervalSinceReferenceDate
                    find.stepsAfterSearch = request.steps
                    find.open(query: request.query)
                }
            }
        }
    }

    func unregister(_ anchor: PanelFindAnchorView) {
        anchors.remove(anchor)
    }

    func modalShown(_ shown: Bool) {
        modals = max(0, modals + (shown ? 1 : -1))
    }

    /// `scope:text` from `--panel-find`.
    func request(_ spec: String, steps: Int = 0) {
        let parts = spec.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2 else { return }
        let scope = String(parts[0])
        let query = String(parts[1])
        if let anchor = anchors.allObjects.first(where: { $0.target?.scope == scope }), case .panel(let find) = anchor.target {
            anchor.activeAt = Date().timeIntervalSinceReferenceDate
            find.stepsAfterSearch = steps
            find.open(query: query)
        } else {
            pending = (scope, query, steps)
        }
    }

    private func install() {
        guard keyMonitor == nil else { return }
        // Local monitors run on the main thread; only a Bool crosses back.
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            nonisolated(unsafe) let key = event
            return MainActor.assumeIsolated { PanelFindRouter.shared.consumes(key) } ? nil : event
        }
        mouseMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { event in
            nonisolated(unsafe) let click = event
            MainActor.assumeIsolated { PanelFindRouter.shared.noteClick(click) }
            return event
        }
    }

    private func noteClick(_ event: NSEvent) {
        guard let window = event.window else { return }
        lastClick[ObjectIdentifier(window)] = event.locationInWindow
        let (views, candidates) = candidates(in: window)
        if let hit = PanelFindRouting.pick(candidates, click: event.locationInWindow, responder: nil), candidates[hit].rect.contains(event.locationInWindow) {
            views[hit].activeAt = Date().timeIntervalSinceReferenceDate
        }
    }

    private func candidates(in window: NSWindow) -> ([PanelFindAnchorView], [PanelFindRouting.Candidate]) {
        var views: [PanelFindAnchorView] = []
        var candidates: [PanelFindRouting.Candidate] = []
        for anchor in anchors.allObjects where anchor.window === window && anchor.target != nil && !anchor.isHiddenOrHasHiddenAncestor {
            let rect = anchor.convert(anchor.bounds, to: nil)
            guard rect.width > 1, rect.height > 1 else { continue }
            views.append(anchor)
            candidates.append(PanelFindRouting.Candidate(rect: rect, activeAt: anchor.activeAt))
        }
        return (views, candidates)
    }

    private func focusedPanel(in window: NSWindow) -> PanelFindAnchorView? {
        let (views, candidates) = candidates(in: window)
        let pick = PanelFindRouting.pick(candidates, click: lastClick[ObjectIdentifier(window)], responder: responderRect(in: window))
        return pick.map { views[$0] }
    }

    private func responderRect(in window: NSWindow) -> CGRect? {
        guard var view = window.firstResponder as? NSView else { return nil }
        // A text field's editor is shared by the window; the field it edits says where it is.
        if let editor = view as? NSTextView, editor.isFieldEditor, let field = editor.delegate as? NSView {
            view = field
        }
        guard view.window === window else { return nil }
        return view.convert(view.bounds, to: nil)
    }

    private func consumes(_ event: NSEvent) -> Bool {
        guard modals == 0, let window = event.window else { return false }
        let flags = event.modifierFlags.intersection([.command, .shift, .option, .control])
        let key = event.charactersIgnoringModifiers?.lowercased()
        if flags == .command, key == "f" {
            return find(in: window)
        }

        if key == "g", flags == .command || flags == [.command, .shift] {
            return step(in: window, forward: flags == .command)
        }

        if flags.isEmpty, event.keyCode == 53 {
            return escape(in: window)
        }

        return false
    }

    private func find(in window: NSWindow) -> Bool {
        guard let anchor = focusedPanel(in: window), let target = anchor.target else { return false }
        anchor.activeAt = Date().timeIntervalSinceReferenceDate
        switch target {
        case .panel(let find):
            find.open()
            return true
        case .native(let scope, let onFind):
            HubPerf.log("find.panel.native \(scope)")
            guard let onFind else { return false }
            onFind()
            return true
        }
    }

    private func step(in window: NSWindow, forward: Bool) -> Bool {
        guard let anchor = focusedPanel(in: window), case .panel(let find) = anchor.target, find.isOpen else { return false }
        if forward { find.next() } else { find.previous() }
        return true
    }

    private func escape(in window: NSWindow) -> Bool {
        guard let anchor = focusedPanel(in: window), case .panel(let find) = anchor.target, find.isOpen else { return false }
        // Esc in another text field (a note, a reply) belongs to that field.
        if let editor = window.firstResponder as? NSTextView, editor.isEditable, !find.fieldFocused {
            return false
        }

        find.close()
        return true
    }
}
