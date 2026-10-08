import AppKit
import SwiftUI

/// The PR bar above the diff: the live thread counts, Submit review, and a threads list folded
/// away by default. The main path is the diff itself: each thread card there has Reply, Resolve and
/// Edit / Delete on my drafts (web/diff-viewer/main.ts). The list also holds the outdated threads,
/// which have no line in the diff.
struct PRReviewBar: View {
    @ObservedObject var model: ReviewModel
    @ObservedObject var store: PRThreadsStore
    /// The room the diff column has for the list; the diff under it keeps at least a few lines.
    var maxListHeight: CGFloat = 900
    @AppStorage("review.prThreads.open", store: HubDefaults.store) private var open = false
    @AppStorage("review.prThreads.height", store: HubDefaults.store) private var listHeight = 260.0
    /// The standalone window's Context panel has a Threads tab: while it is open, a second list of the
    /// same threads above the diff only took the diff's room ("No thread matches" over 350 pt, 2026-10-02).
    @AppStorage(ReviewContextPanel.collapsedKey, store: HubDefaults.store) private var contextCollapsed = true
    private var listInPanel: Bool { !model.embedded && !contextCollapsed }
    @State private var submitting = false
    @State private var fixing = false
    /// The height the drag began with: the layout keeps it until release (see `threadsList`).
    @State private var dragStart: Double?
    @State private var liveHeight: Double?
    @State private var hovering = false
    @GestureState private var dragging = false

    static let minListHeight: CGFloat = 110

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "bubble.left.and.bubble.right")
                    .foregroundColor(ReviewPalette.renamed)
                if let pr = store.pr {
                    ExternalLink(text: pr.identity.label, url: URL(string: pr.webUrl ?? pr.url), font: .system(size: 12, weight: .semibold),
                                 color: Color(red: 0.62, green: 0.78, blue: 1), glyph: .onHover, tooltip: pr.title)
                        .fixedSize()
                    // Inside the hub the PR header above already links the author and both branches.
                    if !model.embedded {
                        // The first to shrink: "Submit review…" at the row's end was cut off by the window edge.
                        PRBarLinks(pr: pr)
                            .layoutPriority(-1)
                    }
                } else {
                    Text(verbatim: model.prLabel).font(.system(size: 12, weight: .semibold)).fixedSize()
                }
                summary
                    .layoutPriority(1)
                if store.loading || store.busy != nil {
                    ProgressView().controlSize(.small)
                        .instantTooltip(store.stale ? "Showing the last known threads; asking the host for the current ones" : "Loading the PR threads")
                }
                if store.stale {
                    Text(store.loading ? "refreshing" : "last known")
                        .foregroundColor(ReviewPalette.dim)
                        .fixedSize()
                        .instantTooltip(store.loading
                            ? "These threads are the last answer on disk. Reply, Resolve and Submit review wait for the host's fresh answer."
                            : "Showing a cached thread list. Refresh from the host to enable replies, resolve and submission.")
                }
                if let busy = store.busy {
                    Text(busy).foregroundColor(ReviewPalette.dim).fixedSize()
                }
                Spacer(minLength: 8)
                if !listInPanel {
                    IconButton(systemName: open ? "rectangle.topthird.inset.filled" : "list.bullet.rectangle",
                               tooltip: open ? "Hide the PR threads list" : "Show the PR threads list: reply, resolve, edit your drafts") {
                        open.toggle()
                    }
                }
                IconButton(systemName: "arrow.clockwise", tooltip: "Load the PR threads again from the host") {
                    store.load(noCache: true)
                }
                if !model.selectedThreads.isEmpty {
                    Button {
                        fixing = true
                    } label: {
                        Label("Fix \(model.selectedThreads.count) \(model.selectedThreads.count == 1 ? "thread" : "threads")…", systemImage: "wrench.and.screwdriver")
                            .labelStyle(.titleOnly)
                            .fixedSize()
                    }
                    .disabled(!store.canWrite)
                    .instantTooltip("Send the selected threads as one task to the agent that owns the branch, then focus its cmux pane (f)")
                    .popover(isPresented: $fixing, arrowEdge: .bottom) {
                        FixThreadsForm(model: model, store: store) { fixing = false }
                    }
                    IconButton(systemName: "xmark.circle", tooltip: "Clear the Fix selection") {
                        model.clearThreadSelection()
                    }
                }
                Button {
                    submitting = true
                } label: {
                    Label("Submit review…", systemImage: "paperplane.circle")
                        .labelStyle(.titleOnly)
                        .fixedSize()
                }
                .disabled(!store.canWrite || store.busy != nil)
                .instantTooltip("Publish your pending drafts as one review (Comment, Approve or Request changes); asks first")
                .popover(isPresented: $submitting, arrowEdge: .bottom) {
                    SubmitReviewForm(store: store) { submitting = false }
                }
            }
            .font(.system(size: 12))
            .buttonStyle(.genHoverPlain())
            .padding(.horizontal, 14)
            .frame(height: 34)
            // Under the row, not in it: as the row's lowest-priority item a full row squeezed the pill into
            // a narrow column that wrapped over the bar ("Draft reply saved; Submit review publishes it."
            // on three lines, 2026-10-08). A success note leaves on its own; an error stays until dismissed.
            .overlay(alignment: .topTrailing) {
                if let notice = store.notice {
                    let isError = notice.hasPrefix("Failed")
                    NoticePill(text: notice, isError: isError) { store.notice = nil }
                        .fixedSize()
                        .padding(.trailing, 14)
                        .offset(y: 38)
                        .task(id: notice) {
                            guard !isError else { return }
                            // A cancelled sleep (the overlay went away) must not clear the notice early.
                            do { try await Task.sleep(for: .seconds(6)) } catch { return }
                            if store.notice == notice { store.notice = nil }
                        }
                }
            }
            if model.showsAgentSendInline {
                // A `--snapshot --agent-send` run: the header's "Send N…" form as its popover shows it.
                AgentSendForm(model: model, previewOpen: true) { model.showsAgentSendInline = false }
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if model.showsFixFormInline {
                // A `--snapshot --fix-form` run: a popover is its own window and never reaches the PNG.
                FixThreadsForm(model: model, store: store) { model.showsFixFormInline = false }
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if open, !listInPanel {
                threadsList
            }
        }
        .overlay(Rectangle().fill(ReviewPalette.hairline).frame(height: 1), alignment: .bottom)
        // s and f from the diff: the same forms the buttons open, each still asking before it sends.
        .onChange(of: model.submitRequests) { _, _ in
            if store.canWrite, store.busy == nil { submitting = true }
        }
        .onChange(of: model.fixRequests) { _, _ in
            // The Fix button waits for the threads too; before they load there is nothing to fix.
            if store.canWrite, !model.selectedThreads.isEmpty { fixing = true }
        }
    }

    private func clamped(_ height: Double) -> CGFloat {
        min(max(Self.minListHeight, CGFloat(height)), max(Self.minListHeight, maxListHeight))
    }

    /// The list with a resizer on its bottom edge. While a drag runs, the layout keeps the height the
    /// drag began with and the list draws over the diff below (or leaves a band of the pane showing);
    /// the height is saved and the web diff reflows once, on release. Resizing the web view per drag
    /// step would lay out the diff for every step, as a side panel drag did before `HubLiveResize`.
    private var threadsList: some View {
        let slot = clamped(dragStart ?? listHeight)
        let shown = clamped(liveHeight ?? listHeight)
        return PRThreadsList(model: model, store: store)
            .frame(height: shown)
            .hubSurface(.content)
            .overlay(Rectangle().fill(ReviewPalette.hairline).frame(height: 1), alignment: .top)
            .overlay(alignment: .bottom) { resizer }
            .frame(height: slot, alignment: .top)
    }

    private var resizer: some View {
        let hot = hovering || dragStart != nil
        return ZStack {
            Rectangle()
                .fill(hot ? ReviewPalette.renamed.opacity(0.55) : Color.clear)
                .frame(height: 1)
            Capsule()
                .fill(ReviewPalette.renamed)
                .frame(width: 36, height: 4)
                .shadow(color: ReviewPalette.renamed.opacity(0.6), radius: 6)
                .opacity(hot ? 1 : 0)
                .scaleEffect(x: hot ? 1 : 0.4)
        }
        // A 10 pt target around a 1 pt line: the edge does not have to be hit to the pixel.
        .frame(height: 1)
        .frame(maxWidth: .infinity)
        .overlay(Color.clear.frame(height: 10).contentShape(Rectangle()))
        .animation(.easeOut(duration: 0.14), value: hot)
        .onHover { inside in
            if inside != hovering { hovering = inside }
        }
        .hoverCursor(.resizeUpDown)
        .onDisappear {
            if hovering { NSCursor.arrow.set() }
            hovering = false
        }
        // Global space: the handle moves with the list during the drag, so local translations would drift.
        .gesture(
            DragGesture(minimumDistance: 1, coordinateSpace: .global)
                .updating($dragging) { _, state, _ in state = true }
                .onChanged { value in dragChanged(value.translation.height) }
                .onEnded { _ in dragEnded() }
        )
        // A cancelled gesture never calls onEnded: without this the diff stayed frozen.
        .onChange(of: dragging) { _, active in
            if !active, dragStart != nil { dragEnded() }
        }
        .instantTooltip("Drag to resize the threads list")
        .accessibilityElement()
        .accessibilityLabel(Text("Resize the PR threads list"))
        .accessibilityValue(Text(verbatim: "\(Int(clamped(listHeight))) points"))
        .accessibilityAdjustableAction { direction in
            listHeight = Double(clamped(listHeight + (direction == .increment ? 40 : -40)))
        }
    }

    private func dragChanged(_ translation: CGFloat) {
        if dragStart == nil {
            dragStart = Double(clamped(listHeight))
            HubLiveResize.shared.begin("prThreads")
        }
        liveHeight = Double(clamped((dragStart ?? listHeight) + Double(translation)))
    }

    private func dragEnded() {
        // Both onEnded and the gesture-state reset call this; only the first one counts.
        guard dragStart != nil else { return }
        let final = liveHeight ?? listHeight
        HubPerf.log("review.prThreads list resized to \(Int(final))")
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            listHeight = final
            liveHeight = nil
            dragStart = nil
        }
        HubLiveResize.shared.end("prThreads")
    }

    @ViewBuilder
    private var summary: some View {
        if let payload = store.payload {
            let openCount = payload.threads.filter { !$0.resolved }.count
            let variants = Self.summaryVariants(threads: payload.threads.count, open: openCount, drafts: payload.draftCount)
            ViewThatFits(in: .horizontal) {
                ForEach(variants.indices, id: \.self) { index in
                    // The shortest one never truncates: a cut word ("0d") read as a code.
                    if index == variants.count - 1 {
                        Text(verbatim: variants[index]).fixedSize()
                    } else {
                        Text(verbatim: variants[index])
                    }
                }
            }
                .foregroundColor(openCount > 0 ? ReviewPalette.modified : ReviewPalette.dim)
                .lineLimit(1)
                .instantTooltip(model.showsLiveThreadsInline
                    ? "Threads on the PR; the ones that are not outdated also sit on their lines in the diff"
                    : "Threads on the PR; they sit on their lines only in the Branch scope or the PR's range")
        } else if let error = store.error {
            Text(verbatim: "Threads did not load: \(error)")
                .foregroundColor(ReviewPalette.removed)
                .lineLimit(1)
                .truncationMode(.tail)
                .textSelection(.enabled)
                .instantTooltip(error)
        } else {
            Text("Loading threads…").foregroundColor(ReviewPalette.dim)
        }
    }

    /// The bar's count, widest first. A narrow diff pane drops whole words before numbers, zero
    /// drafts go first of all, and a pending draft count stays to the last variant (Submit review
    /// sends them).
    static func summaryVariants(threads: Int, open: Int, drafts: Int) -> [String] {
        let draftText = drafts == 1 ? "1 draft" : "\(drafts) drafts"
        if drafts == 0 {
            return ["\(threads) threads · \(open) open", "\(open)/\(threads) open", "\(open) open"]
        }
        return ["\(threads) threads · \(open) open · \(draftText)", "\(open)/\(threads) open · \(draftText)", "\(open) open · \(draftText)", draftText]
    }
}

/// The PR's author and its branches as host links (ForgeWeb), dim until hovered: "genesiscz ·
/// feat/x → master". The head branch shortens first; the target and the author keep their width.
private struct PRBarLinks: View {
    let pr: PRInfo

    var body: some View {
        let forge = pr.forge
        let font = Font.system(size: 11.5)
        if let author = pr.author, !author.isEmpty {
            ExternalLink(text: author, url: forge?.user(author), font: font, icon: "person.crop.circle", glyph: .onHover,
                         tooltip: "\(author) opened \(pr.identity.label)")
                .frame(minWidth: 40)
        }
        if let source = pr.sourceBranch, let target = pr.targetBranch {
            ExternalLink(text: source, url: pr.sourceBranchURL, font: .system(size: 11.5, design: .monospaced), glyph: .onHover,
                         tooltip: "The PR's branch")
                .frame(minWidth: 40)
            ExternalLink(text: "→ \(target)", url: pr.compareURL,
                         font: .system(size: 11.5, design: .monospaced), glyph: .onHover, tooltip: "Compare \(target)...\(source)")
                .frame(minWidth: 50)
        }
    }
}

/// Where a thread stands against the diff on screen (`PRThreadRendering.belongs`).
enum PRThreadPlacement: Equatable {
    /// On its line in this diff. `outdatedOnHost`: the host calls it outdated (a later push moved its
    /// lines), but the diff shows the commit it was written on, so here it is current.
    case onDiff(outdatedOnHost: Bool)
    /// A later push changed its lines, and the diff is not the commit it was written on.
    case outdated
    /// Current on the PR's newest commit, which this diff does not show.
    case newerHead

    static func of(_ thread: PRThread, shownHead: String?, prHead: String?) -> PRThreadPlacement {
        if PRThreadRendering.belongs(thread, shownHead: shownHead, prHead: prHead) {
            return .onDiff(outdatedOnHost: thread.outdated)
        }

        return thread.outdated ? .outdated : .newerHead
    }

    var onDiff: Bool {
        if case .onDiff = self {
            return true
        }

        return false
    }
}

/// The threads of one file, by line.
struct PRThreadFileGroup: Identifiable, Equatable {
    let path: String
    let threads: [PRThread]

    var id: String { path }
    var name: String { (path as NSString).lastPathComponent }
    var folder: String { (path as NSString).deletingLastPathComponent }

    /// Files in the diff's order (`order`: path → position), the others after them by path; each
    /// file's threads by line.
    static func groups(_ threads: [PRThread], order: [String: Int]) -> [PRThreadFileGroup] {
        let byPath = Dictionary(grouping: threads, by: \.path)
        let paths = byPath.keys.sorted { a, b in
            let left = order[a] ?? Int.max
            let right = order[b] ?? Int.max
            return left != right ? left < right : a < b
        }
        return paths.map { path in
            PRThreadFileGroup(path: path, threads: (byPath[path] ?? []).sorted { ($0.line, $0.id) < ($1.line, $1.id) })
        }
    }

    /// A folder that wraps at its slashes, never inside a folder name.
    static func wrappable(_ folder: String) -> String {
        folder.replacingOccurrences(of: "/", with: "/\u{200B}")
    }

    /// "L12" or "L10–12".
    static func lineLabel(_ thread: PRThread) -> String {
        if let start = thread.startLine, start != thread.line {
            return "L\(min(start, thread.line))–\(max(start, thread.line))"
        }

        return "L\(thread.line)"
    }
}

/// Every thread of the PR, one group per file in the diff's order, each file's threads by line. A
/// file's header shows its whole path (name, then the folder on wrapping dim lines); a click opens the
/// file in the diff, a thread's line chip opens that thread's card.
struct PRThreadsList: View {
    @ObservedObject var model: ReviewModel
    @ObservedObject var store: PRThreadsStore
    @AppStorage("review.prThreads.thisFile", store: HubDefaults.store) private var onlyThisFile = false
    @AppStorage("review.prThreads.closed", store: HubDefaults.store) private var showClosed = false
    @State private var find = PanelFindModel(scope: "pr.threads", title: "the threads")
    /// Folded files and threads of this PR (`PRThreadFolds`), read when the PR's threads arrive.
    @State private var folded: Set<String> = []
    @State private var foldedThreads: Set<String> = []
    /// The previous visit to this PR's threads: notes by others written after it are marked new.
    @State private var seenSince: Date?
    @State private var seenFor: String?
    @State private var clicks = PRCardClicks()
    @State private var anchor = PRListAnchor()
    @State private var editors = PRThreadEditors()
    /// Whether each thread's file is still there at the PR's head (one `git ls-tree` per head).
    @ObservedObject private var headFiles = PRHeadFiles.shared
    /// A narrow side panel (the review window's Context panel, 320 pt at its minimum): the toolbar
    /// takes two rows, so nothing runs past the panel's edge.
    var compact = false

    private var shownHead: String? { model.scope.pinnedHead ?? model.remoteHead?.sha }

    private func placements(_ threads: [PRThread]) -> [String: PRThreadPlacement] {
        let prHead = store.payload?.pr.headSha
        let head = shownHead
        return Dictionary(threads.map { ($0.id, PRThreadPlacement.of($0, shownHead: head, prHead: prHead)) },
                          uniquingKeysWith: { first, _ in first })
    }

    /// "Open": not resolved and not outdated for this diff, plus every thread holding my draft.
    private static func isOpen(_ thread: PRThread, _ placement: PRThreadPlacement?) -> Bool {
        thread.comments.contains(where: \.isDraft) || (!thread.resolved && placement != .outdated)
    }

    private func visible(_ threads: [PRThread], _ placements: [String: PRThreadPlacement]) -> [PRThread] {
        let selectedPath = model.repoPath(of: model.selectedID)
        return threads
            .filter { showClosed || Self.isOpen($0, placements[$0.id]) }
            .filter { !onlyThisFile || $0.path == selectedPath }
    }

    /// The PR's head and the threads' files, when the diff shows another commit: then a file may be
    /// gone or renamed at the head. Nil when the diff is the head (every file there is there).
    private func headQuery(_ threads: [PRThread]) -> (repo: String, head: String, shown: String, paths: [String])? {
        guard let head = store.payload?.pr.headSha, !head.isEmpty, let shown = shownHead,
              !PRThreadRendering.sameCommit(head, shown), !threads.isEmpty else { return nil }
        return (model.repo.path, head, shown, Array(Set(threads.map(\.path))).sorted())
    }

    private var fileOrder: [String: Int] {
        var order: [String: Int] = [:]
        for (index, file) in model.files.enumerated() where order[file.path] == nil {
            order[file.path] = index
        }
        return order
    }

    /// Notes by someone else, written after the previous visit; none on the first visit.
    private func newNotes(_ threads: [PRThread]) -> Set<String> {
        guard let seenSince else { return [] }
        let viewer = store.payload?.viewer
        var ids = Set<String>()
        for thread in threads {
            for comment in thread.comments where !comment.isDraft && comment.author.username != viewer {
                if let created = HubFormat.date(comment.createdAt), created > seenSince {
                    ids.insert(comment.id)
                }
            }
        }
        return ids
    }

    var body: some View {
        let all = store.payload?.threads ?? []
        let placed = placements(all)
        let threads = visible(all, placed)
        let groups = PRThreadFileGroup.groups(threads, order: fileOrder)
        let fresh = newNotes(all)
        let query = headQuery(all)
        let atHead = query.flatMap { headFiles.status(repo: $0.repo, head: $0.head, shown: $0.shown, paths: $0.paths) } ?? [:]
        VStack(spacing: 0) {
            toolbar(all: all, placed: placed, shown: threads, files: groups.count)
            PanelFindBar(find: find)
            AgentDraftsList(model: model)
            if threads.isEmpty {
                VStack(spacing: 6) {
                    Image(systemName: store.payload == nil ? "bubble.left.and.bubble.right" : "checkmark.bubble")
                        .font(.system(size: 20))
                        .foregroundColor(ReviewPalette.dim)
                    Text(store.payload == nil ? "No threads loaded yet." : showClosed || onlyThisFile ? "No thread matches these filters." : model.proposal?.drafts.isEmpty == false ? "No open PR threads." : "No open threads.")
                        .font(.system(size: 12))
                        .foregroundColor(ReviewPalette.dim)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    // A plain VStack: every row has its real height after one layout, so a width change (a panel
                    // drag's release) can put the reader back exactly (PRListAnchor). A lazy stack estimated the rows
                    // above the viewport and moved the visible ones again as it measured them. A PR has tens of threads.
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(groups) { group in
                            VStack(alignment: .leading, spacing: 6) {
                                fileHeader(group, placed: placed, fresh: fresh)
                                    .modifier(PRListAnchorRow(anchor: anchor, id: "file:\(group.path)"))
                                if !folded.contains(group.path) {
                                    VStack(alignment: .leading, spacing: 6) {
                                        ForEach(group.threads) { thread in
                                            PRThreadRow(model: model, store: store, thread: thread,
                                                        selected: model.selectedThreads.contains(thread.id),
                                                        placement: placed[thread.id] ?? .onDiff(outdatedOnHost: false),
                                                        fresh: fresh, atHead: atHead[thread.path],
                                                        headSha: query?.head, compact: compact, clicks: clicks,
                                                        editors: editors, folded: foldedThreads.contains(thread.id)) {
                                                toggle(thread: thread.id)
                                            }
                                            .findRow(thread.id, cornerRadius: 8)
                                            .modifier(PRListAnchorRow(anchor: anchor, id: thread.id))
                                        }
                                    }
                                    // The file's rail: a click folds the whole file, as its header's chevron does.
                                    .overlay(alignment: .leading) {
                                        PRFileRail { toggle(file: group.path) }
                                    }
                                }
                            }
                        }
                    }
                    .padding(.horizontal, compact ? 8 : 12)
                    .padding(.top, 4)
                    .padding(.bottom, 12)
                    .coordinateSpace(name: PRListAnchor.space)
                    // The reader's place survives a width change (a panel drag's release, a window resize).
                    .background(PRScrollViewFinder { anchor.attach($0) })
                }
            }
        }
        .panelFind(find, revision: threads.map(\.id) + threads.flatMap { $0.comments.map(\.bodyMarkdown) } + folded.sorted()) {
            threads.filter { !folded.contains($0.path) }.map { thread in
                PanelFindRow(id: thread.id, fields: [PanelFindField("path", "\(thread.path):\(thread.line)")]
                    + thread.comments.flatMap { comment in
                        [PanelFindField("author:\(comment.id)", comment.author.name),
                         PanelFindField("comment:\(comment.id)", comment.bodyMarkdown, markdown: true)]
                    })
            }
        }
        .onChange(of: store.payload?.pr.url, initial: true) { _, _ in markSeen() }
        .onAppear {
            let model = model
            let store = store
            clicks.onJump = { id in
                guard let thread = store.payload?.threads.first(where: { $0.id == id }) else { return }
                let shown = model.scope.pinnedHead ?? model.remoteHead?.sha
                if PRThreadPlacement.of(thread, shownHead: shown, prHead: store.payload?.pr.headSha).onDiff {
                    model.reveal(path: thread.path, thread: thread.id)
                } else {
                    model.reveal(path: thread.path)
                }
            }
            clicks.start()
        }
        .onDisappear { clicks.stop() }
        // One batched `git ls-tree` per head and set of files, off the main thread (PRHeadFiles).
        .task(id: query.map { PRHeadFiles.key(repo: $0.repo, head: $0.head, shown: $0.shown, paths: $0.paths) + "\u{0}\(model.loading)" }) {
            guard !model.loading, let query else { return }
            await headFiles.load(repo: query.repo, head: query.head, shown: query.shown, paths: query.paths)?.value
        }
    }

    /// Reads the previous visit once per PR and records this one.
    private func markSeen() {
        guard let pr = store.pr, seenFor != pr.url else { return }
        let key = "review.prThreads.seen.\(pr.url)"
        let previous = HubDefaults.store.double(forKey: key)
        seenSince = previous > 0 ? Date(timeIntervalSince1970: previous) : nil
        seenFor = pr.url
        HubDefaults.store.set(Date().timeIntervalSince1970, forKey: key)
        folded = Set(HubDefaults.store.stringArray(forKey: PRThreadFolds.filesKey(pr.url)) ?? [])
        foldedThreads = Set(HubDefaults.store.stringArray(forKey: PRThreadFolds.threadsKey(pr.url)) ?? [])
    }

    /// Folds or opens one file's threads; kept per PR.
    private func toggle(file path: String) {
        withAnimation(.snappy(duration: 0.2)) {
            folded = PRThreadFolds.toggled(folded, path)
        }
        if let url = store.pr?.url {
            HubDefaults.store.set(folded.sorted(), forKey: PRThreadFolds.filesKey(url))
        }
    }

    /// Folds or opens one thread to its header and first line; kept per PR.
    private func toggle(thread id: String) {
        withAnimation(.snappy(duration: 0.2)) {
            foldedThreads = PRThreadFolds.toggled(foldedThreads, id)
        }
        if let url = store.pr?.url {
            HubDefaults.store.set(foldedThreads.sorted(), forKey: PRThreadFolds.threadsKey(url))
        }
    }

    // MARK: Toolbar

    @ViewBuilder
    private func toolbar(all: [PRThread], placed: [String: PRThreadPlacement], shown: [PRThread], files: Int) -> some View {
        let openCount = all.filter { Self.isOpen($0, placed[$0.id]) }.count
        let fixable = shown.filter { !$0.resolved && !$0.isMyDraft && !model.selectedThreads.contains($0.id) }.map(\.id)
        let summary = "\(shown.count) \(shown.count == 1 ? "thread" : "threads") in \(files) \(files == 1 ? "file" : "files")"
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                PRFilterChip(title: "Open", count: openCount, on: !showClosed,
                             tooltip: "Open threads, your drafts, and the threads on a newer push") { showClosed = false }
                PRFilterChip(title: "All", count: all.count, on: showClosed,
                             tooltip: "Also the resolved threads and the outdated ones") { showClosed = true }
                Rectangle().fill(ReviewPalette.hairline).frame(width: 1, height: 14)
                PRFilterChip(title: "This file", symbol: "doc.text", on: onlyThisFile,
                             tooltip: "Show only the threads on the file open in the diff") { onlyThisFile.toggle() }
                Spacer(minLength: 0)
                if !compact {
                    selectForFix(fixable)
                    Text(verbatim: summary).foregroundColor(ReviewPalette.dim).fixedSize()
                }
            }
            if compact {
                HStack(spacing: 8) {
                    selectForFix(fixable)
                    Spacer(minLength: 0)
                    Text(verbatim: summary).foregroundColor(ReviewPalette.dim).lineLimit(1)
                }
            }
        }
        .font(.system(size: 11.5))
        .padding(.horizontal, compact ? 10 : 14)
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private func selectForFix(_ fixable: [String]) -> some View {
        if !fixable.isEmpty {
            GhostButton("Select \(fixable.count) open for Fix", symbol: "checklist",
                        tooltip: "Pick every open thread shown here for Fix threads", height: 22) {
                model.selectedThreads.formUnion(fixable)
            }
            .fixedSize()
            .disabled(store.stale)
        }
    }

    // MARK: File header

    private func fileHeader(_ group: PRThreadFileGroup, placed: [String: PRThreadPlacement], fresh: Set<String>) -> some View {
        let open = group.threads.filter { Self.isOpen($0, placed[$0.id]) }.count
        let newCount = group.threads.filter { $0.comments.contains { fresh.contains($0.id) } }.count
        let isFolded = folded.contains(group.path)
        let absolute = model.file(atPath: group.path).flatMap { model.absolutePath(of: $0) }
        return HStack(alignment: .top, spacing: 6) {
            IconButton(systemName: "chevron.right", tooltip: isFolded ? "Show the threads on this file" : "Fold the threads on this file") {
                toggle(file: group.path)
            }
            .rotationEffect(.degrees(isFolded ? 0 : 90))
            .frame(width: 16, height: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: group.name)
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundColor(Color.white.opacity(0.92))
                    .lineLimit(1)
                    .truncationMode(.middle)
                if !group.folder.isEmpty {
                    Text(verbatim: PRThreadFileGroup.wrappable(group.folder) + "/")
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundColor(ReviewPalette.dim)
                        .lineLimit(3)
                        .truncationMode(.middle)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.top, 1)
            Spacer(minLength: 4)
            HStack(spacing: 4) {
                if newCount > 0 {
                    Badge("\(newCount) new", color: ReviewPalette.renamed, look: .filled,
                          tooltip: "Threads with notes from others since you last opened this PR's threads")
                }
                if open > 0 {
                    Badge("\(open) open", color: ReviewPalette.modified, look: .tone)
                } else {
                    Badge("done", color: ReviewPalette.added, look: .tone, symbol: "checkmark")
                }
            }
            .padding(.top, 2)
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .rowButton(cornerRadius: 6) {
            model.reveal(path: group.path)
        }
        .instantTooltip("\(group.path)\nClick to open it in the diff; right-click for Copy path, Finder and Cursor")
        .contextMenu {
            Button("Open in the diff") { model.reveal(path: group.path) }
            Button("Copy path") { Clipboard.copy(group.path, what: "path") }
            if let absolute {
                Button("Copy absolute path") { Clipboard.copy(absolute, what: "path") }
                Divider()
                PathActionsMenu(path: absolute, line: group.threads.first?.line)
            }
        }
    }
}

enum PRThreadFold {
    /// A note's first line of text, without markdown marks, for a folded thread.
    static func firstLine(_ markdown: String) -> String {
        let line = markdown.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty && !$0.hasPrefix("```") } ?? ""
        return line.replacingOccurrences(of: "[*_`>#]+", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
    }
}

/// The unsent reply and draft edit of each thread card. Folding a file removes its cards, and their own
/// state goes with them; the list keeps this copy, so unfolding brings the text back.
final class PRThreadEditors {
    struct Editor: Equatable {
        var replying = false
        var replyText = ""
        var editingID: String?
        var editText = ""

        /// A composer or an edit is open: something to bring back.
        var isOpen: Bool { replying || editingID != nil }
    }

    private var kept: [String: Editor] = [:]

    func keep(_ editor: Editor, for thread: String) {
        kept[thread] = editor.isOpen ? editor : nil
    }

    func take(_ thread: String) -> Editor? {
        kept.removeValue(forKey: thread)
    }
}

/// Folded files and threads of the threads list, kept per PR in the hub's settings.
enum PRThreadFolds {
    static func filesKey(_ pr: String) -> String { "review.prThreads.foldedFiles.\(pr)" }
    static func threadsKey(_ pr: String) -> String { "review.prThreads.foldedThreads.\(pr)" }

    static func toggled(_ set: Set<String>, _ id: String) -> Set<String> {
        set.contains(id) ? set.subtracting([id]) : set.union([id])
    }
}

/// The thin line left of a file's thread cards: a click folds the file, as its header's chevron does.
private struct PRFileRail: View {
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Rectangle()
            .fill(hovering ? ReviewPalette.renamed.opacity(0.8) : Color.white.opacity(0.1))
            .frame(width: hovering ? 3 : 2)
            .frame(width: 8)
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
            .onTapGesture(perform: action)
            .onHover { inside in
                guard NSEvent.pressedMouseButtons == 0 || !inside, inside != hovering else { return }
                hovering = inside
            }
            .hoverCursor(.pointingHand)
            .animation(.easeOut(duration: 0.12), value: hovering)
            .instantTooltip("Fold the threads on this file")
            .accessibilityElement()
            .accessibilityLabel(Text("Fold the threads on this file"))
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { action() }
    }
}

/// When a click on a thread card shows the thread in the diff: one click, no second click within the
/// double-click time (that selects a word), and no text selected by it.
enum PRThreadCardClick {
    static func jumps(clickCount: Int, laterClick: Bool, selectedText: Bool) -> Bool {
        clickCount <= 1 && !laterClick && !selectedText
    }

    /// A press and its release this close together are a click; farther apart they were a drag.
    static func isClick(down: CGPoint, up: CGPoint) -> Bool {
        hypot(up.x - down.x, up.y - down.y) < 4
    }
}

/// A plain click anywhere on a thread card shows that thread in the diff, on mouse-up. Two doors lead
/// here: the card's tap gesture (its chrome: header, padding, avatar) and, for its text, a mouse monitor
/// while the list is on screen, because the selectable text is an NSTextView and SwiftUI gestures never
/// see a click on it. Buttons keep their own action (SwiftUI gives them the tap), a link in the text
/// keeps its own, a drag that selects text never jumps, and a double-click waits out its second click.
@MainActor
final class PRCardClicks {
    /// Each card's frame in the window's content, top-left origin (SwiftUI's global space).
    var frames: [String: CGRect] = [:]
    var onJump: ((String) -> Void)?
    private var token = 0
    private var monitor: Any?
    private var release: Timer?

    func clicked(_ id: String, clickCount: Int, text: NSTextView? = nil) {
        token += 1
        let mine = token
        let wait = min(NSEvent.doubleClickInterval, 0.3)
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
            guard let self else { return }
            let view = text ?? (NSApp.keyWindow?.firstResponder as? NSTextView)
            let selected = view.map { $0.selectedRange().length > 0 } ?? false
            guard PRThreadCardClick.jumps(clickCount: clickCount, laterClick: mine != self.token, selectedText: selected) else {
                HubPerf.log("review.prThreads card click ignored (clicks \(clickCount), selected \(selected))")
                return
            }

            HubPerf.log("review.prThreads card click → \(id)")
            self.onJump?(id)
        }
    }

    func start() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown]) { [weak self] event in
            self?.handle(event)
            return event
        }
    }

    func stop() {
        if let monitor {
            NSEvent.removeMonitor(monitor)
        }
        monitor = nil
        release?.invalidate()
        release = nil
    }

    private func handle(_ event: NSEvent) {
        guard event.type == .leftMouseDown, let window = event.window, let content = window.contentView,
              event.modifierFlags.intersection([.command, .shift, .option, .control]).isEmpty else { return }
        let point = event.locationInWindow
        let flipped = CGPoint(x: point.x, y: content.bounds.height - point.y)
        guard let id = frames.first(where: { $0.value.contains(flipped) })?.key else { return }
        // The text view tracks the press in its own loop and takes the mouse-up with it, so no monitor
        // sees the release: watch the button instead, as `HubLiveResize` does for NSSplitView, and only
        // while it is held. A press on the card's text leaves that text view the first responder; a
        // press anywhere else on the card is SwiftUI's, and its tap gesture already answers it.
        let start = NSEvent.mouseLocation
        let clickCount = event.clickCount
        release?.invalidate()
        // 100 ms: the floor for a timer (CLAUDE.md), and a release is still answered within one frame batch.
        let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self, weak window] timer in
            guard NSEvent.pressedMouseButtons & 1 == 0 else { return }
            timer.invalidate()
            MainActor.assumeIsolated {
                // An editable text view is a Reply/Edit editor or the find field's editor, never the card's text.
                guard let self, let window, let text = window.firstResponder as? NSTextView, !text.isEditable,
                      text.bounds.contains(text.convert(point, from: nil)), !Self.isLink(in: text, at: point),
                      PRThreadCardClick.isClick(down: start, up: NSEvent.mouseLocation) else { return }
                self.clicked(id, clickCount: clickCount, text: text)
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        release = timer
    }

    /// A click on a link in the text opens the link, not the thread.
    private static func isLink(in text: NSTextView, at windowPoint: CGPoint) -> Bool {
        guard let storage = text.textStorage, storage.length > 0 else { return false }
        let index = text.characterIndexForInsertion(at: text.convert(windowPoint, from: nil))
        let candidates = [index, index - 1].filter { $0 >= 0 && $0 < storage.length }
        return candidates.contains { storage.attribute(.link, at: $0, effectiveRange: nil) != nil }
    }
}

/// A thread's placement tag ("this commit · removed at head", "newer push"): GenesisKit's `Badge` look,
/// but it shortens with "…" when the row is narrow. A fixed-size badge set the row's minimum width, and
/// the narrow panel's list then ran past its edge, cut on the left (snapshot 2026-10-07).
private struct PRShrinkBadge: View {
    let text: String
    let color: Color
    var symbol: String?
    let tooltip: String

    var body: some View {
        HStack(spacing: 3) {
            if let symbol {
                Image(systemName: symbol).font(.system(size: 8.5, weight: .semibold))
            }
            Text(verbatim: text)
                .font(.system(size: 10.5, weight: .medium))
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .foregroundColor(color)
        .padding(.horizontal, 6)
        .padding(.vertical, 1)
        .background(Capsule().fill(Color.white.opacity(0.06)))
        .layoutPriority(-1)
        .instantTooltip("\(text)\n\n\(tooltip)")
        .accessibilityLabel(Text(verbatim: "\(text): \(tooltip)"))
    }
}

/// "Open 13" / "All 23" / "This file": a capsule that is filled while on.
private struct PRFilterChip: View {
    let title: String
    var count: Int?
    var symbol: String?
    let on: Bool
    let tooltip: String
    let action: () -> Void

    init(title: String, count: Int? = nil, symbol: String? = nil, on: Bool, tooltip: String, action: @escaping () -> Void) {
        self.title = title
        self.count = count
        self.symbol = symbol
        self.on = on
        self.tooltip = tooltip
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if let symbol {
                    Image(systemName: symbol).font(.system(size: 10))
                }
                Text(title).fontWeight(on ? .semibold : .regular)
                if let count {
                    Text(verbatim: "\(count)")
                        .font(.system(size: 10.5, weight: .semibold).monospacedDigit())
                        .foregroundColor(on ? Color.white.opacity(0.85) : ReviewPalette.dim)
                }
            }
            .foregroundColor(on ? Color.white.opacity(0.95) : ReviewPalette.dim)
            .padding(.horizontal, 9)
            .padding(.vertical, 3)
            .background(Capsule().fill(on ? ReviewPalette.renamed.opacity(0.24) : Color.white.opacity(0.04)))
            .overlay(Capsule().stroke(on ? ReviewPalette.renamed.opacity(0.55) : Color.white.opacity(0.08), lineWidth: 0.5))
            .fixedSize()
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip(tooltip)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

private struct PRThreadRow: View {
    let model: ReviewModel
    @ObservedObject var store: PRThreadsStore
    let thread: PRThread
    /// In the Fix selection (the same set as the diff cards' Fix checkboxes).
    let selected: Bool
    let placement: PRThreadPlacement
    /// Note ids written by others since the previous visit.
    let fresh: Set<String>
    /// The thread's file at the PR's head, when the diff shows an older commit; nil when unknown.
    var atHead: PathAtHead?
    var headSha: String?
    var compact = false
    @State private var replying = false
    @State private var replyText = ""
    @State private var editingID: String?
    @State private var editText = ""
    @State private var hovering = false
    /// The list's click router: a plain click anywhere on the card shows the thread in the diff.
    let clicks: PRCardClicks
    /// Where an unsent reply or draft edit waits while its file is folded (the card itself is gone then).
    let editors: PRThreadEditors
    /// Folded: the header, the first note's first line and the count; the chevron on the right opens it.
    var folded = false
    var toggleFold: () -> Void = {}

    /// A note's markdown at the list's size, `inline code` on a faint fill as the host pages draw it.
    static let noteStyle: MarkdownStyle = {
        var style = MarkdownStyle()
        style.bodySize = 12
        style.textColor = Color.white.opacity(0.86)
        style.codeBackground = Color.black.opacity(0.3)
        style.inlineCodeBackground = Color.white.opacity(0.1)
        style.highlightsCode = true
        style.lineSpacing = 2
        style.blockSpacing = 6
        return style
    }()

    private var cardFill: Color {
        if store.changed.contains(thread.id) {
            return ReviewPalette.renamed.opacity(0.16)
        }

        return Color.white.opacity((thread.resolved ? 0.02 : 0.035) + (hovering ? 0.03 : 0))
    }

    private func cardClicked() {
        clicks.clicked(thread.id, clickCount: NSApp.currentEvent?.clickCount ?? 1)
    }

    private var accent: Color {
        if thread.isMyDraft { return ReviewPalette.modified }
        if thread.resolved { return ReviewPalette.added.opacity(0.7) }
        if placement == .outdated { return Color.white.opacity(0.22) }
        return ReviewPalette.modified
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if folded {
                foldedSummary
            } else {
                ForEach(Array(thread.comments.enumerated()), id: \.element.id) { index, comment in
                    commentView(comment, reply: index > 0)
                }
            }
            if folded {
                EmptyView()
            } else if replying {
                replyComposer
            } else if compact, !thread.isMyDraft {
                HStack(spacing: 10) {
                    Spacer(minLength: 0)
                    threadActions
                }
                .font(.system(size: 11.5))
                .disabled(store.stale)
            }
        }
        .font(.system(size: 12))
        .buttonStyle(.genHoverPlain())
        .disabled(store.busy != nil)
        .padding(.vertical, 9)
        .padding(.leading, 12)
        .padding(.trailing, 10)
        .background(cardFill)
        .background(alignment: .leading) {
            Rectangle().fill(accent).frame(width: 2.5)
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(
            selected ? ReviewPalette.renamed.opacity(0.7) : hovering ? Color.white.opacity(0.16) : ReviewPalette.hairline
        ))
        .contentShape(RoundedRectangle(cornerRadius: 8))
        // Clicks on the card's chrome; a click on its text lands in an NSTextView, which SwiftUI gestures
        // never see, and reaches `PRCardClicks` through its mouse monitor by this frame.
        .onTapGesture { cardClicked() }
        .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { clicks.frames[thread.id] = $0 }
        .onAppear {
            if let kept = editors.take(thread.id) {
                (replying, replyText, editingID, editText) = (kept.replying, kept.replyText, kept.editingID, kept.editText)
            }
        }
        .onDisappear {
            clicks.frames[thread.id] = nil
            editors.keep(PRThreadEditors.Editor(replying: replying, replyText: replyText, editingID: editingID, editText: editText),
                         for: thread.id)
        }
        .onHover { inside in
            // A selection drag that leaves or enters the card does not flicker its hover.
            guard NSEvent.pressedMouseButtons == 0 || !inside, inside != hovering else { return }
            hovering = inside
        }
        .animation(.easeOut(duration: 0.12), value: hovering)
        .accessibilityAction(named: Text("Show in the diff")) { cardClicked() }
        // Room for the file's rail (PRFileRail) on the left. Resolved and outdated cards keep their
        // colours: a dimmed card read as a grey film over it (Martin, 2026-10-07).
        .padding(.leading, 10)
    }

    /// A folded thread: who opened it, its first line, and how many notes it has.
    private var foldedSummary: some View {
        HStack(spacing: 6) {
            if let first = thread.comments.first {
                PRAvatar(name: first.author.name, username: first.author.username, url: first.author.avatarUrl, size: 16)
                Text(verbatim: first.author.name)
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundColor(Color.white.opacity(0.85))
                    .fixedSize()
                Text(verbatim: PRThreadFold.firstLine(first.bodyMarkdown))
                    .font(.system(size: 11.5))
                    .foregroundColor(Color.white.opacity(0.7))
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 4)
            Text(verbatim: thread.comments.count == 1 ? "1 note" : "\(thread.comments.count) notes")
                .font(.system(size: 11))
                .foregroundColor(ReviewPalette.dim)
                .fixedSize()
        }
    }

    private var header: some View {
        HStack(spacing: 6) {
            if !thread.isMyDraft {
                Toggle("", isOn: Binding(get: { selected }, set: { _ in model.toggleThreadSelection(thread.id) }))
                    .toggleStyle(.checkbox)
                    .labelsHidden()
                    .instantTooltip("Select this thread for Fix threads: the selected threads go as one task to the agent that owns the branch")
            }
            Button {
                if placement.onDiff {
                    model.reveal(path: thread.path, thread: thread.id)
                } else {
                    model.reveal(path: thread.path)
                }
            } label: {
                Text(verbatim: PRThreadFileGroup.lineLabel(thread))
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundColor(ReviewPalette.renamed)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(ReviewPalette.renamed.opacity(0.14)))
                    .fixedSize()
            }
            .instantTooltip(placement.onDiff
                ? "Show this thread on its line in the diff"
                : "Open \((thread.path as NSString).lastPathComponent) in the diff; this thread has no line there")
            if thread.isMyDraft {
                Badge("Your draft", color: ReviewPalette.modified, look: .tone,
                      tooltip: "Only you see it until you submit the review")
            } else if thread.resolved {
                Badge("Resolved", color: ReviewPalette.added, look: .tone, symbol: "checkmark")
            } else {
                Badge("Open", color: ReviewPalette.modified, look: .tone)
            }
            placementBadge
            if thread.comments.contains(where: { fresh.contains($0.id) }) {
                Circle().fill(ReviewPalette.renamed).frame(width: 6, height: 6)
                    .instantTooltip("New notes since you last opened this PR's threads")
            }
            Spacer(minLength: 4)
            // A narrow panel puts them under the notes instead: beside the badges they were cut to "Re… R…".
            if !compact, !folded {
                threadActions
            }
            IconButton(systemName: "chevron.down", tooltip: folded ? "Show the whole thread" : "Fold the thread to one line") {
                toggleFold()
            }
            .rotationEffect(.degrees(folded ? -90 : 0))
            .frame(width: 16)
        }
        .font(.system(size: 11.5))
        .lineLimit(1)
        // Cached threads: Resolve, Reply and the Fix pick wait for the host's fresh answer.
        .disabled(store.stale)
    }

    @ViewBuilder
    private var threadActions: some View {
        if !thread.isMyDraft {
            Group {
                if thread.resolvable {
                    Button(thread.resolved ? "Unresolve" : "Resolve") {
                        store.resolve(thread: thread.id, resolved: !thread.resolved)
                    }
                    .instantTooltip(thread.resolved ? "Reopen this thread on the PR" : "Mark this thread resolved on the PR")
                } else {
                    // Said, not hidden: a missing button read as a feature the hub lacks.
                    Button(thread.resolved ? "Unresolve" : "Resolve") {}
                        .disabled(true)
                        .instantTooltip("The host does not let your account \(thread.resolved ? "reopen" : "resolve") this thread (usually only its author, the PR's author or someone with write access can)")
                }
                Button("Reply") {
                    replying = true
                }
                .disabled(replying)
                .instantTooltip("Write a reply: save it as a draft in your pending review, or post it now")
            }
            .fixedSize()
        }
    }

    @ViewBuilder
    private var placementBadge: some View {
        let short = String((thread.commitSha ?? "").prefix(8))
        let head = headNote
        switch placement {
        case .onDiff(outdatedOnHost: true):
            PRShrinkBadge(text: head.map { "this commit · \($0.label)" } ?? "this commit", color: ReviewPalette.renamed, symbol: "clock.arrow.circlepath",
                  tooltip: "The host marks it outdated because a later push changed these lines. The diff shows \(short.isEmpty ? "the commit it was written on" : short), the commit it was written on, so here it sits on its line."
                      + (head.map { "\n\n\($0.tooltip)" } ?? ""))
        case .onDiff:
            headBadge(head)
        case .outdated:
            PRShrinkBadge(text: "Outdated", color: ReviewPalette.dim,
                  tooltip: "A later push changed these lines\(short.isEmpty ? "" : " (written on \(short))"). The diff shows another commit, so the thread has no line in it; its notes stay here.")
            headBadge(head)
        case .newerHead:
            PRShrinkBadge(text: "newer push", color: ReviewPalette.dim, symbol: "arrow.up.circle",
                  tooltip: "Current on the PR's newest commit, which this diff does not show, so it has no line here.")
        }
    }

    /// The file is gone or renamed at the PR's head (`PRHeadFiles`); nil while it is there or unknown.
    private var headNote: (label: String, tooltip: String)? {
        let head = String((headSha ?? "").prefix(10))
        switch atHead {
        case .removed:
            return ("removed at head", "\((thread.path as NSString).lastPathComponent) no longer exists at the PR's head \(head).")
        case .renamed(let to):
            return ("renamed at head", "At the PR's head \(head) this file is \(to).")
        case .present, nil:
            return nil
        }
    }

    @ViewBuilder
    private func headBadge(_ note: (label: String, tooltip: String)?) -> some View {
        if let note {
            PRShrinkBadge(text: note.label, color: ReviewPalette.modified, symbol: "doc.badge.ellipsis", tooltip: note.tooltip)
        }
    }

    @ViewBuilder
    private func commentView(_ comment: PRThreadComment, reply: Bool) -> some View {
        let isNew = fresh.contains(comment.id)
        HStack(alignment: .top, spacing: 8) {
            PRAvatar(name: comment.author.name, username: comment.author.username, url: comment.author.avatarUrl, size: reply ? 18 : 22)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 5) {
                    ExternalLink(text: comment.author.name, url: store.pr?.forge?.user(comment.author.username),
                                 font: .system(size: 12, weight: .semibold), color: Color.white.opacity(0.92), glyph: .onHover,
                                 tooltip: "@\(comment.author.username) on the host", findField: "author:\(comment.id)")
                        .layoutPriority(1)
                    if !compact, comment.author.name != comment.author.username {
                        Text(verbatim: "@\(comment.author.username)").foregroundColor(ReviewPalette.dim).lineLimit(1)
                    }
                    time(comment)
                    if comment.editedAt != nil {
                        Text("edited").foregroundColor(ReviewPalette.dim).fixedSize()
                    }
                    if comment.isDraft {
                        Badge("Draft", color: ReviewPalette.modified, look: .tone,
                              tooltip: "Only you see it until you submit the review")
                    }
                    if isNew {
                        Badge("new", color: ReviewPalette.renamed, look: .filled,
                              tooltip: "Written after you last opened this PR's threads")
                    }
                    Spacer(minLength: 4)
                    // A narrow panel shows them under the text: here they cut the author's name to "q…r".
                    if !compact {
                        draftActions(comment)
                    }
                }
                .font(.system(size: 11.5))
                .lineLimit(1)
                if editingID == comment.id {
                    editor(text: $editText)
                    HStack(spacing: 8) {
                        Spacer()
                        Button("Cancel") { editingID = nil }
                        Button("Save draft") {
                            // The editor stays open with its text until the host took the write, as the diff
                            // cards do: a failed or refused write must not lose what was typed.
                            store.updateDraft(thread: thread.id, note: comment.id, body: editText) { ok in
                                if ok {
                                    editingID = nil
                                }
                            }
                        }
                        .disabled(editText.trimmed.isEmpty || store.stale)
                        .instantTooltip("Replace the draft's text; it stays a draft")
                    }
                } else {
                    // Commit ids and PR/MR references as links (PRRefLinker); a PR link asks where to open it.
                    MarkdownContentView(markdown: PRRefLinker.linkify(comment.bodyMarkdown, forge: store.pr?.forge), style: Self.noteStyle)
                        .findField("comment:\(comment.id)")
                        .environment(\.openURL, OpenURLAction { url in
                            PRRefMenu.open(url, model: model)
                            return .handled
                        })
                        // A code block keeps its lines whole and asks for more width than a narrow panel
                        // has: pin the body to the row, from the left, and cut the long lines at the right.
                        .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
                        .clipped()
                    if compact, comment.isDraft {
                        HStack(spacing: 10) {
                            Spacer(minLength: 0)
                            draftActions(comment)
                        }
                        .font(.system(size: 11.5))
                    }
                }
            }
        }
        .padding(comment.isDraft ? 6 : 0)
        .background(RoundedRectangle(cornerRadius: 6).fill(comment.isDraft ? ReviewPalette.modified.opacity(0.07) : Color.clear))
        // Replies hang under the first note on a thin rail, as the host pages draw a discussion.
        .padding(.leading, reply ? 14 : 0)
        .overlay(alignment: .leading) {
            if reply {
                Rectangle().fill(Color.white.opacity(0.1)).frame(width: 1.5).padding(.leading, 4)
            }
        }
    }

    @ViewBuilder
    private func draftActions(_ comment: PRThreadComment) -> some View {
        if comment.isDraft, editingID != comment.id {
            Button("Edit") {
                editText = comment.bodyMarkdown
                editingID = comment.id
            }
            .fixedSize()
            .instantTooltip("Change the text of this draft")
            Button("Delete") {
                if confirmDelete() {
                    store.deleteDraft(thread: thread.id, note: comment.id)
                }
            }
            .fixedSize()
            .disabled(store.stale)
            .instantTooltip("Delete this draft from your pending review (asks first)")
        }
    }

    @ViewBuilder
    private func time(_ comment: PRThreadComment) -> some View {
        if let url = comment.url.flatMap(URL.init(string:)) {
            Button {
                ExternalOpener.open(url)
            } label: {
                LiveAgo(date: HubFormat.date(comment.createdAt), fallback: comment.createdAt)
                    .foregroundColor(ReviewPalette.dim)
            }
            .fixedSize()
            .hoverCursor(.pointingHand)
            .instantTooltip("\(comment.createdAt)\nOpen this comment on the host\n\(url.absoluteString)")
            .accessibilityRemoveTraits(.isButton)
            .accessibilityAddTraits(.isLink)
        } else {
            LiveAgo(date: HubFormat.date(comment.createdAt), fallback: comment.createdAt)
                .foregroundColor(ReviewPalette.dim)
                .fixedSize()
                .instantTooltip(comment.createdAt)
        }
    }

    private var replyComposer: some View {
        VStack(alignment: .leading, spacing: 6) {
            editor(text: $replyText)
            HStack(spacing: 8) {
                Spacer()
                Button("Cancel") {
                    replying = false
                }
                Button("Post now…") {
                    if confirmPost() {
                        store.reply(thread: thread.id, body: replyText, draft: false) { ok in
                            closeComposer(ok)
                        }
                    }
                }
                .disabled(replyText.trimmed.isEmpty)
                .instantTooltip("Publish the reply at once, visible to everyone (asks first)")
                Button("Save as draft") {
                    store.reply(thread: thread.id, body: replyText, draft: true) { ok in
                        closeComposer(ok)
                    }
                }
                .disabled(replyText.trimmed.isEmpty)
                .instantTooltip("Add the reply to your pending review; Submit review publishes it")
            }
        }
    }

    /// Clears the reply only once the host took it; a failed or refused write keeps the text.
    private func closeComposer(_ ok: Bool) {
        guard ok else { return }
        replying = false
        replyText = ""
    }

    private func editor(text: Binding<String>) -> some View {
        TextEditor(text: text)
            .font(.system(size: 12.5))
            .scrollContentBackground(.hidden)
            .frame(height: 72)
            .padding(4)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.25)))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.white.opacity(0.15)))
    }

    private func confirmPost() -> Bool {
        PRConfirm.post(replyText, on: store, where_: "A reply in the thread on \(thread.path):\(thread.line).")
    }

    private func confirmDelete() -> Bool {
        PRConfirm.deleteDraft(on: store)
    }
}

/// The questions asked before a write that others see (a post) or that cannot be undone (a delete).
/// The same alerts for the threads list and the diff's thread cards.
enum PRConfirm {
    static func post(_ text: String, on store: PRThreadsStore, where_: String) -> Bool {
        let alert = NSAlert()
        alert.messageText = "Post on \(store.label) now?"
        alert.informativeText = "Everyone on the \(store.pr?.identity.isGitLab == true ? "merge request" : "pull request") sees it at once. \(where_)\n\n\(text.prefix(400))"
        alert.addButton(withTitle: "Post")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    static func deleteDraft(on store: PRThreadsStore) -> Bool {
        let alert = NSAlert()
        alert.messageText = "Delete this draft?"
        alert.informativeText = "It leaves your pending review on \(store.label). Nobody else saw it."
        alert.addButton(withTitle: "Delete")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }
}

private struct PRBadge: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold))
            .foregroundColor(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .overlay(Capsule().stroke(color.opacity(0.6)))
            .fixedSize()
    }
}

/// Comment / Approve / Request changes with an optional summary. Submitting asks again in an
/// NSAlert that names the PR and the number of drafts: it is the one path to `pr publish`.
private struct SubmitReviewForm: View {
    @ObservedObject var store: PRThreadsStore
    let close: () -> Void
    @State private var event = PRReviewEvent.comment
    @State private var summary = ""

    private var events: [PRReviewEvent] {
        // GitLab has no "request changes" review.
        store.pr?.identity.isGitLab == true ? [.comment, .approve] : PRReviewEvent.allCases
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Submit your review on \(store.label)")
                .font(.system(size: 13, weight: .semibold))
            Text("\(store.payload?.draftCount ?? 0) pending drafts go out with it. Everyone sees the review at once.")
                .font(.system(size: 11.5))
                .foregroundColor(ReviewPalette.dim)
                .fixedSize(horizontal: false, vertical: true)
            Picker("", selection: $event) {
                ForEach(events) { event in
                    Text(event.title).tag(event)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .instantTooltip("The kind of review")
            Text("Summary (optional)")
                .font(.system(size: 11.5))
                .foregroundColor(ReviewPalette.dim)
            TextEditor(text: $summary)
                .font(.system(size: 12.5))
                .scrollContentBackground(.hidden)
                .frame(height: 90)
                .padding(4)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.25)))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.white.opacity(0.15)))
            HStack(spacing: 8) {
                Spacer()
                Button("Cancel", action: close)
                    .keyboardShortcut(.cancelAction)
                Button("Submit…") {
                    let event = event
                    let summary = summary
                    close()
                    // After the popover is gone: a modal alert over a transient popover can close it mid-click.
                    DispatchQueue.main.async {
                        if confirm(event: event, summary: summary) {
                            store.submitReview(event: event, summary: summary)
                        }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .instantTooltip("Asks once more, naming the PR and the number of drafts")
            }
            .buttonStyle(.genHoverPlain())
        }
        .padding(14)
        .frame(width: 400)
    }

    private func confirm(event: PRReviewEvent, summary: String) -> Bool {
        let drafts = store.payload?.draftCount ?? 0
        let alert = NSAlert()
        alert.messageText = "Submit your review on \(store.label)?"
        var text = "\(store.pr?.title ?? "")\n\n\(event.title). \(drafts) pending \(drafts == 1 ? "draft goes" : "drafts go") out with it, and everyone on the \(store.pr?.identity.isGitLab == true ? "merge request" : "pull request") sees the review at once."
        if !summary.trimmed.isEmpty {
            text += "\n\nSummary: \(summary.trimmed.prefix(300))"
        }
        alert.informativeText = text
        alert.addButton(withTitle: "Submit review")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }
}

// MARK: - The reader's place across a width change

/// Keeps the threads list where the reader was when its width changes: a side panel drag's release,
/// a window resize. The rows re-wrap at the new width and every card's height changes; NSScrollView
/// keeps its pixel offset, so the text under the reader slid to another thread (recording 2026-10-07:
/// "L63–73 qkleblmat" at the top before the release, the thread above it after). The top-most visible
/// row and its distance from the viewport's top are kept while the width is settled; when the rows
/// report a new width, that row goes back to the same distance, once, after the one reflow.
@MainActor
final class PRListAnchor {
    static let space = "prThreads.content"
    /// The list on screen, for the `--drag-context` snapshot demo.
    static weak var current: PRListAnchor?

    private weak var scrollView: NSScrollView?
    private var frames: [String: CGRect] = [:]
    func rowFrame(_ id: String) -> CGRect? { frames[id] }
    /// The row at the viewport's top and its y in the content, with the scroll offset it was read at.
    private(set) var held: (id: String, contentY: CGFloat, offset: CGFloat)?
    private var restorePending = false
    private var observer: NSObjectProtocol?

    var offset: CGFloat { scrollView?.contentView.bounds.origin.y ?? 0 }

    func attach(_ scrollView: NSScrollView) {
        guard self.scrollView !== scrollView else { return }
        self.scrollView = scrollView
        Self.current = self
        scrollView.contentView.postsBoundsChangedNotifications = true
        if let observer {
            NotificationCenter.default.removeObserver(observer)
        }
        observer = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: scrollView.contentView,
                                                          queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, !self.restorePending else { return }
                self.capture()
            }
        }
    }

    deinit {
        if let observer {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    /// A row's frame in the content. A new width means the list re-wrapped: put the reader back.
    func update(_ id: String, _ frame: CGRect) {
        let old = frames[id]
        frames[id] = frame
        if let old, abs(old.width - frame.width) > 0.5 {
            scheduleRestore()
            return
        }
        if !restorePending {
            capture()
        }
    }

    func remove(_ id: String) {
        frames[id] = nil
    }

    /// The top-most row still visible, with its distance from the viewport's top.
    private func capture() {
        let top = offset
        guard let found = PRListAnchorMath.topRow(frames, viewportTop: top) else { return }
        held = (found.id, found.frame.minY, top)
    }

    private func scheduleRestore() {
        guard !restorePending else { return }
        restorePending = true
        // After this layout pass: every visible row has reported its new frame by then.
        DispatchQueue.main.async { [weak self] in
            self?.restore()
        }
    }

    private func restore() {
        restorePending = false
        guard let held, let now = frames[held.id], let scrollView, let document = scrollView.documentView else { return }
        let target = PRListAnchorMath.offset(heldY: held.contentY, heldOffset: held.offset, newY: now.minY,
                                             contentHeight: document.frame.height, viewportHeight: scrollView.contentView.bounds.height)
        // x back to 0 too: the list scrolls only vertically, but after a frozen (wider) layout the clip view
        // kept a horizontal offset and the rows showed cut on the left ("…rrorHandling/", snapshot 2026-10-07).
        if abs(target - offset) > 0.5 || scrollView.contentView.bounds.origin.x != 0 {
            scrollView.contentView.scroll(to: NSPoint(x: 0, y: target))
            scrollView.reflectScrolledClipView(scrollView.contentView)
        }
        HubPerf.log("review.prThreads anchor \(held.id.prefix(12)) kept: y \(Int(held.contentY - held.offset)) → \(Int(now.minY - target)) (offset \(Int(held.offset)) → \(Int(target)))")
        capture()
    }

    /// The top row now and its y in the viewport: what the `--drag-context` demo logs before and after.
    func topRowLine() -> String {
        guard let found = PRListAnchorMath.topRow(frames, viewportTop: offset) else { return "none" }
        let clip = scrollView?.contentView.bounds ?? .zero
        return "\(found.id.prefix(16)) y=\(Int((found.frame.minY - offset).rounded())) x=\(Int(found.frame.minX)) w=\(Int(found.frame.width)) "
            + "(viewport x=\(Int(clip.minX)) w=\(Int(clip.width)), content w=\(Int(scrollView?.documentView?.frame.width ?? 0)))"
    }

    func scroll(to y: CGFloat) {
        guard let scrollView else { return }
        scrollView.contentView.scroll(to: NSPoint(x: 0, y: y))
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }
}

enum PRListAnchorMath {
    /// The row that holds the viewport's top line (or the first one below it).
    static func topRow(_ frames: [String: CGRect], viewportTop: CGFloat) -> (id: String, frame: CGRect)? {
        frames.filter { $0.value.maxY > viewportTop + 1 }
            .min { ($0.value.minY, $0.key) < ($1.value.minY, $1.key) }
            .map { ($0.key, $0.value) }
    }

    /// The scroll offset that puts the held row at the distance from the viewport's top it had, clamped
    /// to the content.
    static func offset(heldY: CGFloat, heldOffset: CGFloat, newY: CGFloat, contentHeight: CGFloat, viewportHeight: CGFloat) -> CGFloat {
        let wanted = heldOffset + (newY - heldY)
        return max(0, min(wanted, max(0, contentHeight - viewportHeight)))
    }
}

/// Reports each row's frame in the list's content to the anchor.
struct PRListAnchorRow: ViewModifier {
    let anchor: PRListAnchor
    let id: String

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .named(PRListAnchor.space)) }) { anchor.update(id, $0) }
            .onDisappear { anchor.remove(id) }
    }
}

/// Finds the NSScrollView a SwiftUI ScrollView is drawn in, once it is in a window.
struct PRScrollViewFinder: NSViewRepresentable {
    let found: (NSScrollView) -> Void

    func makeNSView(context: Context) -> FinderView {
        let view = FinderView()
        view.found = found
        return view
    }

    func updateNSView(_ nsView: FinderView, context: Context) {
        nsView.found = found
    }

    /// Whatever it is offered: an AppKit view without an intrinsic size answers with its current frame,
    /// which would hold the list at its old width after a drag.
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: FinderView, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? 0, height: proposal.height ?? 0)
    }

    final class FinderView: NSView {
        var found: ((NSScrollView) -> Void)?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let scrollView = enclosingScrollView {
                found?(scrollView)
            }
        }
    }
}

extension PRListAnchor {
    /// The held row (the one a width change keeps in place) and its y in the viewport now.
    func heldRowLine() -> (id: String, line: String)? {
        guard let held, let frame = rowFrame(held.id) else { return nil }
        return (held.id, "\(held.id.prefix(16)) y=\(Int((frame.minY - offset).rounded()))")
    }

    func rowLine(_ id: String) -> String {
        guard let frame = rowFrame(id) else { return "\(id.prefix(16)) not on screen" }
        return "\(id.prefix(16)) y=\(Int((frame.minY - offset).rounded()))"
    }
}
