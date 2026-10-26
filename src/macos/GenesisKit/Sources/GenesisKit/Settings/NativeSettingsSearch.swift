import SwiftUI

// The settings window's search (H4): one field above the page list finds a setting on any page by its card title, its
// row title or its detail, and a click opens the page there and flashes the card or row.
//
// Pages are views, not data, so the search learns their cards and rows from what they draw: each titled
// `NativeSettingsCard` and each `NativeSettingsRow` reports itself through a preference, the page on screen keeps its
// entries current, and the first search of a window draws every other page once, hidden, to learn theirs.

/// One thing the search finds on a page: a titled card or a row, with the words it shows.
public struct NativeSettingsSearchEntry: Equatable, Sendable {
    public enum Kind: String, Sendable { case card, row }

    public let kind: Kind
    public let title: String
    public let detail: String?
    /// The titled card a row sits in.
    public var card: String?

    public init(kind: Kind, title: String, detail: String? = nil, card: String? = nil) {
        self.kind = kind
        self.title = title
        self.detail = detail
        self.card = card
    }

    /// The entry's name on its page. A row's names its card too: one row title can repeat in several cards (every
    /// background task has a Schedule row), and each must be its own result and jump target.
    var key: String { "\(kind.rawValue):\(card.map { "\($0)/" } ?? "")\(title)" }
}

/// A settings page as the search sees it: its words, without its views.
public struct NativeSettingsSearchPage: Equatable, Sendable {
    public let id: String
    public let title: String
    public let subtitle: String
    public let section: String

    public init(id: String, title: String, subtitle: String = "", section: String = "") {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.section = section
    }
}

/// One result: what the list shows, and where a click goes (`<page>` or `<page>#<anchor>`).
public struct NativeSettingsSearchResult: Identifiable, Equatable, Sendable {
    public let target: String
    public let title: String
    public let context: String
    public var id: String { target }
}

public enum NativeSettingsSearch {
    /// The anchor of a card or row on a page, as a jump requests it and the card or row answers to it.
    static func anchor(page: String, key: String) -> String { "search/\(page)/\(key)" }

    /// The results for `query`, best first. Every word of the query must appear in the result's title, its detail, its
    /// card or its page. A title that starts with the query ranks first, then one that contains it, then one that holds
    /// every word, then a match in the other words; within a rank the sidebar's order holds. Case and accents are
    /// ignored.
    public static func results(
        _ query: String, pages: [NativeSettingsSearchPage], entries: [String: [NativeSettingsSearchEntry]], limit: Int = 60
    ) -> [NativeSettingsSearchResult] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return [] }
        let words = needle.split(whereSeparator: \.isWhitespace).map(String.init)
        func found(_ fields: [String?]) -> Bool {
            words.allSatisfy { word in fields.contains { $0?.localizedStandardContains(word) == true } }
        }
        func rank(_ title: String) -> Int {
            if title.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive, .anchored]) != nil { return 0 }
            if title.localizedStandardContains(needle) { return 1 }
            return found([title]) ? 2 : 3
        }
        var ranked: [(rank: Int, order: Int, result: NativeSettingsSearchResult)] = []
        var seen: Set<String> = []
        func add(_ result: NativeSettingsSearchResult) {
            guard seen.insert(result.target).inserted else { return }
            ranked.append((rank(result.title), ranked.count, result))
        }
        for page in pages {
            if found([page.title, page.subtitle, page.section]) {
                add(NativeSettingsSearchResult(
                    target: page.id, title: page.title, context: page.section.isEmpty ? page.subtitle : page.section))
            }
            for entry in entries[page.id] ?? [] where found([entry.title, entry.detail, entry.card, page.title]) {
                let context = entry.card.map { $0 == entry.title ? page.title : "\(page.title) · \($0)" } ?? page.title
                add(NativeSettingsSearchResult(
                    target: "\(page.id)#\(anchor(page: page.id, key: entry.key))", title: entry.title, context: context))
            }
        }
        return ranked.sorted { ($0.rank, $0.order) < ($1.rank, $1.order) }.prefix(limit).map(\.result)
    }
}

/// What the search knows of each page, by page id. Not observed by the window itself, so a page that reports its
/// entries redraws only the result list.
@MainActor
final class NativeSettingsSearchIndex: ObservableObject {
    @Published private(set) var entries: [String: [NativeSettingsSearchEntry]] = [:]

    func set(_ page: String, _ list: [NativeSettingsSearchEntry]) {
        if entries[page] != list { entries[page] = list }
    }

}

struct NativeSettingsSearchKey: PreferenceKey {
    static let defaultValue: [NativeSettingsSearchEntry] = []

    static func reduce(value: inout [NativeSettingsSearchEntry], nextValue: () -> [NativeSettingsSearchEntry]) {
        value.append(contentsOf: nextValue())
    }
}

extension EnvironmentValues {
    /// The settings page a card or row is drawn on; nil outside the settings window.
    @Entry var nativeSettingsPageID: String? = nil
    /// The title of the titled card a row is drawn in, so the row's search key and its jump target name the card.
    @Entry var nativeSettingsSearchCard: String? = nil
    /// True in the hidden copy of the pages the search reads: nothing there flashes, and a page's own code must not
    /// speak (`GenAnnounce`) or ask for anything, since nobody sees it.
    @Entry public var nativeSettingsIndexing = false
}

/// A card or row the search can jump to: when a jump names it, it flashes, and its marker is what the page scrolls to.
private struct NativeSettingsSearchTarget: ViewModifier {
    let key: String
    let cornerRadius: CGFloat
    let outset: CGFloat
    @Environment(\.nativeSettingsPageID) private var page
    @Environment(\.nativeSettingsIndexing) private var indexing
    @ObservedObject private var center = NativeSettingsHighlightCenter.shared

    func body(content: Content) -> some View {
        content.overlay {
            if !indexing, let page, let anchor = center.anchor, anchor == NativeSettingsSearch.anchor(page: page, key: key) {
                Color.clear
                    .padding(-outset)
                    .attentionPulse(
                        trigger: center.token,
                        style: .borderFlash(color: .accentColor, cornerRadius: cornerRadius),
                        since: center.requestedAt
                    )
                    .id(anchor)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
    }
}

extension View {
    /// Reports a card or row to the settings search and makes it a jump target.
    func nativeSettingsSearchable(_ entry: NativeSettingsSearchEntry, cornerRadius: CGFloat, outset: CGFloat = 0) -> some View {
        modifier(NativeSettingsSearchTarget(key: entry.key, cornerRadius: cornerRadius, outset: outset))
            .transformPreference(NativeSettingsSearchKey.self) { entries in
                if entry.kind == .card {
                    for index in entries.indices where entries[index].card == nil { entries[index].card = entry.title }
                    entries.insert(entry, at: 0)
                } else {
                    entries.append(entry)
                }
            }
    }
}

/// Every page but the one on screen, drawn once and hidden while a search runs, so the search learns their cards and
/// rows. Their own loads run as if each page had been opened; nothing is drawn, hit or read by VoiceOver.
struct NativeSettingsSearchIndexer: View {
    @ObservedObject var store: NativeSettingsStore
    let search: NativeSettingsSearchIndex

    var body: some View {
        ZStack(alignment: .topLeading) {
            ForEach(store.sections.flatMap(\.pages).filter { $0.id != store.selectedPageID }) { page in
                let id = page.id
                page.content()
                    .environment(\.nativeSettingsPageID, id)
                    .onPreferenceChange(NativeSettingsSearchKey.self) { entries in
                        MainActor.assumeIsolated { search.set(id, entries) }
                    }
            }
        }
        .environment(\.nativeSettingsIndexing, true)
        .frame(width: 620)
        .fixedSize(horizontal: false, vertical: true)
        .hidden()
        .disabled(true)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// The search field and its results, in the sidebar above the page list. Return opens the first result, Esc empties
/// the field, ⌘F puts the cursor in it.
struct NativeSettingsSearchField: View {
    @Binding var query: String
    let focused: FocusState<Bool>.Binding
    let submit: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass").font(.system(size: 12)).foregroundStyle(.secondary)
                .accessibilityHidden(true)
            TextField("Search settings", text: $query)
                .textFieldStyle(.plain)
                .font(.system(size: 13))
                .focused(focused)
                .onSubmit(submit)
                .onExitCommand { query = "" }
                .accessibilityIdentifier("settings.search")
            if !query.isEmpty {
                IconButton(systemName: "xmark.circle.fill", tooltip: "Clear the search", size: 11) {
                    query = ""
                    focused.wrappedValue = true
                }
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 30)
        .background(RoundedRectangle(cornerRadius: 8).fill(.white.opacity(0.05)))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(.white.opacity(0.1), lineWidth: 0.5))
        .background {
            Button("Search settings") { focused.wrappedValue = true }
                .keyboardShortcut("f", modifiers: .command)
                .opacity(0)
                .frame(width: 0, height: 0)
                .accessibilityHidden(true)
        }
    }
}

/// The results of a search, in the place of the page list.
struct NativeSettingsSearchResults: View {
    let query: String
    @ObservedObject var store: NativeSettingsStore
    @ObservedObject var search: NativeSettingsSearchIndex
    let open: (NativeSettingsSearchResult) -> Void
    let clear: () -> Void

    static func pages(_ store: NativeSettingsStore) -> [NativeSettingsSearchPage] {
        store.sections.flatMap { section in
            section.pages.map {
                NativeSettingsSearchPage(id: $0.id, title: $0.title, subtitle: $0.subtitle, section: section.title)
            }
        }
    }

    var body: some View {
        let results = NativeSettingsSearch.results(query, pages: Self.pages(store), entries: search.entries)
        VStack(alignment: .leading, spacing: 1) {
            if results.isEmpty {
                EmptyState(
                    symbol: "magnifyingglass",
                    text: "No setting matches “\(query.trimmingCharacters(in: .whitespacesAndNewlines))”.",
                    actionTitle: "Clear the search", action: clear)
            } else {
                Text(Plural.count(results.count, "result"))
                    .font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                    .padding(.horizontal, 10).padding(.bottom, 4)
                    .accessibilityAddTraits(.isHeader)
                ForEach(results) { result in
                    Button { open(result) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(result.title).font(.system(size: 13)).lineLimit(2)
                            if !result.context.isEmpty {
                                Text(result.context).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 10).padding(.vertical, 5).contentShape(Rectangle())
                    }
                    .buttonStyle(.genHoverRow())
                    .instantTooltip(result.context.isEmpty ? "Open \(result.title)" : "Open \(result.title) in \(result.context)")
                    .accessibilityIdentifier("settings.search.result.\(result.target)")
                }
            }
        }
    }
}
