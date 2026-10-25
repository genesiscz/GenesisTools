//
//  MarkdownDocumentsModel.swift
//  GenesisKit
//
//  The window's state: open tabs, selection, layout, find, links and the settings it remembers.
//

import AppKit
import Combine
import SwiftUI
import UniformTypeIdentifiers

private let markdownRendererKey = "markdownWindow.renderer"
private let markdownModeKey = "markdownWindow.mode"
private let markdownSplitKey = "markdownWindow.splitRatio"
private let markdownOutlineKey = "markdownWindow.outline"
private let markdownFilesKey = "markdownWindow.files"
private let markdownGitKey = "markdownWindow.git"
private let markdownRecentsKey = "markdownWindow.recents"
private let markdownFilesRootKey = "markdownWindow.filesRoot"
private let markdownFilesWidthKey = "markdownWindow.filesWidth"
private let markdownGitWidthKey = "markdownWindow.gitWidth"
private let markdownZoomKey = "markdownWindow.zoom"
private let markdownFloatKey = "markdownWindow.float"
private let markdownThemeKey = "markdownWindow.theme"
private let markdownArticleWidthKey = "markdownWindow.articleWidth"
private let markdownTabsKey = "markdownWindow.tabs"
private let markdownScrollKey = "markdownWindow.scroll"
private let markdownSelectedKey = "markdownWindow.selected"

@MainActor
final class MarkdownDocumentsModel: ObservableObject {
    @Published private(set) var docs: [MarkdownDocument] = []
    @Published var selectedId: String? {
        didSet {
            guard selectedId != oldValue else { return }
            revisionRequest += 1
            if let selectedId, !navigatingHistory { history.visit(selectedId) }
        }
    }
    /// The notes shown, for Back and Forward (`MarkdownDocumentsModel+History.swift`). Every selection is a visit,
    /// except the one Back or Forward makes (`navigatingHistory`).
    var history = MarkdownNavigationHistory()
    var navigatingHistory = false
    /// The preview tab (italic title): the file a single click in the file tree opened, which the next such
    /// click replaces in place. nil = every tab is kept. An edit, a double-click on the tab or `keep(_:)`
    /// keeps it (`MarkdownDocumentsModel+Tabs.swift`). Not remembered between launches.
    @Published var previewTabId: String?
    /// Keeps the preview tab on its first edit; nil while there is no preview tab.
    var previewEditWatch: AnyCancellable?
    /// The viewer's tunables (preview and wrapped tabs, hover previews, contrast, toolbar labels). The
    /// process-wide one; a test hands in its own. The window forwards its changes to this model.
    var configuration = GenesisKitMarkdownConfiguration.shared
    /// The last grouping of the tabs and what it was computed from (`MarkdownDocumentsModel+TabGroups`).
    let tabGroupMemo = MarkdownTabGroupMemo()
    /// Reading view, source, or both (⌘E / ⌘\), per window, not per file.
    /// Remembered between launches like the rest of the chrome.
    @Published var modeRaw: String = MarkdownViewMode.preview.rawValue {
        didSet { defaults.set(modeRaw, forKey: markdownModeKey) }
    }
    /// The editor's share of the width in split view.
    @Published var splitRatio: Double = MarkdownSplit.defaultRatio {
        didSet { defaults.set(splitRatio, forKey: markdownSplitKey) }
    }
    // These three read and write the model's OWN defaults, not
    // `UserDefaults.standard`. A property initializer cannot see `self`, so
    // they are loaded in `init` instead — reaching for the standard suite
    // there leaks state between windows and between tests.
    /// The heading outline on the left (⌘⇧O), remembered between launches.
    @Published var showOutline = false {
        didSet { defaults.set(showOutline, forKey: markdownOutlineKey) }
    }
    /// The file sidebar on the far left (⌘⇧B), remembered between launches.
    @Published var showFiles = false {
        didSet { defaults.set(showFiles, forKey: markdownFilesKey) }
    }
    /// The file sidebar's width in points, dragged at its right edge and remembered between launches.
    @Published var filesWidth: Double = MarkdownSidebarWidth.standard {
        didSet { defaults.set(filesWidth, forKey: markdownFilesWidthKey) }
    }
    /// The git sidebar's width; its left edge drags like the file sidebar's right edge.
    @Published var gitWidth: Double = MarkdownSidebarWidth.gitStandard {
        didSet { defaults.set(gitWidth, forKey: markdownGitWidthKey) }
    }
    /// Folder the file sidebar is rooted at. Empty means "follow the open
    /// document", which is what a reader expects the first time they open it.
    @Published var filesRoot: String = "" {
        willSet {
            // The place the tree leaves, for Back (`MarkdownTreeHistory`). Not while Back or Forward itself moves it.
            if !restoringTreePlace, newValue != filesRoot, let place = treePlace?() { treeHistory.record(place) }
        }
        didSet { defaults.set(filesRoot, forKey: markdownFilesRootKey) }
    }

    /// The directory the sidebar should list: the pinned one, else the folder
    /// of the open document, else home.
    var filesRootURL: URL {
        if !filesRoot.isEmpty {
            let url = URL(fileURLWithPath: (filesRoot as NSString).expandingTildeInPath)
            var isDirectory: ObjCBool = false
            if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), isDirectory.boolValue {
                return url
            }
        }
        if let doc = selected { return FileTree.defaultRoot(for: doc.url) }
        return FileManager.default.homeDirectoryForCurrentUser
    }

    /// A Finder drop: readable files become tabs (the last one selected),
    /// a folder re-roots the file sidebar, and anything else goes to the app
    /// that owns it rather than silently doing nothing.
    func acceptDrop(_ urls: [URL]) {
        let (tabs, external) = MarkdownDrop.split(urls)
        if !tabs.isEmpty { open(tabs) }
        let folder = MarkdownDrop.firstFolder(urls)
        if let folder {
            filesRoot = folder.standardizedFileURL.path
            showFiles = true
        }
        // A document goes to its app; anything that could run (an app, a script, an executable) waits for Open
        // Anyway, since a stray drop must not start a program (UX audit W14).
        var sent: [(app: String, url: URL)] = []
        var held: [URL] = []
        for url in external {
            if let app = defaultApp(url), MarkdownDocumentLinks.mayOpenWithDefaultApp(url, app: app) {
                openExternally(url)
                sent.append((app.name, url))
            } else {
                held.append(url)
            }
        }
        let folders = urls.filter { url in
            var isDirectory: ObjCBool = false
            return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) && isDirectory.boolValue
        }.count
        let gone = urls.count - tabs.count - external.count - folders
        // One note for the whole drop: what opened, what went where, what is gone, what waits (UX audit D7). Tabs
        // alone need none: the tab is on screen.
        guard let text = Self.dropSummary(opened: tabs, sent: sent, folder: folder, gone: gone, held: held) else { return }
        guard !held.isEmpty else {
            post(MarkdownNotice(text, tone: gone > 0 ? .warning : .info))
            return
        }
        let label = held.count == 1 ? "Open Anyway" : "Open \(held.count) Anyway"
        post(MarkdownNotice(text, tone: .warning, actions: [
            .button(label, symbol: "arrow.up.forward.app") { [weak self] in
                self?.dismissNotice()
                held.forEach { self?.openExternally($0) }
            },
        ]))
    }

    /// The sentence after a drop, or nil when it only opened tabs. "Opened 2 notes, sent 1 file to Preview."
    static func dropSummary(opened: [URL], sent: [(app: String, url: URL)], folder: URL?, gone: Int, held: [URL]) -> String? {
        guard !sent.isEmpty || folder != nil || gone > 0 || !held.isEmpty else { return nil }
        func count(_ n: Int, _ word: String) -> String { "\(n) \(word)\(n == 1 ? "" : "s")" }
        var parts: [String] = []
        if !opened.isEmpty {
            let notes = opened.allSatisfy { $0.pathExtension.lowercased() == "md" }
            parts.append("opened " + count(opened.count, notes ? "note" : "file"))
        }
        var apps: [String] = []
        for item in sent where !apps.contains(item.app) { apps.append(item.app) }
        for app in apps {
            let files = sent.filter { $0.app == app }
            let what = files.count == 1 ? "\u{201C}\(files[0].url.lastPathComponent)\u{201D}" : count(files.count, "file")
            parts.append("sent \(what) to \(app)")
        }
        if let folder { parts.append("showed \(folder.lastPathComponent) in the sidebar") }
        if gone > 0 { parts.append(count(gone, "file") + (gone == 1 ? " was" : " were") + " not found") }
        var sentences: [String] = []
        if !parts.isEmpty {
            let joined = parts.count > 1 ? parts.dropLast().joined(separator: ", ") + " and " + parts.last! : parts[0]
            sentences.append(joined.prefix(1).uppercased() + joined.dropFirst() + ".")
        }
        if held.count == 1 {
            sentences.append("\u{201C}\(held[0].lastPathComponent)\u{201D} is not a file this viewer shows, and opening it can start a program.")
        } else if held.count > 1 {
            sentences.append("\(held.count) files are not files this viewer shows, and opening them can start a program.")
        }
        return sentences.joined(separator: " ")
    }

    /// "Go to Location…" (⇧⌘G): the sheet, and the folder (or a link's file) the file tree last revealed.
    @Published var goToOpen = false
    @Published private(set) var revealTarget: URL?
    @Published private(set) var revealToken = 0
    /// What the sidebar pulses after a reveal: the revealed row, or its header when the tree re-rooted
    /// (`MarkdownSidebarReveal`). A date with it, so a row that scrolls into view later does not replay it.
    @Published private(set) var revealPulse: MarkdownSidebarPulse?
    /// The folder "Search in Folder…" limits the sidebar's next text search to. The sidebar takes it
    /// (and clears it) when it opens its search, so a plain ⌘⇧F searches the whole tree again.
    @Published var treeSearchScope: URL?

    /// A path from "Go to Location…". A folder shows in the file tree: revealed and selected when it
    /// is under the tree's root, else the tree's new root. A file opens as a tab and the tree stays
    /// where it is. Returns what is wrong, nil when it went.
    func goTo(_ raw: String) -> String? {
        guard let url = MarkdownGoTo.url(from: raw, base: filesRootURL) else { return "Type a path." }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
            return "Nothing at \((url.path as NSString).abbreviatingWithTildeInPath)."
        }

        if isDirectory.boolValue {
            revealInSidebar(url)
        } else {
            // A tree that follows the open document would move to the file's folder: pinned first.
            if filesRoot.isEmpty {
                filesRoot = filesRootURL.standardizedFileURL.path
            }
            open([url])
        }
        return nil
    }

    /// The file sidebar, open, with `item` (a folder or a file) shown ("Show in Sidebar"). Its folders open, the
    /// row glides into view and pulses; outside the root the tree first re-roots (`MarkdownSidebarReveal.plan`).
    /// With `navigate` ("Navigate in Sidebar") the tree re-roots at the folder (a file: its folder) and its header
    /// pulses instead.
    func revealInSidebar(_ item: URL, navigate: Bool = false) {
        let item = item.standardizedFileURL
        showFiles = true
        let isFolder = MarkdownLinkRoute.isFolder(item)
        let plan = navigate
            ? MarkdownSidebarReveal.Plan.reRoot((isFolder ? item : item.deletingLastPathComponent()).path)
            : MarkdownSidebarReveal.plan(item, isFolder: isFolder, root: filesRootURL.standardizedFileURL)
        revealToken += 1
        switch plan {
        case .row:
            revealPulse = MarkdownSidebarPulse(target: .row(item.path), token: revealToken)
        case .root:
            revealPulse = MarkdownSidebarPulse(target: .header, token: revealToken)
        case .reRoot(let folder):
            filesRoot = folder
            // "Show in Sidebar" lands on the row in the new root as well; "Navigate in Sidebar" lights the header.
            revealPulse = MarkdownSidebarPulse(target: navigate || item.path == folder ? .header : .row(item.path), token: revealToken)
        }
        revealTarget = item
        GenesisKit.log("markdown: sidebar reveal \(item.path) navigate=\(navigate) -> \(plan)")
    }

    /// A link to a folder: a menu at the pointer, since a folder has no single place to open in. The
    /// same folder verbs as a path segment or a tree folder (`pathMenu`).
    private func offerFolder(_ folder: URL) {
        let started = Date()
        let picked = presentFolderMenu(folder, pathMenu(for: folder, kind: .folder))
        let ms = Int(Date().timeIntervalSince(started) * 1000)
        GenesisKit.log("markdown: folder link \(folder.path), menu open \(ms) ms, picked=\(picked)")
    }

    /// The file sidebar's back and forward (`MarkdownTreeHistory`). The tree view supplies its place (`treePlace`)
    /// and applies the one asked for (`pendingTreePlace`): the open folders and the scroll offset live there.
    let treeHistory = MarkdownTreeHistory()
    /// Supplies the sidebar's current root, expanded folders and scroll offset to history.
    var treePlace: (() -> MarkdownTreePlace)?
    /// The saved place the sidebar must restore before acknowledging completion.
    @Published private(set) var pendingTreePlace: MarkdownTreePlace?
    private var restoringTreePlace = false

    /// Navigates to the previous sidebar place while saving the current place for Forward.
    func treeBack() {
        guard let current = treePlace?(), let place = treeHistory.goBack(from: current) else { return }
        restoreTreePlace(place)
    }

    /// Navigates to the next sidebar place while saving the current place for Back.
    func treeForward() {
        guard let current = treePlace?(), let place = treeHistory.goForward(from: current) else { return }
        restoreTreePlace(place)
    }

    private func restoreTreePlace(_ place: MarkdownTreePlace) {
        showFiles = true
        restoringTreePlace = true
        filesRoot = place.root
        restoringTreePlace = false
        pendingTreePlace = place
        GenesisKit.log("markdown: sidebar history -> \(place.root.isEmpty ? "(follows document)" : place.root), \(place.expanded.count) open folders")
    }

    /// The tree took the place back.
    func treePlaceRestored() {
        pendingTreePlace = nil
    }

    /// Walk the sidebar up one folder. Pins the result, so it stays there when
    /// the reader switches tabs.
    func filesRootUp() {
        let parent = filesRootURL.deletingLastPathComponent()
        guard parent.path != filesRootURL.path else { return }
        filesRoot = parent.path
    }

    /// Heading the reading pane should jump to, and the one it currently shows.
    @Published var scrollTarget: String?
    /// The heading on screen lives in its own object (`MarkdownSectionSpy`): the page reports it while the reader
    /// scrolls, and as a property of this model every report re-ran the whole window's bodies (2026-10-15: eight
    /// views per report, 15 ms each with 100 tabs). Only the outline shows it.
    let section = MarkdownSectionSpy()
    var activeSectionSlug: String? {
        get { section.slug }
        set {
            if section.slug != newValue {
                section.slug = newValue
            }
        }
    }
    /// Find bar (⌘F): the query, the token that re-fires it, and the tally the
    /// renderer reports back.
    @Published var findOpen = false
    @Published var findQuery = ""
    @Published private(set) var findToken = 0
    @Published private(set) var findDelta = 0
    /// 1-based, as the counter shows it. -1 = the page refused the pattern (an invalid regex).
    @Published var findIndex = 0
    @Published var findCount = 0
    /// Bumped by every ⌘F, so the bar takes focus (and selects its text) even when it is already open.
    @Published var findFocusToken = 0
    /// Replace row of the find bar (⌥⌘F), source view only.
    @Published var replaceOpen = false
    @Published var replaceText = ""
    /// The match the source editor should select and scroll to.
    @Published private(set) var sourceSelection: MarkdownSourceSelection?
    /// Find in selection: the matches stay inside the selection that existed
    /// when it was turned on (`setFindInSelection`). Not remembered between launches.
    @Published var findInSelection = false
    /// The source range find in selection took, and the tab it belongs to.
    var findScope: MarkdownFindScope?
    /// Bumped each time find in selection turns on: the page takes its DOM selection of that moment.
    var findScopeToken = 0
    /// The editor's latest selection, and the latest one the reader made. Find's
    /// own selections are not the reader's, so they never become a seed or a scope.
    /// Plain properties: the caret moves on every keystroke, and nothing on screen shows these.
    var editorSelection: MarkdownEditorSelection?
    var editorUserSelection: MarkdownEditorSelection?
    /// The find field has the keyboard. ⌘F then only selects the field's text;
    /// from the editor or the page it takes their one-line selection as the query.
    var findFieldFocused = false

    /// Match case, whole word and regex, remembered between launches in this
    /// model's defaults (`markdownWindow.find.*`). Every change runs the search again.
    var findOptions: MarkdownFindOptions {
        get { MarkdownFindOptions(defaults: defaults) }
        set {
            guard newValue != findOptions else { return }
            objectWillChange.send()
            newValue.save(to: defaults)
            search()
        }
    }

    /// The tabs and the selected tab survive a relaunch, so the viewer comes
    /// back the way it was closed. Files that vanished meanwhile are dropped.
    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let paths = defaults.stringArray(forKey: markdownTabsKey) ?? []
        docs = paths
            .filter { FileManager.default.fileExists(atPath: $0) }
            .map { MarkdownDocument(url: URL(fileURLWithPath: $0)) }
        let wanted = defaults.string(forKey: markdownSelectedKey)
        selectedId = docs.contains { $0.id == wanted } ? wanted : docs.last?.id
        modeRaw = defaults.string(forKey: markdownModeKey) ?? MarkdownViewMode.preview.rawValue
        scrollMemory = (defaults.dictionary(forKey: markdownScrollKey) as? [String: [String: Double]]) ?? [:]
        let ratio = defaults.double(forKey: markdownSplitKey)
        splitRatio = ratio > 0 ? ratio : MarkdownSplit.defaultRatio
        showOutline = defaults.bool(forKey: markdownOutlineKey)
        showFiles = defaults.bool(forKey: markdownFilesKey)
        showGit = defaults.bool(forKey: markdownGitKey)
        if let data = defaults.data(forKey: markdownRecentsKey),
           let entries = try? JSONDecoder().decode([MarkdownRecent].self, from: data) {
            recents = MarkdownRecents(entries: entries)
        }
        filesRoot = defaults.string(forKey: markdownFilesRootKey) ?? ""
        filesWidth = MarkdownSidebarWidth.clamped(defaults.double(forKey: markdownFilesWidthKey))
        gitWidth = MarkdownSidebarWidth.clamped(defaults.double(forKey: markdownGitWidthKey), fallback: MarkdownSidebarWidth.gitStandard)
    }

    var mode: MarkdownViewMode {
        MarkdownViewMode(rawValue: modeRaw) ?? .preview
    }

    /// Where each tab was left, so switching tabs (or reopening the window)
    /// comes back to the same place instead of the top. Keyed by file path,
    /// then by which pane: the reading view and the editor scroll apart.
    private var scrollMemory: [String: [String: Double]] = [:]

    func scrollOffset(for id: String, pane: MarkdownPane) -> Double? {
        scrollMemory[id]?[pane.rawValue]
    }

    func rememberScroll(_ offset: Double, for id: String, pane: MarkdownPane) {
        guard scrollMemory[id]?[pane.rawValue] != offset else { return }
        scrollMemory[id, default: [:]][pane.rawValue] = offset
        // NOT written to disk here. This runs on every bounds change of a
        // scrolling text view — dozens of times per gesture — and
        // `UserDefaults.set` serializes the whole dictionary each time. The
        // position is kept in memory and flushed when the reader stops.
        scheduleScrollFlush()
    }

    private var scrollFlush: DispatchWorkItem?
    private var lastScrollWrite: Date = .distantPast
    private static let scrollWriteInterval: TimeInterval = 0.75
    /// Test seam: how many times the dictionary actually reached the disk.
    private(set) var scrollWrites = 0

    /// Leading edge, then coalesced. The first position of a gesture is on
    /// disk at once (a kill right after must not lose it), and the dozens that
    /// follow collapse into one trailing write instead of one write each.
    private func scheduleScrollFlush() {
        let now = Date()
        if now.timeIntervalSince(lastScrollWrite) >= Self.scrollWriteInterval {
            flushScroll()
            return
        }
        scrollFlush?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.flushScroll() }
        scrollFlush = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.scrollWriteInterval, execute: work)
    }

    /// Called when a tab goes away or the window closes, so a position is not
    /// lost to a pending write.
    func flushScroll() {
        scrollFlush?.cancel()
        scrollFlush = nil
        lastScrollWrite = Date()
        persistScroll()
    }

    private func persistScroll() {
        scrollWrites += 1
        // Only the open tabs are worth keeping.
        let live = Set(docs.map(\.id))
        scrollMemory = scrollMemory.filter { live.contains($0.key) }
        defaults.set(scrollMemory, forKey: markdownScrollKey)
    }

    func setMode(_ mode: MarkdownViewMode) {
        modeRaw = mode.rawValue
    }

    /// ⌘E: the reading view and the source swap. From split it returns to the
    /// reading view, since split is already showing the source.
    func toggleSource() {
        setMode(mode == .preview ? .source : .preview)
    }

    /// ⇧⌘E: side by side, and back to the reading view. (Not ⌘\: a backslash
    /// needs a modifier on the Czech layout, so the shortcut never matched.)
    func toggleSplit() {
        setMode(mode == .split ? .preview : .split)
    }

    private let defaults: UserDefaults

    private func persistTabs() {
        defaults.set(docs.map(\.id), forKey: markdownTabsKey)
        defaults.set(selectedId, forKey: markdownSelectedKey)
    }

    /// Reading size (⌘+ / ⌘- / ⌘0), remembered between launches.
    @Published var zoom: Double = UserDefaults.standard.object(forKey: markdownZoomKey) as? Double
        ?? MarkdownZoom.base
    {
        didSet { UserDefaults.standard.set(zoom, forKey: markdownZoomKey) }
    }

    /// Reading column width in CSS px, dragged from the grips beside the page.
    /// 0 = the stylesheet's default.
    @Published var articleWidth: Double = UserDefaults.standard.double(forKey: markdownArticleWidthKey) {
        didSet { UserDefaults.standard.set(articleWidth, forKey: markdownArticleWidthKey) }
    }

    /// Keep the window above the app you are reading against, remembered
    /// between launches. The window controller mirrors this onto the level.
    @Published var floating = UserDefaults.standard.bool(forKey: markdownFloatKey) {
        didSet { UserDefaults.standard.set(floating, forKey: markdownFloatKey) }
    }
    /// Closed tabs, newest last, so ⌘⇧T walks back through them.
    @Published private(set) var recentlyClosed: [URL] = []
    /// How many of the newest `recentlyClosed` entries one batch close (a group, every other tab) left: ⌘⇧T and the
    /// note's Undo reopen them together. 0 after a single close.
    private(set) var closedBatchCount = 0
    /// While `closeTabs` runs: the files it closed so far.
    private var closingBatch: [URL]?
    /// How many closed tabs ⌘⇧T keeps; a batch larger than this is kept whole.
    static let reopenLimit = 100
    /// File → Open Recent (MarkdownRecents.swift), kept in this window's defaults.
    private(set) var recents = MarkdownRecents() {
        didSet {
            guard recents != oldValue, let data = try? JSONEncoder().encode(recents.entries) else { return }
            defaults.set(data, forKey: markdownRecentsKey)
        }
    }

    /// Open Recent's "Clear Closed": the files still open in a tab stay.
    func clearRecents() {
        recents.clear(keeping: Set(docs.map(\.id)))
    }
    /// Palette for the chrome and the page, cycled from the status bar.
    @Published var themeRaw: String = UserDefaults.standard.string(forKey: markdownThemeKey)
        ?? MarkdownTheme.genesis.rawValue
    {
        didSet { UserDefaults.standard.set(themeRaw, forKey: markdownThemeKey) }
    }

    var theme: MarkdownTheme {
        MarkdownTheme(rawValue: themeRaw, contrast: configuration.contrast) ?? MarkdownTheme(palette: .genesis, contrast: configuration.contrast)
    }

    func cycleTheme() {
        themeRaw = theme.next.rawValue
    }

    /// The compare sheet (mine versus disk) for the selected tab.
    @Published var compareOpen = false

    // MARK: Git (MarkdownDocumentsModel+Git.swift)

    /// The git sidebar: this file's history and the repository, remembered between launches.
    @Published var showGit = false {
        didSet { defaults.set(showGit, forKey: markdownGitKey) }
    }
    /// The Changes mode's scope (nil: the configured default) and its picked commit, here so the git sidebar can
    /// open a file at a scope.
    @Published var changesScope: GitFileScope?
    @Published var changesCommit: String?
    /// A past version of a file, read-only in its tab.
    var revisionRequest = 0
    @Published var revisionView: MarkdownRevision?
    /// Two versions of a file in the Changes mode.
    @Published var revisionCompare: MarkdownRevisionCompare?
    /// A commit's files, in a sheet.
    @Published var commitSheet: MarkdownCommitSheet?
    /// The live reading web view, for PDF export and print.
    let webProxy = MarkdownWebProxy()
    /// The window's one message (`MarkdownNoticeSlot`): a save failure, a replace count, a closed batch of tabs.
    @Published private(set) var notice: MarkdownNotice?
    private var noticeClear: Task<Void, Never>?

    /// Shows `notice` in place of the one before, announces it to VoiceOver, and clears it after its lifetime
    /// (an error stays until it is closed).
    func post(_ notice: MarkdownNotice) {
        self.notice = notice
        GenAnnounce.post(notice.text, priority: notice.tone == .error ? .high : .medium)
        noticeClear?.cancel()
        guard let lifetime = notice.lifetime else { return }
        let id = notice.id
        noticeClear = Task { [weak self] in
            try? await Task.sleep(for: .seconds(lifetime))
            guard !Task.isCancelled else { return }
            self?.dismissNotice(id)
        }
    }

    /// Save as PDF… (⇧⌘S, File menu, toolbar): the reading page of the selected tab, a failure in the slot.
    func exportPDF() {
        guard let doc = selected else { return }
        exportError = nil
        MarkdownExport.savePDF(from: webProxy, note: doc.url, in: NSApp.keyWindow) { [weak self] in self?.exportError = $0 }
    }

    /// Print… (⌘P, File menu, toolbar).
    func printDocument() {
        guard let doc = selected else { return }
        exportError = nil
        webProxy.printDocument(title: doc.title, in: NSApp.keyWindow) { [weak self] in self?.exportError = $0 }
    }

    /// Closes the shown note; with an id, only while that note is still the one shown.
    func dismissNotice(_ id: UUID? = nil) {
        guard let notice, id == nil || notice.id == id else { return }
        self.notice = nil
    }

    /// The shown error's sentence. Setting a text posts it as an error; setting nil closes an error (a success
    /// stays for its own lifetime).
    var exportError: String? {
        get { notice?.tone == .error ? notice?.text : nil }
        set {
            if let newValue {
                post(MarkdownNotice(newValue, tone: .error))
            } else if notice?.tone == .error {
                dismissNotice()
            }
        }
    }

    /// Where ⌘F looks. With the editor on screen it searches the source, which
    /// is also the only place a replace makes sense; otherwise it marks matches
    /// in the rendered page, which only the web renderer can do.
    var findsInSource: Bool { mode.showsEditor }
    var supportsFind: Bool { findsInSource || (mode.showsPreview && renderer == .web) }
    /// PDF and print go through the reading web view, so they need it on screen.
    /// Not `supportsFind`: that is also true in source view, where there is none.
    var canExport: Bool { mode.showsPreview && renderer == .web }

    func zoomStep(_ direction: Int) {
        zoom = MarkdownZoom.step(from: zoom, direction: direction)
    }

    func zoomReset() {
        zoom = MarkdownZoom.base
    }

    /// An empty query clears the marks, so a closed bar is a cleared document,
    /// and so is a pattern that cannot run (the counter says why).
    var findCommand: MarkdownFindCommand {
        let options = findOptions
        let runs = findOpen && SourceFind.patternError(findQuery, options: options) == nil
        return MarkdownFindCommand(
            query: runs ? findQuery : "",
            token: findToken,
            delta: findDelta,
            options: options,
            scope: findInSelection ? findScopeToken : nil,
            scrollbarMarks: GenesisKitMarkdownConfiguration.shared.scrollbarMatchMarks
        )
    }

    func search() {
        findDelta = 0
        findToken &+= 1
        if findsInSource { runSourceFind(delta: 0) }
    }

    /// Walks the matches. With nothing marked yet (a fresh document, a renderer
    /// switch) it searches first, so ⌘G never lands on an empty document.
    func stepFind(_ delta: Int) {
        guard findCount > 0 else {
            search()
            return
        }
        findDelta = delta
        findToken &+= 1
        if findsInSource { runSourceFind(delta: delta) }
    }

    /// ⌘F always opens and focuses the field with its text selected, so typing
    /// replaces the old query. From the editor or the page, a one-line selection
    /// becomes the query first, as in Cursor. Closing is Esc or the close
    /// button, so a second ⌘F never hides a bar you were about to type in.
    func openFind() {
        let fieldHadKeyboard = findOpen && findFieldFocused
        findOpen = true
        if !fieldHadKeyboard { seedFindFromSelection() }
        findFocusToken &+= 1
        search()
    }

    func closeFind() {
        findOpen = false
        findQuery = ""
        findIndex = 0
        findCount = 0
        replaceOpen = false
        sourceSelection = nil
        findInSelection = false
        findScope = nil
        findFieldFocused = false
        search()
    }

    // MARK: Find and replace in the source

    /// Walks the matches in the selected document and tells the editor which
    /// one to show. `delta` 0 starts from where the caret already is.
    func runSourceFind(delta: Int) {
        guard let doc = selected else { return }
        let matches = SourceFind.matches(
            in: doc.displayText, query: findQuery, options: findOptions, within: activeSourceScope
        )
        findCount = matches.count
        guard !matches.isEmpty else {
            findIndex = 0
            sourceSelection = nil
            return
        }
        if delta == 0, findIndex <= 0 {
            findIndex = SourceFind.firstMatch(after: sourceSelection?.range.location ?? 0, in: matches)
        } else {
            findIndex = SourceFind.step(count: matches.count, current: findIndex, delta: delta == 0 ? 0 : delta)
        }
        findIndex = min(max(findIndex, 1), matches.count)
        show(matches[findIndex - 1])
    }

    /// Replaces the match on screen, then moves to the next one. With regex on,
    /// the replacement is a template (`$1`).
    func replaceCurrent() {
        guard findsInSource, let doc = selected, !findQuery.isEmpty else { return }
        let options = findOptions
        let matches = SourceFind.matches(
            in: doc.displayText, query: findQuery, options: options, within: activeSourceScope
        )
        guard findIndex >= 1, findIndex <= matches.count else {
            runSourceFind(delta: 0)
            return
        }
        let match = matches[findIndex - 1]
        let value = SourceFind.replacement(
            for: match, in: doc.displayText, query: findQuery, options: options, template: replaceText
        )
        let result = SourceFind.replace(in: doc.displayText, match: match, with: value)
        doc.edit(result.text)
        growFindScope(by: (value as NSString).length - match.length)
        let remaining = SourceFind.matches(
            in: result.text, query: findQuery, options: options, within: activeSourceScope
        )
        findCount = remaining.count
        findIndex = remaining.isEmpty ? 0 : SourceFind.firstMatch(after: result.next, in: remaining)
        if findIndex > 0 { show(remaining[findIndex - 1]) } else { sourceSelection = nil }
    }

    /// Every match, or every match inside the selection with find in selection on.
    func replaceAll() {
        guard findsInSource, let doc = selected, !findQuery.isEmpty else { return }
        let before = (doc.displayText as NSString).length
        let result = SourceFind.replaceAll(
            in: doc.displayText, query: findQuery, options: findOptions, within: activeSourceScope, with: replaceText
        )
        guard result.count > 0 else { return }
        doc.edit(result.text)
        growFindScope(by: (result.text as NSString).length - before)
        findCount = 0
        findIndex = 0
        sourceSelection = nil
        post(MarkdownNotice("Replaced \(result.count) \(result.count == 1 ? "match" : "matches")", tone: .success))
    }

    func show(_ range: NSRange) {
        sourceSelection = MarkdownSourceSelection(range: range, token: (sourceSelection?.token ?? 0) + 1)
    }

    /// A line the reader asked for (a text hit in the file sidebar): the
    /// source editor selects it, and the preview scrolls its block to the top
    /// (the pane converts the file line to a body line, see `lineTarget`).
    @Published var lineTarget: MarkdownLineSync?

    /// Bumped by ⌘⇧F: the sidebar opens (if it was closed) and focuses its
    /// search field in text mode.
    @Published var treeSearchToken = 0
    /// The last token the sidebar acted on. Kept here, not in the view: ⌘⇧F on
    /// a closed sidebar bumps the token before the view exists, so the view
    /// consumes it on appear, and a later plain reopen must not replay it.
    var treeSearchHandled = 0

    /// Lines a link or an open URL (`range=`) asked for. The source editor
    /// selects them and the preview marks and scrolls to them, until another
    /// tab is selected.
    @Published var lineHighlight: MarkdownLineHighlight?

    func reveal(_ range: MarkdownLineRange) {
        guard let doc = selected else { return }
        show(range.characterRange(in: doc.displayText))
        lineHighlight = MarkdownLineHighlight(range: range, token: (lineHighlight?.token ?? 0) + 1)
    }

    /// `line` is 1-based and counts from the top of the file, frontmatter
    /// included, the way grep reports it.
    func jump(toLine line: Int) {
        guard let doc = selected, line >= 1 else { return }
        let starts = SourceEditing.lineStarts(doc.displayText)
        let index = min(line - 1, starts.count - 1)
        let start = starts[index]
        let end = index + 1 < starts.count ? starts[index + 1] - 1 : (doc.displayText as NSString).length
        show(NSRange(location: start, length: max(0, end - start)))
        lineTarget = MarkdownLineSync(line: line - 1, token: (lineTarget?.token ?? 0) + 1)
    }

    func openTreeSearch() {
        showFiles = true
        treeSearchToken += 1
    }
    /// Reading engine, shared with the vault pane's own choice of the three.
    @Published var rendererRaw: String = UserDefaults.standard.string(forKey: markdownRendererKey)
        ?? MarkdownRenderer.web.rawValue
    {
        didSet { UserDefaults.standard.set(rendererRaw, forKey: markdownRendererKey) }
    }

    var renderer: MarkdownRenderer {
        MarkdownRenderer(rawValue: rendererRaw) ?? .web
    }

    var selected: MarkdownDocument? {
        docs.first { $0.id == selectedId } ?? docs.last
    }

    /// Adds every path that is not open yet and selects the last one given. Opening the preview tab's own
    /// file this way (a double-click in the tree, a link) keeps it. `asPreview` is `openPreview`'s door: a
    /// new file becomes the preview tab, in the old preview tab's place when there is one.
    func open(_ urls: [URL], asPreview: Bool = false) {
        for url in urls {
            let std = url.standardizedFileURL
            recents.opened(std)
            if !docs.contains(where: { $0.url == std }) {
                let doc = MarkdownDocument(url: std)
                if asPreview, let id = previewTabId, let slot = docs.firstIndex(where: { $0.id == id && !$0.isDirty }) {
                    // Replaced, not closed: the old preview was never kept, so it is no tab to reopen.
                    scrollMemory.removeValue(forKey: id)
                    docs[slot] = doc
                } else {
                    docs.append(doc)
                }
                if asPreview { markPreview(doc) }
            } else if !asPreview, previewTabId == std.path {
                keep(std.path)
            }
            select(std.path)
        }
        persistTabs()
    }

    /// The scroll target belongs to the document that was showing, so it is
    /// dropped on every switch; otherwise the new tab jumps to a heading of the
    /// old one that happens to share a slug.
    func select(_ id: String?) {
        // An @Published assignment publishes even when the value does not change, and every publish re-runs every view
        // that observes the model: a tab switch published 10 times. Assign only what changes.
        if id != selectedId {
            if revisionView != nil { revisionView = nil }
            if revisionCompare != nil { revisionCompare = nil }
            selectedId = id
        }
        if scrollTarget != nil { scrollTarget = nil }
        if lineTarget != nil { lineTarget = nil }
        if lineHighlight != nil { lineHighlight = nil }
        if activeSectionSlug != nil { activeSectionSlug = nil }
        if findIndex != 0 { findIndex = 0 }
        if findCount != 0 { findCount = 0 }
        if findOpen {
            search()
        }
        persistTabs()
    }

    /// Next Tab / Previous Tab (`MarkdownKeymap`, ⇧⌘ with the two keys right of P): wrapping at the ends, in the
    /// order the tab bar shows them (groups in their order, a collapsed group's tabs skipped).
    func selectTab(offset: Int) {
        let order = visibleTabOrder
        guard order.count > 1, let current = order.firstIndex(where: { $0 == selected?.id }) else { return }
        let next = ((current + offset) % order.count + order.count) % order.count
        select(order[next])
    }

    /// ⌘1 to ⌘8: the tab at that place in the bar's order; ⌘9 the last tab.
    func selectTab(number: Int) {
        let order = visibleTabOrder
        guard !order.isEmpty, number >= 1 else { return }
        let index = number >= 9 ? order.count - 1 : number - 1
        guard order.indices.contains(index) else { return }
        select(order[index])
    }

    /// Move Tab Left or Right (the tab's menu and its VoiceOver actions): one place in the bar's order, across a
    /// group's edge into the next group, as a drag there would. The keyboard twin of a tab drag (UX audit W6).
    func shiftTab(_ id: String, by offset: Int) {
        let order = visibleTabOrder
        guard let index = order.firstIndex(of: id) else { return }
        let target = index + offset
        guard order.indices.contains(target) else { return }
        dropTab(id, beside: order[target], after: offset > 0)
    }

    func canShiftTab(_ id: String, by offset: Int) -> Bool {
        let order = visibleTabOrder
        guard let index = order.firstIndex(of: id) else { return false }
        return order.indices.contains(index + offset)
    }

    /// Moves a tab before another one, or to the end with nil (a drag in the tab bar). The order is saved like any
    /// other tab change.
    func moveTab(_ id: String, before target: String?) {
        guard id != target, let from = docs.firstIndex(where: { $0.id == id }) else { return }
        var reordered = docs
        let doc = reordered.remove(at: from)
        let slot = target.flatMap { target in reordered.firstIndex { $0.id == target } } ?? reordered.endIndex
        reordered.insert(doc, at: slot)
        guard reordered.map(\.id) != docs.map(\.id) else { return }
        docs = reordered
        persistTabs()
    }

    /// ⌃⇧C, the toolbar, and a file row's Copy Path: the open note's path.
    func copySelectedPath() {
        guard let path = selected?.url.path else { return }
        Clipboard.copy(path, what: "path")
    }

    /// ⌘S on the selected tab. A refused save surfaces through the banner,
    /// which is already on screen whenever `diskChange` is set.
    func saveSelected() {
        guard let doc = selected else { return }
        _ = save(doc)
    }

    /// Saves `doc` and says so when it did not work: a failure as an error note with Try Again, a save refused
    /// because the file changed on disk with the tab selected, where its conflict banner is. Every save the reader
    /// starts goes through here: ⌘S, and Save in the unsaved-changes prompt of a tab, the window or ⌘Q, which used to
    /// leave the tab open with no word (UX audit W1).
    @discardableResult
    func save(_ doc: MarkdownDocument) -> MarkdownDocument.SaveOutcome {
        let outcome = doc.save()
        switch outcome {
        case .saved, .nothingToSave:
            break
        case .blockedByDiskChange:
            if selectedId != doc.id { select(doc.id) }
            post(MarkdownNotice(
                "\u{201C}\(doc.title)\u{201D} was not saved: the file changed on disk. Pick a version in the banner, then save again.",
                tone: .error))
        case .failed(let message):
            if selectedId != doc.id { select(doc.id) }
            post(MarkdownNotice(message, tone: .error, actions: [
                .button("Try Again", symbol: "arrow.clockwise") { [weak self, weak doc] in
                    guard let self, let doc else { return }
                    self.dismissNotice()
                    self.save(doc)
                },
            ]))
        }
        return outcome
    }

    /// Closing a dirty tab asks first. Returns false when the reader cancelled. `remember: false` keeps
    /// the file off the ⌘⇧T stack: a renamed or trashed file's old path is not a tab to reopen.
    @discardableResult
    func close(
        _ doc: MarkdownDocument,
        confirm: @MainActor (MarkdownDocument) -> UnsavedChoice = MarkdownDocumentsModel.askUnsaved,
        remember: Bool = true
    ) -> Bool {
        if doc.isDirty {
            switch confirm(doc) {
            case .save:
                if save(doc) != .saved { return false }
            case .discard: break
            case .cancel: return false
            }
        }
        forceClose(doc, remember: remember)
        return true
    }

    enum UnsavedChoice { case save, discard, cancel }

    /// Closes several tabs as one action (Close Tabs in Group, Close Other Tabs). Each dirty tab asks first, and a
    /// cancel stops there. Two or more closed tabs leave a note with Undo, and ⌘⇧T reopens them all at once: before,
    /// ⌘⇧T brought back one tab per press and the stack forgot all but 20 (UX audit W3). Returns false on a cancel.
    @discardableResult
    func closeTabs(
        _ tabs: [MarkdownDocument],
        confirm: @MainActor (MarkdownDocument) -> UnsavedChoice = MarkdownDocumentsModel.askUnsaved
    ) -> Bool {
        closingBatch = []
        var finished = true
        for doc in tabs where docs.contains(where: { $0.id == doc.id }) {
            guard close(doc, confirm: confirm) else {
                finished = false
                break
            }
        }
        let closed = closingBatch ?? []
        closingBatch = nil
        closedBatchCount = closed.count
        if closed.count > 1 {
            let count = closed.count
            post(MarkdownNotice("Closed \(count) tabs.", tone: .info, actions: [
                .button("Reopen \(count) Tabs", symbol: "arrow.uturn.backward") { [weak self] in
                    guard let self else { return }
                    self.dismissNotice()
                    self.reopenLastClosed()
                },
            ]))
        }
        return finished
    }

    /// Closing the whole window (or quitting): every unsaved tab is saved or
    /// discarded, but no tab is removed, so the session reopens with the same
    /// tabs and the same selection. Returns false when the reader cancelled,
    /// with the tab that was being asked about left selected.
    @discardableResult
    func resolveUnsavedForClose(confirm: @MainActor (MarkdownDocument) -> UnsavedChoice = MarkdownDocumentsModel.askUnsaved) -> Bool {
        let original = selectedId
        // Selecting each dirty tab to show the prompt is not a visit. Cancel would otherwise leave Back on a
        // tab the reader only saw in the alert.
        navigatingHistory = true
        defer { navigatingHistory = false }
        for doc in docs where doc.isDirty {
            select(doc.id)
            switch confirm(doc) {
            case .save:
                if save(doc) != .saved { return false }
            case .discard:
                doc.discardDraft()
            case .cancel:
                return false
            }
        }
        if selectedId != original { select(original) }
        return true
    }

    static func askUnsaved(_ doc: MarkdownDocument) -> UnsavedChoice {
        let alert = NSAlert()
        alert.messageText = "Save changes to \u{201C}\(doc.title)\u{201D}?"
        alert.informativeText = doc.hasDiskChange
            ? "The file also changed on disk. Saving is refused until you reload, keep yours or merge."
            : "Your changes will be lost if you don't save them."
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Don't Save")
        alert.addButton(withTitle: "Cancel")
        switch alert.runModal() {
        case .alertFirstButtonReturn: return .save
        case .alertSecondButtonReturn: return .discard
        default: return .cancel
        }
    }

    private func forceClose(_ doc: MarkdownDocument, remember: Bool = true) {
        // Drop this tab's reading position here rather than leaving it to the
        // next write to filter out: with writes coalesced, "the next write"
        // may be a second away or may never come.
        scrollMemory.removeValue(forKey: doc.id)
        flushScroll()
        if previewTabId == doc.id { keep(doc.id) }
        recentlyClosed.removeAll { $0 == doc.url }
        if remember {
            recentlyClosed.append(doc.url)
            recents.closed(doc.url)
        }
        if remember {
            if closingBatch != nil { closingBatch?.append(doc.url) } else { closedBatchCount = 0 }
        }
        if recentlyClosed.count > max(Self.reopenLimit, closingBatch?.count ?? 0) {
            recentlyClosed.removeFirst(recentlyClosed.count - max(Self.reopenLimit, closingBatch?.count ?? 0))
        }
        let position = docs.firstIndex { $0.id == doc.id }
        docs.removeAll { $0.id == doc.id }
        if selectedId == doc.id {
            // The tab that moved into the closed one's place, or the one before it when the closed tab
            // was the last: as in a browser. `docs.last` jumped from the first tab to the far end.
            let next = position.map { min($0, docs.count - 1) }.flatMap { docs.indices.contains($0) ? docs[$0].id : nil }
            select(next ?? docs.last?.id)
        }
        persistTabs()
    }

    /// ⌘⇧T. A file that is open again already (reopened by hand, or by a new
    /// `genesis open`) is dropped from the stack rather than re-selected twice.
    func reopenLastClosed() {
        if closedBatchCount > 1 {
            let batch = Array(recentlyClosed.suffix(closedBatchCount))
            recentlyClosed.removeLast(batch.count)
            closedBatchCount = 0
            let closed = batch.filter { url in !docs.contains { $0.url == url } }
            if !closed.isEmpty {
                open(closed)
                return
            }
        }
        closedBatchCount = 0
        while let url = recentlyClosed.popLast() {
            if docs.contains(where: { $0.url == url }) {
                continue
            }
            open([url])
            return
        }
    }

    /// Where `follow` hands a URL to the system. Tests swap it for a recorder.
    var openExternally: (URL) -> Void = { NSWorkspace.shared.open($0) }
    /// Where `follow` shows the menu for a code file. Tests swap it for a recorder.
    var presentFileMenu: (MarkdownFileLinkMenu) -> Void = { $0.popUp() }
    /// Where `follow` shows the menu for a folder link; true when an item was picked. Tests swap it for a
    /// recorder: the real one pops an NSMenu at the user's pointer and takes the keyboard, which is what
    /// `swift test` did on 2026-10-13 (ten menus in xctest processes between 12:44 and 13:43).
    var presentFolderMenu: (URL, [PathMenuEntry]) -> Bool = { _, entries in PathMenu.popUp(entries) }
    /// The app macOS opens a file with, and how a menu pick opens the file there. Tests swap both.
    var defaultApp: (URL) -> DefaultApp? = DefaultApp.forFile
    var openWithApp: (DefaultApp, URL, Int?) -> Void = { app, file, line in app.open(file, line: line) }

    /// The menu for a link to a code file or any other file that is not a note: its default app
    /// (at the line when that app is an editor with a line link), this viewer when it can show the
    /// file, and the file sidebar. A note is untrusted, so the default app is offered only where
    /// `mayOpenWithDefaultApp` allows it.
    func fileLinkMenu(_ file: URL, lines: MarkdownLineRange?) -> MarkdownFileLinkMenu {
        var items: [MarkdownFileLinkMenu.Item] = []
        if let app = defaultApp(file), app.bundleIdentifier != Bundle.main.bundleIdentifier,
           MarkdownDocumentLinks.mayOpenWithDefaultApp(file, app: app) {
            items.append(.init(title: "Open in \(app.name)") { [weak self] in
                self?.openWithApp(app, file, lines?.first)
            })
        }
        if FileTree.isReadable(file) {
            items.append(.init(title: "Open in Genesis Markdown") { [weak self] in
                self?.open([file])
                if let lines { self?.reveal(lines) }
            })
        }
        items.append(.init(title: "Reveal in sidebar") { [weak self] in
            self?.revealInSidebar(file)
        })
        return MarkdownFileLinkMenu(file: file, items: items)
    }

    /// A link clicked inside `doc`: another markdown file joins the tabs, a web
    /// address goes to the browser, a document to its app. Every link door
    /// (page links, wikilinks, reference definitions, the editor's ⌘-click)
    /// ends here, and a note is untrusted: a scheme URL leaves only through
    /// `MarkdownWebView.externalURL`, a `file:` URL is a local path like any
    /// other, and a local target opens only when it is a document.
    func follow(_ ref: String, from doc: MarkdownDocument) {
        var target = ref.trimmingCharacters(in: .whitespacesAndNewlines)
        // `[text][label]` points at a definition further down the file.
        if !MarkdownDocumentLinks.hasScheme(target), MarkdownWebView.externalURL(target) == nil,
           let definition = MarkdownSourceLinks.reference(target, in: doc.displayText) {
            target = definition
        }
        // The allowlist goes first: `mailto:` has no `//`, so `hasScheme` misses it and it
        // would otherwise be resolved as a relative path and dropped.
        if let path = MarkdownDocumentLinks.filePath(target) {
            target = path
        } else if let url = MarkdownWebView.externalURL(target) {
            openExternally(url)
            return
        } else if MarkdownDocumentLinks.hasScheme(target) {
            // A click that does nothing looks broken: say which kind of link was refused (UX audit W8).
            let scheme = target.prefix { $0 != ":" }
            post(MarkdownNotice("Links that start with \u{201C}\(scheme):\u{201D} are not opened from a note.", tone: .warning))
            return
        }
        // `Note#Heading` (or a bare `#Heading`, this note) jumps to the heading
        // after the note is open. The page handles its own `#…` clicks, but a
        // reference definition can produce one too.
        if target.hasPrefix("#") {
            if let fragment = MarkdownDocumentLinks.fragment(of: target) { scrollTarget = fragment }
            return
        }
        guard let (url, fragment) = MarkdownDocumentLinks.locate(
            target, folder: doc.folder, vaultRoot: GenesisKit.host?.markdownVaultRoot
        ) else {
            GenesisKit.log("markdown: link \(target) resolves to nothing")
            post(MarkdownNotice("Nothing found for \u{201C}\(target)\u{201D}.", tone: .warning))
            return
        }
        let route = MarkdownLinkRoute.decide(url, fragment: fragment)
        GenesisKit.log("markdown: link \(url.path) fragment=\(fragment ?? "-") -> \(String(describing: route))")
        switch route {
        case let .note(note, heading, lines)?:
            open([note])
            if let lines { reveal(lines) } else if let heading { scrollTarget = heading }
        case let .viewer(file, lines)?:
            open([file])
            if let lines { reveal(lines) }
        case let .choose(file, lines)?:
            presentFileMenu(fileLinkMenu(file, lines: lines))
        case let .folder(folder)?:
            offerFolder(folder)
        case nil:
            break
        }
    }
}
