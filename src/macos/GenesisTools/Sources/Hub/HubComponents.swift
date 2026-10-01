import AppKit
import SwiftUI
import UniformTypeIdentifiers

// Shared building blocks for every GenesisTools.app window (hub, review). See ../../CLAUDE.md:
// every icon-only control gets `.instantTooltip`, every external URL is an `ExternalLink`, every
// path is a `PathLabel`, every side panel is a `ResizableSidePanel`, every status line is a `NoticePill`.
// The ones Genesis.app shares (IconButton, PathLabel, PathActionsMenu, CopyChip, NoticePill, LiveAgo,
// MenuButton, badges) live in GenesisKit (../../../GenesisKit).


// MARK: - External links

enum ExternalOpener {
    /// Opens web URLs in Brave (Martin's browser); other schemes go to their own app.
    static func open(_ url: URL) {
        guard url.scheme == "http" || url.scheme == "https" else {
            NSWorkspace.shared.open(url)
            return
        }

        let brave = URL(fileURLWithPath: "/Applications/Brave Browser.app")
        if FileManager.default.fileExists(atPath: brave.path) {
            NSWorkspace.shared.open([url], withApplicationAt: brave, configuration: NSWorkspace.OpenConfiguration())
        } else {
            NSWorkspace.shared.open(url)
        }
    }
}

/// Text that opens a web page, marked with the external-link glyph so it never looks like plain text.
/// URLs come from `ForgeWeb` (Hub/HubForgeLinks.swift) or from `tools` JSON, never pasted per view.
struct ExternalLink: View {
    enum Glyph {
        /// The ↗ glyph always shows: a link that stands on its own.
        case always
        /// Dense rows: the label keeps its look, and the glyph and an underline appear on hover.
        case onHover
    }

    let text: String
    let url: URL?
    var font: Font = .system(size: 12)
    var color: Color = ReviewPalette.dim
    /// An SF Symbol before the text (the person icon of an author).
    var icon: String?
    var glyph: Glyph = .always
    /// The tooltip; the URL itself when nil.
    var tooltip: String?
    /// The key a panel find row lists this text under (a row with several links names each one).
    var findField = "link"
    /// False draws the same label with no button, hover or tooltip: a dense list's rows away from the
    /// pointer (`TimelineRowView`), where every control is a responder SwiftUI walks per update.
    var interactive = true
    @State private var hovering = false

    var body: some View {
        if let url, !interactive {
            HStack(spacing: 3) {
                if let icon {
                    Image(systemName: icon)
                }
                FindText(text, field: findField).lineLimit(1).truncationMode(.middle)
                Image(systemName: "arrow.up.right.square").font(.system(size: 9))
                    .opacity(glyph == .always ? 1 : 0)
                    .accessibilityHidden(true)
            }
            .font(font)
            .foregroundColor(color)
        } else if let url {
            Button {
                ExternalOpener.open(url)
            } label: {
                HStack(spacing: 3) {
                    if let icon {
                        Image(systemName: icon)
                    }
                    // Under a panel find row the matches are marked (field `findField`).
                    FindText(text, field: findField).lineLimit(1).truncationMode(.middle)
                        .underline(glyph == .onHover && hovering)
                    Image(systemName: "arrow.up.right.square").font(.system(size: 9))
                        .opacity(glyph == .always || hovering ? 1 : 0)
                }
                .font(font)
                .foregroundColor(color)
            }
            .buttonStyle(.genHoverPlain())
            .onHover { inside in hovering = inside }
            .hoverCursor(.pointingHand)
            .instantTooltip(tooltip.map { "\($0)\n\(url.absoluteString)" } ?? url.absoluteString)
            // A link, not a button, for VoiceOver and `tools control find --role link`.
            .accessibilityRemoveTraits(.isButton)
            .accessibilityAddTraits(.isLink)
            .accessibilityLabel(Text(text))
            .accessibilityValue(Text(url.absoluteString))
        } else {
            HStack(spacing: 3) {
                if let icon {
                    Image(systemName: icon)
                }
                FindText(text, field: findField).lineLimit(1)
            }
            .font(font)
            .foregroundColor(color)
        }
    }
}

/// What `tools hub repo --json` says about a folder: checkout, branch, origin web pages, PR/MR.
/// The TypeScript side owns remote parsing and host rules (src/review/lib/repo.ts,
/// src/utils/git/origins/web.ts); Swift only reads the result.
struct RepoFacts: Codable, Equatable {
    struct Origin: Codable, Equatable {
        let url: String
        let host: String?
        let kind: String?
        let web: String?
    }

    struct PullRequest: Codable, Equatable {
        let number: Int
        let state: String
        let target: String
        let url: String

        /// "PR !12" on GitLab, "PR #12" on GitHub, with the state when it is not open.
        func label(kind: String?) -> String {
            let number = kind == "gitlab" ? "MR !\(self.number)" : "PR #\(self.number)"
            return state == "OPEN" ? number : "\(number) (\(state.lowercased()))"
        }
    }

    let path: String
    let root: String?
    let repo: String?
    let branch: String?
    let head: String?
    let origin: Origin?
    let branchUrl: String?
    let headUrl: String?
    let pr: PullRequest?
    let prError: String?

    var webURL: URL? { origin?.web.flatMap(URL.init(string:)) }
    var branchURL: URL? { branchUrl.flatMap(URL.init(string:)) }
    var prURL: URL? { pr.flatMap { URL(string: $0.url) } }
    var forge: ForgeWeb? { ForgeWeb(kind: origin?.kind, web: origin?.web) }
    /// The branch against its PR/MR's target; nil without a PR.
    var compareURL: URL? {
        guard let pr, let branch else { return nil }
        return forge?.compare(base: pr.target, head: branch)
    }

    /// Blocking: runs `tools`, so call it off the main thread only.
    static func fetch(_ paths: [String], pr: Bool) -> [RepoFacts] {
        guard !paths.isEmpty else { return [] }
        let span = HubPerf.begin("repoFacts", "\(paths.count) paths pr=\(pr)")
        defer { span.end() }
        do {
            // The CLI answers fresh by default; the PR lookup cache's own TTL (tools hub config) still caps a day.
            let data = try ToolsCLIRunner.run(["hub", "repo"] + paths + (pr ? ["--pr", "--max-cache-age", "86400"] : []))
            return try JSONDecoder().decode([RepoFacts].self, from: data)
        } catch {
            HubPerf.log("repoFacts failed: \(error)")
            return []
        }
    }
}

/// The hub's cache of `RepoFacts`, keyed by folder. A view asks `facts(for:)` during its body; an
/// unknown folder is queued and fetched in one batch on a background queue, never in the body:
/// a `Process.waitUntilExit()` inside a body spins the main run loop, AppKit lays out inside the
/// body being computed, and that re-entry corrupted SwiftUI's StackLayout (hub crash 2026-09-24).
/// The last facts of every folder stay on disk (Hub/HubSWR.swift): links paint at launch from
/// them, and each folder is still fetched once per run.
@MainActor
final class RepoFactsStore: ObservableObject {
    static let shared = RepoFactsStore()

    @Published private(set) var byPath: [String: RepoFacts] = [:]
    private var requested = Set<String>()
    private var requestedPR = Set<String>()
    private var queue: [String] = []
    private var queuePR: [String] = []
    private var flushScheduled = false
    private static let cache = HubSWR.cache("repo-facts")
    private static let cacheKey = "all"
    /// Folders whose facts on screen came from a fetch of this run, not the disk.
    private var fresh = Set<String>()
    private var saveScheduled = false

    init() {
        Task { [weak self] in
            let span = HubPerf.begin("repoFacts.cache", awaits: true)
            let cached = await Self.cache.load([String: RepoFacts].self, key: Self.cacheKey) ?? [:]
            span.end("\(cached.count) folders")
            guard let self, !cached.isEmpty else { return }
            // A fetch that landed first wins; the cache only fills the folders still unknown.
            var merged = self.byPath
            for (path, facts) in cached where merged[path] == nil {
                merged[path] = facts
            }
            if merged != self.byPath {
                self.byPath = merged
                HubSWR.painted("repoFacts", "\(cached.count) folders")
            }
        }
    }

    /// The cached facts, or nil until the batch that fetches them lands. `pr` adds the PR/MR lookup (gh / glab).
    func facts(for path: String, pr: Bool = false) -> RepoFacts? {
        guard !path.isEmpty else { return nil }
        if pr {
            if requestedPR.insert(path).inserted {
                requested.insert(path)
                queuePR.append(path)
                scheduleFlush()
            }
        } else if requested.insert(path).inserted {
            queue.append(path)
            scheduleFlush()
        }

        return byPath[path]
    }

    /// Fetch again on the next read (after a checkout switch or a push).
    func invalidate(_ path: String) {
        requested.remove(path)
        requestedPR.remove(path)
    }

    private func scheduleFlush() {
        guard !flushScheduled else { return }
        flushScheduled = true
        DispatchQueue.main.async { [weak self] in self?.flush() }
    }

    private func flush() {
        flushScheduled = false
        let plain = queue.filter { !queuePR.contains($0) }
        let withPR = queuePR
        queue.removeAll()
        queuePR.removeAll()
        for (paths, pr) in [(plain, false), (withPR, true)] where !paths.isEmpty {
            DispatchQueue.global(qos: .userInitiated).async {
                let found = RepoFacts.fetch(paths, pr: pr)
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    for facts in found {
                        // A plain batch must not drop a PR the slower batch stored, or will store: a
                        // cached PR stays on screen until the --pr answer replaces it.
                        if !pr, let old = self.byPath[facts.path], old.pr != nil,
                           self.fresh.contains(facts.path) || self.requestedPR.contains(facts.path) {
                            continue
                        }
                        self.fresh.insert(facts.path)
                        if self.byPath[facts.path] != facts {
                            self.byPath[facts.path] = facts
                        }
                    }
                    if !found.isEmpty {
                        self.scheduleSave()
                    }
                }
            }
        }
    }

    /// Writes the fresh facts once per burst of batches, off the main thread.
    private func scheduleSave() {
        guard !saveScheduled else { return }
        saveScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self else { return }
            self.saveScheduled = false
            let snapshot = self.byPath.filter { self.fresh.contains($0.key) }
            let cache = Self.cache
            let key = Self.cacheKey
            DispatchQueue.global(qos: .utility).async {
                // Folders fetched in an earlier run and not seen in this one stay.
                var all = cache.read([String: RepoFacts].self, key: key) ?? [:]
                all.merge(snapshot) { _, new in new }
                cache.write(all, key: key)
            }
        }
    }
}

/// "PR #12 ↗" / "MR !12 ↗" for the branch, from `RepoFacts`; nothing while unknown or when there is none.
struct PullRequestLink: View {
    let facts: RepoFacts?

    var body: some View {
        if let facts, let pr = facts.pr {
            ExternalLink(text: pr.label(kind: facts.origin?.kind), url: facts.prURL, font: .system(size: 11.5, weight: .medium), color: Color(red: 0.62, green: 0.78, blue: 1))
                .instantTooltip("\(pr.label(kind: facts.origin?.kind)) → \(pr.target): open in the browser")
        } else if let facts, facts.pr == nil, let error = facts.prError, !error.isEmpty, facts.branch != nil {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 10))
                .foregroundColor(ReviewPalette.dim)
                .instantTooltip("PR/MR lookup failed: \(error)")
        }
    }
}

/// "→ master" after a branch with a PR/MR: the host's compare view of the branch against the target.
struct CompareLink: View {
    let facts: RepoFacts?

    var body: some View {
        if let facts, let pr = facts.pr, let branch = facts.branch, let url = facts.compareURL {
            ExternalLink(text: "→ \(pr.target)", url: url, font: .system(size: 11.5, design: .monospaced), glyph: .onHover, tooltip: "Compare \(pr.target)...\(branch)")
        }
    }
}

extension NSWindow {
    /// Shows a `--snapshot` window without it ever reaching the screen: alpha 0, no mouse, not in
    /// the window cycle. AppKit and WebKit still lay it out and draw it, so the PNG is complete,
    /// and nothing flashes on the desktop or takes the keystrokes of whoever is typing.
    func orderInForSnapshot() {
        alphaValue = 0
        ignoresMouseEvents = true
        collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary]
        orderFrontRegardless()
    }
}

// MARK: - Side split

/// Two children: the main view and a `ResizableSidePanel` on `panelEdge`. The panel gets its ideal
/// (saved) width, but never more than `maxFraction` of the width; the main view gets the rest.
/// A plain HStack gives a fixed-width panel its full width first and squeezes the main view.
struct SideSplit: Layout {
    var panelEdge: SidePanelEdge
    var maxFraction: CGFloat = 0.4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count == 2 else {
            for subview in subviews {
                subview.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
            }
            return
        }
        let panelIndex = panelEdge == .trailing ? 1 : 0
        let panel = subviews[panelIndex]
        let main = subviews[1 - panelIndex]
        let ideal = panel.sizeThatFits(ProposedViewSize(width: nil, height: bounds.height)).width
        let panelWidth = min(ideal, (bounds.width * maxFraction).rounded(.down))
        let mainWidth = bounds.width - panelWidth
        let panelX = panelEdge == .trailing ? bounds.minX + mainWidth : bounds.minX
        let mainX = panelEdge == .trailing ? bounds.minX : bounds.minX + panelWidth
        main.place(at: CGPoint(x: mainX, y: bounds.minY), proposal: ProposedViewSize(width: mainWidth, height: bounds.height))
        panel.place(at: CGPoint(x: panelX, y: bounds.minY), proposal: ProposedViewSize(width: panelWidth, height: bounds.height))
    }
}

// MARK: - Title bar header

/// A main view's header. Its first row sits in the window's title bar, right of the traffic lights and
/// the title (`.titlebarRow()`, WindowTitlebar.swift), so the content starts right under the title bar;
/// the row's empty part zooms and drags the window. `details` are the rows under it. Every hub mode
/// used a 34 pt top padding here, which left an empty band under the title bar (Martin, 2026-09-28).
struct TitlebarHeader<Row: View, Details: View>: View {
    let row: Row
    let details: Details?

    init(@ViewBuilder row: () -> Row, @ViewBuilder details: () -> Details) {
        self.row = row()
        self.details = details()
    }

    /// `details: nil` for a header that is only the title bar row at the moment.
    init(details: Details?, @ViewBuilder row: () -> Row) {
        self.row = row()
        self.details = details
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            row
                .padding(.leading, 18)
                .padding(.trailing, 14)
                .titlebarRow()
            if let details {
                details
                    .padding(.leading, 18)
                    .padding(.trailing, 14)
                    .padding(.top, 2)
                    .padding(.bottom, 10)
            }
            // A row of its own, not an overlay: the title bar row takes no height, and a pane that starts
            // right at the title bar's edge gets its safe area. The session screen ignores that area and
            // slid up under the row (snapshot 2026-09-28 21:02).
            Rectangle().fill(ReviewPalette.hairline).frame(height: 1)
        }
    }
}

extension TitlebarHeader where Details == EmptyView {
    init(@ViewBuilder row: () -> Row) {
        self.row = row()
        self.details = nil
    }
}

// MARK: - Group preferences (pin, collapse, order) for list sections

/// Persisted per list: which groups are pinned (on top), collapsed, and their manual order.
final class GroupPrefs: ObservableObject {
    /// Which list these are (`prs.repos`): a header dragged from one list never drops into another.
    let key: String
    @Published var pinned: [String] { didSet { save() } }
    @Published var collapsed: Set<String> { didSet { save() } }
    @Published var order: [String] { didSet { save() } }

    init(key: String) {
        self.key = key
        let defaults = HubDefaults.store
        pinned = defaults.stringArray(forKey: "groups.\(key).pinned") ?? []
        collapsed = Set(defaults.stringArray(forKey: "groups.\(key).collapsed") ?? [])
        order = defaults.stringArray(forKey: "groups.\(key).order") ?? []
        // The `--bench` fold sweep clicks a header through this; a live hub never listens.
        if HubDefaults.isolated {
            benchFold = NotificationCenter.default.addObserver(forName: HubBench.groupFold, object: nil, queue: .main) { [weak self] note in
                guard let self, let fold = note.object as? HubBench.GroupFold, fold.list == key else { return }
                self.toggleCollapsed(fold.key)
            }
        }
    }

    private var benchFold: NSObjectProtocol?

    private func save() {
        let defaults = HubDefaults.store
        defaults.set(pinned, forKey: "groups.\(key).pinned")
        defaults.set(Array(collapsed), forKey: "groups.\(key).collapsed")
        defaults.set(order, forKey: "groups.\(key).order")
    }

    /// Pinned first (in pin order), then the manual order, then the rest alphabetically by `label`
    /// (for groups keyed by something other than their title), the key breaking a tie.
    func sorted(_ names: [String], label: (String) -> String = { $0 }) -> [String] {
        names.sorted { a, b in
            let pa = pinned.firstIndex(of: a), pb = pinned.firstIndex(of: b)
            if pa != nil || pb != nil { return (pa ?? .max) < (pb ?? .max) }
            let oa = order.firstIndex(of: a), ob = order.firstIndex(of: b)
            if oa != nil || ob != nil { return (oa ?? .max) < (ob ?? .max) }
            let byLabel = label(a).localizedCaseInsensitiveCompare(label(b))
            return byLabel == .orderedSame ? a < b : byLabel == .orderedAscending
        }
    }

    func togglePin(_ name: String) {
        if let index = pinned.firstIndex(of: name) { pinned.remove(at: index) } else { pinned.append(name) }
    }

    func toggleCollapsed(_ name: String) {
        MainActor.assumeIsolated { HubMainBusy.measure("groups.\(key).toggle") }
        if collapsed.contains(name) { collapsed.remove(name) } else { collapsed.insert(name) }
    }

    func move(_ name: String, by delta: Int, among names: [String]) {
        var current = sorted(names).filter { !pinned.contains($0) }
        guard let index = current.firstIndex(of: name) else { return }
        let target = max(0, min(current.count - 1, index + delta))
        current.remove(at: index)
        current.insert(name, at: target)
        order = current
    }

    /// A header dragged onto another: `name` lands just before `target` (or after it) in the shown
    /// order, the same order `move` and `sorted` use. It takes the target's side of the pin line, so
    /// a group dropped among the pinned ones is pinned and one dropped below them is not. Groups
    /// not shown right now (filtered out) keep their stored places behind the shown ones.
    func drop(_ name: String, on target: String, after: Bool, among names: [String]) {
        guard name != target, names.contains(name), names.contains(target) else { return }
        var shown = sorted(names).filter { $0 != name }
        guard let index = shown.firstIndex(of: target) else { return }
        shown.insert(name, at: after ? index + 1 : index)
        let pinnedAfter = pinned.contains(target)
        let isPinned: (String) -> Bool = { [pinned] in $0 == name ? pinnedAfter : pinned.contains($0) }
        pinned = shown.filter(isPinned) + pinned.filter { !names.contains($0) }
        order = shown.filter { !isPinned($0) } + order.filter { !names.contains($0) }
    }
}

/// The group header being dragged, so a header under the pointer knows whether the drag comes from
/// its own list. In-process only; the drop itself checks the dragged text too.
@MainActor
enum GroupDrag {
    static var current: (list: String, key: String)?

    static func token(list: String, key: String) -> String { "genesistools-group\n\(list)\n\(key)" }
}

/// A header over which another header of the same list is dragged: a line above or below it shows
/// where the dragged group lands.
private struct GroupDropDelegate: DropDelegate {
    let key: String
    let height: CGFloat
    let prefs: GroupPrefs
    let allNames: [String]
    @Binding var edge: VerticalEdge?

    private var source: String? {
        guard let drag = GroupDrag.current, drag.list == prefs.key, drag.key != key else { return nil }
        return drag.key
    }

    func validateDrop(info: DropInfo) -> Bool { source != nil }

    func dropEntered(info: DropInfo) { update(info) }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        update(info)
        return DropProposal(operation: source == nil ? .forbidden : .move)
    }

    func dropExited(info: DropInfo) { edge = nil }

    func performDrop(info: DropInfo) -> Bool {
        let after = edge == .bottom
        edge = nil
        guard let source, let provider = info.itemProviders(for: [.plainText]).first else { return false }
        let expected = GroupDrag.token(list: prefs.key, key: source)
        let (prefs, key, allNames) = (prefs, key, allNames)
        // The text confirms the drag is this header's: a stale `current` must not turn some other
        // text dropped here into a reorder.
        _ = provider.loadObject(ofClass: NSString.self) { object, _ in
            guard (object as? NSString) as String? == expected else { return }
            DispatchQueue.main.async {
                MainActor.assumeIsolated { GroupDrag.current = nil }
                HubPerf.log("groups.\(prefs.key) dropped \(source) \(after ? "after" : "before") \(key)")
                withAnimation(.snappy(duration: 0.25)) {
                    prefs.drop(source, on: key, after: after, among: allNames)
                }
            }
        }
        return true
    }

    private func update(_ info: DropInfo) {
        let next: VerticalEdge? = source == nil ? nil : (info.location.y < height / 2 ? .top : .bottom)
        if edge != next { edge = next }
    }
}

/// Header of a fixed sidebar group ("Live", "Today", "Earlier"): title and count, pinned while its rows scroll.
struct PlainGroupHeader: View {
    let title: String
    let count: Int

    var body: some View {
        HStack {
            Text(title)
            Spacer()
            Text(verbatim: "\(count)").font(.system(size: 10.5, design: .monospaced))
        }
        .font(.system(size: 11.5, weight: .semibold))
        .foregroundColor(ReviewPalette.dim)
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .hubSurface(.bar)
    }
}

/// Header of a collapsible, pinnable, movable group in a sidebar list.
struct GroupHeader: View {
    let title: String
    let count: Int
    @ObservedObject var prefs: GroupPrefs
    let allNames: [String]
    /// The project's absolute path, when the group is a project: adds a copy button and menu item.
    var path: String?
    /// The group's identity in `prefs` and `allNames` when the title is not unique (two projects
    /// both named `service`); the title otherwise.
    var key: String?

    /// Where a header dragged over this one would land (a line on that edge); nil when none is.
    @State private var dropEdge: VerticalEdge?
    @State private var height: CGFloat = 26

    var body: some View {
        let key = key ?? title
        let isCollapsed = prefs.collapsed.contains(key)
        let isPinned = prefs.pinned.contains(key)
        HStack(spacing: 6) {
            // A real button, so the keyboard and VoiceOver can fold the group. The copy button stays
            // outside it: a button inside a button leaves both ambiguous.
            Button { prefs.toggleCollapsed(key) } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(isCollapsed ? 0 : 90))
                    Text(title).font(.system(size: 11.5, weight: .semibold))
                    if isPinned {
                        Image(systemName: "pin.fill").font(.system(size: 9)).foregroundColor(ReviewPalette.modified)
                    }
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverPlain())
            .accessibilityLabel(Text(title))
            .accessibilityValue(Text(isCollapsed ? "collapsed, \(count) items" : "expanded, \(count) items"))
            .accessibilityHint(Text(isCollapsed ? "Expands the group" : "Collapses the group"))
            if let path {
                IconButton(systemName: "doc.on.doc", tooltip: "Copy absolute path: \(path)", size: 9.5) { PathOpener.copy(path, what: "path") }
            }
            Text(verbatim: "\(count)").font(.system(size: 10.5, design: .monospaced))
        }
        .foregroundColor(ReviewPalette.dim)
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(ReviewPalette.sidebar)
        .overlay(alignment: dropEdge == .top ? .top : .bottom) {
            if dropEdge != nil {
                Capsule()
                    .fill(Color.accentColor)
                    .frame(height: 2)
                    .padding(.horizontal, 8)
                    .allowsHitTesting(false)
            }
        }
        .contentShape(Rectangle())
        .onGeometryChange(for: CGFloat.self, of: \.size.height) { height = $0 }
        // Drag a header onto another to reorder the groups; the order is the one `prefs` keeps for
        // Move up / Move down. A click without a drag still folds the group.
        .onDrag {
            let list = prefs.key
            MainActor.assumeIsolated { GroupDrag.current = (list, key) }
            return NSItemProvider(object: GroupDrag.token(list: list, key: key) as NSString)
        }
        .onDrop(of: [.plainText], delegate: GroupDropDelegate(key: key, height: height, prefs: prefs, allNames: allNames, edge: $dropEdge))
        .contextMenu {
            Button(isPinned ? "Unpin" : "Pin to top") { prefs.togglePin(key) }
            Button("Move up") { prefs.move(key, by: -1, among: allNames) }.disabled(isPinned)
            Button("Move down") { prefs.move(key, by: 1, among: allNames) }.disabled(isPinned)
            Button(isCollapsed ? "Expand" : "Collapse") { prefs.toggleCollapsed(key) }
            if let path {
                Divider()
                Button("Copy absolute path to project") { PathOpener.copy(path, what: "path") }
                Button("Open in Finder") { PathOpener.finder(path) }
                Button("Open in Cursor") { PathOpener.cursor(path) }
            }
        }
        .instantTooltip("Click to fold; drag onto another group to reorder; right-click to pin")
        // One accessible button: VoiceOver and `tools control` can fold it, and pin it through a named
        // action, instead of meeting an unlabelled group with a tap gesture on it.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "\(title), \(count)\(isPinned ? ", pinned" : "")\(isCollapsed ? ", folded" : "")"))
        .accessibilityAddTraits(.isButton)
        // `key`, not `title`: two projects can share a title, and their prefs are keyed apart.
        .accessibilityAction { prefs.toggleCollapsed(key) }
        .accessibilityAction(named: Text(isPinned ? "Unpin" : "Pin to top")) { prefs.togglePin(key) }
        // `.ignore` hides the copy button above, so a project header offers its job as a named action.
        .accessibilityActions {
            if let path {
                Button("Copy absolute path") { PathOpener.copy(path, what: "path") }
            }
        }
    }
}

/// The repository root above a folder (the directory holding `.git`), else the folder itself.
func projectRoot(of cwd: String) -> String {
    var dir = URL(fileURLWithPath: cwd)
    while dir.path != "/" {
        if FileManager.default.fileExists(atPath: dir.appendingPathComponent(".git").path) {
            return dir.path
        }
        dir.deleteLastPathComponent()
    }
    return cwd
}
