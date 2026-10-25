import SwiftUI

public struct NativeSettingsCard<Content: View>: View {
    @Environment(\.nativeSettingsSearchCard) private var searchCard
    private let title: String?
    private let subtitle: String?
    private let content: Content

    public init(_ title: String? = nil, subtitle: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.content = content()
    }

    public var body: some View {
        let card = VStack(alignment: .leading, spacing: 16) {
            if let title {
                VStack(alignment: .leading, spacing: 5) {
                    Text(title).font(.system(size: 13, weight: .semibold))
                    if let subtitle { Text(subtitle).font(.system(size: 11)).foregroundStyle(.secondary) }
                }
            }
            content.environment(\.nativeSettingsSearchCard, title ?? searchCard)
        }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
            .nativeGlassSurface()
        // A titled card is a place the settings search finds and flashes (NativeSettingsSearch.swift).
        if let title {
            card.nativeSettingsSearchable(NativeSettingsSearchEntry(kind: .card, title: title, detail: subtitle), cornerRadius: 22)
        } else {
            card
        }
    }
}

public struct NativeSettingsRow<Accessory: View>: View {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.nativeSettingsSearchCard) private var searchCard
    private let title: String
    private let detail: String?
    private let accessory: Accessory

    public init(_ title: String, detail: String? = nil, @ViewBuilder accessory: () -> Accessory) {
        self.title = title
        self.detail = detail
        self.accessory = accessory()
    }

    public var body: some View {
        HStack(spacing: 24) {
            VStack(alignment: .leading, spacing: 5) {
                // A disabled row's title goes secondary; its detail stays readable, since it usually says why. An enabled
                // title keeps the style it inherits (white on a gradient card).
                if isEnabled {
                    Text(title).font(.system(size: 13, weight: .medium))
                } else {
                    Text(title).font(.system(size: 13, weight: .medium)).foregroundStyle(.secondary)
                }
                if let detail {
                    Text(detail).font(.system(size: 11)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
            accessory
        }
        .nativeSettingsSearchable(NativeSettingsSearchEntry(kind: .row, title: title, detail: detail, card: searchCard),
                                  cornerRadius: 10, outset: 8)
    }
}

public struct NativeSettingsToggle: View {
    private let title: String
    private let detail: String?
    private let identifier: String?
    @Binding private var value: Bool

    public init(_ title: String, detail: String? = nil, identifier: String? = nil, isOn: Binding<Bool>) {
        self.title = title
        self.detail = detail
        self.identifier = identifier
        _value = isOn
    }

    public var body: some View {
        NativeSettingsRow(title, detail: detail) {
            Toggle(title, isOn: $value).labelsHidden().toggleStyle(.switch).controlSize(.small)
                .nativeSettingsDisabledLook()
                .accessibilityIdentifier(identifier ?? "settings.toggle.\(title)")
        }
    }
}

public struct NativeSettingsPageIcon: View {
    private let symbol: String
    private let tint: Color
    private let size: CGFloat

    public init(symbol: String, tint: Color, size: CGFloat = 28) {
        self.symbol = symbol
        self.tint = tint
        self.size = size
    }

    public var body: some View {
        Image(systemName: symbol).font(.system(size: size * 0.5, weight: .semibold))
            .foregroundStyle(.white).frame(width: size, height: size)
            .background(tint.gradient, in: RoundedRectangle(cornerRadius: size * 0.26))
            .overlay(RoundedRectangle(cornerRadius: size * 0.26).stroke(.white.opacity(0.16), lineWidth: 0.5))
            .accessibilityHidden(true)
    }
}

@MainActor
public struct FeatureSettingsView: View {
    @ObservedObject private var store: NativeSettingsStore
    @ObservedObject private var appearance: NativeSettingsAppearance
    @Environment(\.accessibilityReduceMotion) private var systemStill
    /// What the settings search knows of each page. Held, not observed: a page that reports its cards and rows redraws
    /// the result list, never this window and the page on screen.
    @State private var search = NativeSettingsSearchIndex()
    private let title: String

    public init(store: NativeSettingsStore, title: String = "Settings") {
        self.store = store
        self.appearance = store.appearance
        self.title = title
    }

    public var body: some View {
        HStack(spacing: 0) {
            NativeSettingsSidebar(store: store, appearance: appearance, search: search, title: title)
            Rectangle().fill(.white.opacity(0.075)).frame(width: 1)
            VStack(alignment: .leading, spacing: 0) {
                if let page = store.selectedPage {
                    HStack(spacing: 13) {
                        NativeSettingsPageIcon(symbol: page.symbol, tint: page.tint, size: 36)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(page.title).font(.system(size: 24, weight: .semibold))
                            if !page.subtitle.isEmpty {
                                Text(page.subtitle).font(.system(size: 12)).foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 0)
                    }.padding(.horizontal, 28).padding(.top, 24).padding(.bottom, 23)
                    NativeSettingsPageScroll(
                        page: page, catalogError: store.catalogError, search: search,
                        still: systemStill || appearance.reduceMotion)
                } else {
                    VStack(spacing: 12) {
                        Image(systemName: "slider.horizontal.3").font(.system(size: 34)).foregroundStyle(.secondary)
                        Text(store.catalogError?.description ?? "Choose a feature to see its settings.")
                            .font(.system(size: 14)).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .titlebarBackground(NativeSettingsBackdrop())
        .titlebarZone()
        .frame(minWidth: 860, minHeight: 650)
        .environmentObject(store)
        .environmentObject(appearance)
        .nativeSettingsAppearance(appearance)
        .preferredColorScheme(.dark)
    }
}

/// The page on screen. It keeps the search's entries for the page current, and brings the card or row a search result
/// or a link asked for into view while it flashes.
@MainActor
private struct NativeSettingsPageScroll: View {
    let page: NativeSettingsPage
    let catalogError: NativeSettingsCatalogError?
    let search: NativeSettingsSearchIndex
    let still: Bool
    @ObservedObject private var center = NativeSettingsHighlightCenter.shared

    var body: some View {
        let id = page.id
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let error = catalogError {
                        Label(error.description, systemImage: "exclamationmark.triangle")
                            .font(.system(size: 12)).foregroundStyle(.orange)
                    }
                    page.content()
                        .environment(\.nativeSettingsPageID, id)
                        .onPreferenceChange(NativeSettingsSearchKey.self) { entries in
                            MainActor.assumeIsolated {
                                let had = search.entries[id].map(holdsTarget) ?? false
                                search.set(id, entries)
                                // A card drawn after its page loaded its settings: scroll once it is there.
                                if !had, holdsTarget(entries) { Task { await reveal(proxy) } }
                            }
                        }
                }.padding(.horizontal, 28).padding(.bottom, 28)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .task(id: center.token) { await reveal(proxy) }
        }
        .id(id)
    }

    private func holdsTarget(_ entries: [NativeSettingsSearchEntry]) -> Bool {
        guard let anchor = center.anchor else { return false }
        return entries.contains { NativeSettingsSearch.anchor(page: page.id, key: $0.key) == anchor }
    }

    /// Only a fresh request scrolls: a page visited again later stays where its reader left it.
    private func reveal(_ proxy: ScrollViewProxy) async {
        guard center.anchor != nil, let at = center.requestedAt, Date().timeIntervalSince(at) < 2 else { return }
        try? await Task.sleep(for: .milliseconds(80))
        guard let anchor = center.anchor else { return }
        let place = UnitPoint(x: 0.5, y: 0.15)
        if still {
            proxy.scrollTo(anchor, anchor: place)
        } else {
            withAnimation(.easeInOut(duration: 0.25)) { proxy.scrollTo(anchor, anchor: place) }
        }
    }
}

/// The page list, and the search field above it. While the field holds text, its results take the list's place.
@MainActor
private struct NativeSettingsSidebar: View {
    @ObservedObject var store: NativeSettingsStore
    @ObservedObject var appearance: NativeSettingsAppearance
    let search: NativeSettingsSearchIndex
    let title: String
    @Environment(\.accessibilityReduceMotion) private var systemStill
    @Namespace private var navigation
    @State private var query = ""
    @FocusState private var searchFocused: Bool
    /// The hidden copy of the other pages is drawn: from a search that starts while a page is still unknown, until the
    /// field is empty again. Later searches use what it learned.
    @State private var indexing = false

    private var searching: Bool { !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "slider.horizontal.3").font(.system(size: 19, weight: .medium))
                    .foregroundStyle(.white.opacity(0.7))
                Text(title).font(.system(size: 24, weight: .semibold, design: .rounded))
            }.padding(.horizontal, 24).padding(.top, 28).padding(.bottom, 14)
            NativeSettingsSearchField(query: $query, focused: $searchFocused, submit: openFirst)
                .padding(.horizontal, 12).padding(.bottom, 12)
            // The list scrolls under the header with a visible scroller and room after the last row, so the last
            // page is never hidden behind a footer (it was: "Providers" sat half cut above one in a 760 pt window).
            ScrollView {
                Group {
                    if searching {
                        NativeSettingsSearchResults(
                            query: query, store: store, search: search, open: open,
                            clear: {
                                query = ""
                                searchFocused = true
                            })
                    } else {
                        VStack(alignment: .leading, spacing: 12) {
                            ForEach(store.sections) { section in
                                VStack(alignment: .leading, spacing: 1) {
                                    if !section.title.isEmpty {
                                        Text(section.title).font(.system(size: 11, weight: .semibold)).foregroundStyle(
                                            .secondary
                                        )
                                        .padding(.horizontal, 10).padding(.bottom, 4)
                                    }
                                    ForEach(section.pages) { page in navigationRow(page) }
                                }
                            }
                        }
                    }
                }.padding(.horizontal, 12).padding(.top, 2).padding(.bottom, 16)
            }
            .scrollIndicators(.automatic)
        }.frame(width: 238)
            .titlebarBackground(Color.white.opacity(0.025))
            .background(alignment: .topLeading) {
                if indexing { NativeSettingsSearchIndexer(store: store, search: search) }
            }
            .onChange(of: searching) { _, now in
                if !now {
                    indexing = false
                } else if store.sections.flatMap(\.pages).contains(where: { !search.knows($0.id) && $0.id != store.selectedPageID }) {
                    indexing = true
                }
            }
    }

    /// A page, or a card or row on it: the page opens, scrolls there, and flashes it.
    private func open(_ result: NativeSettingsSearchResult) {
        store.select(pageID: result.target)
    }

    private func openFirst() {
        let pages = NativeSettingsSearchResults.pages(store)
        if let first = NativeSettingsSearch.results(query, pages: pages, entries: search.entries).first { open(first) }
    }

    private func navigationRow(_ page: NativeSettingsPage) -> some View {
        let selected = store.selectedPageID == page.id
        return Button {
            if systemStill || appearance.reduceMotion {
                store.select(pageID: page.id)
            } else {
                withAnimation(.easeInOut(duration: 0.18)) { _ = store.select(pageID: page.id) }
            }
        } label: {
            HStack(spacing: 10) {
                NativeSettingsPageIcon(symbol: page.symbol, tint: page.tint, size: 22)
                Text(page.title).font(.system(size: 13, weight: selected ? .semibold : .regular))
                    .lineLimit(1)
                Spacer(minLength: 0)
            }.padding(.horizontal, 10).padding(.vertical, 5).contentShape(Rectangle())
        }.buttonStyle(.genHoverRow())
            .background {
                if selected {
                    RoundedRectangle(cornerRadius: 10).fill(.white.opacity(0.09))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(.white.opacity(0.08), lineWidth: 0.5))
                        .matchedGeometryEffect(id: "settings.selection", in: navigation)
                }
            }
            .accessibilityIdentifier("settings.page.\(page.id)")
            .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
