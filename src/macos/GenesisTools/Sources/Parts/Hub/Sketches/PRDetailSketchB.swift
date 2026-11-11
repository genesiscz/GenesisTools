import AppKit
import SwiftUI

// Hub UX wave 2, area "prDetail", option B (design sketch, `--sketch prDetail=b`): the PR is one document with tabs
// (Overview, Changes, Threads, Commits, Checks). One header, one tab row that also holds the open tab's own controls,
// and under it ONE full-width pane: no overview column beside the diff, no Files pane, no threads bar
// (catalog C13, C14, C62, C27). The file tree opens on demand from the Changes tab's Files button.
// The current view is `PRDetailView` (Hub/HubPRs.swift); this file is the whole option, so a pick is one move and the
// losing option is one deleted file. Notes: the 2026-11-10-UXRedesign notes folder, sketches/prDetail/NOTES.md.

/// The document's tabs, in their ⌘⌥1 to ⌘⌥5 order.
private enum DocumentTab: String, CaseIterable, Hashable {
    case overview, changes, threads, commits, checks
}

struct PRDetailSketchB: View {
    var model: HubModel
    @ObservedObject var prs: PRsModel
    let pr: HubPR
    @State private var tab: DocumentTab
    @State private var reviewing = false
    @State private var launching = false
    @State private var pickingFiles = false

    init(model: HubModel, prs: PRsModel, pr: HubPR) {
        self.model = model
        _prs = ObservedObject(wrappedValue: prs)
        self.pr = pr
        // The existing "threads list open" setting (`--set review.prThreads.open=true`) opens on Threads; else the diff.
        _tab = State(initialValue: HubDefaults.store.bool(forKey: "review.prThreads.open") ? .threads : .changes)
    }

    private var detail: HubPRDetail? {
        guard let detail = prs.details[pr.id] else { return nil }
        return detail.headSha == nil || pr.headSha == nil || detail.headSha == pr.headSha ? detail : nil
    }

    var body: some View {
        let _ = RenderProbe.hit("prs.sketchB.body")
        VStack(spacing: 0) {
            header
            page
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .hubSurface(.content)
        }
        .background { tabKeys }
        .onAppear { PRChecksSection.prepareSnapshot() }
    }

    // MARK: Header (C13, C14): title row, fact line, then the tabs with the open tab's controls on the same row

    private var header: some View {
        TitlebarHeader {
            HStack(spacing: 10) {
                if let forge = Forge(kind: pr.origin?.kind) {
                    ForgeBadge(forge: forge, number: pr.number, url: URL(string: pr.url)) { ExternalOpener.open($0) }
                } else {
                    PRStateIcon(pr: pr)
                    ExternalLink(text: pr.label, url: URL(string: pr.url), font: .system(size: 13, weight: .semibold),
                                 color: Color(red: 0.62, green: 0.78, blue: 1))
                }
                Text(pr.title)
                    .font(.system(size: 15, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .instantTooltip(pr.title)
                    .contextMenu {
                        Button("Copy title") { Clipboard.copy(pr.title, what: "title") }
                        Button("Copy \(pr.label) and title") { Clipboard.copy("\(pr.label) \(pr.title)", what: "title") }
                    }
                    .layoutPriority(1)
                PRHeaderState(pr: pr, mergeable: detail?.mergeable)
                CIBadge(ci: pr.ci, url: detail?.webUrls?.checks.flatMap(URL.init(string:)))
                Spacer()
                if let notice = model.headerNotice {
                    NoticePill(text: notice.text, tone: notice.tone) { model.headerNotice = nil }
                }
                if prs.review == nil, let fetch = prs.fetchState(pr) {
                    PRFetchStatus(pr: pr, state: fetch) { prs.retryFetch(pr) }
                }
                if let path = pr.localWorktree ?? pr.repoRoot {
                    Button {
                        reviewing = true
                    } label: {
                        Label(pr.proposal == nil ? "Review with agent" : "Review again", systemImage: "checklist")
                    }
                    .instantTooltip("Start an agent that reviews this PR and pushes its verdict and draft comments here; nothing is posted")
                    .popover(isPresented: $reviewing, arrowEdge: .bottom) {
                        LaunchPicker(mode: .new(cwd: path, name: "review \(pr.repo) \(pr.label)", prompt: PRDetailView.reviewPrompt(pr))) { outcome in
                            reviewing = false
                            model.postLaunchNotice(outcome)
                        }
                    }
                }
                moreMenu
                    .popover(isPresented: $launching, arrowEdge: .bottom) {
                        if let path = pr.localWorktree {
                            LaunchPicker(mode: .new(cwd: path, name: "\(pr.repo) \(pr.label)")) { outcome in
                                launching = false
                                model.postLaunchNotice(outcome)
                            }
                        }
                    }
            }
        } details: {
            VStack(alignment: .leading, spacing: 8) {
                facts
                if let notice = prs.notice, notice.ref.matches(pr) {
                    NoticePill(text: notice.text, isError: notice.isError) { prs.notice = nil }
                }
                HStack(spacing: 12) {
                    GenSegmentedTabs("PR", items: DocumentTab.allCases.map { GenSegmentedTabs.Item($0, title($0)) },
                                     selection: $tab, minSegmentWidth: 64, identifier: "prDetail.tabs")
                    Spacer(minLength: 8)
                    tabControls
                }
                .font(.system(size: 12))
                .lineLimit(1)
                .buttonStyle(.genHoverPlain())
            }
        }
    }

    /// Who, which branches, how big: the PR's totals once, here.
    private var facts: some View {
        HStack(spacing: 10) {
            ExternalLink(text: pr.author ?? "unknown", url: pr.authorURL, font: .system(size: 11.5),
                         icon: "person.crop.circle", glyph: .onHover, tooltip: pr.author.map { "\($0)'s profile" })
            HStack(spacing: 4) {
                let font = Font.system(size: 11.5, design: .monospaced)
                ExternalLink(text: pr.headBranch, url: pr.headBranchURL, font: font, glyph: .onHover, tooltip: "Head branch \(pr.headBranch)")
                    .layoutPriority(1)
                ExternalLink(text: "→", url: pr.compareURL, font: font, glyph: .onHover, tooltip: "Compare \(pr.baseBranch)...\(pr.headBranch)")
                ExternalLink(text: pr.baseBranch, url: pr.baseBranchURL, font: font, glyph: .onHover, tooltip: "Base branch \(pr.baseBranch)")
            }
            if let add = detail?.additions, let del = detail?.deletions {
                HStack(spacing: 5) {
                    Text(verbatim: "+\(add)").foregroundColor(ReviewPalette.added)
                    Text(verbatim: "−\(del)").foregroundColor(ReviewPalette.removed)
                }
                .font(.system(size: 11.5, design: .monospaced))
                .accessibilityElement(children: .combine)
                .accessibilityLabel(Text(verbatim: "\(Plural.count(add, "line")) added, \(del) removed"))
            }
            if let approvals = pr.approvals, approvals > 0 {
                Label("\(approvals)", systemImage: "hand.thumbsup").instantTooltip(Plural.count(approvals, "approval"))
            }
            ForEach(pr.labels, id: \.self) { label in
                PRLabelPill(pr: pr, label: label)
            }
            if let path = pr.localWorktree {
                PathLabel(path: path)
            }
            Spacer(minLength: 0)
        }
        .font(.system(size: 11.5))
        .foregroundColor(ReviewPalette.dim)
        .lineLimit(1)
    }

    /// Each tab names its count: the number lives on the tab that shows the counted things.
    private func title(_ tab: DocumentTab) -> String {
        switch tab {
        case .overview: return "Overview"
        case .changes:
            let count = detail?.changedFiles ?? prs.review?.files.count ?? 0
            return count > 0 ? "Changes \(count)" : "Changes"
        case .threads:
            if let payload = prs.review?.pr?.payload { return "Threads \(PRThreadCounts(payload.threads).open)" }
            return "Threads"
        case .commits:
            let count = detail?.commitsTotal ?? detail?.commits?.count ?? 0
            return count > 0 ? "Commits \(count)" : "Commits"
        case .checks:
            let failed = (detail?.checks ?? []).filter { $0.status == "failed" }.count
            return failed > 0 ? "Checks \(failed)✕" : "Checks"
        }
    }

    /// The open tab's own controls, at the end of the tab row: nothing else sits between the tabs and the page.
    @ViewBuilder
    private var tabControls: some View {
        switch tab {
        case .changes:
            if let review = prs.review {
                ChangesControls(review: review, pr: pr, pickingFiles: $pickingFiles)
            }
        case .threads:
            if let store = prs.review?.pr, let payload = store.payload {
                let counts = PRThreadCounts(payload.threads)
                Text(verbatim: "\(counts.open) open · \(counts.outdated) outdated · \(counts.total) in all")
                    .foregroundColor(ReviewPalette.dim)
                // Sketch: inert. The current Submit review form is private to the threads bar; the pick moves it here.
                Button("Submit review…") {}
                    .disabled(true)
                    .instantTooltip("Publish your pending drafts as one review. In this sketch the button is not wired yet.")
            }
        case .overview, .commits, .checks:
            EmptyView()
        }
    }

    /// The rare PR actions in one menu: the review window, a new session, the host's pages, copies.
    private var moreMenu: some View {
        MenuButton(style: .genHoverIcon()) {
            var items: [MenuButtonItem] = []
            if prs.review != nil {
                items.append(.action("Open in Its Own Review Window") { prs.openInReviewWindow(pr) })
            }
            if pr.localWorktree != nil {
                items.append(.action("New Session in the PR's Worktree…") { launching = true })
            }
            if let web = detail?.webUrls {
                items.append(.divider)
                if let files = web.files.flatMap(URL.init(string:)) { items.append(.action("Open Files on the Host") { ExternalOpener.open(files) }) }
                if let commits = web.commits.flatMap(URL.init(string:)) { items.append(.action("Open Commits on the Host") { ExternalOpener.open(commits) }) }
                if let checks = web.checks.flatMap(URL.init(string:)) { items.append(.action("Open Checks on the Host") { ExternalOpener.open(checks) }) }
            }
            items.append(.divider)
            items.append(.action("Copy Title") { Clipboard.copy(pr.title, what: "title") })
            items.append(.action("Copy Link") { PathOpener.copy(pr.url) })
            return items
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.system(size: 14))
                .foregroundColor(ReviewPalette.dim)
        }
        .instantTooltip("More: the review window, a new session, the host's pages")
        .accessibilityLabel(Text("More PR actions"))
    }

    /// ⌘⌥1 to ⌘⌥5 pick a tab, in the order they show.
    private var tabKeys: some View {
        ZStack {
            ForEach(Array(DocumentTab.allCases.enumerated()), id: \.offset) { index, item in
                Button("") { tab = item }
                    .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: [.command, .option])
            }
        }
        .opacity(0)
        .frame(width: 0, height: 0)
        .accessibilityHidden(true)
    }

    // MARK: The page (C62): one pane at the full width

    @ViewBuilder
    private var page: some View {
        switch tab {
        case .overview:
            overview
        case .changes:
            if let review = prs.review {
                DiffColumn(review: review)
            } else if prs.fetchState(pr) == .fetching {
                DiffSkeleton()
            } else {
                EmptyState(symbol: "arrow.down.circle", text: "The diff is not on this Mac yet",
                           detail: "The PR's head is fetched into its repository when you open it.")
            }
        case .threads:
            if let review = prs.review, let store = review.pr {
                // A thread's text stops at a width a reader can follow: at the pane's full width (about 1,600 pt at the
                // shot size) one line of a comment held some 250 characters.
                PRThreadsList(model: review, store: store)
                    .frame(maxWidth: Self.threadsMeasure)
                    .frame(maxWidth: .infinity)
            } else {
                EmptyState(symbol: "bubble.left.and.bubble.right", text: "The review threads arrive with the PR's head")
            }
        case .commits:
            readable {
                if let commits = detail?.commits, !commits.isEmpty {
                    if let review = prs.review {
                        // A commit opens its diff: the Changes tab, scoped to that commit.
                        PRCommitsSection(prs: prs, review: review, pr: pr, commits: commits, total: detail?.commitsTotal,
                                         folded: .constant(false)) { tab = .changes }
                    } else {
                        let authors = PRCommitRow.showsAuthors(commits)
                        ForEach(commits.reversed()) { commit in
                            PRCommitRow(pr: pr, commit: commit, selected: false, inApp: false, showsAuthor: authors) {
                                if let url = pr.commitURL(commit.sha) { ExternalOpener.open(url) }
                            }
                            .equatable()
                        }
                    }
                } else {
                    SkeletonLines(count: 6).skeletonShimmer()
                }
            }
        case .checks:
            if let checks = detail?.checks, !checks.isEmpty {
                readable {
                    PRChecksSection(model: model, pr: pr, checks: checks, folded: .constant(false))
                }
            } else {
                EmptyState(symbol: "checkmark.seal", text: detail == nil ? "Reading the checks" : "No checks on this PR")
            }
        }
    }

    /// The widest the Threads page runs: the cards keep their header controls on one line and the comment text stays
    /// near 150 characters a line.
    private static let threadsMeasure: CGFloat = 1040

    /// A list in a column a reader can follow (about 900 pt), centred in a wide window.
    private func readable<Content: View>(@ViewBuilder _ content: @escaping () -> Content) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0, content: content)
                .padding(.horizontal, 24)
                .padding(.vertical, 18)
                .frame(maxWidth: 900, alignment: .leading)
                .frame(maxWidth: .infinity)
        }
    }

    /// The description in full, as a page, then the agent sessions on the PR.
    private var overview: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let body = detail?.body?.trimmed, !body.isEmpty {
                    PRDescriptionView(markdown: linkedDescription(body), whole: true, foldHeight: PRDescriptionView.minimumFold) { _ in }
                        .environment(\.openURL, OpenURLAction { url in
                            if let id = PRDescriptionLinker.prID(from: url) {
                                if !prs.open(id: id) { model.post("That PR is no longer in the list", .warning) }
                            } else {
                                ExternalOpener.open(url)
                            }
                            return .handled
                        })
                } else if detail == nil {
                    SkeletonLines(count: 8).skeletonShimmer()
                } else {
                    Text("No description").foregroundColor(ReviewPalette.dim)
                }
                LazyVStack(alignment: .leading, spacing: 0) {
                    PRSessionsSection(model: model, prs: prs, store: prs.sessions, pr: pr, folded: .constant(false))
                }
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 18)
            .frame(maxWidth: 900, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
    }

    /// The description with its links, as the current overview makes it.
    private func linkedDescription(_ body: String) -> String {
        let siblings = prs.prs.filter { $0.project == pr.project }
        let key = ["sketchB", pr.id, body, (prs.details[pr.id]?.branchMentions ?? []).joined(separator: " "),
                   siblings.map { "\($0.number)\($0.isGitLab ? "!" : "#")\($0.headBranch)>\($0.baseBranch)" }.sorted().joined(separator: " ")]
            .joined(separator: "\u{1}")
        return PRDescriptionCache.linked(key: key) {
            var branches = Set(prs.details[pr.id]?.branchMentions ?? [])
            for other in siblings + [pr] {
                branches.insert(other.headBranch)
                branches.insert(other.baseBranch)
            }
            let gitLab = pr.isGitLab
            let context = PRLinkContext(forge: pr.forge, branches: branches) { number in
                siblings.first { $0.number == number && $0.isGitLab == gitLab }?.id
            }
            return PRDescriptionLinker.linkify(body, context: context)
        }
    }
}

// MARK: - The Changes tab's controls

/// Files (the tree on demand, C27), the scope, the scope's own totals when it is not the whole PR, then the view
/// controls. They sit on the tab row, so the diff starts right under it.
private struct ChangesControls: View {
    @ObservedObject var review: ReviewModel
    let pr: HubPR
    @Binding var pickingFiles: Bool
    @State private var pickingCommit = false
    @State private var pickingAgent = false

    /// The scope the hub opens a PR with: the PR's base against its head, under the hub's own label (`PRsModel.scope`).
    /// `review.prScope` describes the same range under another label, so the two never compare equal as values.
    private var wholePR: Bool {
        guard case .range(_, _, let label, _) = review.scope else { return false }
        return label == "\(pr.label) vs \(pr.baseBranch)"
    }

    var body: some View {
        HStack(spacing: 10) {
            Button { pickingFiles = true } label: {
                Label("Files", systemImage: "list.bullet.indent").fixedSize()
            }
            .instantTooltip("The changed files as a tree with a filter; a click scrolls the diff to the file")
            .popover(isPresented: $pickingFiles, arrowEdge: .bottom) {
                FileSidebar(model: review)
                    .frame(width: 380, height: 560)
                    .hubSurface(.content)
            }
            scopeChip
            if review.loading {
                ProgressView().controlSize(.small).instantTooltip("Reading the diff")
            }
            if !wholePR {
                let totals = review.totals
                Text(verbatim: "+\(totals.additions)").foregroundColor(ReviewPalette.added)
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                Text(verbatim: "−\(totals.deletions)").foregroundColor(ReviewPalette.removed)
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
            }
            if review.unsentCount > 0 {
                Button { pickingAgent = true } label: {
                    Label("Send \(Plural.count(review.unsentCount, "comment"))…", systemImage: "paperplane").fixedSize()
                }
                .instantTooltip("Pick the agent session that gets the queued comments")
                .popover(isPresented: $pickingAgent, arrowEdge: .bottom) {
                    AgentSendForm(model: review) { pickingAgent = false }
                }
            }
            Divider().frame(height: 16)
            GenSegmentedTabs("Diff layout", items: [.init(DiffViewOptions.Style.unified, "Unified"), .init(DiffViewOptions.Style.split, "Split")],
                             selection: Binding(get: { review.options.diffStyle }, set: { review.setStyle($0) }),
                             minSegmentWidth: 56, identifier: "prDetail.diffLayout")
            IconButton(systemName: review.options.wrap ? "text.alignleft" : "arrow.left.and.right.text.vertical",
                       tooltip: review.options.wrap ? "Long lines wrap (click to scroll instead)" : "Long lines scroll (click to wrap)") {
                review.toggleWrap()
            }
            IconButton(systemName: "magnifyingglass", tooltip: HubKeymap.hint("Find in every file of the diff", HubKeymap.findOpen)) { review.find() }
            IconButton(systemName: "arrow.clockwise", tooltip: review.reloadTooltip) { review.reloadAll() }
        }
        .sheet(isPresented: $review.showsComparePicker) {
            if let store = review.versions {
                ComparePushesSheet(model: review, store: store)
            }
        }
    }

    /// The scope as words: "All changes vs master" for the PR's own range, never "#507" a second time.
    private var scopeChip: some View {
        let chip: (title: String, detail: String?, mono: Bool) = {
            if wholePR { return ("All changes", "vs \(pr.baseBranch)", false) }
            switch review.scope {
            case .commit(let sha, let title): return (String(sha.prefix(7)), title, true)
            case .branch: return ("Branch", "vs \(review.base ?? "base")", false)
            default: return (review.scope.title, nil, false)
            }
        }()
        return MenuButton(items: { ScopeMenu.items(model: review) { pickingCommit = true } }) {
            GitPickerChip(systemImage: review.scope.symbol, title: chip.title, detail: chip.detail, monospacedTitle: chip.mono)
        }
        .frame(minWidth: 80, maxWidth: 320, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .instantTooltip("What this diff compares: the whole PR, one commit, a range or a push. The text size is in View.")
        .gitCommitPopover(isPresented: $pickingCommit, choices: review.commits.map { GitCommitChoice($0) }, selection: shownCommit,
                          title: "Commits ahead of \(review.base ?? "the base")", details: GitCommitDetailsLoader(folder: review.repo),
                          onPick: { choice in review.setScope(.commit(sha: choice.sha, title: choice.subject)) },
                          onPickRange: { range in
                              if let scope = ScopeMenu.rangeScope(range) { review.setScope(scope) }
                          })
    }

    private var shownCommit: String? {
        if case .commit(let sha, _) = review.scope { return sha }
        return nil
    }
}

// MARK: - The diff

/// The review's web diff without the review header and threads bar around it (`ReviewRootView` draws both).
private struct DiffColumn: View {
    @ObservedObject var review: ReviewModel

    var body: some View {
        Group {
            if let error = review.error {
                Text(error)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundColor(ReviewPalette.removed)
                    .padding(12)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else if review.files.isEmpty && !review.loading {
                EmptyState(symbol: "checkmark.circle", text: review.emptyMessage)
            } else {
                DiffHost(renderer: review.renderer)
                    .overlay {
                        if review.files.isEmpty && review.loading {
                            DiffSkeleton()
                                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                                .hubSurface(.content)
                        }
                    }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onGeometryChange(for: Bool.self, of: { $0.size.width > 0 && $0.size.width < ReviewRootView.wrapBelow }) { review.fitWrap(narrow: $0) }
        .onGeometryChange(for: Bool.self, of: { $0.size.width > 0 && $0.size.width < HubDiffLayout.autoSplitBelow }) { review.fitStyle(narrow: $0) }
        .onAppear { review.start() }
        .onDisappear { review.stop() }
    }
}

/// The renderer's one web view, claimed by the container that enters a window (the rule of `RendererHost` in
/// Review/ReviewWindow.swift, which is private there; the pick makes that one shared instead of this copy).
private struct DiffHost: NSViewRepresentable {
    let renderer: DiffRenderer
    @AppStorage(GenScrollBarStyle.key) private var scrollBars = GenScrollBarStyle.genesis.rawValue

    func makeNSView(context: Context) -> DiffHostContainer {
        renderer.setScrollBars(GenScrollBarStyle(stored: scrollBars))
        let container = DiffHostContainer()
        container.renderer = renderer
        if renderer.view.window == nil { container.claim() }
        return container
    }

    func updateNSView(_ container: DiffHostContainer, context: Context) {
        renderer.setScrollBars(GenScrollBarStyle(stored: scrollBars))
        container.renderer = renderer
        if renderer.view.superview !== container, container.window != nil, renderer.view.window == nil {
            container.claim()
        }
    }
}

private final class DiffHostContainer: NSView {
    var renderer: DiffRenderer?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil, renderer?.view.superview !== self { claim() }
    }

    func claim() {
        guard let view = renderer?.view else { return }
        view.removeFromSuperview()
        view.translatesAutoresizingMaskIntoConstraints = false
        addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: leadingAnchor),
            view.trailingAnchor.constraint(equalTo: trailingAnchor),
            view.topAnchor.constraint(equalTo: topAnchor),
            view.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }
}
