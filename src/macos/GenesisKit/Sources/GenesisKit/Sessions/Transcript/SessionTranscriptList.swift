//
//  SessionTranscriptList.swift
//  Genesis
//
//  The conversation view of the Session Details window: a search and filter bar, then a
//  `List` of prompt sections whose headers float (the sticky turn separator). One row per
//  prompt, reply, thinking block and tool call; tool calls and thinking are one line until
//  expanded.
//
//  Perf contract (kept from the previous transcript, measured 2026-08-28): rows live in a
//  `List`, which on macOS is an NSTableView with row recycling, so only visible rows exist.
//  A LazyVStack realised rows without releasing them and locked into a re-measure loop at
//  98% CPU when ~200 rows collapsed. Rows are Equatable value views: they read precomputed
//  fields only, and expansion lives in `TranscriptExpansion` because recycled rows lose @State.
//
//  One copy for both apps (GenesisKit, 2026-09-30). The host supplies the markdown renderer
//  (`GenesisKitHost.transcriptMarkdown`), the tool rows' services (`TranscriptServices`), and may
//  drive the tool filter and reveals (`TranscriptFilters`, `TranscriptBus`). Outside a following
//  chat, `TranscriptScrollAnchor` holds the rows on screen while earlier turns are prepended.
//

import AppKit
import SwiftUI

public enum TranscriptLoadState: Equatable {
    case loading
    case loaded
    case failed(String)
}

public struct TranscriptPreset: Equatable {
    public var chips: Set<TranscriptFilter> = []
    public var query = ""
    public var expanded: Set<String> = []
    /// A row id to open at instead of the latest turn.
    public var scrollTo: String?
    /// Overrides the stored verbosity (snapshots).
    public var verbosity: TranscriptVerbosity?
    /// Open as if the prompt arrows had been pressed to this 0-based prompt.
    public var jumpToPrompt: Int?

    public init(
        chips: Set<TranscriptFilter> = [],
        query: String = "",
        expanded: Set<String> = [],
        scrollTo: String? = nil,
        verbosity: TranscriptVerbosity? = nil,
        jumpToPrompt: Int? = nil
    ) {
        self.chips = chips
        self.query = query
        self.expanded = expanded
        self.scrollTo = scrollTo
        self.verbosity = verbosity
        self.jumpToPrompt = jumpToPrompt
    }
}

/// Which collapsible rows are open. A row is open when `all` (Expand all / Collapse all) or its
/// default says so, flipped when the reader toggled it since.
@MainActor
public final class TranscriptExpansion: ObservableObject {
    @Published private(set) var toggled: Set<String> = []
    @Published private(set) var all: Bool?

    public init() {}

    public func isOpen(_ id: String, byDefault open: Bool = false) -> Bool {
        (all ?? open) != toggled.contains(id)
    }

    /// A row the reader opened by hand shows its whole input and output (Martin, 2026-09-28: "show
    /// me the entire input … the entire output"); a row open by its level's default or by Expand all
    /// stays trimmed. Its "… +N lines" / "Show fewer lines" (`id#all`) flips either one.
    public func showsAll(_ id: String, byDefault open: Bool) -> Bool {
        let openedByHand = toggled.contains(id) && isOpen(id, byDefault: open)
        return toggled.contains(id + "#all") != openedByHand
    }

    public func expand(_ more: Set<String>) {
        toggled.formUnion(more)
    }

    public func toggle(_ id: String) {
        if toggled.contains(id) {
            toggled.remove(id)
        } else {
            toggled.insert(id)
        }
    }

    public func setAll(_ open: Bool?) {
        all = open
        toggled = []
    }
}

public struct SessionTranscriptList: View {
    public let document: TranscriptDocument
    public let provider: AIProviderMeta
    public let modelName: String?
    public let loadState: TranscriptLoadState
    public let hasEarlier: Bool
    public let loadingEarlier: Bool
    /// `Turns 190–269 of 269`, or nil when the whole session is loaded.
    public let windowNote: String?
    public let onLoadEarlier: () -> Void
    /// Starting filter, query, expanded rows and scroll target. Snapshot tests and previews use it;
    /// the window opens with the default (everything, collapsed, at the latest turn).
    public var preset = TranscriptPreset()
    /// Session file, change log and host actions for the tool rows.
    public var services: TranscriptServices = .none
    /// A live conversation (the chat): new rows scroll into view while the reader is at the end,
    /// and a "Latest" button appears once they scrolled away.
    public var followsLatest = false
    public var emptyMessage = "No turns in this session file."

    public init(
        document: TranscriptDocument,
        provider: AIProviderMeta,
        modelName: String?,
        loadState: TranscriptLoadState,
        hasEarlier: Bool,
        loadingEarlier: Bool,
        windowNote: String?,
        onLoadEarlier: @escaping () -> Void,
        preset: TranscriptPreset = TranscriptPreset(),
        services: TranscriptServices = .none,
        followsLatest: Bool = false,
        emptyMessage: String = "No turns in this session file."
    ) {
        self.document = document
        self.provider = provider
        self.modelName = modelName
        self.loadState = loadState
        self.hasEarlier = hasEarlier
        self.loadingEarlier = loadingEarlier
        self.windowNote = windowNote
        self.onLoadEarlier = onLoadEarlier
        self.preset = preset
        self.services = services
        self.followsLatest = followsLatest
        self.emptyMessage = emptyMessage
    }

    /// Persisted: the reader picks a level once, not per window.
    @AppStorage("sessionTranscript.verbosity") private var verbosityRaw = TranscriptVerbosity.inputs.rawValue
    /// Line wrapping in tool calls, per block kind (`TranscriptWrap`).
    @AppStorage("sessionTranscript.wrapInputs") private var wrapInputs = false
    @AppStorage("sessionTranscript.wrapOutputs") private var wrapOutputs = false
    @State private var query = ""
    @State private var appliedQuery = ""
    @State private var chips: Set<TranscriptFilter> = []
    @State private var visible: [TranscriptSection] = []
    @State private var promptIds: [String] = []
    @State private var promptCursor: Int?
    @State private var scrollTarget: ScrollRequest?
    @State private var didInitialScroll = false
    /// Whether the reader is at the latest row; a live transcript follows new rows only then, never
    /// pulling a reader who scrolled up. Only a following chat (`followsLatest`) reads it, from scroll
    /// geometry, because a reply that grows pushes the end marker off screen while the reader is still at
    /// the end; before macOS 15 from the last section's end marker. Session Details uses `anchor.atEnd`.
    @State private var atLatest = true
    /// The chat's scroll-geometry tracking (`LatestTracker`) needs macOS 15. Before that a following
    /// chat keeps the end-marker tracking and the scroll anchor, so a reader who scrolls up is still seen.
    private var tracksLatestByGeometry: Bool {
        guard followsLatest else { return false }
        if #available(macOS 15, *) { return true }
        return false
    }
    // The end marker of the newest section (see `atLatest`).
    private var latestEndMarker: String? { visible.last.map { Self.endMarker($0.id) } }
    /// Holds the rows on screen still while earlier turns are prepended, and keeps a reader at the
    /// latest turn there as rows grow (`TranscriptScrollAnchor`). Not in a following chat
    /// (`followsLatest`), which follows by its own scroll geometry.
    @StateObject private var anchor = TranscriptScrollAnchor()
    @StateObject private var expansion = TranscriptExpansion()
    /// A host's tool filter for this session (GenesisTools: the sidebar's tool analytics), and its
    /// requests to show a row (`TranscriptBus`). A reveal for a row the document does not hold yet
    /// waits here until the host's window load brings it.
    @ObservedObject private var filters = TranscriptFilters.shared
    @State private var pendingReveal: String?
    /// A reveal is clearing the filters and is about to scroll to its own row; the `onChange`
    /// handlers those clears trigger must not schedule a competing `.firstHit` scroll to the bottom in
    /// between (`Self.scroll`'s 120 ms / 350 ms retries could land after the reveal's).
    @State private var revealing = false
    /// Rows a live session appended in the last change: they fade in (`RowArrival`). Set in the same
    /// pass as `visible`, so no extra list render.
    @State private var arriving: Set<String> = []
    /// Rows appended while the reader was scrolled up: the "N new" pill (`NewItemsPill`).
    @State private var unseen = 0

    private var toolFilter: String? { filters.tool(for: services.sessionId) }
    @FocusState private var searchFocused: Bool

    private struct ScrollRequest: Equatable {
        let id: String
        let anchor: UnitPoint
        let serial: Int
    }

    public var body: some View {
        let _ = RenderProbe.hit("list.body")
        VStack(spacing: 0) {
            toolbar
            Rectangle().fill(SessionPalette.hairline).frame(height: 1)
            content
        }
        .background(SessionPalette.background)
        .task(id: query) {
            // Debounced: filtering a few thousand rows is cheap, doing it per keystroke is not free.
            if !query.isEmpty {
                try? await Task.sleep(nanoseconds: 140_000_000)
            }
            guard !Task.isCancelled else { return }
            appliedQuery = query
        }
        .onAppear {
            if preset != TranscriptPreset() {
                chips = preset.chips
                if let level = preset.verbosity { verbosityRaw = level.rawValue }
                query = preset.query
                appliedQuery = preset.query
                expansion.expand(preset.expanded)
            }
            recompute(.preserve)
        }
        .onChange(of: document) {
            recompute(.preserve, documentChanged: true)
            // A reveal that waited for this document.
            if let pending = pendingReveal, TranscriptBus.contains(pending, in: document.sections) {
                pendingReveal = nil
                reveal(pending)
            }
        }
        .onChange(of: chips) { if !revealing { recompute(.firstHit) } }
        .onChange(of: toolFilter) { if !revealing { recompute(.firstHit) } }
        .onReceive(NotificationCenter.default.publisher(for: TranscriptBus.list)) { note in
            if case .reveal(let rowId)? = TranscriptBus.message(note, for: TranscriptBus.list, sessionId: services.sessionId) {
                reveal(rowId)
            }
        }
        .onChange(of: verbosityRaw) {
            // A new level resets what the reader opened or closed by hand.
            expansion.setAll(nil)
            recompute(.preserve)
        }
        .onChange(of: appliedQuery) {
            // Tell the host, which searches the whole session.
            services.onQuery?(appliedQuery)
            if !revealing { recompute(.firstHit) }
        }
        // The host's services arrive after the first page, so a query applied
        // before that (a preset, fast typing) is sent again once they exist.
        .onChange(of: ObjectIdentifier(services)) {
            if !appliedQuery.isEmpty {
                services.onQuery?(appliedQuery)
            }
        }
    }

    // MARK: Toolbar

    /// One row when it fits; in a narrow pane (the hub's side-by-side panes) the search field takes
    /// its own row and the controls wrap below it, instead of the whole screen clipping.
    private var toolbar: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                searchField
                toolbarControls
            }
            .padding(.horizontal, 16)
            .frame(height: 40)
            VStack(alignment: .leading, spacing: 6) {
                searchField
                HStack(spacing: 10) {
                    toolbarControls
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            // A third layout for a hub pane of about 440 pt, where the row
            // above was still wider than the column and clipped at both edges (audit 2026-09-24).
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    searchField
                    Spacer(minLength: 4)
                    promptNavigator
                }
                HStack(spacing: 8) {
                    chipBar
                    verbosityMenu
                    expandButtons
                    wrapMenu
                    Spacer(minLength: 0)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
    }

    private var searchField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 11))
                .foregroundStyle(SessionPalette.dim)
            TextField("Search transcript", text: $query)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .focused($searchFocused)
                .onSubmit { jump(1) }
                .accessibilityIdentifier("session-transcript-search")
            if !query.isEmpty {
                Text(verbatim: "\(matchCount)")
                    .font(SessionPalette.mono(10.5))
                    .foregroundStyle(SessionPalette.dim)
                Button {
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(SessionPalette.dim)
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip("Clear the search")
                .accessibilityIdentifier("session-transcript-search-clear")
            }
        }
        .padding(.horizontal, 9)
        .frame(height: 26)
        .frame(minWidth: 150, maxWidth: 300)
        .layoutPriority(1)
        .background(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(SessionPalette.hairline))
        .background(
            // ⌘F focuses the search field from anywhere in the window.
            Button("") { searchFocused = true }
                .keyboardShortcut("f", modifiers: .command)
                .opacity(0)
                .accessibilityHidden(true)
        )
    }

    @ViewBuilder
    private var toolbarControls: some View {
        chipBar

        verbosityMenu

        expandButtons

        wrapMenu

        Spacer(minLength: 8)

        if let windowNote {
            // Dropped, not truncated, when the window is too narrow for it.
            ViewThatFits(in: .horizontal) {
                Text(verbatim: windowNote)
                    .font(.system(size: 11))
                    .foregroundStyle(SessionPalette.dim)
                    .fixedSize()
                Color.clear.frame(width: 0, height: 0)
            }
        }

        promptNavigator
    }

    /// "All" plus one toggle chip per filter. Several chips can be on (Chat + Errors); turning the
    /// last one off, or pressing All, shows everything again.
    private var chipBar: some View {
        HStack(spacing: 4) {
            FilterChip(title: "All", isOn: chips.isEmpty) { chips = [] }
                .instantTooltip("Show every row")
                .accessibilityIdentifier("session-transcript-chip-all")
            ForEach(TranscriptFilter.allCases) { chip in
                FilterChip(title: chip.title, isOn: chips.contains(chip), tint: chip == .errors ? SessionPalette.red : SessionPalette.blue) {
                    if chips.contains(chip) {
                        chips.remove(chip)
                    } else {
                        chips.insert(chip)
                    }
                }
                .instantTooltip(chipTooltip(chip))
                .accessibilityIdentifier("session-transcript-chip-\(chip.rawValue)")
            }
            // The host's tool filter, cleared from here.
            if let toolFilter {
                FilterChip(title: "\(TranscriptDocument.displayName(toolFilter)) ✕", isOn: true, tint: SessionPalette.orange) {
                    filters.setTool(nil, for: services.sessionId)
                }
                .instantTooltip("Only \(toolFilter) calls in the loaded turns (set in the sidebar's Tools). Click to show every row")
                .accessibilityIdentifier("session-transcript-chip-tool")
            }
        }
        .fixedSize()
    }

    private func chipTooltip(_ chip: TranscriptFilter) -> String {
        switch chip {
        case .chat: return "Prompts, replies and thinking (combine with other chips)"
        case .tools: return "Tool calls (combine with other chips)"
        case .errors: return "Failed tool calls (combine with other chips)"
        }
    }

    private var verbosity: TranscriptVerbosity {
        TranscriptVerbosity(rawValue: verbosityRaw) ?? .inputs
    }

    // A drawn `MenuButton` (Genesis UI/MenuButton.swift, GenesisTools Hub/HubMenuButton.swift), not a `Menu`. The
    // toolbar is a ViewThatFits, which builds a new NSPopUpButton for every measurement of each of its three layouts.
    private var verbosityMenu: some View {
        MenuButton(style: .genHoverPlain(brighten: 0.12)) {
            TranscriptVerbosity.allCases.map { level in
                .action(level.title, checked: level == verbosity) { verbosityRaw = level.rawValue }
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: verbosity.symbol)
                    .font(.system(size: 10.5))
                Text(verbatim: verbosity.title)
                    .font(.system(size: 11.5, weight: .medium))
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .bold))
            }
            .foregroundStyle(SessionPalette.secondary)
            .padding(.horizontal, 9)
            .frame(height: 22)
            .overlay(Capsule().strokeBorder(SessionPalette.cardBorder))
            .contentShape(Capsule())
        }
        .fixedSize()
        .instantTooltip("Transcript detail: \(verbosity.detail)")
        .accessibilityIdentifier("session-transcript-verbosity")
    }

    private var expandButtons: some View {
        HStack(spacing: 2) {
            Button { expansion.setAll(true) } label: {
                Image(systemName: "arrow.up.and.down.text.horizontal")
                    .font(.system(size: 11, weight: .medium))
                    .frame(width: 20, height: 20)
            }
            .buttonStyle(.genHoverIcon(accent: SessionPalette.blue, diameter: 22))
            .instantTooltip("Expand all tool calls and thinking")
            .accessibilityIdentifier("session-transcript-expand-all")

            Button { expansion.setAll(false) } label: {
                Image(systemName: "arrow.down.and.line.horizontal.and.arrow.up")
                    .font(.system(size: 11, weight: .medium))
                    .frame(width: 20, height: 20)
            }
            .buttonStyle(.genHoverIcon(accent: SessionPalette.blue, diameter: 22))
            .instantTooltip("Collapse all tool calls and thinking")
            .accessibilityIdentifier("session-transcript-collapse-all")
        }
        .foregroundStyle(SessionPalette.secondary)
    }

    private var wrap: TranscriptWrap { TranscriptWrap(inputs: wrapInputs, outputs: wrapOutputs) }

    /// Line wrapping for tool inputs and outputs, each on its own (Martin, 2026-09-30: long commands
    /// were clipped sideways). Lit while either wraps.
    private var wrapMenu: some View {
        MenuButton(style: .genHoverIcon(accent: SessionPalette.blue, diameter: 22)) {
            [
                .action("Wrap tool inputs", checked: wrapInputs) { setWrap(inputs: !wrapInputs, outputs: wrapOutputs) },
                .action("Wrap tool outputs", checked: wrapOutputs) { setWrap(inputs: wrapInputs, outputs: !wrapOutputs) },
                .divider,
                .action("Wrap both", checked: wrapInputs && wrapOutputs) { setWrap(inputs: true, outputs: true) },
                .action("Wrap neither", checked: !wrap.any) { setWrap(inputs: false, outputs: false) },
            ]
        } label: {
            Image(systemName: "arrow.turn.down.left")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(wrap.any ? SessionPalette.blue : SessionPalette.secondary)
                .frame(width: 20, height: 20)
        }
        .fixedSize()
        .instantTooltip("Line wrapping in tool calls: \(wrap.detail)")
        .accessibilityLabel(Text("Line wrapping"))
        .accessibilityValue(Text(wrap.detail))
        .accessibilityIdentifier("session-transcript-wrap")
    }

    private func setWrap(inputs: Bool, outputs: Bool) {
        wrapInputs = inputs
        wrapOutputs = outputs
    }

    private var promptNavigator: some View {
        HStack(spacing: 4) {
            Button { jump(-1) } label: {
                Image(systemName: "chevron.up")
                    .font(.system(size: 10, weight: .semibold))
                    .frame(width: 20, height: 20)
            }
            .buttonStyle(.genHoverIcon(accent: SessionPalette.blue, diameter: 22))
            .keyboardShortcut("[", modifiers: .command)
            .disabled(promptIds.isEmpty)
            .instantTooltip("Previous prompt (⌘[)")
            .accessibilityIdentifier("session-transcript-prev-prompt")

            Text(verbatim: promptPosition)
                .font(SessionPalette.mono(11))
                .foregroundStyle(SessionPalette.dim)
                .fixedSize()
                .frame(minWidth: 44)

            Button { jump(1) } label: {
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .frame(width: 20, height: 20)
            }
            .buttonStyle(.genHoverIcon(accent: SessionPalette.blue, diameter: 22))
            .keyboardShortcut("]", modifiers: .command)
            .disabled(promptIds.isEmpty)
            .instantTooltip("Next prompt (⌘])")
            .accessibilityIdentifier("session-transcript-next-prompt")
        }
        .foregroundStyle(SessionPalette.secondary)
    }

    private var promptPosition: String {
        // A position only once the reader navigated: a scroll by hand moves away from any cursor.
        guard let cursor = promptCursor else {
            return "\(promptIds.count) prompt\(promptIds.count == 1 ? "" : "s")"
        }
        return "\(cursor + 1) / \(promptIds.count)"
    }

    /// Rows that hold the query. A prompt kept only as its section's context is not one.
    private var matchCount: Int {
        let needle = appliedQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return visible.reduce(0) { total, section in
            total + section.rows.filter { !$0.isPrompt || needle.isEmpty || $0.searchText.contains(needle) }.count
        }
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        switch loadState {
        case .loading where document.sections.isEmpty:
            placeholder {
                ProgressView().controlSize(.small)
                Text("Loading transcript…")
            }
        case .failed(let message) where document.sections.isEmpty:
            placeholder {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 22))
                    .foregroundStyle(SessionPalette.red)
                Text(verbatim: message)
                    .font(SessionPalette.mono(11.5))
                    .foregroundStyle(SessionPalette.red)
                    .multilineTextAlignment(.center)
                    .textSelection(.enabled)
            }
        default:
            if document.sections.isEmpty {
                placeholder {
                    Image(systemName: "text.bubble")
                        .font(.system(size: 22))
                        .foregroundStyle(SessionPalette.dim)
                    Text(verbatim: emptyMessage)
                }
            } else if visible.isEmpty {
                placeholder {
                    Image(systemName: "line.3.horizontal.decrease.circle")
                        .font(.system(size: 22))
                        .foregroundStyle(SessionPalette.dim)
                    Text("Nothing matches this filter.")
                }
            } else {
                // The List is the overlay of a flexible spacer, not a child of the stack, so its own
                // layout never reaches the views around it. Every row it realised, loaded or measured
                // while scrolling changed the List's layout, and as a direct child that re-laid out
                // the whole window each frame: the toolbar's ViewThatFits measured its three layouts
                // again, the header and the sidebar with it. Measured 2026-09-25 on a live session:
                // p95 175 ms of main thread per scrolled frame as a child, 17.7 ms as an overlay
                // (`SessionTranscriptScrollTests`). A separate NSHostingView was 200 ms and worse.
                Color.clear
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .overlay { list }
            }
        }
    }

    private func placeholder<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(spacing: 10, content: content)
            .font(.system(size: 12))
            .foregroundStyle(SessionPalette.dim)
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var list: some View {
        ScrollViewReader { proxy in
            List {
                // Jump target for the first prompt: the list top (see `jump`).
                ForEach(["top"], id: \.self) { id in marker(id) }
                if hasEarlier {
                    loadEarlierRow
                        .listRowInsets(EdgeInsets())
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
                ForEach(visible) { section in
                    Section {
                        // The end marker is an element of the same ForEach: `scrollTo` only finds
                        // rows by ForEach identity, and a static `.id` row in a List is not one.
                        ForEach(section.rows.map(ListItem.row) + [.end(Self.endMarker(section.id))]) { item in
                            switch item {
                            case .row(let row):
                                TranscriptRowView(
                                    row: row,
                                    provider: provider,
                                    modelName: modelName,
                                    verbosity: verbosity,
                                    expanded: expansion.isOpen(row.id, byDefault: defaultOpen(row)),
                                    // A row opened by hand, or the reader's own "… +N lines"
                                    // (`TranscriptExpansion.showsAll`): Expand all opens rows, it does
                                    // not untrim every output.
                                    showAll: expansion.showsAll(row.id, byDefault: defaultOpen(row)),
                                    openMembers: openMembers(row),
                                    fullMembers: fullMembers(row),
                                    wrap: wrap,
                                    services: services,
                                    onToggle: { expansion.toggle($0) }
                                )
                                .equatable()
                                .modifier(RowArrival(active: arriving.contains(row.id)))
                                .listRowInsets(EdgeInsets())
                                .listRowSeparator(.hidden)
                                .listRowBackground(Color.clear)
                            case .end(let id):
                                marker(id)
                                    // A following chat before macOS 15 has no scroll geometry (`tracksLatestByGeometry`).
                                    .onAppear { if followsLatest, !tracksLatestByGeometry, id == latestEndMarker { atLatest = true } }
                                    .onDisappear { if followsLatest, !tracksLatestByGeometry, id == latestEndMarker { atLatest = false } }
                            }
                        }
                    } header: {
                        TranscriptSectionHeader(section: section)
                            .listRowInsets(EdgeInsets())
                    }
                }
                Color.clear.frame(height: 12)
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            // Where the list is, for `anchor`.
            .background {
                if !tracksLatestByGeometry {
                    TranscriptScrollAnchorProbe(anchor: anchor)
                }
            }
            .environment(\.defaultMinListRowHeight, 1)
            .accessibilityIdentifier("session-transcript-list")
            .modifier(LatestTracker(enabled: followsLatest, atLatest: $atLatest))
            .overlay(alignment: .bottomTrailing) {
                if followsLatest, !atLatest {
                    latestButton(proxy)
                } else if !followsLatest, !anchor.atEnd, unseen > 0 {
                    NewItemsPill(count: unseen, noun: "new") {
                        unseen = 0
                        anchor.scrollToEnd()
                    }
                    .padding(14)
                }
            }
            .onChange(of: anchor.atEnd) { _, atEnd in
                if atEnd {
                    unseen = 0
                }
            }
            .onChange(of: scrollTarget) { _, request in
                guard let request else { return }
                Self.scroll(proxy, to: request.id, anchor: request.anchor)
            }
            .onChange(of: document) {
                // One plain scroll per change, not the three-pass `scroll`: a streaming reply
                // changes the document several times a second.
                guard followsLatest, atLatest else { return }
                DispatchQueue.main.async {
                    // Read after `recompute` ran: a new prompt adds a section.
                    guard let last = visible.last else { return }
                    proxy.scrollTo(Self.endMarker(last.id), anchor: .bottom)
                }
            }
            // A live session's appended rows (GenesisTools hub) are followed by `anchor` alone, and only
            // while the reader is at the end: one ease-out glide per change. The three-pass `scroll` to
            // the new last row that used to run here too moved the viewport twice more after it, which
            // read as a jump on every append (Martin, 2026-10-01).
            .onAppear {
                guard !didInitialScroll, visible.last?.rows.last != nil else { return }
                didInitialScroll = true
                if let target = preset.scrollTo {
                    Self.scroll(proxy, to: target, anchor: .top)
                    return
                }
                if let index = preset.jumpToPrompt, promptIds.indices.contains(index) {
                    promptCursor = index
                    let target = Self.jumpTarget(promptId: promptIds[index], in: visible)
                    Self.scroll(proxy, to: target, anchor: .top)
                    return
                }
                // A conversation opens at its latest turn. Each pass reads the latest end marker again:
                // a live session appends during the 350 ms of passes, and a pass to the row that was last
                // at the first one landed above the end, so the list took the reader for scrolled up.
                for delay in [0, 0.12, 0.35] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                        guard let section = visible.last else { return }
                        proxy.scrollTo(Self.endMarker(section.id), anchor: .bottom)
                    }
                }
            }
        }
    }

    private func latestButton(_ proxy: ScrollViewProxy) -> some View {
        Button {
            atLatest = true
            if let last = visible.last {
                Self.scroll(proxy, to: Self.endMarker(last.id), anchor: .bottom)
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "arrow.down")
                    .font(.system(size: 10, weight: .bold))
                Text("Latest")
                    .font(.system(size: 11.5, weight: .semibold))
            }
            .foregroundStyle(SessionPalette.text)
            .padding(.horizontal, 11)
            .frame(height: 26)
            .background(Capsule().fill(SessionPalette.card))
            .overlay(Capsule().strokeBorder(SessionPalette.cardBorder))
            .shadow(color: .black.opacity(0.35), radius: 6, y: 2)
        }
        .buttonStyle(.genHoverPlain())
        .padding(14)
        .instantTooltip("Scroll to the latest message")
        .accessibilityIdentifier("session-transcript-latest")
    }

    private enum ListItem: Identifiable {
        case row(TranscriptRow)
        case end(String)

        var id: String {
            switch self {
            case .row(let row): return row.id
            case .end(let id): return id
            }
        }
    }

    /// A 1 pt row the jump arrows scroll to. See `jump` for why a prompt is not the target itself.
    private func marker(_ id: String) -> some View {
        Color.clear
            .frame(height: 1)
            .id(id)
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }

    /// NSTableView places rows it has not measured yet at estimated heights, so the first
    /// `scrollTo` of a far row lands short. The second pass, after those rows were measured on
    /// the way, lands exactly.
    private static func scroll(_ proxy: ScrollViewProxy, to id: String, anchor: UnitPoint) {
        DispatchQueue.main.async { proxy.scrollTo(id, anchor: anchor) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { proxy.scrollTo(id, anchor: anchor) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { proxy.scrollTo(id, anchor: anchor) }
    }

    private static func endMarker(_ sectionId: String) -> String { "end-\(sectionId)" }


    private var loadEarlierRow: some View {
        HStack {
            Spacer()
            Button(action: onLoadEarlier) {
                HStack(spacing: 6) {
                    if loadingEarlier {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "arrow.up.to.line")
                            .font(.system(size: 10, weight: .semibold))
                    }
                    Text(loadingEarlier ? "Loading earlier turns…" : "Load earlier turns")
                        .font(.system(size: 11.5, weight: .medium))
                }
                .foregroundStyle(SessionPalette.secondary)
                .padding(.horizontal, 12)
                .frame(height: 26)
                .overlay(Capsule().strokeBorder(SessionPalette.cardBorder))
            }
            .buttonStyle(.genHoverPlain())
            .disabled(loadingEarlier)
            .instantTooltip("Fetch the turns before this window")
            .accessibilityIdentifier("session-transcript-load-earlier")
            Spacer()
        }
        .padding(.vertical, 10)
    }

    // MARK: Logic

    private enum ScrollIntent {
        /// New data: keep the reader where they are. Earlier turns prepended above the first
        /// row would otherwise push the view; scroll back to that row.
        case preserve
        /// A new filter or query: start at the first hit.
        case firstHit
    }

    /// Tool calls start open at "Inputs + output" and above, thinking only at Verbose; a folded
    /// group and a long prompt start closed. A Read starts closed at every level (Martin,
    /// 2026-10-01): its output is the file, which the reader already has.
    private func defaultOpen(_ row: TranscriptRow) -> Bool {
        switch row.kind {
        case .tool(let line): return verbosity.opensTools && TranscriptToolKind.of(line.name) != .read
        case .thinking: return verbosity.opensThinking
        default: return false
        }
    }

    /// Which calls inside a folded group the reader opened.
    private func openMembers(_ row: TranscriptRow) -> Set<String> {
        // And which parts of a prompt (`PromptPartsView`).
        if !row.parts.isEmpty {
            return Set(row.parts.indices.map { TranscriptPromptParts.partId(row.id, $0) }.filter { expansion.isOpen($0) })
        }
        guard case .toolGroup(let group) = row.kind else { return [] }
        return Set(group.members.map(\.id).filter { expansion.isOpen($0) })
    }

    /// The opened calls of a folded group that show their whole body (every one is opened by hand;
    /// see `TranscriptExpansion.showsAll`).
    private func fullMembers(_ row: TranscriptRow) -> Set<String> {
        guard case .toolGroup(let group) = row.kind else { return [] }
        return Set(group.members.map(\.id).filter { expansion.isOpen($0) && expansion.showsAll($0, byDefault: false) })
    }

    /// `documentChanged`: only a new document can hold rows that arrived; a filter, a level or a
    /// reveal recomputes the same rows and must not count them as new.
    private func recompute(_ intent: ScrollIntent, documentChanged: Bool = false) {
        let previousFirst = visible.first?.rows.first?.id
        let previousLast = visible.last?.rows.last?.id
        // The host's tool filter narrows the chips' result (`filters`).
        let filtered = TranscriptBus.onlyTool(toolFilter, in: document.filtered(chips, query: appliedQuery))
        let sections = verbosity == .minimal ? TranscriptDocument.folded(filtered) : filtered
        visible = sections
        noteArrivals(after: previousLast, intent: intent, documentChanged: documentChanged)
        let ids = sections.flatMap { $0.rows.filter(\.isPrompt).map(\.id) }
        promptIds = ids
        if let cursor = promptCursor, cursor >= ids.count {
            promptCursor = ids.isEmpty ? nil : ids.count - 1
        }

        switch intent {
        case .firstHit:
            promptCursor = nil
            if appliedQuery.isEmpty, chips.isEmpty, toolFilter == nil, let last = sections.last?.rows.last?.id {
                request(last, anchor: .bottom)
            } else if !sections.isEmpty {
                request("top", anchor: .top)
            }
        case .preserve:
            guard didInitialScroll, let previousFirst, sections.first?.rows.first?.id != previousFirst,
                  sections.contains(where: { $0.rows.contains { $0.id == previousFirst } })
            else { return }
            if followsLatest, atLatest {
                // At the end: the document-change scroll keeps the reader there; a scroll to the old first
                // row would undo it.
                return
            } else if followsLatest, tracksLatestByGeometry {
                // Earlier turns arrive only from the "Load earlier turns" row at the very top, so the reader
                // is at the old first row: it stays where it was. (No anchor probe here: geometry tracking.)
                request(previousFirst, anchor: .top)
            } else {
                // The scroll back to the previous first row came a pass after the insert and put that
                // row at the top, not where the reader was; a transcript opened at its latest turn ended
                // thousands of points above it after the fill. The anchor holds the viewport inside the
                // insert's own layout pass instead.
                anchor.holdForPrepend()
            }
        }
    }

    /// Rows a live session appended after `previousLast` fade in, and count toward the "N new" pill
    /// while the reader is scrolled up. A prepend, a filter or the first load appends nothing.
    private func noteArrivals(after previousLast: String?, intent: ScrollIntent, documentChanged: Bool) {
        // The previous last row is gone (the window moved, a filter dropped it): the old count means nothing.
        if let previousLast, Self.rows(after: previousLast, in: visible) == nil, unseen > 0 {
            unseen = 0
        }
        guard !followsLatest, documentChanged, case .preserve = intent, didInitialScroll, let previousLast,
              let fresh = Self.rows(after: previousLast, in: visible), !fresh.isEmpty
        else {
            if !arriving.isEmpty { arriving = [] }
            return
        }
        arriving = Set(fresh)
        if !anchor.atEnd {
            unseen += fresh.count
        }
    }

    /// The ids after `id`, scanning from the end; nil when `id` is gone.
    static func rows(after id: String, in sections: [TranscriptSection]) -> [String]? {
        var after: [String] = []
        for section in sections.reversed() {
            for row in section.rows.reversed() {
                if row.id == id {
                    return after.reversed()
                }
                after.append(row.id)
            }
        }
        return nil
    }

    /// Scrolls so the target prompt sits just below its pinned section header. Scrolling to the
    /// prompt row itself put it under that header (the header pins over the top 36 pt). Instead the
    /// target is the 1 pt end marker of the PREVIOUS section: at the viewport top, the next
    /// section's header follows it in flow and pushes the old pinned header away, so the new
    /// header and then the prompt land at the top. The first section uses the list-top marker.
    private func jump(_ delta: Int) {
        guard !promptIds.isEmpty else { return }
        let current = promptCursor ?? (delta < 0 ? promptIds.count : -1)
        let next = min(max(current + delta, 0), promptIds.count - 1)
        promptCursor = next
        request(Self.jumpTarget(promptId: promptIds[next], in: visible), anchor: .top)
    }

    public static func jumpTarget(promptId: String, in sections: [TranscriptSection]) -> String {
        guard let index = sections.firstIndex(where: { $0.rows.contains { $0.id == promptId } }), index > 0 else {
            return "top"
        }
        return endMarker(sections[index - 1].id)
    }

    /// Shows one row the host asked for (a prompt, a tool call). A filter that hides it is cleared
    /// first; the scroll goes out on the next pass, after the filters' own scroll to the first hit, so
    /// it is the one that lands.
    private func reveal(_ rowId: String) {
        if rowId == "top" {
            request("top", anchor: .top)
            return
        }

        guard TranscriptBus.contains(rowId, in: document.sections) else {
            pendingReveal = rowId
            return
        }

        if !TranscriptBus.contains(rowId, in: visible) {
            revealing = true
            chips = []
            query = ""
            appliedQuery = ""
            filters.setTool(nil, for: services.sessionId)
            recompute(.preserve)
        }
        guard let shown = TranscriptBus.visibleRow(rowId, in: visible) else {
            revealing = false
            return
        }
        if rowId.hasPrefix("t-") {
            expansion.expand([rowId, shown])
        }
        let target = rowId.hasPrefix("p-") ? Self.jumpTarget(promptId: rowId, in: visible) : shown
        DispatchQueue.main.async { request(target, anchor: .top) }
        // `revealing` outlives the filter handlers and `Self.scroll`'s 350 ms retry; clearing it in the
        // hop above could run before SwiftUI delivers those `onChange` calls.
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.revealQuietSeconds) { revealing = false }
    }

    /// Longer than `Self.scroll`'s last retry (0.35 s), so no `.firstHit` scroll lands after a reveal.
    private static let revealQuietSeconds = 0.5

    private func request(_ id: String, anchor: UnitPoint) {
        // A jump the list asks for is not undone by a prepend's hold.
        self.anchor.releaseHold()
        scrollTarget = ScrollRequest(id: id, anchor: anchor, serial: (scrollTarget?.serial ?? 0) + 1)
    }
}

/// Tells a following list whether the reader is at the end. Scroll geometry belongs to the scroll
/// view, so reading it cannot feed back into placing the rows. Hysteresis: 60 pt to rejoin, 160 pt
/// to leave, so a row growing under a streaming reply does not flip it. Before macOS 15 the list keeps
/// the end-marker tracking instead (`tracksLatestByGeometry`).
private struct LatestTracker: ViewModifier {
    let enabled: Bool
    @Binding var atLatest: Bool

    func body(content: Content) -> some View {
        if enabled, #available(macOS 15, *) {
            content.onScrollGeometryChange(for: CGFloat.self) { geo in
                geo.contentSize.height - geo.containerSize.height - geo.contentOffset.y
            } action: { _, unseenBelow in
                let next = atLatest ? unseenBelow <= 160 : unseenBelow <= 60
                if next != atLatest {
                    atLatest = next
                }
            }
        } else {
            content
        }
    }
}

// MARK: - Section header (sticky)

public struct TranscriptSectionHeader: View {
    public let section: TranscriptSection

    public var body: some View {
        // The short labels are drawn whole and the usage text is the one
        // that truncates (behind the hairline, which gives way first). In a 650 pt transcript pane
        // the fixed-size usage once squeezed the rest to "Pr… #3… 00… 5m…" (snapshot 2026-09-25).
        HStack(spacing: 10) {
            Text(verbatim: section.number > 0 ? "Prompt" : "Earlier")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(SessionPalette.secondary)
                .fixedSize()
            if section.number > 0 {
                Text(verbatim: "#\(section.number)")
                    .font(SessionPalette.mono(10.5))
                    .foregroundStyle(SessionPalette.faint)
                    .fixedSize()
                    .instantTooltip("Turn \(section.number) of the session file")
            }
            if let startedAt = section.startedAt {
                Text(verbatim: SessionFormat.moment(startedAt))
                    .font(SessionPalette.mono(11))
                    .foregroundStyle(SessionPalette.dim)
                    .fixedSize()
            }
            if let duration = section.duration {
                Text(verbatim: SessionFormat.duration(duration))
                    .font(SessionPalette.mono(11))
                    .foregroundStyle(SessionPalette.faint)
                    .fixedSize()
            }
            Rectangle().fill(SessionPalette.hairline).frame(height: 1).layoutPriority(-2)
            if let usage = section.usage, !usage.compact.isEmpty {
                Text(verbatim: usage.compact)
                    .font(SessionPalette.mono(10.5))
                    .foregroundStyle(SessionPalette.dim)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .layoutPriority(-1)
                    .instantTooltip(usage.detailed)
            }
            if section.toolCount > 0 {
                Text(verbatim: "\(section.toolCount) tool\(section.toolCount == 1 ? "" : "s")")
                    .font(SessionPalette.mono(10.5))
                    .foregroundStyle(SessionPalette.dim)
                    .fixedSize()
            }
            if section.errorCount > 0 {
                HStack(spacing: 4) {
                    SessionStatusDot(color: SessionPalette.red)
                    Text(verbatim: "\(section.errorCount) failed")
                }
                .font(SessionPalette.mono(10.5))
                .foregroundStyle(SessionPalette.red)
            }
        }
        .padding(.horizontal, 12)
        .frame(height: 28)
        .frame(maxWidth: .infinity)
        // Opaque, and past its own frame: AppKit gives a section header row 36 pt with 4 pt of
        // transparent padding above and below the 28 pt content (measured), and the rows scrolling
        // under a pinned header showed through those strips.
        .background(SessionPalette.background.padding(.vertical, -4).padding(.trailing, -20))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("session-transcript-section-header")
    }
}

// MARK: - Rows

public struct TranscriptRowView: View, Equatable {
    public let row: TranscriptRow
    public let provider: AIProviderMeta
    public let modelName: String?
    public let verbosity: TranscriptVerbosity
    public let expanded: Bool
    public let showAll: Bool
    public let openMembers: Set<String>
    /// See `SessionTranscriptList.fullMembers`.
    public var fullMembers: Set<String> = []
    /// See `TranscriptWrap`.
    public var wrap = TranscriptWrap()
    public let services: TranscriptServices
    public let onToggle: (String) -> Void

    public init(
        row: TranscriptRow,
        provider: AIProviderMeta,
        modelName: String?,
        verbosity: TranscriptVerbosity,
        expanded: Bool,
        showAll: Bool,
        openMembers: Set<String>,
        fullMembers: Set<String> = [],
        wrap: TranscriptWrap = TranscriptWrap(),
        services: TranscriptServices,
        onToggle: @escaping (String) -> Void
    ) {
        self.row = row
        self.provider = provider
        self.modelName = modelName
        self.verbosity = verbosity
        self.expanded = expanded
        self.showAll = showAll
        self.openMembers = openMembers
        self.fullMembers = fullMembers
        self.wrap = wrap
        self.services = services
        self.onToggle = onToggle
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.row == rhs.row && lhs.expanded == rhs.expanded && lhs.showAll == rhs.showAll && lhs.wrap == rhs.wrap
            && lhs.provider == rhs.provider && lhs.modelName == rhs.modelName && lhs.verbosity == rhs.verbosity
            && lhs.openMembers == rhs.openMembers && lhs.fullMembers == rhs.fullMembers && lhs.services === rhs.services
    }

    public var body: some View {
        let _ = RenderProbe.hit("row.body")
        switch row.kind {
        case .prompt(let text, let images):
            // A prompt with peer messages, task results or reminders shows each part.
            if row.parts.isEmpty {
                PromptCard(
                    id: row.id, text: text, images: images, clock: row.clock, expanded: expanded,
                    actions: services.rowActions?(row) ?? [], onToggle: onToggle
                )
            } else {
                PromptPartsView(rowId: row.id, parts: row.parts, images: images, clock: row.clock, open: openMembers, onToggle: onToggle)
            }
        case .reply(let text, let usage, let model):
            ReplyBlock(
                text: text, usage: usage, clock: row.clock, provider: provider, modelName: model ?? modelName,
                showsAuthor: row.showsAuthor, actions: services.rowActions?(row) ?? []
            )
        case .notice(let notice):
            NoticeCard(id: row.id, notice: notice, clock: row.clock, onAction: services.onNoticeAction)
        case .activity(let activity):
            ActivityRow(activity: activity)
        case .thinking(let text):
            ThinkingLine(id: row.id, text: text, expanded: expanded, onToggle: onToggle)
        case .tool(let line):
            ToolCallRowView(
                rowId: row.id,
                toolId: line.toolId,
                line: line,
                verbosity: verbosity,
                open: expanded,
                showAll: showAll,
                wrap: wrap,
                services: services,
                onToggle: onToggle
            )
        case .toolGroup(let group):
            ToolGroupRow(id: row.id, group: group, open: expanded, openMembers: openMembers, fullMembers: fullMembers, wrap: wrap, services: services, onToggle: onToggle)
        }
    }
}

/// The one place the transcript reaches for the app's markdown renderer: the host's
/// (`GenesisKitHost.transcriptMarkdown`), else inline markdown in one `Text`.
public struct TranscriptMarkdown: View {
    public let text: String

    public var body: some View {
        Group {
            if let rendered = GenesisKit.host?.transcriptMarkdown(text, style: .sessionTranscript) {
                rendered
            } else {
                Text((try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text))
                    .font(.system(size: 13))
                    .foregroundStyle(SessionPalette.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .textSelection(.enabled)
    }
}

private struct Avatar: View {
    let glyph: String
    let color: Color
    var solid = false

    var body: some View {
        Text(verbatim: glyph)
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(solid ? Color.black.opacity(0.85) : color)
            .frame(width: 22, height: 22)
            .background(Circle().fill(solid ? color : color.opacity(0.18)))
    }
}

/// A button a prompt or reply offers on hover and in its context menu. Built by the host per row.
public struct TranscriptRowAction: Identifiable {
    public let id: String
    public let title: String
    public let symbol: String
    public let run: () -> Void

    public init(
        id: String,
        title: String,
        symbol: String,
        run: @escaping () -> Void
    ) {
        self.id = id
        self.title = title
        self.symbol = symbol
        self.run = run
    }
}

/// The hover buttons of a prompt or reply. Hidden until the pointer is over the row, so a long
/// conversation does not carry a toolbar on every message.
private struct RowActionStrip: View {
    let actions: [TranscriptRowAction]
    let visible: Bool

    var body: some View {
        HStack(spacing: 2) {
            ForEach(actions) { action in
                Button(action: action.run) {
                    Image(systemName: action.symbol)
                        .font(.system(size: 10.5, weight: .medium))
                        .frame(width: 20, height: 20)
                }
                .buttonStyle(.genHoverIcon(accent: SessionPalette.blue, diameter: 22))
                .instantTooltip(action.title)
                .accessibilityLabel(Text(action.title))
                .accessibilityIdentifier("transcript-row-action-\(action.id)")
            }
        }
        .foregroundStyle(SessionPalette.dim)
        .opacity(visible ? 1 : 0)
        .allowsHitTesting(visible)
    }
}

/// Tracks the pointer only for a row that has hover buttons. Session Details has none, and every
/// prompt and reply the list scrolled under a resting pointer re-drew its markdown twice.
private struct HoverWhenActions: ViewModifier {
    let hasActions: Bool
    @Binding var hovering: Bool

    func body(content: Content) -> some View {
        if hasActions {
            content.onHover { hovering = $0 }
        } else {
            content
        }
    }
}

private struct RowContextMenu: ViewModifier {
    let actions: [TranscriptRowAction]

    func body(content: Content) -> some View {
        if actions.isEmpty {
            content
        } else {
            content.contextMenu {
                ForEach(actions) { action in
                    Button(action.title, action: action.run)
                }
            }
        }
    }
}

public struct PromptCard: View {
    public let id: String
    public let text: String
    public let images: [TranscriptImageRef]
    public let clock: String?
    public let expanded: Bool
    public var actions: [TranscriptRowAction] = []
    public let onToggle: (String) -> Void

    @State private var hovering = false

    private static let collapsedLines = 14

    public init(
        id: String,
        text: String,
        images: [TranscriptImageRef],
        clock: String?,
        expanded: Bool,
        actions: [TranscriptRowAction] = [],
        onToggle: @escaping (String) -> Void
    ) {
        self.id = id
        self.text = text
        self.images = images
        self.clock = clock
        self.expanded = expanded
        self.actions = actions
        self.onToggle = onToggle
    }

    public var body: some View {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        let isLong = lines.count > Self.collapsedLines || text.utf8.count > 1600
        let shown = isLong && !expanded ? collapsed(lines) : text

        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Avatar(glyph: "Y", color: SessionPalette.orange, solid: true)
                Text("You")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(SessionPalette.text)
                if let clock {
                    Text(verbatim: clock)
                        .font(.system(size: 11.5))
                        .foregroundStyle(SessionPalette.dim)
                }
                Spacer(minLength: 0)
                if !actions.isEmpty {
                    RowActionStrip(actions: actions, visible: hovering)
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                if shown.isEmpty {
                    Text("(empty prompt)")
                        .font(.system(size: 12))
                        .foregroundStyle(SessionPalette.faint)
                } else {
                    TranscriptMarkdown(text: shown)
                }
                if isLong {
                    Button(expanded ? "Show less" : (lines.count > Self.collapsedLines ? "Show all \(lines.count) lines" : "Show the full message")) { onToggle(id) }
                        .buttonStyle(.genHoverPlain())
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(SessionPalette.blue)
                        .accessibilityIdentifier("transcript-prompt-expand")
                }
                if !images.isEmpty {
                    HStack(spacing: 8) {
                        ForEach(images, id: \.self) { image in
                            TranscriptThumbnail(image: image)
                        }
                    }
                }
            }
            .padding(.leading, 12)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(SessionPalette.card))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(SessionPalette.cardBorder))
        .contentShape(Rectangle())
        .modifier(HoverWhenActions(hasActions: !actions.isEmpty, hovering: $hovering))
        .modifier(RowContextMenu(actions: actions))
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 2)
    }

    private func collapsed(_ lines: [Substring]) -> String {
        let head = lines.prefix(Self.collapsedLines).joined(separator: "\n")
        guard head.utf8.count > 1600 else { return head }
        return String(decoding: head.utf8.prefix(1600), as: UTF8.self) + "…"
    }
}

private struct ReplyBlock: View {
    let text: String
    let usage: String?
    let clock: String?
    let provider: AIProviderMeta
    let modelName: String?
    let showsAuthor: Bool
    var actions: [TranscriptRowAction] = []

    @State private var hovering = false

    var body: some View {
        let _ = RenderProbe.hit("reply.body")
        VStack(alignment: .leading, spacing: 4) {
            if showsAuthor {
                authorRow
            } else if usage != nil || !actions.isEmpty {
                // A continuation keeps its cost line, right-aligned, without repeating who wrote it.
                HStack(spacing: 8) {
                    Spacer(minLength: 8)
                    if !actions.isEmpty {
                        RowActionStrip(actions: actions, visible: hovering)
                    }
                    if let usage {
                        Text(verbatim: usage)
                            .font(SessionPalette.mono(10.5))
                            .foregroundStyle(SessionPalette.faint)
                            .lineLimit(1)
                    }
                }
            }
            TranscriptMarkdown(text: text)
                .padding(.leading, 12)
        }
        .padding(.horizontal, 12)
        .padding(.top, showsAuthor ? 6 : 2)
        .padding(.bottom, 2)
        .contentShape(Rectangle())
        .modifier(HoverWhenActions(hasActions: !actions.isEmpty, hovering: $hovering))
        .modifier(RowContextMenu(actions: actions))
    }

    private var authorRow: some View {
            HStack(spacing: 8) {
                Avatar(glyph: provider.glyph, color: provider.color)
                Text(verbatim: provider.displayName)
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(SessionPalette.text)
                if let modelName, !modelName.isEmpty {
                    SessionPill(text: modelName)
                }
                if let clock {
                    Text(verbatim: clock)
                        .font(.system(size: 11.5))
                        .foregroundStyle(SessionPalette.dim)
                }
                Spacer(minLength: 8)
                if !actions.isEmpty {
                    RowActionStrip(actions: actions, visible: hovering)
                }
                if let usage {
                    Text(verbatim: usage)
                        .font(SessionPalette.mono(10.5))
                        .foregroundStyle(SessionPalette.faint)
                        .lineLimit(1)
                }
            }
    }
}

/// `Approval · open_url` with its buttons, `Connection lost`, `Forked`: a host note inline.
private struct NoticeCard: View {
    let id: String
    let notice: TranscriptNotice
    let clock: String?
    let onAction: ((String, String) -> Void)?

    private var tint: Color {
        switch notice.level {
        case .info: return SessionPalette.blue
        case .success: return SessionPalette.green
        case .warning: return SessionPalette.orange
        case .error: return SessionPalette.red
        }
    }

    private var symbol: String {
        switch notice.level {
        case .info: return "info.circle"
        case .success: return "checkmark.circle"
        case .warning: return "exclamationmark.shield"
        case .error: return "exclamationmark.triangle"
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 16)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(verbatim: notice.title)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(SessionPalette.text)
                    if let clock {
                        Text(verbatim: clock)
                            .font(.system(size: 11))
                            .foregroundStyle(SessionPalette.faint)
                    }
                }
                if let detail = notice.detail, !detail.isEmpty {
                    Text(verbatim: detail)
                        .font(SessionPalette.mono(11))
                        .foregroundStyle(SessionPalette.secondary)
                        .lineLimit(6)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if !notice.actions.isEmpty, let onAction {
                    HStack(spacing: 6) {
                        ForEach(Array(notice.actions.enumerated()), id: \.offset) { index, title in
                            Button { onAction(id, title) } label: {
                                Text(verbatim: title)
                                    .font(.system(size: 11.5, weight: .semibold))
                                    .foregroundStyle(index == 0 ? Color.black.opacity(0.85) : SessionPalette.text)
                                    .padding(.horizontal, 12)
                                    .frame(height: 24)
                                    .background(Capsule().fill(index == 0 ? tint : SessionPalette.fillStrong))
                            }
                            .buttonStyle(.genHoverPlain())
                            .accessibilityIdentifier("transcript-notice-action-\(title.lowercased())")
                        }
                    }
                    .padding(.top, 2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(tint.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(tint.opacity(0.28)))
        .padding(.leading, 24)
        .padding(.trailing, 12)
        .padding(.vertical, 4)
        .accessibilityIdentifier("transcript-notice")
    }
}

/// The running turn: a sweeping mark, what it does, and the elapsed time. Only the clock text
/// redraws each second; the row itself changes only when the activity does.
private struct ActivityRow: View {
    let activity: TranscriptActivity

    var body: some View {
        HStack(spacing: 9) {
            WorkingMark()
            Text(verbatim: activity.label)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(SessionPalette.secondary)
            if let detail = activity.detail, !detail.isEmpty {
                Text(verbatim: detail)
                    .font(SessionPalette.mono(11.5))
                    .foregroundStyle(SessionPalette.dim)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 8)
            if activity.finishedTools > 0 {
                Text(verbatim: "\(activity.finishedTools) done")
                    .font(SessionPalette.mono(10.5))
                    .foregroundStyle(SessionPalette.faint)
            }
            LiveTime(date: activity.startedAt, style: .elapsed, alignment: .trailing)
                .font(SessionPalette.mono(10.5))
                .foregroundStyle(SessionPalette.faint)
        }
        .padding(.horizontal, 8)
        .frame(height: 28)
        .padding(.leading, 24)
        .padding(.trailing, 12)
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("transcript-activity")
    }
}

/// Three dots that rise in turn. A transform animation (never a shadow), and it stops with the row.
private struct WorkingMark: View {
    @State private var phase = false

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(SessionPalette.blue)
                    .frame(width: 4.5, height: 4.5)
                    .scaleEffect(phase ? 1 : 0.55)
                    .opacity(phase ? 1 : 0.4)
                    .animation(
                        .easeInOut(duration: 0.55).repeatForever(autoreverses: true).delay(Double(index) * 0.18),
                        value: phase
                    )
            }
        }
        .frame(width: 22)
        .onAppear { phase = true }
    }
}

/// A toggle chip: filled when on, hairline when off.
public struct FilterChip: View {
    public let title: String
    public let isOn: Bool
    public var tint: Color = SessionPalette.blue
    public let action: () -> Void

    public init(title: String, isOn: Bool, tint: Color = SessionPalette.blue, action: @escaping () -> Void) {
        self.title = title
        self.isOn = isOn
        self.tint = tint
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            // As wide as the semibold label either way. A chip that widened when turned on made the
            // toolbar's ViewThatFits switch layout under the pointer, so the next click landed on
            // another control (2026-09-30).
            Text(verbatim: title)
                .font(.system(size: 11.5, weight: .semibold))
                .hidden()
                .overlay {
                    Text(verbatim: title)
                        .font(.system(size: 11.5, weight: isOn ? .semibold : .medium))
                        .foregroundStyle(isOn ? SessionPalette.text : SessionPalette.dim)
                        .fixedSize()
                }
                .padding(.horizontal, 9)
                .frame(height: 22)
                .background(Capsule().fill(isOn ? tint.opacity(0.28) : Color.clear))
                .overlay(Capsule().strokeBorder(isOn ? tint.opacity(0.6) : SessionPalette.cardBorder))
                .contentShape(Capsule())
        }
        .buttonStyle(.genHoverPlain())
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}

private struct ThinkingLine: View {
    let id: String
    let text: String
    let expanded: Bool
    let onToggle: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button { onToggle(id) } label: {
                HStack(spacing: 8) {
                    Image(systemName: "brain")
                        .font(.system(size: 11))
                        .foregroundStyle(SessionPalette.purple.opacity(0.8))
                        .frame(width: 14)
                    Text("Thinking")
                        .font(.system(size: 12).italic())
                        .foregroundStyle(SessionPalette.secondary)
                    Text(verbatim: SessionFormat.chars(text.utf8.count))
                        .font(SessionPalette.mono(10.5))
                        .foregroundStyle(SessionPalette.faint)
                    Spacer(minLength: 0)
                    Chevron(expanded: expanded)
                }
                .padding(.horizontal, 8)
                .frame(height: 24)
                .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverRow(accent: .white, cornerRadius: 7))
            .accessibilityIdentifier("transcript-thinking-row")

            if expanded {
                Text(verbatim: text)
                    .font(.system(size: 12))
                    .foregroundStyle(SessionPalette.dim)
                    .lineSpacing(2)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 12)
                    .overlay(alignment: .leading) {
                        Rectangle().fill(SessionPalette.purple.opacity(0.35)).frame(width: 2)
                    }
                    .padding(.leading, 12)
                    .padding(.bottom, 6)
            }
        }
        .padding(.leading, 24)
        .padding(.trailing, 12)
        .padding(.vertical, 0)
    }
}

public struct Chevron: View {
    public let expanded: Bool

    public var body: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(SessionPalette.faint)
            .rotationEffect(.degrees(expanded ? 90 : 0))
            .frame(width: 12)
    }
}

// MARK: - Image thumbnails

private struct TranscriptThumbnail: View {
    let image: TranscriptImageRef
    @State private var thumbnail: NSImage?

    var body: some View {
        if let path = image.path {
            Button {
                // One opener for every path; a missing image says so.
                PathOpener.open(path)
            } label: {
                ZStack {
                    RoundedRectangle(cornerRadius: 8, style: .continuous).fill(SessionPalette.fill)
                    if let thumbnail {
                        Image(nsImage: thumbnail)
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                    } else {
                        Image(systemName: "photo")
                            .foregroundStyle(SessionPalette.faint)
                    }
                }
                .frame(width: 96, height: 64)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(SessionPalette.cardBorder))
            }
            .buttonStyle(.genHoverPlain())
            .instantTooltip("Open \(image.label)")
            .accessibilityLabel(Text(verbatim: "Open \(image.label)"))
            .accessibilityIdentifier("transcript-image-thumbnail")
            .task(id: path) {
                thumbnail = await TranscriptThumbnailCache.shared.thumbnail(for: path)
            }
        } else {
            HStack(spacing: 5) {
                Image(systemName: "photo")
                    .font(.system(size: 10))
                Text(verbatim: image.label)
                    .font(.system(size: 11))
            }
            .foregroundStyle(SessionPalette.dim)
            .padding(.horizontal, 8)
            .frame(height: 22)
            .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(SessionPalette.fill))
            .instantTooltip("A pasted image; the transcript keeps no copy of it")
        }
    }
}

/// Downsampled thumbnails, decoded off the main thread and kept in memory for the session.
public actor TranscriptThumbnailCache {
    public static let shared = TranscriptThumbnailCache()

    private var images: [String: NSImage] = [:]

    public func thumbnail(for path: String) -> NSImage? {
        if let cached = images[path] { return cached }
        let url = URL(fileURLWithPath: path) as CFURL
        guard let source = CGImageSourceCreateWithURL(url, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 256,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let image = NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
        images[path] = image
        return image
    }
}


// MARK: - Folded tool runs (Minimal)

private struct ToolGroupRow: View {
    let id: String
    let group: TranscriptToolGroup
    let open: Bool
    let openMembers: Set<String>
    /// See `SessionTranscriptList.fullMembers`.
    let fullMembers: Set<String>
    /// See `TranscriptWrap`.
    let wrap: TranscriptWrap
    let services: TranscriptServices
    let onToggle: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Button { onToggle(id) } label: {
                HStack(spacing: 8) {
                    Image(systemName: "wrench.and.screwdriver")
                        .font(.system(size: 10.5))
                        .foregroundStyle(SessionPalette.faint)
                        .frame(width: 14)
                    Text(verbatim: group.summary)
                        .font(.system(size: 12))
                        .foregroundStyle(SessionPalette.secondary)
                        .lineLimit(1)
                    if group.failed > 0 {
                        Text(verbatim: "\(group.failed) failed")
                            .font(SessionPalette.mono(10.5, weight: .semibold))
                            .foregroundStyle(SessionPalette.red)
                    }
                    Spacer(minLength: 8)
                    if let duration = group.duration {
                        Text(verbatim: "~" + SessionFormat.duration(duration))
                            .font(SessionPalette.mono(10.5))
                            .foregroundStyle(SessionPalette.faint)
                    }
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(SessionPalette.faint)
                        .rotationEffect(.degrees(open ? 90 : 0))
                        .frame(width: 12)
                }
                .padding(.horizontal, 8)
                .frame(height: 24)
                .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverRow(accent: .white, cornerRadius: 7))
            .padding(.leading, 24)
            .padding(.trailing, 12)
            .accessibilityIdentifier("transcript-tool-group")

            if open {
                ForEach(group.members) { member in
                    if case .tool(let line) = member.kind {
                        ToolCallRowView(
                            rowId: member.id,
                            toolId: line.toolId,
                            line: line,
                            verbosity: .inputs,
                            open: openMembers.contains(member.id),
                            showAll: fullMembers.contains(member.id),
                            wrap: wrap,
                            services: services,
                            onToggle: onToggle
                        )
                        .padding(.leading, 14)
                    }
                }
            }
        }
        .padding(.vertical, 0)
    }
}
