// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground.worktrees/genesis-session-redesign/Genesis/apps/Genesis/Sources/Genesis/Sessions/SessionTranscriptList.swift at 2026-09-24T08:22:05+02:00 at commit hash 352701bd4e327a97ee223015319f46223ad3a6e5
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
//  Portable except for `MarkdownContentView` (one use, in `TranscriptMarkdown`) and the app's
//  `.genHover*` / `.instantTooltip` conventions.
//

import AppKit
// GenesisTools adaptation: the kit types are compiled into this module.
// import GenesisAIMonitorKit
import SwiftUI

enum TranscriptLoadState: Equatable {
    case loading
    case loaded
    case failed(String)
}

struct TranscriptPreset: Equatable {
    var chips: Set<TranscriptFilter> = []
    var query = ""
    var expanded: Set<String> = []
    /// A row id to open at instead of the latest turn.
    var scrollTo: String?
    /// Overrides the stored verbosity (snapshots).
    var verbosity: TranscriptVerbosity?
    /// Open as if the prompt arrows had been pressed to this 0-based prompt.
    var jumpToPrompt: Int?
}

/// Which collapsible rows are open. A row is open when `all` (Expand all / Collapse all) or its
/// default says so, flipped when the reader toggled it since.
@MainActor
final class TranscriptExpansion: ObservableObject {
    @Published private(set) var toggled: Set<String> = []
    @Published private(set) var all: Bool?

    func isOpen(_ id: String, byDefault open: Bool = false) -> Bool {
        (all ?? open) != toggled.contains(id)
    }

    func expand(_ more: Set<String>) {
        toggled.formUnion(more)
    }

    func toggle(_ id: String) {
        if toggled.contains(id) {
            toggled.remove(id)
        } else {
            toggled.insert(id)
        }
    }

    func setAll(_ open: Bool?) {
        all = open
        toggled = []
    }
}

struct SessionTranscriptList: View {
    let document: TranscriptDocument
    let provider: AIProviderMeta
    let modelName: String?
    let loadState: TranscriptLoadState
    let hasEarlier: Bool
    let loadingEarlier: Bool
    /// `Turns 190–269 of 269`, or nil when the whole session is loaded.
    let windowNote: String?
    let onLoadEarlier: () -> Void
    /// Starting filter, query, expanded rows and scroll target. Snapshot tests and previews use it;
    /// the window opens with the default (everything, collapsed, at the latest turn).
    var preset = TranscriptPreset()
    /// Session file, change log and host actions for the tool rows.
    var services: TranscriptServices = .none

    /// Persisted: the reader picks a level once, not per window.
    @AppStorage("sessionTranscript.verbosity") private var verbosityRaw = TranscriptVerbosity.inputs.rawValue
    @State private var query = ""
    @State private var appliedQuery = ""
    @State private var chips: Set<TranscriptFilter> = []
    @State private var visible: [TranscriptSection] = []
    @State private var promptIds: [String] = []
    @State private var promptCursor: Int?
    @State private var scrollTarget: ScrollRequest?
    @State private var didInitialScroll = false
    // GenesisTools adaptation: whether the reader is at the latest row (the last section's end marker is
    // on screen); a live transcript follows new rows only then, never pulling a reader who scrolled up.
    @State private var atLatest = true
    @StateObject private var expansion = TranscriptExpansion()
    @FocusState private var searchFocused: Bool

    private struct ScrollRequest: Equatable {
        let id: String
        let anchor: UnitPoint
        let serial: Int
    }

    var body: some View {
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
        .onChange(of: document) { recompute(.preserve) }
        .onChange(of: chips) { recompute(.firstHit) }
        .onChange(of: verbosityRaw) {
            // A new level resets what the reader opened or closed by hand.
            expansion.setAll(nil)
            recompute(.preserve)
        }
        .onChange(of: appliedQuery) {
            // GenesisTools adaptation: tell the host, which searches the whole session.
            services.onQuery?(appliedQuery)
            recompute(.firstHit)
        }
        // GenesisTools adaptation: the host's services arrive after the first page, so a query applied
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
            // GenesisTools adaptation: a third layout for a hub pane of about 440 pt, where the row
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

    private var verbosityMenu: some View {
        Menu {
            ForEach(TranscriptVerbosity.allCases) { level in
                Button {
                    verbosityRaw = level.rawValue
                } label: {
                    if level == verbosity {
                        Label(level.title, systemImage: "checkmark")
                    } else {
                        Text(level.title)
                    }
                }
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
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
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

    private var matchCount: Int {
        visible.reduce(0) { $0 + $1.rows.count }
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
                    Text("No turns in this session file.")
                }
            } else if visible.isEmpty {
                placeholder {
                    Image(systemName: "line.3.horizontal.decrease.circle")
                        .font(.system(size: 22))
                        .foregroundStyle(SessionPalette.dim)
                    Text("Nothing matches this filter.")
                }
            } else {
                list
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
                                    showAll: expansion.isOpen(row.id + "#all"),
                                    openMembers: openMembers(row),
                                    services: services,
                                    onToggle: { expansion.toggle($0) }
                                )
                                .equatable()
                                .listRowInsets(EdgeInsets())
                                .listRowSeparator(.hidden)
                                .listRowBackground(Color.clear)
                            case .end(let id):
                                marker(id)
                                    // GenesisTools adaptation: track `atLatest` (see its declaration).
                                    .onAppear { if id == latestEndMarker { atLatest = true } }
                                    .onDisappear { if id == latestEndMarker { atLatest = false } }
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
            .environment(\.defaultMinListRowHeight, 1)            .accessibilityIdentifier("session-transcript-list")
            .onChange(of: scrollTarget) { _, request in
                guard let request else { return }
                Self.scroll(proxy, to: request.id, anchor: request.anchor)
            }
            // GenesisTools adaptation: a live session appended rows while the reader was at the latest one.
            .onChange(of: visible.last?.rows.last?.id) { _, newLast in
                guard didInitialScroll, atLatest, appliedQuery.isEmpty, chips.isEmpty, let newLast else { return }
                Self.scroll(proxy, to: newLast, anchor: .bottom)
            }
            .onAppear {
                guard !didInitialScroll, let last = visible.last?.rows.last?.id else { return }
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
                // A conversation opens at its latest turn.
                Self.scroll(proxy, to: last, anchor: .bottom)
            }
        }
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

    // GenesisTools adaptation: the end marker of the newest section (see `atLatest`).
    private var latestEndMarker: String? { visible.last.map { Self.endMarker($0.id) } }

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
    /// group and a long prompt start closed.
    private func defaultOpen(_ row: TranscriptRow) -> Bool {
        switch row.kind {
        case .tool: return verbosity.opensTools
        case .thinking: return verbosity.opensThinking
        default: return false
        }
    }

    /// Which calls inside a folded group the reader opened.
    private func openMembers(_ row: TranscriptRow) -> Set<String> {
        guard case .toolGroup(let group) = row.kind else { return [] }
        return Set(group.members.map(\.id).filter { expansion.isOpen($0) })
    }

    private func recompute(_ intent: ScrollIntent) {
        let previousFirst = visible.first?.rows.first?.id
        let filtered = document.filtered(chips, query: appliedQuery)
        let sections = verbosity == .minimal ? TranscriptDocument.folded(filtered) : filtered
        visible = sections
        let ids = sections.flatMap { $0.rows.filter(\.isPrompt).map(\.id) }
        promptIds = ids
        if let cursor = promptCursor, cursor >= ids.count {
            promptCursor = ids.isEmpty ? nil : ids.count - 1
        }

        switch intent {
        case .firstHit:
            promptCursor = nil
            if appliedQuery.isEmpty, chips.isEmpty, let last = sections.last?.rows.last?.id {
                request(last, anchor: .bottom)
            } else if !sections.isEmpty {
                request("top", anchor: .top)
            }
        case .preserve:
            guard didInitialScroll, let previousFirst, sections.first?.rows.first?.id != previousFirst,
                  sections.contains(where: { $0.rows.contains { $0.id == previousFirst } })
            else { return }
            request(previousFirst, anchor: .top)
        }
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

    static func jumpTarget(promptId: String, in sections: [TranscriptSection]) -> String {
        guard let index = sections.firstIndex(where: { $0.rows.contains { $0.id == promptId } }), index > 0 else {
            return "top"
        }
        return endMarker(sections[index - 1].id)
    }

    private func request(_ id: String, anchor: UnitPoint) {
        scrollTarget = ScrollRequest(id: id, anchor: anchor, serial: (scrollTarget?.serial ?? 0) + 1)
    }
}

// MARK: - Section header (sticky)

struct TranscriptSectionHeader: View {
    let section: TranscriptSection

    var body: some View {
        HStack(spacing: 10) {
            Text(verbatim: section.number > 0 ? "Prompt" : "Earlier")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(SessionPalette.secondary)
            if section.number > 0 {
                Text(verbatim: "#\(section.number)")
                    .font(SessionPalette.mono(10.5))
                    .foregroundStyle(SessionPalette.faint)
                    .instantTooltip("Turn \(section.number) of the session file")
            }
            if let startedAt = section.startedAt {
                Text(verbatim: SessionFormat.moment(startedAt))
                    .font(SessionPalette.mono(11))
                    .foregroundStyle(SessionPalette.dim)
            }
            if let duration = section.duration {
                Text(verbatim: SessionFormat.duration(duration))
                    .font(SessionPalette.mono(11))
                    .foregroundStyle(SessionPalette.faint)
            }
            Rectangle().fill(SessionPalette.hairline).frame(height: 1)
            if let usage = section.usage, !usage.compact.isEmpty {
                Text(verbatim: usage.compact)
                    .font(SessionPalette.mono(10.5))
                    .foregroundStyle(SessionPalette.dim)
                    .fixedSize()
                    .instantTooltip(usage.detailed)
            }
            if section.toolCount > 0 {
                Text(verbatim: "\(section.toolCount) tool\(section.toolCount == 1 ? "" : "s")")
                    .font(SessionPalette.mono(10.5))
                    .foregroundStyle(SessionPalette.dim)
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
        .padding(.horizontal, 20)
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

struct TranscriptRowView: View, Equatable {
    let row: TranscriptRow
    let provider: AIProviderMeta
    let modelName: String?
    let verbosity: TranscriptVerbosity
    let expanded: Bool
    let showAll: Bool
    let openMembers: Set<String>
    let services: TranscriptServices
    let onToggle: (String) -> Void

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.row == rhs.row && lhs.expanded == rhs.expanded && lhs.showAll == rhs.showAll
            && lhs.provider == rhs.provider && lhs.modelName == rhs.modelName && lhs.verbosity == rhs.verbosity
            && lhs.openMembers == rhs.openMembers && lhs.services === rhs.services
    }

    var body: some View {
        switch row.kind {
        case .prompt(let text, let images):
            PromptCard(id: row.id, text: text, images: images, clock: row.clock, expanded: expanded, onToggle: onToggle)
        case .reply(let text, let usage, let model):
            ReplyBlock(text: text, usage: usage, clock: row.clock, provider: provider, modelName: model ?? modelName, showsAuthor: row.showsAuthor)
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
                services: services,
                onToggle: onToggle
            )
        case .toolGroup(let group):
            ToolGroupRow(id: row.id, group: group, open: expanded, openMembers: openMembers, services: services, onToggle: onToggle)
        }
    }
}

/// The one place the transcript reaches for the app's markdown renderer.
private struct TranscriptMarkdown: View {
    let text: String

    var body: some View {
        MarkdownContentView(markdown: text, style: .sessionTranscript)
            .textSelection(.enabled)
    }
}

extension MarkdownStyle {
    static let sessionTranscript = MarkdownStyle(
        bodySize: 13,
        textColor: SessionPalette.text,
        secondaryColor: SessionPalette.secondary,
        mutedColor: SessionPalette.dim,
        accentColor: SessionPalette.blue,
        codeColor: Color.white.opacity(0.88),
        codeBackground: Color.white.opacity(0.06),
        taskDoneColor: SessionPalette.green,
        lineSpacing: 3,
        blockSpacing: 8,
        headingScale: 0.86
    )
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

private struct PromptCard: View {
    let id: String
    let text: String
    let images: [TranscriptImageRef]
    let clock: String?
    let expanded: Bool
    let onToggle: (String) -> Void

    private static let collapsedLines = 14

    var body: some View {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        let isLong = lines.count > Self.collapsedLines || text.utf8.count > 1600
        let shown = isLong && !expanded ? collapsed(lines) : text

        VStack(alignment: .leading, spacing: 8) {
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
            .padding(.leading, 30)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(SessionPalette.card))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(SessionPalette.cardBorder))
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 6)
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

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if showsAuthor {
                authorRow
            } else if let usage {
                // A continuation keeps its cost line, right-aligned, without repeating who wrote it.
                HStack {
                    Spacer(minLength: 8)
                    Text(verbatim: usage)
                        .font(SessionPalette.mono(10.5))
                        .foregroundStyle(SessionPalette.faint)
                        .lineLimit(1)
                }
            }
            TranscriptMarkdown(text: text)
                .padding(.leading, 30)
        }
        .padding(.horizontal, 20)
        .padding(.top, showsAuthor ? 10 : 6)
        .padding(.bottom, 6)
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
                if let usage {
                    Text(verbatim: usage)
                        .font(SessionPalette.mono(10.5))
                        .foregroundStyle(SessionPalette.faint)
                        .lineLimit(1)
                }
            }
    }
}

/// A toggle chip: filled when on, hairline when off.
struct FilterChip: View {
    let title: String
    let isOn: Bool
    var tint: Color = SessionPalette.blue
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(verbatim: title)
                .font(.system(size: 11.5, weight: isOn ? .semibold : .medium))
                .foregroundStyle(isOn ? SessionPalette.text : SessionPalette.dim)
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
                .frame(height: 26)
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
        .padding(.leading, 42)
        .padding(.trailing, 16)
        .padding(.vertical, 1)
    }
}

private struct Chevron: View {
    let expanded: Bool

    var body: some View {
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
                NSWorkspace.shared.open(URL(fileURLWithPath: path))
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
actor TranscriptThumbnailCache {
    static let shared = TranscriptThumbnailCache()

    private var images: [String: NSImage] = [:]

    func thumbnail(for path: String) -> NSImage? {
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
                .frame(height: 26)
                .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverRow(accent: .white, cornerRadius: 7))
            .padding(.leading, 42)
            .padding(.trailing, 16)
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
                            showAll: false,
                            services: services,
                            onToggle: onToggle
                        )
                        .padding(.leading, 14)
                    }
                }
            }
        }
        .padding(.vertical, 1)
    }
}
