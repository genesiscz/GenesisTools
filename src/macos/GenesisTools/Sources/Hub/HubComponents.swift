import AppKit
import SwiftUI
import UniformTypeIdentifiers

// Shared building blocks for every GenesisTools.app window (hub, review). See ../../CLAUDE.md:
// every icon-only control gets `.instantTooltip`, every external URL is an `ExternalLink`, every
// path is a `PathLabel`, every side panel is a `ResizableSidePanel`, every status line is a `NoticePill`.

// MARK: - Icon button with tooltip

/// The only way to put an icon-only button in these windows: it always carries an instant tooltip.
struct IconButton: View {
    let systemName: String
    let tooltip: String
    var size: CGFloat = 12
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: size))
                .frame(width: 16, height: 16)
                .contentShape(Rectangle())
        }
        // The same hover disc as the stolen Genesis screen (Hub/Stolen/UI/GenHoverButton.swift).
        .buttonStyle(.genHoverIcon())
        .instantTooltip(tooltip)
        // The tooltip is also the name VoiceOver and UI automation read.
        .accessibilityLabel(Text(tooltip))
    }
}

extension View {
    /// A clickable list row: a real button (keyboard, VoiceOver, automation) with the row hover,
    /// instead of an `onTapGesture` that none of them see.
    func rowButton(cornerRadius: CGFloat = 8, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { self }
            .buttonStyle(HubRowButtonStyle(cornerRadius: cornerRadius))
    }
}

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
    @State private var hovering = false

    var body: some View {
        if let url {
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
            .onHover { inside in
                hovering = inside
                if inside { NSCursor.pointingHand.push() } else { NSCursor.pop() }
            }
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
struct RepoFacts: Decodable, Equatable {
    struct Origin: Decodable, Equatable {
        let url: String
        let host: String?
        let kind: String?
        let web: String?
    }

    struct PullRequest: Decodable, Equatable {
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
            let data = try ToolsCLIRunner.run(["hub", "repo"] + paths + (pr ? ["--pr"] : []))
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
@MainActor
final class RepoFactsStore: ObservableObject {
    static let shared = RepoFactsStore()

    @Published private(set) var byPath: [String: RepoFacts] = [:]
    private var requested = Set<String>()
    private var requestedPR = Set<String>()
    private var queue: [String] = []
    private var queuePR: [String] = []
    private var flushScheduled = false

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
                        // A plain batch must not drop a PR the slower batch already stored.
                        if !pr, let old = self.byPath[facts.path], old.pr != nil {
                            continue
                        }
                        self.byPath[facts.path] = facts
                    }
                }
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

// MARK: - Paths

enum PathOpener {
    static func finder(_ path: String) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    /// `cursor -g path:line` when a line is known, else the folder or file.
    static func cursor(_ path: String, line: Int? = nil) {
        let cli = ["~/.local/bin/cursor", "/usr/local/bin/cursor", "/opt/homebrew/bin/cursor"]
            .map { ($0 as NSString).expandingTildeInPath }
            .first { FileManager.default.isExecutableFile(atPath: $0) }
        let process = Process()
        if let cli {
            process.executableURL = URL(fileURLWithPath: cli)
            process.arguments = line.map { ["-g", "\(path):\($0)"] } ?? [path]
        } else {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            process.arguments = ["-a", "Cursor", path]
        }
        try? process.run()
    }

    /// Off the main thread: the terminal host's CLI runs synchronously, up to its 60 s timeout.
    static func cmux(_ path: String) {
        Task.detached(priority: .userInitiated) {
            let error = AgentLauncher.openInTerminal(name: (path as NSString).lastPathComponent, cwd: path, command: ["zsh"])
            if let error {
                await MainActor.run { HubPerf.log("cmux open \(path) failed: \(error)") }
            }
        }
    }

    static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

/// A path you can act on: click for Finder / Cursor / cmux / copy, plus quick copy and reveal icons.
/// A popover, not a SwiftUI `Menu`: a Menu whose label truncates inside a header HStack sent
/// AttributeGraph into a layout cycle and crashed the hub (2026-09-24).
struct PathLabel: View {
    let path: String
    var font: Font = .system(size: 11, design: .monospaced)
    var showIcons = true
    /// The key a panel find row lists this path under (a row with several paths names each one).
    var findField = "path"
    @State private var showingActions = false

    private var display: String { Self.display(path) }

    /// The shown text ("~/…"): what a panel find row lists under `findField`.
    static func display(_ path: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
    }

    var body: some View {
        HStack(spacing: 2) {
            Button {
                showingActions = true
            } label: {
                FindText(display, field: findField).font(font).foregroundColor(ReviewPalette.dim).lineLimit(1).truncationMode(.middle)
            }
            .buttonStyle(.genHoverPlain())
            .instantTooltip("Open or copy \(display)")
            .popover(isPresented: $showingActions, arrowEdge: .bottom) {
                VStack(alignment: .leading, spacing: 2) {
                    action("folder", "Open in Finder") { PathOpener.finder(path) }
                    action("chevron.left.forwardslash.chevron.right", "Open in Cursor") { PathOpener.cursor(path) }
                    action("terminal", "Open in a new cmux workspace") { PathOpener.cmux(path) }
                    Divider().padding(.vertical, 2)
                    action("doc.on.doc", "Copy path") { PathOpener.copy(path) }
                    action("doc.on.doc", "Copy ~ path") { PathOpener.copy(display) }
                }
                .padding(8)
                .frame(width: 240)
                .onAppear { HubPerf.log("pathLabel.actions shown for \(display)") }
            }
            if showIcons {
                IconButton(systemName: "doc.on.doc", tooltip: "Copy path", size: 10) { PathOpener.copy(path) }
                IconButton(systemName: "folder", tooltip: "Reveal in Finder", size: 10) { PathOpener.finder(path) }
                IconButton(systemName: "chevron.left.forwardslash.chevron.right", tooltip: "Open in Cursor", size: 10) { PathOpener.cursor(path) }
            }
        }
    }

    private func action(_ icon: String, _ title: String, perform: @escaping () -> Void) -> some View {
        Button {
            showingActions = false
            perform()
        } label: {
            Label(title, systemImage: icon)
                .font(.system(size: 12))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 4)
                .padding(.horizontal, 6)
                .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverRow())
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

// MARK: - Notice pill

/// A short status line that fades after a few seconds: icon, message, optional dim detail.
struct NoticePill: View {
    let text: String
    var detail: String?
    var isError = false
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .foregroundColor(isError ? ReviewPalette.removed : ReviewPalette.added)
            Text(text).font(.system(size: 12, weight: .medium)).lineLimit(1)
            if let detail {
                Text(detail).font(.system(size: 11.5)).foregroundColor(ReviewPalette.dim).lineLimit(1).truncationMode(.middle)
            }
            IconButton(systemName: "xmark", tooltip: "Dismiss", size: 9, action: dismiss)
        }
        .padding(.leading, 10)
        .padding(.trailing, 4)
        .padding(.vertical, 3)
        .background(Capsule().fill(Color.white.opacity(0.06)))
        .overlay(Capsule().stroke(Color.white.opacity(0.1)))
        .task(id: text) {
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            if !isError { dismiss() }
        }
    }
}

// MARK: - Copy chip

/// A short monospaced value (a session id's first 8 characters) that copies the full value on
/// click, and says "Copied" in its own place for a moment.
struct CopyChip: View {
    let label: String
    let value: String
    let tooltip: String
    @State private var copied = false

    var body: some View {
        Button {
            PathOpener.copy(value)
            withAnimation(.easeOut(duration: 0.15)) { copied = true }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: copied ? "checkmark" : "number")
                    .font(.system(size: 9.5, weight: .semibold))
                    .foregroundColor(copied ? ReviewPalette.added : ReviewPalette.dim)
                Text(verbatim: copied ? "Copied" : label)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(copied ? ReviewPalette.added : Color.white.opacity(0.8))
            }
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(RoundedRectangle(cornerRadius: 5).fill(Color.white.opacity(0.06)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip(tooltip)
        .accessibilityLabel(Text(tooltip))
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .milliseconds(1400))
            withAnimation(.easeOut(duration: 0.2)) { copied = false }
        }
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
                IconButton(systemName: "doc.on.doc", tooltip: "Copy absolute path: \(path)", size: 9.5) { PathOpener.copy(path) }
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
                Button("Copy absolute path to project") { PathOpener.copy(path) }
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
                Button("Copy absolute path") { PathOpener.copy(path) }
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
