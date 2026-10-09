import Combine
import Foundation
import WebKit

/// What a standalone review window shows, kept on disk so the same review opens where it was: after a
/// rebuild relaunches it (src/macos/lib/permissions/relaunch.ts), and on any later open of the same thing.
///
/// Keyed by what the window shows (`ReviewSessionKey`): a proposal file, a full PR URL, a repository
/// with a PR reference, or a repository with its launch scope and session. Saved one second after the last
/// change, encoded and written off the main thread, in `~/.genesis-tools/review/state/`.
///
/// The diff page reports its part (`PageState`: the first visible line, unsent reply and comment text)
/// through its own message handler, `genesisReviewState` (web/diff-viewer/review-state.ts), and gets it
/// back once it is ready. A scroll anchor is a file id plus a line, never a pixel offset, so it lands
/// on the same code after a reload whatever the font size or the files above it.
struct ReviewSessionState: Codable, Equatable {
    var version = 1
    var scope: SavedScope?
    var selectedFile: String?
    var filter: String?
    var treeMode: Bool?
    var collapsed: [String]?
    /// The left panel (Review/ReviewContextPanel.swift): its tab, whether it is folded, and the threads
    /// list's filters (Review/PRThreadsPanel.swift). They are settings in `HubDefaults`; a window puts
    /// back the values it had.
    var contextTab: String?
    var contextCollapsed: Bool?
    var threadsOpen: Bool?
    var threadsThisFile: Bool?
    var threadsClosed: Bool?
    /// The push banner's head the reader dismissed, so it stays dismissed.
    var dismissedNewsHead: String?
    /// The checkout picked in the Worktree choice, when it is not the one the window opened on.
    var worktree: String?
    /// The base picked in the Base choice; nil is automatic.
    var chosenBase: String?
    var page: PageState?

    struct PageState: Codable, Equatable {
        var anchor: Anchor?
        var boxes: [ThreadBox]
        var composer: Composer?
    }

    /// The first line on screen: a file id of the diff and its line on one side (nil line: the file's top).
    struct Anchor: Codable, Equatable {
        var fileId: String
        var line: Int?
        var side: String?
    }

    /// An open reply or note edit on a PR thread card, with the text typed so far.
    struct ThreadBox: Codable, Equatable {
        var threadId: String
        var kind: String
        var noteId: String?
        var body: String
    }

    /// The new-comment composer with its text.
    struct Composer: Codable, Equatable {
        var fileId: String
        var side: String
        var startLine: Int
        var endLine: Int
        var editingId: String?
        var body: String
    }

    /// The page's `{type: "state", anchor, boxes, composer}` message as a `PageState`.
    static func pageState(from body: [String: Any]) -> PageState? {
        var fields = body
        fields.removeValue(forKey: "type")
        guard JSONSerialization.isValidJSONObject(fields),
              let data = try? JSONSerialization.data(withJSONObject: fields) else { return nil }
        return try? JSONDecoder().decode(PageState.self, from: data)
    }
}

/// `DiffScope` in a form `Codable` can hold.
struct SavedScope: Codable, Equatable {
    var kind: String
    var count: Int?
    var sha: String?
    var title: String?
    var base: String?
    var head: String?
    var label: String?
    var fallbackBase: String?
    /// `compare`: the two versions and the ref the diff targets.
    var from: CompareEnd?
    var to: CompareEnd?
    var targetRef: String?

    init(_ scope: DiffScope) {
        switch scope {
        case .lastTurns(let count): kind = "lastTurns"; self.count = count
        case .uncommitted: kind = "uncommitted"
        case .unstaged: kind = "unstaged"
        case .staged: kind = "staged"
        case .branch: kind = "branch"
        case .commit(let sha, let title): kind = "commit"; self.sha = sha; self.title = title
        case .range(let base, let head, let label, let fallbackBase):
            kind = "range"; self.base = base; self.head = head; self.label = label; self.fallbackBase = fallbackBase
        case .compare(let from, let to, let label, let targetRef):
            kind = "compare"; self.from = from; self.to = to; self.label = label; self.targetRef = targetRef
        }
    }

    var scope: DiffScope? {
        switch kind {
        case "lastTurns": return count.map { .lastTurns($0) }
        case "uncommitted": return .uncommitted
        case "unstaged": return .unstaged
        case "staged": return .staged
        case "branch": return .branch
        case "commit": return sha.map { .commit(sha: $0, title: title ?? "") }
        case "range":
            guard let base, let head else { return nil }
            return .range(base: base, head: head, label: label ?? "", fallbackBase: fallbackBase)
        case "compare":
            guard let from, let to else { return nil }
            return .compare(from: from, to: to, label: label ?? "", targetRef: targetRef)
        default: return nil
        }
    }

    /// The scope to open on: the saved one, unless it is a range other than the launch's (a proposal
    /// whose PR moved on names new shas, and the old pair would show a diff nobody asked for).
    static func restorable(_ saved: SavedScope?, launch: DiffScope) -> DiffScope? {
        guard let scope = saved?.scope else { return nil }
        if case .range = scope, scope != launch {
            return nil
        }
        return scope
    }
}

enum ReviewSessionKey {
    /// A full PR URL is globally identified; a short reference belongs to the launch repository.
    /// Without a PR, use the launch scope and session, not the scope picked later in the window.
    static func key(proposalPath: String?, prTarget: String?, repo: String, launchScope: DiffScope, session: String?) -> String {
        if let proposalPath, !proposalPath.isEmpty {
            return "proposal:\(URL(fileURLWithPath: proposalPath).standardizedFileURL.path)"
        }
        if let prTarget, !prTarget.isEmpty {
            if let url = URL(string: prTarget), let scheme = url.scheme, ["https", "http"].contains(scheme), url.host != nil {
                return "pr:\(prTarget)"
            }
            let checkout = URL(fileURLWithPath: repo).standardizedFileURL.path
            return "repo:\(checkout)|pr:\(prTarget)"
        }
        return "repo:\(repo)|scope:\(ReviewCache.scopeKey(launchScope, session: session))|session:\(session ?? "-")"
    }
}

/// Reads, applies and saves one review window's `ReviewSessionState`.
final class ReviewSessionPersistence: NSObject, WKScriptMessageHandler {
    static let messageName = "genesisReviewState"
    /// Under `genesisHome()`, like the face records: a sandboxed GENESIS_TOOLS_HOME keeps unsent text in the sandbox.
    static var directory: URL {
        URL(fileURLWithPath: genesisHome()).appendingPathComponent(".genesis-tools/review/state", isDirectory: true)
    }

    static let store = DiskCache(directory: directory, namespace: "window")
    static let saveDelay = 1.0
    private static let writer = DispatchQueue(label: "review.state.writer", qos: .utility)
    /// The window's one instance; the user content controller holds only a weak proxy.
    private static var active: ReviewSessionPersistence?

    /// The `HubDefaults` keys of the left panel a window saves and puts back.
    enum DefaultsKey {
        static let contextTab = "review.context.tab"
        static let threadsOpen = "review.prThreads.open"
        static let threadsThisFile = "review.prThreads.thisFile"
        static let threadsClosed = "review.prThreads.closed"
    }

    private weak var model: ReviewModel?
    private let key: String
    private let cache: DiskCache
    private var page: ReviewSessionState.PageState?
    private var lastWritten: ReviewSessionState?
    private var pendingSave: DispatchWorkItem?
    private var subscriptions: Set<AnyCancellable> = []
    private var defaultsObserver: NSObjectProtocol?

    private init(model: ReviewModel, key: String, cache: DiskCache, saved: ReviewSessionState?) {
        self.model = model
        self.key = key
        self.cache = cache
        page = saved?.page
        lastWritten = saved
        super.init()
    }

    deinit {
        if let defaultsObserver { NotificationCenter.default.removeObserver(defaultsObserver) }
    }

    /// Call once in `runReview`, after the model has its launch scope and proposal and before `start()`:
    /// the first load then already reads the saved scope.
    static func attach(model: ReviewModel, key: String, launchScope: DiffScope, cache: DiskCache = store) {
        let saved = cache.read(ReviewSessionState.self, key: key)
        if let saved {
            apply(saved, to: model, launchScope: launchScope, defaults: HubDefaults.store)
            HubPerf.log("review.state restored \(key): scope \(saved.scope?.kind ?? "-"), file \(saved.selectedFile ?? "-"), "
                + "anchor \(saved.page?.anchor.map { "\($0.fileId):\($0.line ?? 0)" } ?? "-"), \(saved.page?.boxes.count ?? 0) open boxes")
        }
        let persistence = ReviewSessionPersistence(model: model, key: key, cache: cache, saved: saved)
        persistence.observe()
        active = persistence
    }

    /// Puts the Swift side of `state` on `model` and in `defaults`.
    static func apply(_ state: ReviewSessionState, to model: ReviewModel, launchScope: DiffScope, defaults: UserDefaults) {
        if let scope = SavedScope.restorable(state.scope, launch: launchScope) {
            model.scope = scope
        }
        if let file = state.selectedFile {
            // The first load keeps a selection its files contain (ReviewModel.apply), else it picks the first.
            model.selectedID = file
        }
        if let filter = state.filter { model.filter = filter }
        if let treeMode = state.treeMode { model.treeMode = treeMode }
        if let collapsed = state.collapsed { model.collapsed = Set(collapsed) }
        if let dismissed = state.dismissedNewsHead { model.dismissedNewsHead = dismissed }
        if let base = state.chosenBase { model.chosenBase = base }
        if let tree = state.worktree, FileManager.default.fileExists(atPath: tree) { model.switchWorktree(to: tree) }
        if let tab = state.contextTab { defaults.set(tab, forKey: DefaultsKey.contextTab) }
        if let folded = state.contextCollapsed { defaults.set(folded, forKey: ReviewContextPanel.collapsedKey) }
        if let open = state.threadsOpen { defaults.set(open, forKey: DefaultsKey.threadsOpen) }
        if let thisFile = state.threadsThisFile { defaults.set(thisFile, forKey: DefaultsKey.threadsThisFile) }
        if let closed = state.threadsClosed { defaults.set(closed, forKey: DefaultsKey.threadsClosed) }
    }

    /// The window's state now: the model, the left panel's settings, and the page's last report.
    static func capture(model: ReviewModel, defaults: UserDefaults, page: ReviewSessionState.PageState?) -> ReviewSessionState {
        var state = ReviewSessionState()
        state.scope = SavedScope(model.scope)
        state.selectedFile = model.selectedID
        state.filter = model.filter
        state.treeMode = model.treeMode
        state.collapsed = model.collapsed.sorted()
        state.dismissedNewsHead = model.dismissedNewsHead
        state.worktree = model.repo.path
        state.chosenBase = model.chosenBase
        state.contextTab = defaults.string(forKey: DefaultsKey.contextTab)
        state.contextCollapsed = defaults.object(forKey: ReviewContextPanel.collapsedKey) as? Bool
        state.threadsOpen = defaults.object(forKey: DefaultsKey.threadsOpen) as? Bool
        state.threadsThisFile = defaults.object(forKey: DefaultsKey.threadsThisFile) as? Bool
        state.threadsClosed = defaults.object(forKey: DefaultsKey.threadsClosed) as? Bool
        state.page = page
        return state
    }

    private func observe() {
        guard let model else { return }
        let changes: [AnyPublisher<Void, Never>] = [
            model.$scope.map { _ in () }.eraseToAnyPublisher(),
            model.$selectedID.map { _ in () }.eraseToAnyPublisher(),
            model.$filter.map { _ in () }.eraseToAnyPublisher(),
            model.$treeMode.map { _ in () }.eraseToAnyPublisher(),
            model.$collapsed.map { _ in () }.eraseToAnyPublisher(),
            model.$dismissedNewsHead.map { _ in () }.eraseToAnyPublisher(),
            model.$chosenBase.map { _ in () }.eraseToAnyPublisher(),
            model.$worktrees.map { _ in () }.eraseToAnyPublisher(),
        ]
        Publishers.MergeMany(changes).dropFirst(changes.count).sink { [weak self] in self?.scheduleSave() }.store(in: &subscriptions)
        defaultsObserver = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: HubDefaults.store, queue: .main) { [weak self] _ in
            self?.scheduleSave()
        }
        // The page's half: its handler goes on the renderer's web view, which `runReview` builds anyway.
        if let webView = (model.renderer as? PierreWebDiffRenderer)?.webView {
            webView.configuration.userContentController.add(ReviewStateMessageProxy(self), name: Self.messageName)
        }
    }

    /// One save a second after the last change; `@Published` fires before the value lands, so the
    /// state is read when the save runs.
    private func scheduleSave() {
        pendingSave?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.save() }
        pendingSave = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.saveDelay, execute: work)
    }

    /// Before the process exits: a save still waiting out `saveDelay` runs now, and every queued write
    /// finishes. Main thread only (`applicationWillTerminate`).
    static func flushBeforeExit() {
        active?.flushNow()
        writer.sync {}
    }

    private func flushNow() {
        guard let pending = pendingSave else { return }
        pending.cancel()
        pendingSave = nil
        save()
    }

    private func save() {
        guard let model else { return }
        let state = Self.capture(model: model, defaults: HubDefaults.store, page: page)
        guard state != lastWritten else { return }
        lastWritten = state
        let cache = cache
        let key = key
        Self.writer.async {
            cache.write(state, key: key)
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "ready":
            sendRestore(to: message.webView)
        case "state":
            guard let next = ReviewSessionState.pageState(from: body) else {
                HubPerf.log("review.state page message dropped: it does not decode")
                return
            }
            if next != page {
                page = next
                scheduleSave()
            }
        default:
            break
        }
    }

    /// The page's state back to a page that just loaded: the saved one first, after a web content
    /// process restart the last one it reported.
    private func sendRestore(to webView: WKWebView?) {
        guard let webView, let page, let data = try? JSONEncoder().encode(page),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.genesisReviewState?.restore(\(json));") { _, error in
            if let error {
                HubPerf.log("review.state restore failed: \(error.localizedDescription)")
            }
        }
    }
}

/// WKUserContentController retains its handlers; this keeps it from holding the persistence.
private final class ReviewStateMessageProxy: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
