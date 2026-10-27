//
//  MarkdownFileTreeView.swift
//  GenesisKit
//
//  The file sidebar of the standalone `genesis open` window: the folder the
//  open document lives in, browsable, so switching between the notes in a
//  folder does not mean going back to Finder.
//
//  Unlike the vault pane's tree this is the real filesystem and shows every
//  file, not only the three types the vault indexes. It lists one directory per
//  expanded folder (see FileTree) rather than walking a subtree, so pointing it
//  at a home directory costs one `contentsOfDirectory` call.
//
//  Its type shrinks until the names fit and grows with the sidebar's width only
//  while they all still do (`MarkdownTreeFont`), its rows and folders carry the
//  window's path verbs (`PathMenu`, New File… / New Folder… among them), and
//  "Show in Sidebar" scrolls to a row and pulses it.
//

import AppKit

import SwiftUI

struct MarkdownFileTreeView: View {
    @ObservedObject var model: MarkdownDocumentsModel
    @ObservedObject private var config = GenesisKitMarkdownConfiguration.shared
    /// Observed so a key changed in Keyboard Shortcuts redraws the search tooltip.
    @ObservedObject private var keymap = MarkdownKeymap.shared
    /// The shared tree (GenesisKit Files/FileTree.swift): one flat row list, folders read off the main thread.
    @StateObject private var tree = FileTreeModel(root: FileManager.default.homeDirectoryForCurrentUser)
    @StateObject private var search = FileTreeSearchModel()
    @State private var searchOpen = false
    /// The search hit the keyboard is on (Up and Down in the field); nil: Return opens the first hit.
    @State private var hitCursor: Int?
    /// Why the tree has no rows, once a check of the folder says so (nil while it loads or has rows).
    @State private var treeEmpty: MarkdownTreeEmpty?
    @State private var emptyAttempt = 0
    @State private var debounce: Task<Void, Never>?
    @FocusState private var searchFocused: Bool
    /// The folder "Go to Location…" revealed: highlighted until another document is selected.
    @State private var revealed: String?
    /// A row a reveal waits for: its folder is still being read, so it scrolls (and pulses) when it lands.
    @State private var pendingRow: PendingRow?
    /// What the rows, or the search hits, ask of the text size. Kept across renders: a divider drag asks at
    /// every frame, and the names are measured only when the list changes.
    @State private var rowFit = MarkdownTreeFit<FileTreeRow>()
    /// The same with room for a git mark at each row's end, kept apart so turning the marks on measures again.
    @State private var markedRowFit = MarkdownTreeFit<FileTreeRow>()
    @StateObject private var gitTree = GitTreeDecorationsModel()
    @AppStorage("markdown.config.treeChangedOnly") private var changedOnly = false
    /// The tree lists folders and notes (markdown, canvas, base) only; off lists every file (pictures, JSON, code).
    @AppStorage("markdown.config.treeNotesOnly") private var notesOnly = true
    /// The filtered rows, kept until the rows or the kept paths change: the body asks for them several times per
    /// render, and a long folder is hundreds of extension checks each time.
    @State private var noteRowsMemo = MarkdownNoteRowsMemo()
    @State private var hitFit = MarkdownTreeFit<FileTreeSearch.Hit>()
    @State private var rowPulse: FileTreePulse?
    /// The tree's AppKit scroll view, so a reveal can glide to a row SwiftUI has not laid out yet.
    @State private var scrollBox = MarkdownTreeScrollBox()
    @State private var headerPulse: FileTreePulse?
    /// A place from Back or Forward whose scroll offset waits for its folders' rows (`applyPendingPlaceScroll`).
    @State private var pendingPlaceScroll: Double?
    @State private var placeRestore = MarkdownTreeRestore()
    @ObservedObject private var history: MarkdownTreeHistory
    @GenReduceMotion private var reduceMotion

    init(model: MarkdownDocumentsModel, gitTree: GitTreeDecorationsModel? = nil) {
        self.model = model
        _history = ObservedObject(wrappedValue: model.treeHistory)
        _config = ObservedObject(wrappedValue: model.configuration)
        _gitTree = StateObject(wrappedValue: gitTree ?? GitTreeDecorationsModel())
    }

    private struct PendingRow: Equatable {
        let id: String
        let pulse: FileTreePulse?
    }

    private static let topID = "markdown-files-top"

    /// The text size of the list on screen: the search hits while results show, else the tree's rows.
    private var fontSize: CGFloat {
        let results = showingResults
        return CGFloat(MarkdownTreeFont.size(
            base: config.treeFontSize,
            width: model.filesWidth,
            scales: config.treeFontScalesWithWidth,
            demand: results
                ? hitFit.demand(for: search.hits) { MarkdownTreeDemand.Line(hit: $0) }
                : gitMarks
                    ? markedRowFit.demand(for: tree.rows) { MarkdownTreeDemand.Line(row: $0, gitMark: true) }
                    : rowFit.demand(for: tree.rows) { MarkdownTreeDemand.Line(row: $0) },
            reserve: MarkdownTreeFont.scrollerReserve
        ))
    }

    private var showingResults: Bool { searchOpen && search.isActive }

    /// Git marks on the rows: the setting is on and the root is in a repository.
    private var gitMarks: Bool { config.gitShows(\.gitTreeDecorations) && gitTree.hasRepository }

    private func followGit() {
        gitTree.follow(config.gitShows(\.gitTreeDecorations) ? model.filesRootURL : nil)
    }

    var body: some View {
        let _ = RenderProbe.hit("md.fileTree")
        let root = model.filesRootURL
        VStack(alignment: .leading, spacing: 0) {
            header(root)
            if searchOpen {
                searchRow
            }
            Rectangle().fill(model.theme.border).frame(height: 1)
            ScrollViewReader { proxy in
                Group {
                    if showingResults {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 0) {
                                Color.clear.frame(height: 0).id(Self.topID)
                                LazyVStack(alignment: .leading, spacing: 0) { results }
                            }
                            .padding(.vertical, 4)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    } else if let empty = shownEmpty {
                        emptyTree(empty)
                    } else {
                        // An AppKit table with its own scroll view (`MarkdownTreeTable`).
                        treeRows
                    }
                }
                // The empty space under the rows: the root's own verbs (New File…, New Folder…). A row's
                // own menu wins over it.
                .contextMenu {
                    if !showingResults {
                        PathActionsMenu(
                            url: root, kind: .folder,
                            actions: model.pathActions(for: .folder).filter { $0 != .showInSidebar && $0 != .navigateInSidebar },
                            handlers: model.pathHandlers(for: root, kind: .folder)
                        )
                    }
                }
                .onChange(of: model.revealToken) { _, _ in handleReveal(proxy) }
                .onChange(of: hitCursor) { _, index in
                    guard let index, search.hits.indices.contains(index) else { return }
                    proxy.scrollTo(search.hits[index].id)
                }
                .onChange(of: tree.rows) { _, _ in
                    scrollToPending(proxy)
                    applyPendingPlaceScroll(force: false)
                }
            }
        }
        .background(model.theme.chrome)
        // A marker, not an identifier on the container: SwiftUI pushes a
        // container's identifier onto its children, and the header buttons
        // all answered as "markdown-file-tree" (vault note
        // Dev/Swift/AccessibilityIdentifierPropagationClobbersChildren).
        .axMarker("markdown-file-tree")
        .onAppear {
            tree.setRoot(root)
            revealSelected(root)
            search.setRoot(root)
            applySearchRequest()
            model.treePlace = { [weak model, weak tree, weak scrollBox] in
                guard let model, let tree else {
                    return MarkdownTreePlace(root: "", expanded: [], scrollY: 0)
                }
                return MarkdownTreePlace(
                    root: model.filesRoot, expanded: tree.expandedFolders,
                    scrollY: Double(scrollBox?.scrollView?.contentView.bounds.origin.y ?? 0)
                )
            }
        }
        .onChange(of: model.pendingTreePlace) { _, place in
            if let place { restore(place) }
        }
        .onDisappear {
            cancelPlaceRestore()
            scrollBox.cancelGlide()
            model.treePlace = nil
        }
        .onChange(of: model.selectedId) { _, _ in
            revealed = nil
            revealSelected(model.filesRootURL)
        }
        .onAppear { followGit() }
        .onChange(of: config.git) { _, _ in followGit() }
        .onChange(of: config.gitTreeDecorations) { _, _ in followGit() }
        .onChange(of: root) { _, _ in
            followGit()
            tree.setRoot(model.filesRootURL)
            // Back or Forward puts its own folders and offset back (`restore`); the open document must not move them.
            if model.pendingTreePlace == nil { revealSelected(model.filesRootURL) }
            search.setRoot(model.filesRootURL)
        }
        .onReceive(NotificationCenter.default.publisher(for: .markdownTabFileChanged, object: model)) { _ in
            tree.reload()
            search.invalidate()
        }
        .onChange(of: model.treeSearchToken) { _, _ in applySearchRequest() }
        .onChange(of: search.query) { _, _ in scheduleSearch() }
        .onChange(of: search.mode) { _, _ in scheduleSearch() }
        .onChange(of: search.hits) { _, _ in hitCursor = nil }
        .onChange(of: search.failure) { _, now in if let now { GenAnnounce.post(now.message) } }
        // An empty tree is checked once its rows settle: a folder still being read has no rows either.
        .task(id: MarkdownTreeEmptyCheck(root: root.path, empty: tree.rows.isEmpty, attempt: emptyAttempt)) {
            guard tree.rows.isEmpty else {
                treeEmpty = nil
                return
            }
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled, tree.rows.isEmpty else { return }
            let path = root.path
            let result = await Task.detached(priority: .utility) { MarkdownTreeEmpty.check(path) }.value
            guard !Task.isCancelled else { return }
            treeEmpty = result
        }
    }

    /// The empty state on screen: the folder has nothing, cannot be read, or the changed-files filter hides every row.
    private var shownEmpty: MarkdownTreeEmpty? {
        if tree.rows.isEmpty { return treeEmpty }
        if changedOnly, gitMarks, displayedRows.isEmpty { return .noChanges }
        if notesOnly, displayedRows.isEmpty { return .noNotes }
        return nil
    }

    @ViewBuilder
    private func emptyTree(_ empty: MarkdownTreeEmpty) -> some View {
        let name = Self.folderName(model.filesRootURL)
        switch empty {
        case .empty:
            EmptyState(symbol: "folder", text: "\(name) has no visible files",
                       detail: "Hidden files are not listed.",
                       actionTitle: Self.parentFolderName(model.filesRootURL).map { "Go up to \($0)" },
                       action: { model.filesRootUp() })
                .accessibilityIdentifier("markdown-files-empty")
        case .permission(let kind):
            EmptyState(symbol: "lock", text: "\(name) needs permission to be read",
                       detail: "Allow \(kind.title) for \(PermissionKind.appName), then the folder is read again.",
                       actionTitle: "Allow \(kind.title)",
                       action: { MarkdownTreeEmpty.requestAccess(kind, retry: reloadFolder) })
                .accessibilityIdentifier("markdown-files-unreadable")
        case .unreadable:
            EmptyState(symbol: "folder.badge.questionmark", text: "\(name) cannot be read",
                       detail: "Check that the folder still exists and that your account can read it. Finder's Get Info, Sharing & Permissions shows its access rules.",
                       actionTitle: "Try Again",
                       action: reloadFolder)
                .accessibilityIdentifier("markdown-files-unreadable")
        case .noChanges:
            EmptyState(symbol: "checkmark.circle", text: "No changed files",
                       detail: "Show only changed files is on, and nothing under \(name) differs from git.",
                       actionTitle: "Show all files",
                       action: { changedOnly = false })
                .accessibilityIdentifier("markdown-files-no-changes")
        case .noNotes:
            EmptyState(symbol: "doc.text", text: "No notes in \(name)",
                       detail: "Only notes are listed, and this folder holds other files only.",
                       actionTitle: "Show all files",
                       action: { notesOnly = false })
                .accessibilityIdentifier("markdown-files-no-notes")
        }
    }

    private func reloadFolder() {
        treeEmpty = nil
        emptyAttempt += 1
        tree.reload()
    }

    /// The rows on screen, in order: every row, or only the changed ones when the git filter is on.
    private var displayedRows: [FileTreeRow] {
        let git: GitTreeDecorations? = gitMarks ? gitTree.decorations : nil
        let rows = notesOnly ? noteRowsMemo.rows(tree.rows, keep: Set([revealed, model.selected?.id].compactMap { $0 })) : tree.rows
        return git.map { changedOnly ? FileTreeView.changedRows(rows, $0) : rows } ?? rows
    }

    /// Folders and notes (markdown, canvas, base): the "Notes only" filter. A path in `keep` (the revealed row, the
    /// selected tab) stays, so "Show in Sidebar" on a picture or a JSON tab still finds its row.
    nonisolated static func noteRows(_ rows: [FileTreeRow], keep: Set<String> = []) -> [FileTreeRow] {
        rows.filter {
            $0.isFolder || keep.contains($0.id)
                || FileTree.kind(for: URL(fileURLWithPath: $0.id), isDirectory: false) != .file
        }
    }

    /// Every file row carries the hover preview; a single click opens through `openFromTree`.
    private var treeRows: some View {
        let style = treeStyle
        let actions = treeActions
        let selected = revealed ?? model.selected?.id
        let pulse = rowPulse
        let git: GitTreeDecorations? = gitMarks ? gitTree.decorations : nil
        return MarkdownFileTreeRows(
            rows: displayedRows, selected: selected, style: style, actions: actions, pulse: pulse, git: git, tree: tree,
            model: model, box: scrollBox
        )
        .equatable()
    }

    /// ⌘⇧F, or "Search in Folder…" with its folder in `model.treeSearchScope`: the scope is taken once,
    /// so the next plain ⌘⇧F searches the whole tree.
    private func applySearchRequest() {
        guard model.treeSearchToken != model.treeSearchHandled else { return }
        model.treeSearchHandled = model.treeSearchToken
        search.setScope(model.treeSearchScope)
        model.treeSearchScope = nil
        searchOpen = true
        search.mode = .text
        searchFocused = true
    }

    /// A keystroke never searches by itself: the run starts 60 ms after the
    /// last one, so a fast typist costs one walk and one grep, not ten.
    private func scheduleSearch() {
        debounce?.cancel()
        debounce = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(60))
            guard !Task.isCancelled else { return }
            search.run()
        }
    }

    private var searchRow: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(model.theme.textMuted)
                TextField(search.mode == .names ? "File name" : "Text in files", text: $search.query)
                    .textFieldStyle(.plain)
                    .font(GenTypography.mono(11))
                    .foregroundColor(model.theme.text)
                    .focused($searchFocused)
                    .onExitCommand { closeSearch() }
                    // Return opens the hit the keyboard is on, or the first; Up and Down walk the hits.
                    .onSubmit { openHit(at: hitCursor ?? 0) }
                    .onKeyPress(.downArrow, phases: [.down, .repeat]) { _ in moveHit(1) }
                    .onKeyPress(.upArrow, phases: [.down, .repeat]) { _ in moveHit(-1) }
                    .accessibilityLabel(search.mode == .names ? "Find a file by name" : "Find text in files")
                    .accessibilityHint("Up and Down choose a result, Return opens it")
                    .accessibilityIdentifier("markdown-files-search")
                if !search.query.isEmpty {
                    Button {
                        search.query = ""
                        searchFocused = true
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 10.5))
                            .foregroundColor(model.theme.textMuted)
                            .frame(width: 22, height: 22)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.genHoverPlain())
                    .instantTooltip("Clear")
                    .accessibilityLabel("Clear the search")
                    .accessibilityIdentifier("markdown-files-search-clear")
                }
                // Names or text: one toggle, the way a code editor keeps ⌘P and ⌘⇧F apart.
                Button {
                    search.mode = search.mode == .names ? .text : .names
                } label: {
                    Text(search.mode == .names ? "name" : "text")
                        .font(GenTypography.mono(11, weight: .semibold))
                        .foregroundColor(model.theme.accent)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(model.theme.accent.opacity(0.14))
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                        .frame(minHeight: 22)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.genHoverPlain())
                .accessibilityLabel(search.mode == .names ? "Searching file names" : "Searching text in files")
                .accessibilityHint("Switches between file names and text in files")
                .accessibilityIdentifier("markdown-files-search-mode")
                .instantTooltip(search.mode == .names ? "Searching file names. Click for text in files" : "Searching text in files. Click for file names")
                if search.searching {
                    ProgressView().controlSize(.mini)
                }
            }
            if let scope = search.scope {
                scopeChip(scope)
            }
        }
        .padding(.horizontal, 8)
        .padding(.bottom, 6)
        // The click that opened the row ends by focusing the panel's hosting view; asking for the field in
        // the same pass loses to it, so the request waits one turn of the run loop.
        .onAppear { DispatchQueue.main.async { searchFocused = true } }
    }

    /// "Search in Folder…": the folder the search is limited to. A click removes it and searches the
    /// whole tree again.
    private func scopeChip(_ scope: String) -> some View {
        let name = (scope as NSString).lastPathComponent
        return Button {
            search.setScope(nil)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "folder.fill")
                    .font(.system(size: 8.5))
                Text(name.isEmpty ? "/" : name)
                    .font(GenTypography.mono(11, weight: .medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Image(systemName: "xmark")
                    .font(.system(size: 7, weight: .bold))
                    .opacity(0.8)
            }
            .foregroundColor(model.theme.accent)
            .padding(.horizontal, 7)
            .padding(.vertical, 2.5)
            .background(Capsule().fill(model.theme.accent.opacity(0.14)))
            .frame(minHeight: 22)
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip("Searching only in \(PathLabel.display(scope)). Click to search the whole tree")
        .accessibilityLabel("Searching only in \(name). Remove the folder limit")
        .accessibilityIdentifier("markdown-files-search-scope")
    }

    @ViewBuilder
    private var results: some View {
        let size = fontSize
        if let failure = search.failure, !search.searching {
            NoticePill(text: failure.message, more: failure.detail, tone: .error,
                       fixes: [.button("Try again", symbol: "arrow.clockwise") { search.run() }])
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .accessibilityIdentifier("markdown-files-search-failed")
        } else if search.hits.isEmpty, !search.searching {
            VStack(alignment: .leading, spacing: 3) {
                Text("No match under \((search.searchRoot as NSString).lastPathComponent)")
                    .font(GenTypography.mono(11))
                    .foregroundColor(model.theme.textSecondary)
                    .accessibilityIdentifier("markdown-files-no-match")
                Text(FileTreeSearch.leftOut)
                    .font(.system(size: 11))
                    .foregroundColor(model.theme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("markdown-files-left-out")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
        }
        if search.fellBackToText, !search.hits.isEmpty {
            Text("No file name matches. Text inside files:")
                .font(GenTypography.mono(11))
                .foregroundColor(model.theme.textMuted)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .accessibilityIdentifier("markdown-files-text-fallback")
        }
        ForEach(Array(search.hits.enumerated()), id: \.element.id) { index, hit in
            MarkdownFileTreeResultRow(hit: hit, model: model, fontSize: size, keyed: index == hitCursor) { open(hit) }
        }
        if search.truncated || search.namesCut {
            Text(Self.cutNotice(names: search.mode == .names && !search.fellBackToText, indexFull: search.truncated))
                .font(GenTypography.mono(11))
                .foregroundColor(model.theme.textMuted)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .accessibilityIdentifier("markdown-files-truncated")
        }
    }

    /// A hit opens like a tree row would, then reveals itself in the tree
    /// and, for a text hit, lands on its line.
    private func open(_ hit: FileTreeSearch.Hit) {
        let url = URL(fileURLWithPath: hit.path)
        model.openFromTree(url)
        guard FileTree.isReadable(url) else { return }
        tree.reveal(url)
        if let line = hit.line { model.jump(toLine: line) }
    }

    /// Under a cut list: the name index stopped, or only the first names or text hits are shown.
    static func cutNotice(names: Bool, indexFull: Bool) -> String {
        if names {
            return indexFull
                ? "Index stopped at \(FileTreeSearch.maxIndexedFiles) files. Pick a narrower folder"
                : "First \(FileTreeSearch.maxNameHits) names shown. Type more of the name"
        }
        return "First \(FileTreeSearch.maxTextHits) hits shown"
    }

    /// Up or Down in the search field: the keyboard moves through the hits, from the first.
    private func moveHit(_ step: Int) -> KeyPress.Result {
        guard showingResults, !search.hits.isEmpty else { return .ignored }
        let next = (hitCursor ?? (step > 0 ? -1 : search.hits.count)) + step
        hitCursor = min(max(next, 0), search.hits.count - 1)
        return .handled
    }

    private func openHit(at index: Int) {
        guard showingResults, search.hits.indices.contains(index) else { return }
        open(search.hits[index])
    }

    private func closeSearch() {
        search.clear()
        search.setScope(nil)
        searchOpen = false
    }

    private var scrollAnimation: Animation? {
        reduceMotion ? nil : .easeInOut(duration: 0.3)
    }

    /// "Show in Sidebar", "Navigate in Sidebar", "Go to Location…" or a new file (`revealInSidebar`).
    /// A row: every folder down to it opens, it scrolls into view with an animation and pulses (a folder
    /// opens itself too). A new root: the tree scrolls to its top and the header pulses; a file in it
    /// still scrolls into view, without a second light. The search closes, so the tree is on screen.
    private func handleReveal(_ proxy: ScrollViewProxy) {
        cancelPlaceRestore()
        // A new root, a header reveal or another row: the glide already running would keep writing the old target.
        scrollBox.cancelGlide()
        guard let pulse = model.revealPulse else { return }
        if searchOpen {
            closeSearch()
        }
        let root = model.filesRootURL
        tree.setRoot(root)
        search.setRoot(root)
        switch pulse.target {
        case .header:
            headerPulse = FileTreePulse(id: "", token: pulse.token)
            if let scroll = scrollBox.scrollView {
                MarkdownTreeScroll.toTop(scroll, animated: scrollAnimation != nil)
            }
            if let target = model.revealTarget?.standardizedFileURL, target.path != tree.root.path,
               !MarkdownLinkRoute.isFolder(target) {
                reveal(target, pulse: nil, proxy: proxy)
            } else {
                revealed = nil
            }
        case .row(let path):
            reveal(URL(fileURLWithPath: path), pulse: pulse.tree, proxy: proxy)
        }
    }

    private func reveal(_ target: URL, pulse: FileTreePulse?, proxy: ScrollViewProxy) {
        // `reveal` opens the folders above a file: a name inside a folder opens the folder too.
        tree.reveal(MarkdownLinkRoute.isFolder(target) ? target.appendingPathComponent(".goto") : target)
        revealed = target.path
        pendingRow = PendingRow(id: target.path, pulse: pulse)
        scrollToPending(proxy)
    }

    /// Runs when a reveal asks and again whenever the rows change: a folder read off the main thread
    /// lands later, and only then is the row there to scroll to.
    private func scrollToPending(_ proxy: ScrollViewProxy) {
        guard let pending = pendingRow, tree.rows.contains(where: { $0.id == pending.id }) else { return }
        pendingRow = nil
        let animation = scrollAnimation
        // One turn later: rows that just appeared are laid out first, so the scroll lands on them.
        DispatchQueue.main.async {
            // A lazy list knows only the rows it laid out: an animated `scrollTo` to a far row lands on an estimate,
            // waits, then jumps (recorded 2026-10-15), and as the last step of the glide it once left the row three rows
            // above the sidebar. So the tree's own scroll view glides there frame by frame and places the row itself.
            let rows = displayedRows
            if animation != nil, let index = rows.firstIndex(where: { $0.id == pending.id }), let scroll = scrollBox.scrollView {
                MarkdownTreeScroll.glide(toRow: index, of: rows.count, in: scroll, box: scrollBox)
            } else if let index = rows.firstIndex(where: { $0.id == pending.id }), let scroll = scrollBox.scrollView {
                MarkdownTreeScroll.jump(toRow: index, of: rows.count, in: scroll)
            }
            // Stamped now: a slow folder read must not let the pulse expire before it shows.
            rowPulse = pending.pulse.map { FileTreePulse(id: $0.id, token: $0.token) }
        }
    }

    private func revealSelected(_ root: URL) {
        cancelPlaceRestore()
        scrollBox.cancelGlide()
        tree.setRoot(root)
        search.setRoot(root)
        guard let doc = model.selected else { return }
        tree.reveal(doc.url)
    }

    private var treeStyle: FileTreeStyle {
        let size = fontSize
        return FileTreeStyle(
            text: model.theme.text,
            secondary: model.theme.textSecondary,
            muted: model.theme.textMuted,
            accent: model.theme.accent,
            selection: model.theme.fill,
            font: { .system(size: size, weight: $0 ? .semibold : .regular) },
            metrics: .scaled(toText: size)
        )
    }

    /// A single click opens through `openFromTree` (a preview tab); a double-click keeps the file's tab,
    /// and on a folder it navigates the sidebar there. The row menus are the configured path verbs
    /// (`pathHandlers`), so a rename or a move to the Trash follows into the tabs (`MarkdownFileOps.swift`).
    private var treeActions: FileTreeActions {
        let model = model
        let folderActions = config.folderActions
        let fileActions = config.fileActions
        var hasher = Hasher()
        hasher.combine(folderActions)
        hasher.combine(fileActions)
        return FileTreeActions(
            open: { url in model.openFromTree(url) },
            setRoot: { url in model.navigateInSidebar(url) },
            changed: { model.applyFileChange($0) },
            guardChange: { model.unsavedReason($0) },
            // The menus follow the configured lists: a changed list re-renders every row.
            revision: hasher.finalize(),
            menu: FileTreeMenu(folderActions: folderActions, fileActions: fileActions) { url, kind in
                model.pathHandlers(for: url, kind: kind)
            },
            openKept: { url in model.openFromTree(url, keep: true) }
        )
    }

    /// The folder above `root`, for the header's muted prefix. `/` and a folder directly under it have no name to show.
    static func parentFolderName(_ root: URL) -> String? {
        let parent = root.deletingLastPathComponent()
        guard root.path != "/", parent.path != "/" else { return nil }
        let name = parent.lastPathComponent
        guard !name.isEmpty else { return nil }
        return name
    }

    /// A saved place's name for the back and forward tooltips.
    static func placeName(_ place: MarkdownTreePlace) -> String {
        place.root.isEmpty ? "the open document's folder" : (place.root as NSString).lastPathComponent
    }

    /// The folder label used by create menus and tooltips, including the filesystem root.
    static func folderName(_ folder: URL) -> String {
        folder.lastPathComponent.isEmpty ? "/" : folder.lastPathComponent
    }

    private func cancelPlaceRestore() {
        placeRestore.cancel()
        pendingPlaceScroll = nil
    }

    /// Back or Forward: the root, exactly the folders that were open, then the scroll offset once their rows are in.
    private func restore(_ place: MarkdownTreePlace) {
        let token = placeRestore.begin()
        scrollBox.cancelGlide()
        pendingRow = nil
        if searchOpen { closeSearch() }
        let root = model.filesRootURL
        tree.setRoot(root)
        search.setRoot(root)
        tree.restoreExpanded(place.expanded)
        pendingPlaceScroll = place.scrollY
        applyPendingPlaceScroll(force: false)
        // Folders read off the main thread may never make the list tall enough (one was deleted): place it anyway.
        placeRestore.schedule(token, after: 1) {
            applyPendingPlaceScroll(force: true)
        }
    }

    /// The saved offset, once the rows can hold it. It is set a run-loop turn later, after the table has taken the new
    /// rows (a reload in the same pass put the list back at its top), and checked once more a moment later.
    private func applyPendingPlaceScroll(force: Bool) {
        guard let y = pendingPlaceScroll, let scroll = scrollBox.scrollView else { return }
        scroll.window?.contentView?.layoutSubtreeIfNeeded()
        guard force || Self.maxScroll(scroll) >= y - 1 else { return }
        pendingPlaceScroll = nil
        let rows = tree.rows.count
        let token = placeRestore.current
        placeRestore.schedule(token) {
            Self.place(scroll, at: y)
            GenesisKit.log("markdown: sidebar place scroll \(Int(y)) (max \(Int(Self.maxScroll(scroll))), forced \(force), rows \(rows))")
            placeRestore.schedule(token, after: 0.25) {
                let now = scroll.contentView.bounds.origin.y
                if abs(now - y) > 2, Self.maxScroll(scroll) >= y - 1 {
                    GenesisKit.log("markdown: sidebar place scroll moved to \(Int(now)) after restore, set \(Int(y)) again")
                    Self.place(scroll, at: y)
                }
                model.treePlaceRestored()
            }
        }
    }

    private static func maxScroll(_ scroll: NSScrollView) -> Double {
        scroll.window?.contentView?.layoutSubtreeIfNeeded()
        return Double((scroll.documentView?.frame.height ?? 0) - scroll.contentView.bounds.height + scroll.contentInsets.bottom)
    }

    private static func place(_ scroll: NSScrollView, at y: Double) {
        let clip = scroll.contentView
        let top = -Double(scroll.contentInsets.top)
        clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: min(max(y, top), max(maxScroll(scroll), top))))
        scroll.reflectScrolledClipView(clip)
    }

    /// The + menu. One folder to offer (the root): "New File in <root>", "New Folder in <root>". Two (the folder the
    /// tree last revealed or the open note's folder, and the root): "New File in…" and "New Folder in…", each listing
    /// both by name, so the menu says where the file lands (Martin, 2026-10-15: "in Design or …" was unclear).
    private func newItemEntries(_ root: URL) -> [PathMenuEntry] {
        let near = newItemFolder.standardizedFileURL
        let folders = near.path == root.standardizedFileURL.path ? [root] : [near, root]
        func item(_ action: PathAction, in folder: URL, title: String) -> PathMenuItem? {
            guard case .item(let base)? = PathMenu.entries(for: folder, kind: .folder, actions: [action],
                                                          handlers: model.pathHandlers(for: folder, kind: .folder)).first
            else { return nil }
            return PathMenuItem(id: "\(action.rawValue)-\(folder.path)", title: title, systemImage: base.systemImage,
                                action: action, run: base.run)
        }
        if folders.count == 1 {
            return [PathAction.newFile, .newFolder].compactMap { action in
                item(action, in: root, title: "\(action == .newFile ? "New File" : "New Folder") in \(Self.folderName(root))…")
                    .map(PathMenuEntry.item)
            }
        }
        return [(PathAction.newFile, "New File in", "doc.badge.plus"), (.newFolder, "New Folder in", "folder.badge.plus")]
            .map { action, title, symbol in
                .submenu(id: "\(action.rawValue)-in", title: "\(title)…", systemImage: symbol,
                         entries: folders.compactMap { folder in
                             item(action, in: folder, title: Self.folderName(folder))
                                 .map(PathMenuEntry.item)
                         })
            }
    }

    /// Where the header's New File… / New Folder… create.
    private var newItemFolder: URL {
        let revealedFolder = revealed.map { URL(fileURLWithPath: $0) }.flatMap { MarkdownLinkRoute.isFolder($0) ? $0 : nil }
        return MarkdownSidebarReveal.newItemFolder(
            revealedFolder: revealedFolder, selectedFile: model.selected?.url, root: model.filesRootURL
        )
    }

    /// One of the header's small glyph buttons (back, forward, up).
    private func headerButton(_ symbol: String, enabled: Bool = true, id: String, tip: String,
                              action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 9, weight: .bold))
                .foregroundColor(enabled ? model.theme.textSecondary : model.theme.textMuted.opacity(0.45))
                .frame(width: 22, height: 22)
                .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .disabled(!enabled)
        .accessibilityIdentifier(id)
        .accessibilityLabel(tip)
        .instantTooltip(tip)
    }

    private func header(_ root: URL) -> some View {
        // The 22 pt targets sit side by side with no gap: with 6 pt gaps the folder chip kept about 30 pt of a 230 pt
        // sidebar and showed only "(…" (viewer shots, 2026-10-25). Each button keeps its own 22 pt target.
        HStack(spacing: 2) {
            HStack(spacing: 0) {
                headerButton("chevron.left", enabled: history.canGoBack, id: "markdown-files-back",
                             tip: history.back.last.map { "Back to \(Self.placeName($0))" } ?? "Back") { model.treeBack() }
                headerButton("chevron.right", enabled: history.canGoForward, id: "markdown-files-forward",
                             tip: history.forward.last.map { "Forward to \(Self.placeName($0))" } ?? "Forward") { model.treeForward() }
                headerButton("arrow.up", id: "markdown-files-up",
                             tip: "Up to \(Self.parentFolderName(root) ?? "/")") { model.filesRootUp() }
            }

            // The folder the tree shows: a folder glyph in the accent and its name, with the folder above it muted,
            // so it reads as "you are here" rather than as one more button label (Martin, 2026-10-15).
            HStack(spacing: 4) {
                Image(systemName: "folder.fill")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(model.theme.accent)
                if let parentName = Self.parentFolderName(root) {
                    // The folder above: a click goes there, as the up arrow does (and Back returns).
                    Button {
                        model.filesRootUp()
                    } label: {
                        Text(parentName + " /")
                            .font(.system(size: 11))
                            .foregroundColor(model.theme.textMuted)
                            .lineLimit(1)
                            .frame(minHeight: 22)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.genHoverPlain())
                    .layoutPriority(0)
                    .accessibilityIdentifier("markdown-files-parent")
                    .instantTooltip("Go to \(parentName)")
                }
                Text(root.lastPathComponent.isEmpty ? "/" : root.lastPathComponent)
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundColor(model.theme.text)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .layoutPriority(1)
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 2)
            .background(RoundedRectangle(cornerRadius: 5).fill(model.theme.accent.opacity(0.10)))
            // "Navigate in Sidebar", or a reveal that re-rooted the tree: the new root lights up.
            .fileTreePulse(headerPulse, color: model.theme.accent, cornerRadius: 5)
            .instantTooltip(root.path)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Folder \(root.lastPathComponent)")
            .accessibilityIdentifier("markdown-files-root")
            .layoutPriority(1)

            Spacer(minLength: 0)

            HStack(spacing: 0) {
            PathMenuButton(entries: { newItemEntries(root) }) {
                Image(systemName: "plus")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(model.theme.textMuted)
                    .frame(width: 22, height: 22)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverPlain())
            .accessibilityLabel("New file or folder")
            .accessibilityIdentifier("markdown-files-new")
            .instantTooltip(newItemFolder.path == root.path
                ? "New file or folder in \(Self.folderName(root))"
                : "New file or folder in \(Self.folderName(newItemFolder)) or \(Self.folderName(root))")

            Button {
                notesOnly.toggle()
            } label: {
                Image(systemName: "line.3.horizontal.decrease")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(notesOnly ? model.theme.accent : model.theme.textMuted)
                    .frame(width: 22, height: 22)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverPlain())
            .accessibilityLabel("Show only notes")
            .accessibilityValue(notesOnly ? "on" : "off")
            .accessibilityAddTraits(notesOnly ? .isSelected : [])
            .accessibilityIdentifier("markdown-files-notes-only")
            .instantTooltip(notesOnly
                ? "Showing only notes: click to show every file (pictures, JSON, code)"
                : "Showing every file: click to show only notes")

            Button {
                MarkdownSettingsWindow.shared.show(nil)
                NativeSettingsHighlightCenter.shared.request("markdown-file-sidebar")
            } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(model.theme.textMuted)
                    .frame(width: 22, height: 22)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverPlain())
            .accessibilityLabel("File sidebar settings")
            .accessibilityIdentifier("markdown-files-settings")
            .instantTooltip("File sidebar settings")

            if gitMarks {
                Button {
                    changedOnly.toggle()
                } label: {
                    Image(systemName: "plusminus")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundColor(changedOnly ? model.theme.accent : model.theme.textMuted)
                        .frame(width: 22, height: 22)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.genHoverPlain())
                .accessibilityLabel("Show only changed files")
                .accessibilityValue(changedOnly ? "on" : "off")
                .accessibilityAddTraits(changedOnly ? .isSelected : [])
                .accessibilityIdentifier("markdown-files-changed-only")
                .instantTooltip(changedOnly ? "Showing only changed files: click for all" : "Show only changed files")
            }

            Button {
                if searchOpen { closeSearch() } else { searchOpen = true }
            } label: {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(searchOpen ? model.theme.accent : model.theme.textMuted)
                    .frame(width: 22, height: 22)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverPlain())
            .accessibilityLabel("Find in files")
            .accessibilityValue(searchOpen ? "open" : "closed")
            .accessibilityAddTraits(searchOpen ? .isSelected : [])
            .accessibilityIdentifier("markdown-files-search-toggle")
            .instantTooltip(keymap.hint("Find a file by name, or text in files", "markdown.find.files"))

            Button {
                reloadFolder()
            } label: {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(model.theme.textMuted)
                    .frame(width: 22, height: 22)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverPlain())
            .accessibilityLabel("Re-read this folder")
            .accessibilityIdentifier("markdown-files-reload")
            .instantTooltip("Re-read this folder")
            }
        }
        .padding(.horizontal, 6)
        // 22 pt buttons in a header that kept its height: 4 + 22 + 4 is the old 7 + 16 + 7.
        .padding(.vertical, 4)
    }
}

/// One search hit: the file name, its folder under the root, and for a text
/// hit the line number and the matching line. Its type follows the tree's.
/// The tree's rows, apart from the tree view so a documents-model publish that changes none of them (the
/// preview's section, a tab switch elsewhere) skips the whole `ForEach`. The tree view observes the model; this
/// view compares its inputs instead (2026-10-14: every publish walked all ~340 rows of an expanded vault folder).
private struct MarkdownFileTreeRows: View, Equatable {
    let rows: [FileTreeRow]
    let selected: String?
    let style: FileTreeStyle
    let actions: FileTreeActions
    let pulse: FileTreePulse?
    let git: GitTreeDecorations?
    let tree: FileTreeModel
    /// For the hover preview only: not observed.
    let model: MarkdownDocumentsModel
    let box: MarkdownTreeScrollBox

    /// What the cells draw besides the rows: when it changes, the cells on screen are built again.
    struct Revision: Equatable {
        let selected: String?
        let pulse: FileTreePulse?
        let actions: Int
        let git: GitTreeDecorations?
        let metrics: FileTreeMetrics
        let colors: [Color]
    }

    static func == (left: MarkdownFileTreeRows, right: MarkdownFileTreeRows) -> Bool {
        left.selected == right.selected && left.pulse == right.pulse && left.actions.revision == right.actions.revision
            && left.style.metrics == right.style.metrics && left.style.text == right.style.text
            && left.style.secondary == right.style.secondary && left.style.muted == right.style.muted
            && left.style.accent == right.style.accent && left.style.selection == right.style.selection
            && left.tree === right.tree && left.model === right.model && left.git == right.git && left.rows == right.rows
    }

    var body: some View {
        let _ = RenderProbe.hit("md.fileTreeRows")
        let selectedKey = selected.map { FileTreeRowKey(selection: $0) }
        let (style, tree, actions, pulse, git, model) = (style, tree, actions, pulse, git, model)
        return MarkdownTreeTable(
            rows: rows,
            revision: Revision(selected: selected, pulse: pulse, actions: actions.revision, git: git, metrics: style.metrics,
                               colors: [style.text, style.secondary, style.muted, style.accent, style.selection]),
            box: box,
            keys: MarkdownTreeKeys(
                open: { actions.open($0.url) },
                toggle: { row in
                    GenMotion.perform(expanding: !row.expanded, reduceMotion: tree.reduceMotion) { tree.toggle(row.id) }
                },
                navigate: { actions.setRoot($0.url) },
                up: { model.filesRootUp() },
                start: { rows in selectedKey.flatMap { key in rows.firstIndex { $0.key == key } } }
            )
        ) { row in
            AnyView(
                FileTreeRowView(
                    row: row, selected: row.key == selectedKey, icon: FileTreeView.defaultIcon(row), style: style,
                    model: tree, actions: actions, pulse: pulse?.id == row.id ? pulse : nil,
                    change: git?.change(for: row.id), holdsChanges: git?.holdsChanges(row.id) ?? false,
                    lines: git?.count(for: row.id)
                )
                .equatable()
                .markdownHoverPreview(row.isFolder ? nil : row.url, model: model)
                // A folder says whether it is open; the open file says it is the selected one.
                .accessibilityValue(row.isFolder ? (row.expanded ? "expanded" : "collapsed") : "")
                .accessibilityAddTraits(row.key == selectedKey ? .isSelected : [])
            )
        }
    }
}

private struct MarkdownFileTreeResultRow: View {
    let hit: FileTreeSearch.Hit
    @ObservedObject var model: MarkdownDocumentsModel
    let fontSize: CGFloat
    /// The keyboard is on this hit (Up and Down in the search field).
    var keyed = false
    let action: () -> Void

    var body: some View {
        let metrics = FileTreeMetrics.scaled(toText: fontSize)
        Button(action: action) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: metrics.spacing) {
                    Image(systemName: hit.line == nil ? "doc" : "text.alignleft")
                        .font(.system(size: metrics.icon))
                        .foregroundColor(model.theme.textMuted)
                        .frame(width: metrics.iconWidth)
                    Text(hit.name)
                        .font(.system(size: fontSize, weight: .semibold))
                        .foregroundColor(model.theme.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let line = hit.line {
                        Text(":\(line)")
                            .font(GenTypography.mono(fontSize - 1))
                            .foregroundColor(model.theme.accent)
                    }
                    Spacer(minLength: 0)
                }
                let folder = (hit.relative as NSString).deletingLastPathComponent
                if !folder.isEmpty {
                    Text(folder)
                        .font(.system(size: fontSize - 1.5))
                        .foregroundColor(model.theme.textMuted)
                        .lineLimit(1)
                        .truncationMode(.head)
                        .padding(.leading, metrics.iconWidth + metrics.spacing)
                }
                if let snippet = hit.snippet {
                    Text(snippet)
                        .font(GenTypography.mono(fontSize - 1.5))
                        .foregroundColor(model.theme.text)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .padding(.leading, metrics.iconWidth + metrics.spacing)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, metrics.verticalPadding)
            .background(
                RoundedRectangle(cornerRadius: 5).fill(keyed ? model.theme.accent.opacity(0.16) : Color.clear)
                    .padding(.horizontal, 3)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .accessibilityAddTraits(keyed ? .isSelected : [])
        .contextMenu {
            let url = URL(fileURLWithPath: hit.path)
            PathActionsMenu(entries: MarkdownSearchResultMenu.entries(
                url: url,
                actions: model.pathActions(for: .file),
                handlers: model.pathHandlers(for: url, kind: .file),
                open: action
            ))
        }
        // `.help`, not an instant tooltip: up to 300 rows each with an AppKit hover view lagged the list (2026-10-13).
        .help(hit.path)
        .accessibilityIdentifier("markdown-files-result")
    }
}

/// The right-click menu of a search hit: the same file verbs as a row in the listing, with Open first.
@MainActor
enum MarkdownSearchResultMenu {
    static func entries(
        url: URL,
        actions: [PathAction],
        handlers: PathMenuHandlers,
        environment: PathMenuEnvironment? = nil,
        open: @escaping () -> Void
    ) -> [PathMenuEntry] {
        let leading = [PathMenuItem(id: "open", title: "Open", systemImage: "doc.text", run: open)]
        let verbs = PathMenu.entries(for: url, kind: .file, actions: actions, handlers: handlers, environment: environment ?? .system)
        return leading.map(PathMenuEntry.item) + (verbs.isEmpty ? [] : [.divider(id: "divider-leading")]) + verbs
    }
}

/// The "Notes only" rows of the last tree rows asked for. A class, so a render that fills it does not render again.
final class MarkdownNoteRowsMemo {
    private var source: [FileTreeRow]?
    private var kept: Set<String> = []
    private var result: [FileTreeRow] = []

    func rows(_ rows: [FileTreeRow], keep: Set<String>) -> [FileTreeRow] {
        if rows == source, keep == kept { return result }
        result = MarkdownFileTreeView.noteRows(rows, keep: keep)
        source = rows
        kept = keep
        return result
    }
}

/// The tree's scroll view, set by `MarkdownTreeTable`. A class, so setting it does not re-render the tree. It owns the
/// one glide that may write that scroll view's origin.
final class MarkdownTreeScrollBox {
    /// The table scroll view whose clip origin a reveal may change.
    weak var scrollView: NSScrollView?
    /// The glide writing this scroll view, when one is running.
    private(set) var glide: MarkdownTreeGlide?

    /// Stops the running glide and starts a new one. A second reveal replaces the first.
    func beginGlide() -> MarkdownTreeGlide {
        cancelGlide()
        let next = MarkdownTreeGlide()
        glide = next
        return next
    }

    /// Stops the glide. A new reveal, a re-root, a header reveal and the tree leaving the window call it.
    func cancelGlide() {
        glide?.cancel()
        glide = nil
    }

    /// The glide finished on its own. A glide that a newer one already replaced is left alone.
    func endGlide(_ flight: MarkdownTreeGlide) {
        flight.cancel()
        if glide === flight { glide = nil }
    }
}

/// One running glide: its timer and the scroll-wheel monitor. Cancelling stops both, so an older reveal cannot
/// keep writing the clip origin.
final class MarkdownTreeGlide {
    /// Whether this flight has stopped writing the scroll origin.
    private(set) var cancelled = false
    /// Timer callbacks that ran. A cancelled glide stays at however many ran before `cancel`.
    private(set) var frames = 0
    private var timer: Timer?
    private var monitor: Any?

    /// Records a timer frame for cancellation and progress tests.
    func noteFrame() { frames += 1 }

    /// Attaches this flight's timer and wheel monitor, or disposes of them if already cancelled.
    func arm(timer: Timer, monitor: Any?) {
        if cancelled {
            timer.invalidate()
            if let monitor { NSEvent.removeMonitor(monitor) }
            return
        }
        self.timer = timer
        self.monitor = monitor
    }

    /// Stops the timer and removes the wheel monitor exactly once.
    func cancel() {
        guard !cancelled else { return }
        cancelled = true
        let timer = self.timer
        self.timer = nil
        timer?.invalidate()
        if let monitor {
            NSEvent.removeMonitor(monitor)
            self.monitor = nil
        }
    }
}

/// The reveal's glide. The rows are one height, so the document's height over the row count places a row before the
/// lazy list has laid it out.
enum MarkdownTreeScroll {
    /// The rows' vertical padding inside the scroll content (`MarkdownFileTreeView`).
    static let padding: CGFloat = 4
    /// Seconds spent gliding through the final screen toward a revealed row.
    static let duration: TimeInterval = 0.32

    /// The clip origin that centres row `index` of `count`, clamped to the document.
    static func centeredOrigin(index: Int, count: Int, documentHeight: CGFloat, visibleHeight: CGFloat) -> CGFloat {
        let rowHeight = max(documentHeight - 2 * padding, 0) / CGFloat(max(count, 1))
        let middle = padding + (CGFloat(index) + 0.5) * rowHeight
        let bottom = max(documentHeight - visibleHeight, 0)
        return min(max(middle - visibleHeight / 2, 0), bottom)
    }

    /// Where a glide starts: a target more than a screen and a half away is approached from one screen short of it,
    /// so the eye follows the last screen and the list does not lay out every row in between.
    static func glideStart(from current: CGFloat, to target: CGFloat, visibleHeight: CGFloat) -> CGFloat {
        guard abs(target - current) > visibleHeight * 1.5 else { return current }
        return target > current ? target - visibleHeight : target + visibleHeight
    }

    /// The clip origin that centres row `index`: from the table's own row rect, else from the document's height.
    @MainActor
    static func centeredOrigin(row index: Int, of count: Int, in scroll: NSScrollView) -> CGFloat {
        let visible = scroll.contentView.bounds.height
        guard let table = scroll.documentView as? NSTableView, index < table.numberOfRows else {
            return centeredOrigin(index: index, count: count, documentHeight: scroll.documentView?.frame.height ?? 0,
                                  visibleHeight: visible)
        }
        let insets = scroll.contentInsets
        let top = -insets.top
        let bottom = max(table.frame.height + insets.bottom - visible, top)
        return min(max(table.rect(ofRow: index).midY - visible / 2, top), bottom)
    }

    /// Reduce Motion: the row in the middle at once.
    @MainActor
    static func jump(toRow index: Int, of count: Int, in scroll: NSScrollView) {
        scroll.window?.contentView?.layoutSubtreeIfNeeded()
        let clip = scroll.contentView
        clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: centeredOrigin(row: index, of: count, in: scroll)))
        scroll.reflectScrolledClipView(clip)
    }

    /// The list's top, for a new root.
    @MainActor
    static func toTop(_ scroll: NSScrollView, animated: Bool) {
        let clip = scroll.contentView
        let top = NSPoint(x: clip.bounds.origin.x, y: -scroll.contentInsets.top)
        if animated {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = duration
                clip.animator().setBoundsOrigin(top)
            }
        } else {
            clip.scroll(to: top)
        }
        scroll.reflectScrolledClipView(clip)
    }

    /// Ease in and out over `progress` 0...1.
    static func eased(_ progress: Double) -> Double {
        progress < 0.5 ? 2 * progress * progress : 1 - pow(-2 * progress + 2, 2) / 2
    }

    /// How long the glide keeps the row in the middle after its motion, while the list's height settles.
    static let holdLimit: TimeInterval = 0.5

    /// Scrolls the clip view to row `index` frame by frame and leaves the row in the middle.
    ///
    /// The target follows the document's height on every frame: rows a reveal just opened arrive in it a few frames
    /// later (5721 → 5915 → 6192 pt in the 2026-10-15 recording). After the motion the glide holds the row in the
    /// middle until that height has stopped changing. Only the reader's own scroll stops it early: a change of the
    /// clip origin alone is also what the list does while it grows, and stopping on it left the row three rows above
    /// the sidebar. A glide already running on `box` is cancelled first: two timers would write two origins.
    @MainActor
    static func glide(toRow index: Int, of count: Int, in scroll: NSScrollView, box: MarkdownTreeScrollBox) {
        let flight = box.beginGlide()
        scroll.window?.contentView?.layoutSubtreeIfNeeded()
        let clip = scroll.contentView
        let visible = clip.bounds.height
        func height() -> CGFloat { scroll.documentView?.frame.height ?? 0 }
        func target() -> CGFloat { centeredOrigin(row: index, of: count, in: scroll) }
        let start = glideStart(from: clip.bounds.origin.y, to: target(), visibleHeight: visible)
        GenesisKit.log("markdown: tree reveal row \(index) of \(count), document \(Int(height())) pt, glide \(Int(clip.bounds.origin.y)) -> \(Int(start)) -> \(Int(target()))")
        func place(_ y: CGFloat) {
            guard abs(clip.bounds.origin.y - y) >= 0.5 else { return }
            clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: y))
            scroll.reflectScrolledClipView(clip)
        }
        place(start)
        // A wheel or a trackpad over the window: the reader takes the list over.
        var readerScrolled = false
        let monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { event in
            if event.window === scroll.window { readerScrolled = true }
            return event
        }
        let began = CACurrentMediaTime()
        var lastHeight = height()
        var steadySince = began + duration
        let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { timer in
            MainActor.assumeIsolated {
                guard !flight.cancelled else {
                    timer.invalidate()
                    return
                }
                flight.noteFrame()
                let now = CACurrentMediaTime()
                var done: String?
                if readerScrolled {
                    done = "stopped by the reader"
                } else {
                    let progress = min(1, (now - began) / duration)
                    if height() != lastHeight {
                        lastHeight = height()
                        steadySince = max(now, began + duration)
                    }
                    place(start + (target() - start) * eased(progress))
                    // Done once the height has held for a few frames after the motion, or the hold ran out.
                    if progress >= 1, now - steadySince > 0.08 || now - began > duration + holdLimit {
                        done = "end"
                    }
                }
                if let done {
                    box.endGlide(flight)
                    let origin = Int(clip.bounds.origin.y)
                    let document = Int(height())
                    GenesisKit.log("markdown: tree glide \(done) at \(origin), document \(document) pt")
                }
            }
        }
        flight.arm(timer: timer, monitor: monitor)
        guard !flight.cancelled else { return }
        RunLoop.main.add(timer, forMode: .common)
    }
}

/// Why the file tree shows no rows.
enum MarkdownTreeEmpty: Equatable, Sendable {
    /// The folder holds no visible file.
    case empty
    /// A privacy denial, with the grant for this folder.
    case permission(PermissionKind)
    /// The folder is missing or its filesystem access rules prevent listing it.
    case unreadable
    /// "Show only changed files" is on and nothing changed.
    case noChanges
    /// "Show only notes" is on and the folder holds other files only.
    case noNotes

    /// Reads the folder once, off the main thread: an empty listing and a refused one are different answers.
    nonisolated static func check(_ path: String) -> MarkdownTreeEmpty {
        do {
            _ = try FileManager.default.contentsOfDirectory(atPath: path)
            return .empty
        } catch {
            return failure(error as NSError, path: path)
        }
    }

    /// TCC normally returns EPERM; EACCES and missing paths need filesystem recovery, not a privacy grant.
    nonisolated static func failure(_ error: NSError, path: String, home: URL = FileManager.default.homeDirectoryForCurrentUser) -> MarkdownTreeEmpty {
        let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError
        let posix = error.domain == NSPOSIXErrorDomain ? error.code
            : underlying?.domain == NSPOSIXErrorDomain ? underlying?.code : nil
        let privacy = posix == Int(POSIXErrorCode.EPERM.rawValue)
            || (posix == nil && error.domain == NSCocoaErrorDomain && error.code == CocoaError.fileReadNoPermission.rawValue)
        guard privacy else { return .unreadable }
        let folder = URL(fileURLWithPath: path).standardizedFileURL.path
        for (name, kind) in [("Desktop", PermissionKind.desktopFolder), ("Documents", .documentsFolder), ("Downloads", .downloadsFolder)] {
            let protected = home.appendingPathComponent(name).standardizedFileURL.path
            if folder == protected || folder.hasPrefix(protected + "/") { return .permission(kind) }
        }
        return .permission(.fullDiskAccess)
    }

    @MainActor
    static func requestAccess(_ kind: PermissionKind, retry: @escaping @MainActor () -> Void, center: PermissionCenter = .shared) {
        if center.require(PermissionNeed(kind, reason: "The file sidebar needs to list this folder so you can browse and open its files.", onGranted: retry)) {
            retry()
        }
    }
}

/// The empty-tree check runs again when the root changes or the rows empty or fill.
private struct MarkdownTreeEmptyCheck: Equatable {
    let root: String
    let empty: Bool
    let attempt: Int
}
