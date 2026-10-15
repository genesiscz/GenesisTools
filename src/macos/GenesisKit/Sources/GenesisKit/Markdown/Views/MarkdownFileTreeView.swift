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
    /// The shared tree (GenesisKit Files/FileTree.swift): one flat row list, folders read off the main thread.
    @StateObject private var tree = FileTreeModel(root: FileManager.default.homeDirectoryForCurrentUser)
    @StateObject private var search = FileTreeSearchModel()
    @State private var searchOpen = false
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
    @State private var hitFit = MarkdownTreeFit<FileTreeSearch.Hit>()
    @State private var rowPulse: FileTreePulse?
    @State private var headerPulse: FileTreePulse?
    @GenReduceMotion private var reduceMotion

    init(model: MarkdownDocumentsModel, gitTree: GitTreeDecorationsModel? = nil) {
        self.model = model
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
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Color.clear.frame(height: 0).id(Self.topID)
                        if showingResults {
                            LazyVStack(alignment: .leading, spacing: 0) { results }
                        } else {
                            treeRows
                        }
                    }
                    .padding(.vertical, 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
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
                .onChange(of: tree.rows) { _, _ in scrollToPending(proxy) }
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
            revealSelected(model.filesRootURL)
            search.setRoot(model.filesRootURL)
        }
        .onReceive(NotificationCenter.default.publisher(for: .markdownTabFileChanged, object: model)) { _ in
            tree.reload()
            search.invalidate()
        }
        .onChange(of: model.treeSearchToken) { _, _ in applySearchRequest() }
        .onChange(of: search.query) { _, _ in scheduleSearch() }
        .onChange(of: search.mode) { _, _ in scheduleSearch() }
    }

    /// Every file row carries the hover preview; a single click opens through `openFromTree`.
    private var treeRows: some View {
        let style = treeStyle
        let actions = treeActions
        let selected = revealed ?? model.selected?.id
        let pulse = rowPulse
        let git: GitTreeDecorations? = gitMarks ? gitTree.decorations : nil
        let rows = git.map { changedOnly ? FileTreeView.changedRows(tree.rows, $0) : tree.rows } ?? tree.rows
        return LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(rows) { row in
                FileTreeRowView(
                    row: row, selected: row.id == selected, icon: FileTreeView.defaultIcon(row), style: style,
                    model: tree, actions: actions, pulse: pulse?.id == row.id ? pulse : nil,
                    change: git?.change(for: row.id), holdsChanges: git?.holdsChanges(row.id) ?? false,
                    lines: git?.count(for: row.id)
                )
                .equatable()
                .markdownHoverPreview(row.isFolder ? nil : row.url, model: model)
            }
        }
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
                    .font(GenTypography.mono(10))
                    .foregroundColor(model.theme.text)
                    .focused($searchFocused)
                    .onExitCommand { closeSearch() }
                    .accessibilityIdentifier("markdown-files-search")
                // Names or text: one toggle, the way a code editor keeps ⌘P and ⌘⇧F apart.
                Button {
                    search.mode = search.mode == .names ? .text : .names
                } label: {
                    Text(search.mode == .names ? "name" : "text")
                        .font(GenTypography.mono(8.5, weight: .semibold))
                        .foregroundColor(model.theme.accent)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(model.theme.accent.opacity(0.14))
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.genHoverPlain())
                .accessibilityIdentifier("markdown-files-search-mode")
                .instantTooltip(search.mode == .names ? "Searching file names — click for text in files" : "Searching text in files — click for file names")
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
                    .font(GenTypography.mono(9, weight: .medium))
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
            .contentShape(Capsule())
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip("Searching only in \(PathLabel.display(scope)) — click to search the whole tree")
        .accessibilityLabel("Searching only in \(name). Remove the folder limit")
        .accessibilityIdentifier("markdown-files-search-scope")
    }

    @ViewBuilder
    private var results: some View {
        let size = fontSize
        if search.hits.isEmpty, !search.searching {
            Text("No match under \((search.searchRoot as NSString).lastPathComponent)")
                .font(GenTypography.mono(9.5))
                .foregroundColor(model.theme.textMuted)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .accessibilityIdentifier("markdown-files-no-match")
        }
        if search.fellBackToText, !search.hits.isEmpty {
            Text("No file name matches. Text inside files:")
                .font(GenTypography.mono(9))
                .foregroundColor(model.theme.textMuted)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .accessibilityIdentifier("markdown-files-text-fallback")
        }
        ForEach(search.hits) { hit in
            MarkdownFileTreeResultRow(hit: hit, model: model, fontSize: size) { open(hit) }
        }
        if search.truncated {
            Text(search.mode == .names && !search.fellBackToText
                 ? "Index stopped at \(FileTreeSearch.maxIndexedFiles) files — pick a narrower folder"
                 : "First \(FileTreeSearch.maxTextHits) hits shown")
                .font(GenTypography.mono(9))
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
            withAnimation(scrollAnimation) { proxy.scrollTo(Self.topID, anchor: .top) }
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
            withAnimation(animation) { proxy.scrollTo(pending.id, anchor: .center) }
            // Stamped now: a slow folder read must not let the pulse expire before it shows.
            rowPulse = pending.pulse.map { FileTreePulse(id: $0.id, token: $0.token) }
        }
    }

    private func revealSelected(_ root: URL) {
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

    /// Where the header's New File… / New Folder… create.
    private var newItemFolder: URL {
        let revealedFolder = revealed.map { URL(fileURLWithPath: $0) }.flatMap { MarkdownLinkRoute.isFolder($0) ? $0 : nil }
        return MarkdownSidebarReveal.newItemFolder(
            revealedFolder: revealedFolder, selectedFile: model.selected?.url, root: model.filesRootURL
        )
    }

    private func header(_ root: URL) -> some View {
        HStack(spacing: 6) {
            Button {
                model.filesRootUp()
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(model.theme.textSecondary)
                    .frame(width: 16, height: 16)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverPlain())
            .accessibilityIdentifier("markdown-files-up")
            .instantTooltip("Up to \(root.deletingLastPathComponent().lastPathComponent)")

            Text(root.lastPathComponent.isEmpty ? "/" : root.lastPathComponent)
                .font(GenTypography.mono(9.5, weight: .semibold))
                .foregroundColor(model.theme.text)
                .lineLimit(1)
                .truncationMode(.head)
                .padding(.horizontal, 4)
                .padding(.vertical, 1)
                // "Navigate in Sidebar", or a reveal that re-rooted the tree: the new root lights up.
                .fileTreePulse(headerPulse, color: model.theme.accent, cornerRadius: 4)
                .instantTooltip(root.path)
                .accessibilityIdentifier("markdown-files-root")

            Spacer(minLength: 0)

            PathMenuButton(entries: {
                let folder = newItemFolder
                return PathMenu.entries(
                    for: folder, kind: .folder, actions: [.newFile, .newFolder],
                    handlers: model.pathHandlers(for: folder, kind: .folder)
                )
            }) {
                Image(systemName: "plus")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(model.theme.textMuted)
                    .frame(width: 16, height: 16)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverPlain())
            .accessibilityLabel("New file or folder")
            .accessibilityIdentifier("markdown-files-new")
            .instantTooltip("New file or folder in \(newItemFolder.lastPathComponent)")

            if gitMarks {
                Button {
                    changedOnly.toggle()
                } label: {
                    Image(systemName: "plusminus")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundColor(changedOnly ? model.theme.accent : model.theme.textMuted)
                        .frame(width: 16, height: 16)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.genHoverPlain())
                .accessibilityIdentifier("markdown-files-changed-only")
                .instantTooltip(changedOnly ? "Showing only changed files: click for all" : "Show only changed files")
            }

            Button {
                if searchOpen { closeSearch() } else { searchOpen = true }
            } label: {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(searchOpen ? model.theme.accent : model.theme.textMuted)
                    .frame(width: 16, height: 16)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverPlain())
            .accessibilityIdentifier("markdown-files-search-toggle")
            .instantTooltip("Find a file by name, or text in files (⌘⇧F)")

            Button {
                tree.reload()
            } label: {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(model.theme.textMuted)
                    .frame(width: 16, height: 16)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverPlain())
            .accessibilityIdentifier("markdown-files-reload")
            .instantTooltip("Re-read this folder")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
    }
}

/// One search hit: the file name, its folder under the root, and for a text
/// hit the line number and the matching line. Its type follows the tree's.
private struct MarkdownFileTreeResultRow: View {
    let hit: FileTreeSearch.Hit
    @ObservedObject var model: MarkdownDocumentsModel
    let fontSize: CGFloat
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
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip(hit.path)
        .accessibilityIdentifier("markdown-files-result")
    }
}
