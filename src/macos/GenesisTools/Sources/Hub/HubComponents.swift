import AppKit
import SwiftUI

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
            .buttonStyle(.genHoverRow(accent: .white, cornerRadius: cornerRadius))
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
struct ExternalLink: View {
    let text: String
    let url: URL?
    var font: Font = .system(size: 12)
    var color: Color = ReviewPalette.dim

    var body: some View {
        if let url {
            Button {
                ExternalOpener.open(url)
            } label: {
                HStack(spacing: 3) {
                    Text(text).lineLimit(1).truncationMode(.middle)
                    Image(systemName: "arrow.up.right.square").font(.system(size: 9))
                }
                .font(font)
                .foregroundColor(color)
            }
            .buttonStyle(.genHoverPlain())
            .onHover { inside in
                if inside { NSCursor.pointingHand.push() } else { NSCursor.pop() }
            }
            .instantTooltip(url.absoluteString)
        } else {
            Text(text).font(font).foregroundColor(color).lineLimit(1)
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
    @State private var showingActions = false

    private var display: String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
    }

    var body: some View {
        HStack(spacing: 2) {
            Button {
                showingActions = true
            } label: {
                Text(display).font(font).foregroundColor(ReviewPalette.dim).lineLimit(1).truncationMode(.middle)
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

// MARK: - Resizable side panel

/// A side panel you drag to any width; dragging it below `snap` collapses it to the edge, and the
/// thin strip left behind opens it again. Width and collapsed state persist per `key`.
enum SidePanelEdge { case leading, trailing }

struct ResizableSidePanel<Content: View>: View {
    typealias Edge = SidePanelEdge

    let key: String
    let edge: Edge
    var defaultWidth: CGFloat = 300
    var minWidth: CGFloat = 180
    var snap: CGFloat = 120
    @ViewBuilder let content: () -> Content

    @AppStorage private var width: Double
    @AppStorage private var collapsed: Bool
    @State private var dragStart: Double?

    init(key: String, edge: Edge, defaultWidth: CGFloat = 300, minWidth: CGFloat = 180, snap: CGFloat = 120, @ViewBuilder content: @escaping () -> Content) {
        self.key = key
        self.edge = edge
        self.defaultWidth = defaultWidth
        self.minWidth = minWidth
        self.snap = snap
        self.content = content
        _width = AppStorage(wrappedValue: Double(defaultWidth), "panel.\(key).width")
        _collapsed = AppStorage(wrappedValue: false, "panel.\(key).collapsed")
    }

    var body: some View {
        HStack(spacing: 0) {
            if edge == .trailing { handle }
            if collapsed {
                VStack {
                    IconButton(systemName: edge == .leading ? "sidebar.left" : "sidebar.right", tooltip: "Show panel") {
                        collapsed = false
                    }
                    .padding(.top, 44)
                    Spacer()
                }
                .frame(width: 26)
                .background(ReviewPalette.sidebar)
            } else {
                // Flexible below the saved width, so a parent (`SideSplit`) can clamp it.
                content().frame(minWidth: 0, idealWidth: CGFloat(width), maxWidth: CGFloat(width))
            }
            if edge == .leading { handle }
        }
    }

    private var handle: some View {
        Rectangle()
            .fill(ReviewPalette.hairline)
            .frame(width: 1)
            .overlay(Color.clear.frame(width: 7).contentShape(Rectangle()))
            .onHover { inside in
                if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
            }
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { value in
                        if collapsed {
                            collapsed = false
                            width = Double(minWidth)
                        }
                        let start = dragStart ?? width
                        dragStart = start
                        let delta = edge == .leading ? value.translation.width : -value.translation.width
                        width = max(0, min(900, start + delta))
                    }
                    .onEnded { _ in
                        dragStart = nil
                        if width < Double(snap) {
                            collapsed = true
                            width = Double(defaultWidth)
                        } else if width < Double(minWidth) {
                            width = Double(minWidth)
                        }
                    }
            )
            .instantTooltip("Drag to resize; drag to the edge to collapse")
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

// MARK: - Group preferences (pin, collapse, order) for list sections

/// Persisted per list: which groups are pinned (on top), collapsed, and their manual order.
final class GroupPrefs: ObservableObject {
    private let key: String
    @Published var pinned: [String] { didSet { save() } }
    @Published var collapsed: Set<String> { didSet { save() } }
    @Published var order: [String] { didSet { save() } }

    init(key: String) {
        self.key = key
        let defaults = UserDefaults.standard
        pinned = defaults.stringArray(forKey: "groups.\(key).pinned") ?? []
        collapsed = Set(defaults.stringArray(forKey: "groups.\(key).collapsed") ?? [])
        order = defaults.stringArray(forKey: "groups.\(key).order") ?? []
    }

    private func save() {
        let defaults = UserDefaults.standard
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
        .contentShape(Rectangle())
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
        .instantTooltip("Click to fold; right-click to pin or reorder")
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
