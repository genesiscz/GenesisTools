import AppKit
import CoreServices
import SwiftUI
import WebKit

// GenesisTools --review [--repo <path>] [--session <id>] [--scope uncommitted|unstaged|staged|branch]
//                       [--style split|unified] [--snapshot <png>]
//
// The per-session review window. v1 shows a repository's working tree against HEAD; the session
// change log (handoff h_p38uwgeo) becomes a second source behind the same model. `--snapshot`
// renders once, writes a PNG of the window and exits, so a change can be checked without a screen.

func runReview(_ args: [String]) -> Never {
    var repoPath = FileManager.default.currentDirectoryPath
    var snapshotPath: String?
    var session: String?
    var scope = DiffScope.uncommitted
    var proposalPath: String?
    var options = DiffViewOptions()
    var activate = true
    var index = 0
    while index < args.count {
        let value = index + 1 < args.count ? args[index + 1] : nil
        switch args[index] {
        case "--repo": repoPath = value ?? repoPath; index += 1
        case "--snapshot": snapshotPath = value; index += 1
        case "--session": session = value; index += 1
        case "--scope": scope = DiffScope(argument: value ?? "") ?? .uncommitted; index += 1
        case "--proposal": proposalPath = value; index += 1
        case "--no-activate": activate = false
        case "--style": options.diffStyle = DiffViewOptions.Style(rawValue: value ?? "") ?? .split; index += 1
        default: break
        }
        index += 1
    }

    let app = NSApplication.shared
    // A snapshot run must never become the active app: it would take the keystrokes of whoever is typing.
    app.setActivationPolicy(snapshotPath == nil ? .regular : .prohibited)
    let delegate = ReviewAppDelegate()
    app.delegate = delegate
    installBrowserURLForwarder()

    var proposal: ProposalDocument?
    if let proposalPath {
        do {
            let document = try ProposalDocument(url: URL(fileURLWithPath: proposalPath))
            repoPath = document.repoPath ?? repoPath
            scope = .range(base: document.baseSha, head: document.headSha, label: "\(document.label) \(document.title.prefix(40))")
            proposal = document
        } catch {
            FileHandle.standardError.write(Data("review: cannot read proposal \(proposalPath): \(error)\n".utf8))
            exit(1)
        }
    }

    let model = ReviewModel(repo: URL(fileURLWithPath: repoPath).standardizedFileURL, options: options, session: session)
    model.scope = scope
    model.proposal = proposal
    let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 1320, height: 860),
        styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
        backing: .buffered,
        defer: false
    )
    window.title = "Review · \(model.repo.lastPathComponent)"
    window.titlebarAppearsTransparent = true
    window.appearance = NSAppearance(named: .darkAqua)
    window.backgroundColor = ReviewPalette.background
    window.contentView = NSHostingView(rootView: ReviewRootView(model: model))
    window.center()
    window.setFrameAutosaveName("GenesisToolsReview")
    delegate.window = window

    if let snapshotPath {
        model.onFirstRender = {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                ReviewSnapshot.write(window: window, webView: (model.renderer as? PierreWebDiffRenderer)?.webView, to: snapshotPath) {
                    exit(0)
                }
            }
        }
        // A snapshot run must end even if the page never renders.
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
            FileHandle.standardError.write(Data("review snapshot: no render within 30 s\n".utf8))
            exit(1)
        }
        window.orderInForSnapshot()
    } else {
        window.makeKeyAndOrderFront(nil)
        if activate {
            app.activate(ignoringOtherApps: true)
        }
    }

    MainActor.assumeIsolated { HangWatch.start() }
    model.start()
    app.run()
    exit(0)
}

private final class ReviewAppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow?

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

enum ReviewPalette {
    static let background = NSColor(srgbRed: 0.075, green: 0.075, blue: 0.08, alpha: 1)
    static let sidebar = Color(nsColor: NSColor(srgbRed: 0.095, green: 0.095, blue: 0.1, alpha: 1))
    static let hairline = Color.white.opacity(0.08)
    static let added = Color(red: 0.36, green: 0.80, blue: 0.47)
    static let removed = Color(red: 0.96, green: 0.38, blue: 0.40)
    static let modified = Color(red: 0.98, green: 0.66, blue: 0.25)
    static let renamed = Color(red: 0.45, green: 0.62, blue: 0.98)
    static let dim = Color.white.opacity(0.5)

    static func color(_ status: DiffFile.Status) -> Color {
        switch status {
        case .added: return added
        case .deleted: return removed
        case .modified: return modified
        case .renamed: return renamed
        }
    }
}

// MARK: - Model

final class ReviewModel: ObservableObject {
    /// Past either limit the renderer gets one file at a time, like Codex's "This diff is large".
    static let largeLineLimit = 4_000
    static let largeFileLimit = 60

    let repo: URL
    let renderer: DiffRenderer
    let comments: ReviewCommentStore
    /// The agent session this review is for; "Send to agent" types into its cmux pane.
    let session: String?
    var onFirstRender: (() -> Void)?

    @Published var branch = ""
    @Published var base: String?
    @Published var scope = DiffScope.uncommitted
    @Published var commits: [RepoCommit] = []
    /// An agent's review proposal shown on this diff (drafts + meta), when opened with --proposal.
    @Published var proposal: ProposalDocument?
    /// Inside the hub the header is not next to the traffic lights, so it needs no leading inset.
    var embedded = false
    @Published var files: [DiffFile] = []
    @Published var filter = ""
    @Published var selectedID: String?
    @Published var options: DiffViewOptions
    @Published var error: String?
    @Published var loading = false
    @Published var lastLoaded: Date?
    @Published var commentCount = 0
    @Published var unsentCount = 0
    @Published var notice: String?
    @Published var treeMode = true
    @Published var collapsed: Set<String> = []
    /// Set only by keyboard / prev-next navigation, so a click in the list never scrolls the list.
    @Published var sidebarScrollTarget: String?

    private var watcher: RepoWatcher?
    private var started = false
    private var loadInFlight = false
    private var reloadAgain = false
    private var rendered = false
    /// A file asked for by `reveal(path:)` before the diff had it.
    private var pendingRevealPath: String?
    /// When the last file set went to the renderer; `.rendered` closes the span.
    private var renderStart: CFAbsoluteTime?
    private let createdAt = CFAbsoluteTimeGetCurrent()
    private var loadGeneration = 0

    init(repo: URL, options: DiffViewOptions, session: String? = nil, renderer: DiffRenderer = PierreWebDiffRenderer()) {
        self.repo = repo
        self.options = options
        self.session = session
        self.renderer = renderer
        comments = ReviewCommentStore(repo: repo)
        renderer.onEvent = { [weak self] event in
            self?.handle(event)
        }
        renderer.apply(options)
    }

    var totals: (additions: Int, deletions: Int) {
        files.reduce((0, 0)) { ($0.0 + $1.additions, $0.1 + $1.deletions) }
    }

    var isLarge: Bool {
        let totals = totals
        return totals.additions + totals.deletions > Self.largeLineLimit || files.count > Self.largeFileLimit
    }

    var filteredFiles: [DiffFile] {
        let needle = filter.trimmed.lowercased()
        guard !needle.isEmpty else { return files }
        return files.filter { $0.path.lowercased().contains(needle) }
    }

    var selectedIndex: Int? {
        files.firstIndex { $0.id == selectedID }
    }

    /// Starts loading and watching. Idempotent; the view calls it on appear and `stop()` on
    /// disappear, so a hidden review (a hub tab not shown) neither watches nor reloads.
    func start() {
        guard !started else { return }
        started = true
        reload()
        watcher = RepoWatcher(root: repo) { [weak self] in
            self?.reload()
        }
    }

    func stop() {
        started = false
        watcher = nil
    }

    /// One load at a time: events that arrive during a load collapse into one follow-up load.
    func reload() {
        if loadInFlight {
            reloadAgain = true
            return
        }

        loadInFlight = true
        loadGeneration += 1
        let generation = loadGeneration
        loading = true
        let source = GitWorkingTreeSource(repo: repo)
        let scope = scope
        DispatchQueue.global(qos: .userInitiated).async {
            let span = HubPerf.begin("review.load", "\(scope)")
            let result = Result { try source.load(scope: scope) }
            span.end()
            let commits = source.commits()
            DispatchQueue.main.async { [weak self] in
                self?.commits = commits
            }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.loadInFlight = false
                if self.reloadAgain {
                    self.reloadAgain = false
                    self.reload()
                    return
                }
                guard generation == self.loadGeneration else { return }
                self.loading = false
                self.lastLoaded = Date()
                switch result {
                case .success(let snapshot):
                    self.error = nil
                    if self.branch != snapshot.branch {
                        RepoFactsStore.shared.invalidate(self.repo.path)
                    }
                    self.branch = snapshot.branch
                    self.base = snapshot.base
                    let changed = snapshot.files != self.files
                    self.files = snapshot.files
                    self.comments.reanchor(files: snapshot.files)
                    if let pending = self.pendingRevealPath,
                       let file = snapshot.files.first(where: { $0.path == pending || $0.oldPath == pending }) {
                        self.pendingRevealPath = nil
                        self.selectedID = file.id
                    }
                    if self.selectedID == nil || !self.files.contains(where: { $0.id == self.selectedID }) {
                        self.selectedID = self.files.first?.id
                    }
                    if changed || !self.rendered {
                        self.pushToRenderer()
                    } else {
                        self.pushComments()
                    }
                case .failure(let failure):
                    self.error = "\(failure)"
                }
            }
        }
    }

    /// Opens the file with this repo-relative path, now or once the next load has it.
    func reveal(path: String) {
        if let file = files.first(where: { $0.path == path || $0.oldPath == path }) {
            select(file.id)
        } else {
            pendingRevealPath = path
            notice = files.isEmpty ? nil : "\(path) has no change in this scope."
        }
    }

    func select(_ id: String) {
        selectedID = id
        if isLarge {
            pushToRenderer()
        } else {
            renderer.reveal(fileID: id)
        }
    }

    func step(_ delta: Int) {
        guard !files.isEmpty else { return }
        let next = ((selectedIndex ?? 0) + delta + files.count) % files.count
        select(files[next].id)
        sidebarScrollTarget = files[next].id
    }

    func setScope(_ next: DiffScope) {
        guard next != scope else { return }
        scope = next
        files = []
        rendered = false
        reload()
    }

    func setStyle(_ style: DiffViewOptions.Style) {
        options.diffStyle = style
        renderer.apply(options)
    }

    func toggleWrap() {
        options.wrap.toggle()
        renderer.apply(options)
    }

    func stepFont(_ delta: Double) {
        options.fontSize = max(10, min(20, options.fontSize + delta))
        renderer.apply(options)
    }

    private func pushToRenderer() {
        renderStart = PerfLog.now()
        pushComments()
        if isLarge, let index = selectedIndex {
            renderer.show([files[index]])
        } else {
            renderer.show(files)
        }
    }

    private func pushComments() {
        renderer.showComments(comments.rendered(for: files) + (proposal?.rendered(for: files) ?? []))
        commentCount = comments.comments.count
        unsentCount = comments.comments.filter { $0.state == .local }.count
    }

    /// Writes every unsent comment with its code into one markdown file, copies it, and, when the
    /// window was opened for a session, tells that session's cmux pane to read it. The pane gets one
    /// line, never the comment text, so nothing multi-line is typed into the agent's prompt.
    func sendToAgent() {
        let ids = comments.comments.filter { $0.state == .local }.map(\.id)
        guard !ids.isEmpty else {
            notice = "No unsent comments."
            return
        }

        let message = comments.agentMessage(repo: repo, branch: branch, files: files, ids: ids)
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        let outbox = comments.directory.appendingPathComponent("outbox", isDirectory: true)
        let file = outbox.appendingPathComponent("\(stamp).md")
        do {
            try FileManager.default.createDirectory(at: outbox, withIntermediateDirectories: true)
            try message.write(to: file, atomically: true, encoding: .utf8)
        } catch {
            notice = "Could not write \(file.path): \(error.localizedDescription)"
            return
        }

        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(message, forType: .string)

        guard let session, session.range(of: "^[A-Za-z0-9-]+$", options: .regularExpression) != nil else {
            comments.markSent(ids)
            pushComments()
            notice = "\(ids.count) comments copied. Paste them into the agent, or open the window with --session."
            return
        }

        let line = "Read the review comments in \(file.path) and address each one."
        let host = TerminalHosts.current
        notice = "Sending \(ids.count) comments…"
        Task { @MainActor in
            let error = await Task.detached(priority: .userInitiated) { host.send(sessionId: session, text: line) }.value
            if let error {
                notice = "\(host.name) send failed (\(error.prefix(80))); the comments are copied to the clipboard."
            } else {
                comments.markSent(ids)
                pushComments()
                notice = "Sent \(ids.count) comments to session \(session.prefix(8))."
            }
        }
    }

    private func handle(_ event: DiffRendererEvent) {
        switch event {
        case .ready:
            PerfLog.since("hub.review.webview-ready", createdAt)
        case .rendered:
            PerfLog.since("hub.review.render", renderStart)
            renderStart = nil
            if !rendered {
                rendered = true
                onFirstRender?()
            }
        case .failed(let message):
            error = message
            HubPerf.log("review.renderer failed: \(message)")
            FileHandle.standardError.write(Data("review renderer: \(message)\n".utf8))
        case .commentSubmitted(let input):
            if let id = input.editingID, id.hasPrefix("draft:") {
                updateDraft(id, status: "edited", body: input.body)
            } else if let id = input.editingID {
                comments.edit(id: id, body: input.body)
            } else {
                comments.add(input, files: files)
            }
            pushComments()
        case .commentDeleted(let id):
            comments.delete(id: id)
            pushComments()
        case .openLine(let fileID, let line, _):
            if let file = files.first(where: { $0.id == fileID }) {
                PathOpener.cursor(repo.appendingPathComponent(file.path).path, line: line)
            }
        case .commentAction(let id, let action):
            switch action {
            case "accept": updateDraft(id, status: "accepted")
            case "reject": updateDraft(id, status: "rejected")
            case "restore": updateDraft(id, status: "proposed")
            default: notice = "GitHub / GitLab review sync is not wired yet (backend handoff h_3te8zv19)."
            }
        }
    }

    private func updateDraft(_ id: String, status: String, body: String? = nil) {
        guard let proposal, id.hasPrefix("draft:") else { return }
        do {
            try proposal.update(draftID: String(id.dropFirst(6)), status: status, editedBody: body)
            objectWillChange.send()
        } catch {
            notice = "Could not save the proposal: \(error.localizedDescription)"
        }
        pushComments()
    }
}

// MARK: - Views

struct ReviewRootView: View {
    @ObservedObject var model: ReviewModel

    var body: some View {
        // The file list keeps its saved width only while the diff keeps 60% of the width: embedded in
        // a narrow hub pane, a 290 pt list used to squeeze the diff to a sliver.
        SideSplit(panelEdge: .trailing, maxFraction: 0.4) {
            VStack(spacing: 0) {
                ReviewHeader(model: model)
                if let proposal = model.proposal {
                    ProposalBanner(model: model, proposal: proposal)
                }
                if model.isLarge {
                    LargeDiffBanner(model: model)
                }
                if let notice = model.notice {
                    NoticePill(text: notice, isError: notice.lowercased().contains("could not") || notice.contains("failed")) {
                        model.notice = nil
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                }
                if let error = model.error {
                    Text(error)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundColor(ReviewPalette.removed)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if model.files.isEmpty && !model.loading {
                    VStack(spacing: 8) {
                        Image(systemName: "checkmark.circle")
                            .font(.system(size: 28))
                            .foregroundColor(ReviewPalette.added)
                        Text("No changes against HEAD")
                            .foregroundColor(ReviewPalette.dim)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    RendererHost(renderer: model.renderer)
                }
            }
            .frame(minWidth: 0, maxWidth: .infinity)
            .clipped()
            ResizableSidePanel(key: "review.files", edge: .trailing, defaultWidth: 290) {
                FileSidebar(model: model)
            }
        }
        .background(Color(nsColor: ReviewPalette.background))
        .preferredColorScheme(.dark)
        .onAppear { model.start() }
        .onDisappear { model.stop() }
    }
}

private struct ReviewHeader: View {
    @ObservedObject var model: ReviewModel
    @ObservedObject private var repos = RepoFactsStore.shared

    var body: some View {
        // Full row when it fits; in a narrow hub pane the controls move to a second row, so the
        // header never makes the diff column wider than its pane.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                summary
                Spacer()
                controls(styleWidth: 140)
            }
            .frame(height: 44)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 10) {
                    summary
                    Spacer(minLength: 0)
                }
                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    controls(styleWidth: 104)
                }
            }
            .padding(.vertical, 8)
        }
        .buttonStyle(.genHoverPlain())
        .padding(.leading, model.embedded ? 14 : 78)
        .padding(.trailing, 14)
        .overlay(Rectangle().fill(ReviewPalette.hairline).frame(height: 1), alignment: .bottom)
    }

    @ViewBuilder
    private var summary: some View {
        let totals = model.totals
        let facts = repos.facts(for: model.repo.path, pr: true)
            // Inside the hub the worktree / session header above already names the repo and branch.
            if !model.embedded {
                Image(systemName: "arrow.triangle.branch")
                    .foregroundColor(ReviewPalette.dim)
                ExternalLink(text: model.repo.lastPathComponent, url: facts?.webURL, font: .system(size: 13, weight: .semibold), color: Color.white.opacity(0.92))
                ExternalLink(text: model.branch, url: facts?.branchURL)
                PullRequestLink(facts: facts)
            }
            ScopeMenu(model: model)
                .layoutPriority(1)
            Text(verbatim: "+\(totals.additions)")
                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                .foregroundColor(ReviewPalette.added)
                .fixedSize()
            Text(verbatim: "−\(totals.deletions)")
                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                .foregroundColor(ReviewPalette.removed)
                .fixedSize()
            Text(verbatim: "\(model.files.count) files")
                .font(.system(size: 12))
                .foregroundColor(ReviewPalette.dim)
                .fixedSize()
    }

    @ViewBuilder
    private func controls(styleWidth: CGFloat) -> some View {
            if model.loading {
                ProgressView().controlSize(.small)
            }
            if model.commentCount > 0 {
                Label {
                    Text(verbatim: "\(model.commentCount)")
                } icon: {
                    Image(systemName: "text.bubble")
                }
                .font(.system(size: 12))
                .foregroundColor(ReviewPalette.dim)
                .instantTooltip("\(model.commentCount) comments, \(model.unsentCount) not sent yet")
            }
            Button(action: model.sendToAgent) {
                Label(model.unsentCount > 0 ? "Send \(model.unsentCount)" : "Send", systemImage: "paperplane")
                    .font(.system(size: 12, weight: .semibold))
                    .fixedSize()
            }
            .disabled(model.unsentCount == 0)
            .instantTooltip(model.session == nil
                ? "Copy the comments with their code for an agent"
                : "Send the comments to session \(model.session?.prefix(8) ?? "")")
            Picker("", selection: Binding(get: { model.options.diffStyle }, set: { model.setStyle($0) })) {
                Text("Split").tag(DiffViewOptions.Style.split)
                Text("Unified").tag(DiffViewOptions.Style.unified)
            }
            .pickerStyle(.segmented)
            .frame(width: styleWidth)
            .instantTooltip("Side by side, or one column")
            HStack(spacing: 0) {
                IconButton(systemName: "textformat.size.smaller", tooltip: "Smaller diff text") { model.stepFont(-1) }
                Text(verbatim: "\(Int(model.options.fontSize))")
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundColor(ReviewPalette.dim)
                    .frame(width: 18)
                IconButton(systemName: "textformat.size.larger", tooltip: "Larger diff text") { model.stepFont(1) }
            }
            IconButton(
                systemName: model.options.wrap ? "text.alignleft" : "arrow.left.and.right.text.vertical",
                tooltip: model.options.wrap ? "Long lines wrap (click to scroll instead)" : "Long lines scroll (click to wrap)"
            ) { model.toggleWrap() }
            IconButton(systemName: "arrow.clockwise", tooltip: "Reload the diff") { model.reload() }
    }
}

/// Codex's review source menu: what the diff compares.
private struct ScopeMenu: View {
    @ObservedObject var model: ReviewModel

    var body: some View {
        Menu {
            Button("Last Turn") { model.setScope(.lastTurn) }
                .disabled(true)
                .instantTooltip("Needs the per-session change log (handoff h_p38uwgeo)")
            Divider()
            scopeButton(.uncommitted)
            scopeButton(.unstaged)
            scopeButton(.staged)
            Divider()
            Menu("Committed") {
                if model.commits.isEmpty {
                    Text("No commits ahead of the base")
                }
                ForEach(model.commits) { commit in
                    Button("\(commit.short)  \(commit.subject)  ·  \(commit.when)") {
                        model.setScope(.commit(sha: commit.sha, title: commit.subject))
                    }
                }
            }
            scopeButton(.branch)
        } label: {
            Text(label)
                .font(.system(size: 12, weight: .medium))
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .instantTooltip("What this diff compares")
    }

    private var label: String {
        switch model.scope {
        case .branch: return "Branch vs \(model.base ?? "base")"
        case .commit(let sha, let title): return "\(sha.prefix(7)) \(title.prefix(40))"
        default: return model.scope.title
        }
    }

    private func scopeButton(_ scope: DiffScope) -> some View {
        Button {
            model.setScope(scope)
        } label: {
            if model.scope == scope {
                Label(scope.title, systemImage: "checkmark")
            } else {
                Text(scope.title)
            }
        }
    }
}

/// The agent's overall verdict above the diff, with a tally of what Martin decided so far.
private struct ProposalBanner: View {
    @ObservedObject var model: ReviewModel
    let proposal: ProposalDocument

    var body: some View {
        let drafts = proposal.drafts
        let tally = Dictionary(grouping: drafts, by: \.status).mapValues(\.count)
        let color: Color = proposal.decision == "approve" ? ReviewPalette.added : proposal.decision == "request_changes" ? ReviewPalette.removed : ReviewPalette.modified
        let unplaced = proposal.unplaced(in: model.files)
        HStack(alignment: .top, spacing: 12) {
            Text(proposal.decision.replacingOccurrences(of: "_", with: " ").uppercased())
                .font(.system(size: 10.5, weight: .bold))
                .foregroundColor(.black.opacity(0.85))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Capsule().fill(color))
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text("\(proposal.agent) reviewed \(proposal.label)").font(.system(size: 12, weight: .semibold))
                    if let confidence = proposal.confidence {
                        Text(verbatim: "[\(confidence)%]").font(.system(size: 11.5, design: .monospaced)).foregroundColor(ReviewPalette.dim)
                    }
                    Text(verbatim: "\(drafts.count) drafts · \(tally["proposed"] ?? 0) open · \(tally["accepted"] ?? 0) accepted · \((tally["edited"] ?? 0)) edited · \(tally["rejected"] ?? 0) rejected")
                        .font(.system(size: 11.5))
                        .foregroundColor(ReviewPalette.dim)
                    if unplaced > 0 {
                        Text(verbatim: "\(unplaced) not in this diff")
                            .font(.system(size: 11.5))
                            .foregroundColor(ReviewPalette.modified)
                    }
                }
                Text(proposal.summary)
                    .font(.system(size: 12.5))
                    .foregroundColor(Color.white.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 10).fill(color.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(color.opacity(0.35)))
        .padding(.horizontal, 12)
        .padding(.top, 10)
    }
}

private struct LargeDiffBanner: View {
    @ObservedObject var model: ReviewModel

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "info.circle")
                .foregroundColor(ReviewPalette.dim)
            Text("This diff is large, showing one file at a time")
                .font(.system(size: 12))
            Spacer()
            IconButton(systemName: "chevron.left", tooltip: "Previous file (⌘[)") { model.step(-1) }
                .keyboardShortcut("[", modifiers: .command)
            IconButton(systemName: "chevron.right", tooltip: "Next file (⌘])") { model.step(1) }
                .keyboardShortcut("]", modifiers: .command)
        }
        .buttonStyle(.genHoverPlain())
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.05)))
        .padding(.horizontal, 12)
        .padding(.top, 10)
    }
}

private struct SidebarRow: Identifiable {
    enum Kind {
        case directory(name: String, additions: Int, deletions: Int)
        case file(DiffFile)
    }

    let id: String
    let depth: Int
    let kind: Kind
}

private final class TreeNode {
    let name: String
    let path: String
    var children: [String: TreeNode] = [:]
    var files: [DiffFile] = []

    init(name: String, path: String) {
        self.name = name
        self.path = path
    }

    var totals: (Int, Int) {
        let own = files.reduce((0, 0)) { ($0.0 + $1.additions, $0.1 + $1.deletions) }
        return children.values.reduce(own) { sum, child in
            let t = child.totals
            return (sum.0 + t.0, sum.1 + t.1)
        }
    }
}

/// Flat: one header per directory, like GitHub's file list. Tree: nested folders, where a chain of
/// single-child folders collapses into one row (`src/browser-router/lib`), like Codex's review pane.
private func sidebarRows(_ files: [DiffFile], tree: Bool, collapsed: Set<String>) -> [SidebarRow] {
    guard tree else {
        let grouped = Dictionary(grouping: files, by: \.directory)
        return grouped.keys.sorted().flatMap { directory -> [SidebarRow] in
            let group = grouped[directory] ?? []
            let header = directory.isEmpty
                ? []
                : [SidebarRow(id: "dir:\(directory)", depth: 0, kind: .directory(name: directory, additions: 0, deletions: 0))]
            return header + group.map { SidebarRow(id: $0.id, depth: 0, kind: .file($0)) }
        }
    }

    let root = TreeNode(name: "", path: "")
    for file in files {
        var node = root
        for part in file.directory.split(separator: "/").map(String.init) where !file.directory.isEmpty {
            let path = node.path.isEmpty ? part : "\(node.path)/\(part)"
            if node.children[part] == nil {
                node.children[part] = TreeNode(name: part, path: path)
            }
            node = node.children[part]!
        }
        node.files.append(file)
    }

    var rows: [SidebarRow] = []
    func walk(_ node: TreeNode, depth: Int) {
        for child in node.children.values.sorted(by: { $0.name < $1.name }) {
            var folder = child
            var label = child.name
            while folder.files.isEmpty, folder.children.count == 1, let only = folder.children.values.first {
                folder = only
                label += "/\(only.name)"
            }
            let totals = folder.totals
            let id = "dir:\(folder.path)"
            rows.append(SidebarRow(id: id, depth: depth, kind: .directory(name: label, additions: totals.0, deletions: totals.1)))
            if !collapsed.contains(id) {
                walk(folder, depth: depth + 1)
            }
        }
        for file in node.files.sorted(by: { $0.name < $1.name }) {
            rows.append(SidebarRow(id: file.id, depth: depth, kind: .file(file)))
        }
    }
    walk(root, depth: 0)
    return rows
}

private struct FileSidebar: View {
    @ObservedObject var model: ReviewModel

    var body: some View {
        let rows = sidebarRows(model.filteredFiles, tree: model.treeMode && model.filter.isEmpty, collapsed: model.collapsed)
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass")
                        .foregroundColor(ReviewPalette.dim)
                    TextField("Filter files…", text: $model.filter)
                        .textFieldStyle(.plain)
                }
                .padding(.horizontal, 10)
                .frame(height: 30)
                .background(RoundedRectangle(cornerRadius: 8).stroke(ReviewPalette.hairline))
                Button {
                    model.treeMode.toggle()
                } label: {
                    Image(systemName: model.treeMode ? "list.bullet.indent" : "list.bullet")
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip(model.treeMode ? "Tree view (click for flat list)" : "Flat list (click for tree view)")
            }
            .padding(.horizontal, 10)
            .padding(.top, 52)
            .padding(.bottom, 8)

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(rows) { row in
                            switch row.kind {
                            case .directory(let name, let additions, let deletions):
                                DirectoryRow(
                                    name: name,
                                    depth: row.depth,
                                    additions: additions,
                                    deletions: deletions,
                                    tree: model.treeMode && model.filter.isEmpty,
                                    collapsed: model.collapsed.contains(row.id)
                                )
                                .rowButton(cornerRadius: 5) {
                                    if model.collapsed.contains(row.id) {
                                        model.collapsed.remove(row.id)
                                    } else {
                                        model.collapsed.insert(row.id)
                                    }
                                }
                            case .file(let file):
                                FileRow(file: file, selected: file.id == model.selectedID, depth: row.depth)
                                    .id(file.id)
                                    .rowButton(cornerRadius: 5) { model.select(file.id) }
                            }
                        }
                    }
                    .padding(.bottom, 12)
                }
                .onChange(of: model.sidebarScrollTarget) { id in
                    guard let id else { return }
                    // Unfold the folders above the target so the row exists, then scroll only as far as needed.
                    for folder in model.collapsed where id.hasPrefix(String(folder.dropFirst(4)) + "/") {
                        model.collapsed.remove(folder)
                    }
                    DispatchQueue.main.async {
                        proxy.scrollTo(id)
                    }
                }
            }
        }
        .background(ReviewPalette.sidebar)
    }
}

private struct DirectoryRow: View {
    let name: String
    let depth: Int
    let additions: Int
    let deletions: Int
    let tree: Bool
    let collapsed: Bool

    var body: some View {
        HStack(spacing: 6) {
            if tree {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .rotationEffect(.degrees(collapsed ? 0 : 90))
                    .foregroundColor(ReviewPalette.dim)
                    .frame(width: 10)
            }
            Text(name)
                .font(.system(size: 11.5, weight: .medium))
                .foregroundColor(ReviewPalette.dim)
                .lineLimit(1)
                .truncationMode(.head)
            Spacer(minLength: 4)
            if tree && collapsed {
                if additions > 0 {
                    Text(verbatim: "+\(additions)").foregroundColor(ReviewPalette.added.opacity(0.7))
                }
                if deletions > 0 {
                    Text(verbatim: "−\(deletions)").foregroundColor(ReviewPalette.removed.opacity(0.7))
                }
            }
        }
        .font(.system(size: 11, design: .monospaced))
        .padding(.leading, 12 + CGFloat(depth) * 14)
        .padding(.trailing, 12)
        .padding(.top, tree ? 0 : 8)
        .frame(height: tree ? 24 : 30, alignment: .bottom)
        .contentShape(Rectangle())
    }
}

private struct FileRow: View {
    let file: DiffFile
    let selected: Bool
    var depth = 0

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(ReviewPalette.color(file.status))
                .frame(width: 6, height: 6)
            Text(file.name)
                .font(.system(size: 12.5))
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 4)
            if file.skipped != nil {
                Image(systemName: "doc.badge.ellipsis")
                    .foregroundColor(ReviewPalette.dim)
            }
            if file.additions > 0 {
                Text(verbatim: "+\(file.additions)")
                    .foregroundColor(ReviewPalette.added)
            }
            if file.deletions > 0 {
                Text(verbatim: "−\(file.deletions)")
                    .foregroundColor(ReviewPalette.removed)
            }
        }
        .font(.system(size: 11, design: .monospaced))
        .padding(.leading, 12 + CGFloat(depth) * 14)
        .padding(.trailing, 12)
        .frame(height: 26)
        .background(
            RoundedRectangle(cornerRadius: 7)
                .fill(selected ? Color.white.opacity(0.08) : Color.clear)
                .overlay(RoundedRectangle(cornerRadius: 7).stroke(selected ? Color.accentColor.opacity(0.6) : Color.clear))
        )
        .padding(.horizontal, 6)
        .contentShape(Rectangle())
        .instantTooltip(file.path)
    }
}

/// SwiftUI gets a fresh container per `makeNSView`; the renderer's one long-lived view moves into
/// whichever container is current. Handing SwiftUI the same NSView from two makeNSView calls (the
/// hub re-creates this view on tab and header changes) crashed layout in StackLayout.sizeThatFits.
private struct RendererHost: NSViewRepresentable {
    let renderer: DiffRenderer

    func makeNSView(context: Context) -> NSView {
        let container = NSView()
        attach(to: container)
        return container
    }

    func updateNSView(_ container: NSView, context: Context) {
        if renderer.view.superview !== container {
            attach(to: container)
        }
    }

    private func attach(to container: NSView) {
        let view = renderer.view
        view.removeFromSuperview()
        view.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            view.topAnchor.constraint(equalTo: container.topAnchor),
            view.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
    }
}

// MARK: - Live reload

/// FSEvents on the repository with the stream's own latency as the debounce; `.git/` noise is
/// ignored except the index and HEAD, which move on commit, checkout and stage.
/// The stream holds this box (retained, released by the stream), never the watcher itself, so an
/// event queued after the watcher is gone finds a nil reference instead of freed memory.
private final class RepoWatcherBox {
    weak var watcher: RepoWatcher?

    init(_ watcher: RepoWatcher) {
        self.watcher = watcher
    }
}

private final class RepoWatcher {
    private var stream: FSEventStreamRef?
    private let onChange: () -> Void
    private let root: String

    init(root: URL, onChange: @escaping () -> Void) {
        self.root = root.path
        self.onChange = onChange
        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passRetained(RepoWatcherBox(self)).toOpaque(),
            retain: nil,
            release: { info in
                if let info {
                    Unmanaged<RepoWatcherBox>.fromOpaque(info).release()
                }
            },
            copyDescription: nil
        )
        let callback: FSEventStreamCallback = { _, info, count, paths, _, _ in
            guard let info, let watcher = Unmanaged<RepoWatcherBox>.fromOpaque(info).takeUnretainedValue().watcher else { return }
            let list = unsafeBitCast(paths, to: NSArray.self) as? [String] ?? []
            if list.prefix(count).contains(where: watcher.matters) {
                watcher.onChange()
            }
        }
        stream = FSEventStreamCreate(
            nil,
            callback,
            &context,
            [root.path] as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            0.35,
            FSEventStreamCreateFlags(kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagFileEvents)
        )
        if let stream {
            FSEventStreamSetDispatchQueue(stream, DispatchQueue.main)
            FSEventStreamStart(stream)
        }
    }

    deinit {
        if let stream {
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
        }
    }

    private func matters(_ path: String) -> Bool {
        if path.contains("/node_modules/") || path.contains("/.build/") {
            return false
        }

        if path.contains("/.git/") {
            return path.hasSuffix("/.git/index") || path.hasSuffix("/.git/HEAD")
        }

        return true
    }
}

// MARK: - Snapshot

/// Writes the window as a PNG without Screen Recording: the SwiftUI chrome through
/// `cacheDisplay`, the web content through WKWebView's own snapshot, composited at its frame.
enum ReviewSnapshot {
    static func write(window: NSWindow, webView: WKWebView?, to path: String, done: @escaping () -> Void) {
        guard let content = window.contentView else {
            done()
            return
        }

        let bounds = content.bounds
        guard let rep = content.bitmapImageRepForCachingDisplay(in: bounds) else {
            done()
            return
        }

        content.cacheDisplay(in: bounds, to: rep)
        let image = NSImage(size: bounds.size)
        image.addRepresentation(rep)

        guard let webView else {
            save(image, to: path)
            done()
            return
        }

        webView.takeSnapshot(with: nil) { webImage, _ in
            if let webImage {
                var frame = webView.convert(webView.bounds, to: content)
                if content.isFlipped {
                    frame.origin.y = bounds.height - frame.maxY
                }
                let composed = NSImage(size: bounds.size)
                composed.lockFocus()
                image.draw(in: bounds)
                webImage.draw(in: frame)
                composed.unlockFocus()
                save(composed, to: path)
            } else {
                save(image, to: path)
            }
            done()
        }
    }

    private static func save(_ image: NSImage, to path: String) {
        guard let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:])
        else { return }
        try? png.write(to: URL(fileURLWithPath: path))
    }
}
