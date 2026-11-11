import AppKit
import SwiftUI

// Hub UX wave 2, area "prDetail", option A (design sketch, `--sketch prDetail=a`): one detail header, the diff in the
// middle with ONE toolbar of its own, and one trailing inspector whose tabs (About, Files, Threads, Checks, Commits)
// replace the fixed overview column, the Files pane and the threads bar (catalog C13, C14, C62, C27).
// The current view is `PRDetailView` (Hub/HubPRs.swift); this file is the whole option, so a pick is one move and the
// losing option is one deleted file. Notes: the 2026-11-10-UXRedesign notes folder, sketches/prDetail/NOTES.md.

/// The inspector's tabs, in their ⌘⌥1 to ⌘⌥5 order.
private enum InspectorTab: String, CaseIterable, Hashable {
    case about, files, threads, checks, commits
}

struct PRDetailSketchA: View {
    var model: HubModel
    @ObservedObject var prs: PRsModel
    let pr: HubPR
    @State private var tab: InspectorTab
    @State private var reviewing = false
    @State private var launching = false
    @State private var width: CGFloat = 0
    /// The reader's Show description / Show less per PR and the setting behind it: the keys the current overview uses.
    @AppStorage(HubPROverview.descriptionWholeKey, store: HubDefaults.store) private var descriptionWhole = false
    @AppStorage(HubPROverview.descriptionChoicesKey, store: HubDefaults.store) private var descriptionChoices = ""
    @State private var inspectorHeight: CGFloat = 0

    init(model: HubModel, prs: PRsModel, pr: HubPR) {
        self.model = model
        _prs = ObservedObject(wrappedValue: prs)
        self.pr = pr
        // The existing "threads list open" setting (`--set review.prThreads.open=true`) opens on Threads; else About.
        _tab = State(initialValue: HubDefaults.store.bool(forKey: "review.prThreads.open") ? .threads : .about)
    }

    /// The inspector may take 45% of the width; below its minimum it folds to a rail (the Files pane's rules).
    private static let inspectorFraction: CGFloat = 0.45
    /// Wide enough for the five tab titles and for a thread card's header on one line. At the Files pane's saved width
    /// (about 330 pt) the titles read "Threads…" and "Commits…", and a thread's author was cut in the middle.
    private static let inspectorMinWidth: CGFloat = 420
    /// The inspector's own saved width: it holds more than a file tree, so it does not take the Files pane's.
    private static let inspectorKey = "prs.sketch.inspector"

    /// The detail for the PR's current head; an older head's numbers wait for the fresh answer.
    private var detail: HubPRDetail? {
        guard let detail = prs.details[pr.id] else { return nil }
        return detail.headSha == nil || pr.headSha == nil || detail.headSha == pr.headSha ? detail : nil
    }

    var body: some View {
        let _ = RenderProbe.hit("prs.sketchA.body")
        VStack(spacing: 0) {
            header
            if let review = prs.review {
                let room = width * Self.inspectorFraction
                SideSplit(panelEdge: .trailing, maxFraction: Self.inspectorFraction) {
                    VStack(spacing: 0) {
                        DiffToolbar(review: review, pr: pr) { tab = .threads }
                        DiffColumn(review: review)
                    }
                    .flexiblePane(neighbourOf: Self.inspectorKey)
                    .hubSurface(.content)
                    ResizableSidePanel(key: Self.inspectorKey, edge: .trailing, title: "Inspector", defaultWidth: 460,
                                       minWidth: Self.inspectorMinWidth, maxWidth: max(Self.inspectorMinWidth, room),
                                       autoCollapse: width > 0 && room < Self.inspectorMinWidth) {
                        inspector(review: review)
                            .hubSurface(.content)
                    }
                }
                .measuredWidth("prs.detail", $width)
            } else if prs.fetchState(pr) == .fetching {
                HStack(spacing: 0) {
                    DiffSkeleton()
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                    Rectangle().fill(ReviewPalette.hairline).frame(width: 1)
                    inspector(review: nil)
                        .frame(width: 440)
                }
                .hubSurface(.content)
            } else {
                // No diff on this Mac: the About tab is the page.
                about
                    .hubSurface(.content)
            }
        }
        .onAppear { PRChecksSection.prepareSnapshot() }
    }

    // MARK: Header (C13, C14): one title row, one fact line, every count once

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
            HStack(spacing: 10) {
                ExternalLink(text: pr.author ?? "unknown", url: pr.authorURL, font: .system(size: 11.5),
                             icon: "person.crop.circle", glyph: .onHover, tooltip: pr.author.map { "\($0)'s profile" })
                branches
                if let files = detail?.changedFiles {
                    Text(verbatim: Plural.count(files, "file"))
                }
                if let add = detail?.additions, let del = detail?.deletions {
                    HStack(spacing: 5) {
                        Text(verbatim: "+\(add)").foregroundColor(ReviewPalette.added)
                        Text(verbatim: "−\(del)").foregroundColor(ReviewPalette.removed)
                    }
                    .font(.system(size: 11.5, design: .monospaced))
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(Text(verbatim: "\(add) lines added, \(del) removed"))
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
            if let notice = prs.notice, notice.ref.matches(pr) {
                NoticePill(text: notice.text, isError: notice.isError) { prs.notice = nil }
                    .padding(.top, 6)
            }
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

    /// `head → base`, each a host link, shortened in the middle.
    private var branches: some View {
        let font = Font.system(size: 11.5, design: .monospaced)
        return HStack(spacing: 4) {
            ExternalLink(text: pr.headBranch, url: pr.headBranchURL, font: font, glyph: .onHover, tooltip: "Head branch \(pr.headBranch)")
                .layoutPriority(1)
            ExternalLink(text: "→", url: pr.compareURL, font: font, glyph: .onHover, tooltip: "Compare \(pr.baseBranch)...\(pr.headBranch)")
            ExternalLink(text: pr.baseBranch, url: pr.baseBranchURL, font: font, glyph: .onHover, tooltip: "Base branch \(pr.baseBranch)")
        }
    }

    // MARK: Inspector (C62, C27): one pane, five tabs

    private func tabTitle(_ tab: InspectorTab, review: ReviewModel?) -> String {
        switch tab {
        case .about: return "About"
        case .files:
            // The file count is on the header's fact line; a second copy here was the "counts twice" defect (C14).
            return "Files"
        case .threads:
            if let payload = review?.pr?.payload { return "Threads \(PRThreadCounts(payload.threads).open)" }
            return "Threads"
        case .checks:
            let failed = (detail?.checks ?? []).filter { $0.status == "failed" }.count
            return failed > 0 ? "Checks \(failed)✕" : "Checks"
        case .commits:
            let count = detail?.commitsTotal ?? detail?.commits?.count ?? 0
            return count > 0 ? "Commits \(count)" : "Commits"
        }
    }

    private func inspector(review: ReviewModel?) -> some View {
        VStack(spacing: 0) {
            GenSegmentedTabs("Inspector", items: InspectorTab.allCases.map { GenSegmentedTabs.Item($0, tabTitle($0, review: review)) },
                             selection: $tab, minSegmentWidth: 0, identifier: "prDetail.inspector")
                // Each title at its own width: equal segments cut the longest one ("Commits 743") first.
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background { tabKeys }
            Rectangle().fill(ReviewPalette.hairline).frame(height: 1)
            Group {
                switch tab {
                case .about:
                    about
                case .files:
                    if let review {
                        FileSidebar(model: review)
                    } else {
                        waiting("The changed files arrive with the PR's head")
                    }
                case .threads:
                    if let review, let store = review.pr {
                        threads(review: review, store: store)
                    } else {
                        waiting("The review threads arrive with the PR's head")
                    }
                case .checks:
                    if let checks = detail?.checks, !checks.isEmpty {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 0) {
                                PRChecksSection(model: model, pr: pr, checks: checks, folded: .constant(false))
                            }
                            .padding(14)
                        }
                    } else {
                        EmptyState(symbol: "checkmark.seal", text: detail == nil ? "Reading the checks" : "No checks on this PR")
                    }
                case .commits:
                    commits(review: review)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
    }

    /// ⌘⌥1 to ⌘⌥5 pick a tab, in the order they show.
    private var tabKeys: some View {
        ZStack {
            ForEach(Array(InspectorTab.allCases.enumerated()), id: \.offset) { index, item in
                Button("") { tab = item }
                    .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: [.command, .option])
            }
        }
        .opacity(0)
        .frame(width: 0, height: 0)
        .accessibilityHidden(true)
    }

    private func waiting(_ text: String) -> some View {
        EmptyState(symbol: "arrow.down.circle", text: text)
    }

    /// The threads tab: the counts and Submit review on top, the review window's own list under them.
    private func threads(review: ReviewModel, store: PRThreadsStore) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                if let payload = store.payload {
                    let counts = PRThreadCounts(payload.threads)
                    Text(verbatim: "\(counts.open) open · \(counts.outdated) outdated · \(counts.total) in all")
                        .foregroundColor(counts.open > 0 ? ReviewPalette.modified : ReviewPalette.dim)
                    if payload.draftCount > 0 {
                        Text(verbatim: Plural.count(payload.draftCount, "draft")).foregroundColor(ReviewPalette.dim)
                    }
                } else {
                    Text("Reading the PR's threads…").foregroundColor(ReviewPalette.dim)
                }
                Spacer(minLength: 6)
                // Sketch: inert. The current Submit review form is private to the threads bar; the pick moves it here.
                Button("Submit review…") {}
                    .disabled(true)
                    .instantTooltip("Publish your pending drafts as one review. In this sketch the button is not wired yet.")
            }
            .font(.system(size: 12))
            .lineLimit(1)
            .buttonStyle(.genHoverPlain())
            .padding(.horizontal, 12)
            .frame(height: 32)
            Rectangle().fill(ReviewPalette.hairline).frame(height: 1)
            PRThreadsList(model: review, store: store, compact: true)
        }
    }

    private func commits(review: ReviewModel?) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if let commits = detail?.commits, !commits.isEmpty {
                    if let review {
                        PRCommitsSection(prs: prs, review: review, pr: pr, commits: commits, total: detail?.commitsTotal,
                                         folded: .constant(false)) {}
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
            .padding(14)
        }
    }

    /// About: the description (folded as the current overview folds it), then the agent sessions on the PR.
    private var about: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let body = detail?.body?.trimmed, !body.isEmpty {
                    PRDescriptionView(markdown: linkedDescription(body), whole: descriptionShownWhole,
                                      foldHeight: PRDescriptionView.foldHeight(column: inspectorHeight)) { whole in
                        descriptionChoices = PRDescriptionChoices.set(descriptionChoices, pr: pr.id, whole: whole)
                    }
                    .environment(\.openURL, OpenURLAction { url in
                        if let id = PRDescriptionLinker.prID(from: url) {
                            if !prs.open(id: id) { model.post("That PR is no longer in the list", .warning) }
                        } else {
                            ExternalOpener.open(url)
                        }
                        return .handled
                    })
                } else if detail == nil {
                    SkeletonLines(count: 6).skeletonShimmer()
                } else {
                    Text("No description").foregroundColor(ReviewPalette.dim)
                }
                LazyVStack(alignment: .leading, spacing: 0) {
                    PRSessionsSection(model: model, prs: prs, store: prs.sessions, pr: pr, folded: .constant(false))
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onGeometryChange(for: CGFloat.self, of: { $0.size.height.rounded() }) { inspectorHeight = $0 }
    }

    private var descriptionShownWhole: Bool {
        PRDescriptionChoices.whole(descriptionChoices, pr: pr.id) ?? descriptionWhole
    }

    /// The description with its links, as the current overview makes it.
    private func linkedDescription(_ body: String) -> String {
        let siblings = prs.prs.filter { $0.project == pr.project }
        let key = ["sketchA", pr.id, body, (prs.details[pr.id]?.branchMentions ?? []).joined(separator: " "),
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

// MARK: - The diff's one toolbar

/// Scope, the open threads, then the view controls. The PR's totals are in the header; this row prints its own only
/// when the scope is not the whole PR (a commit, a range), so no number shows twice.
private struct DiffToolbar: View {
    @ObservedObject var review: ReviewModel
    let pr: HubPR
    let showThreads: () -> Void
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
                Text(verbatim: Plural.count(review.files.count, "file")).foregroundColor(ReviewPalette.dim)
            }
            if let payload = review.pr?.payload {
                let counts = PRThreadCounts(payload.threads)
                Button(action: showThreads) {
                    Label("\(counts.open) open threads", systemImage: "bubble.left.and.bubble.right")
                        .foregroundColor(counts.open > 0 ? ReviewPalette.modified : ReviewPalette.dim)
                        .fixedSize()
                }
                .instantTooltip("Open threads: unresolved and not outdated. Click for the Threads tab, where the outdated ones are too.")
            }
            Spacer(minLength: 8)
            if review.unsentCount > 0 {
                Button { pickingAgent = true } label: {
                    Label("Send \(Plural.count(review.unsentCount, "comment"))…", systemImage: "paperplane").fixedSize()
                }
                .instantTooltip("Pick the agent session that gets the queued comments")
                .popover(isPresented: $pickingAgent, arrowEdge: .bottom) {
                    AgentSendForm(model: review) { pickingAgent = false }
                }
            }
            Button {
                review.setStyle(review.options.diffStyle == .split ? .unified : .split)
            } label: {
                Text(verbatim: review.options.diffStyle == .split ? "Split" : "Unified").fixedSize()
            }
            .instantTooltip(review.options.diffStyle == .split ? "Side by side (click for one column)" : "One column (click for side by side)")
            IconButton(systemName: review.options.wrap ? "text.alignleft" : "arrow.left.and.right.text.vertical",
                       tooltip: review.options.wrap ? "Long lines wrap (click to scroll instead)" : "Long lines scroll (click to wrap)") {
                review.toggleWrap()
            }
            IconButton(systemName: "magnifyingglass", tooltip: HubKeymap.hint("Find in every file of the diff", HubKeymap.findOpen)) { review.find() }
            textSize
            IconButton(systemName: "arrow.clockwise", tooltip: review.reloadTooltip) { review.reloadAll() }
        }
        .font(.system(size: 12))
        .lineLimit(1)
        .buttonStyle(.genHoverPlain())
        .padding(.horizontal, 14)
        .frame(height: 36)
        .overlay(Rectangle().fill(ReviewPalette.hairline).frame(height: 1), alignment: .bottom)
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
        .frame(minWidth: 80, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .instantTooltip("What this diff compares: the whole PR, one commit, a range or a push")
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

    private var textSize: some View {
        let review = review
        let size = Int(review.options.fontSize)
        let standard = Int(DiffViewOptions().fontSize)
        return MenuButton(style: .genHoverPlain()) {
            [
                .action("Larger Text", enabled: size < 20) { review.stepFont(1) },
                .action("Smaller Text", enabled: size > 10) { review.stepFont(-1) },
                .divider,
                .action("Standard Size (\(standard) pt)", checked: size == standard) { review.stepFont(Double(standard - size)) },
            ]
        } label: {
            HStack(spacing: 3) {
                Image(systemName: "textformat.size").font(.system(size: 11))
                Text(verbatim: "\(size)").font(.system(size: 11, design: .monospaced))
            }
            .foregroundColor(ReviewPalette.dim)
            .fixedSize()
        }
        .fixedSize()
        .instantTooltip("Diff text size: \(size) pt")
        .accessibilityLabel(Text("Diff text size, \(size) points"))
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
