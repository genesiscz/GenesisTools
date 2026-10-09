import AppKit
import SwiftUI

// MARK: - Linkify

/// Turns the references a PR comment makes into links, as the host pages do: a commit id links to the
/// commit on the host (shown as code), `!12` on GitLab and `#12` on GitHub to that MR/PR of the same
/// project, and `group/project!12` / `owner/repo#12` to one of another project. Code spans, fenced
/// blocks, links and bare URLs stay as they are. The result is still markdown, for the threads list
/// (`MarkdownContentView`) and the diff cards (`RenderedLiveThread.Note.display`).
enum PRRefLinker {
    private final class Box: NSObject {
        let value: String
        init(_ value: String) { self.value = value }
    }

    nonisolated(unsafe) private static let cache: NSCache<NSString, Box> = {
        let cache = NSCache<NSString, Box>()
        cache.countLimit = 2000
        return cache
    }()

    /// Code spans, markdown links, autolinks and bare URLs: never linked again.
    private static let protected = try? NSRegularExpression(pattern: "`[^`]*`|!?\\[[^\\]]*\\]\\([^)]*\\)|<https?://[^>]*>|https?://[^\\s<>()]+")

    /// A PR/MR reference with an optional project path, or a commit id of 7 to 40 hex characters.
    private static let reference = try? NSRegularExpression(pattern:
        "(?<![\\w/!#&.@-])(?:([A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+))?([!#])(\\d+)\\b"
            + "|(?<![\\w/.#!@-])([0-9a-f]{7,40})(?![\\w/-])")

    /// Cached per project and text: a row's body runs on every re-measure.
    static func linkify(_ markdown: String, forge: ForgeWeb?) -> String {
        guard let forge, !markdown.isEmpty else { return markdown }
        let key = "\(forge.project)\u{0}\(markdown)" as NSString
        if let hit = cache.object(forKey: key) {
            return hit.value
        }

        var fence: (mark: Character, count: Int)?
        let lines = markdown.components(separatedBy: "\n").map { line -> String in
            let marker = MarkdownContentView.fenceMarker(line)
            if let open = fence {
                if let marker, marker.mark == open.mark, marker.count >= open.count, marker.info.isEmpty {
                    fence = nil
                }
                return line
            }
            if let marker {
                fence = (marker.mark, marker.count)
                return line
            }
            // An indented code block (four spaces) is code too.
            if line.hasPrefix("    ") || line.hasPrefix("\t") {
                return line
            }
            return linkLine(line, forge: forge)
        }
        let result = lines.joined(separator: "\n")
        cache.setObject(Box(result), forKey: key)
        return result
    }

    private static func linkLine(_ line: String, forge: ForgeWeb) -> String {
        guard let protected else { return line }
        let ns = line as NSString
        var out = ""
        var last = 0
        for match in protected.matches(in: line, range: NSRange(location: 0, length: ns.length)) {
            out += linkPlain(ns.substring(with: NSRange(location: last, length: match.range.location - last)), forge: forge)
            out += ns.substring(with: match.range)
            last = match.range.location + match.range.length
        }
        out += linkPlain(ns.substring(from: last), forge: forge)
        return out
    }

    private static func linkPlain(_ text: String, forge: ForgeWeb) -> String {
        guard let reference, !text.isEmpty else { return text }
        let ns = text as NSString
        var out = ""
        var last = 0
        for match in reference.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            guard let replacement = replacement(match, in: ns, forge: forge) else { continue }
            out += ns.substring(with: NSRange(location: last, length: match.range.location - last))
            out += replacement
            last = match.range.location + match.range.length
        }
        out += ns.substring(from: last)
        return out
    }

    private static func replacement(_ match: NSTextCheckingResult, in text: NSString, forge: ForgeWeb) -> String? {
        func group(_ index: Int) -> String? {
            let range = match.range(at: index)
            return range.location == NSNotFound ? nil : text.substring(with: range)
        }

        if let sha = group(4) {
            // A word of only letters ("deadbeef", "facade") or only digits is not a commit id.
            guard sha.contains(where: \.isNumber), sha.contains(where: \.isLetter), let url = forge.commit(sha) else { return nil }
            return "[`\(sha)`](\(url.absoluteString))"
        }

        guard let symbol = group(2), let number = group(3).flatMap(Int.init) else { return nil }
        // GitLab's `#12` is an issue and GitHub has no `!12`: both stay text.
        guard symbol == (forge.kind == .gitlab ? "!" : "#") else { return nil }
        let project = group(1)
        guard let target = project.map({ forge.sibling($0) }) ?? forge, let url = target.pullRequest(number) else { return nil }
        return "[\(project ?? "")\(symbol)\(number)](\(url.absoluteString))"
    }
}

// MARK: - A thread's file at the PR's head

/// Where a thread's file is in the PR's newest commit.
enum PathAtHead: Equatable {
    case present
    case removed
    case renamed(to: String)
}

enum PRHeadPresence {
    /// `paths`: the threads' files; `present`: those `git ls-tree` found at the head; `renames`: old
    /// path → new path between the commit on screen and the head.
    static func decide(paths: [String], present: Set<String>, renames: [String: String]) -> [String: PathAtHead] {
        var result: [String: PathAtHead] = [:]
        for path in paths {
            if present.contains(path) {
                result[path] = .present
            } else if let renamed = renames[path] {
                result[path] = .renamed(to: renamed)
            } else {
                result[path] = .removed
            }
        }
        return result
    }

    /// `git diff --name-status -M` lines: `R087<TAB>old<TAB>new`; every other status is skipped.
    static func renames(_ nameStatus: String) -> [String: String] {
        var result: [String: String] = [:]
        for line in nameStatus.split(separator: "\n") {
            let parts = line.split(separator: "\t", omittingEmptySubsequences: false)
            guard parts.count == 3, parts[0].hasPrefix("R") else { continue }
            result[String(parts[1])] = String(parts[2])
        }
        return result
    }
}

/// The threads' files at the PR's head, one batched `git ls-tree` per repository, head and set of
/// paths, off the main thread, kept for the process. A head that is not in the repository gives no
/// answer, and the list then says nothing extra.
@MainActor
final class PRHeadFiles: ObservableObject {
    static let shared = PRHeadFiles()

    @Published private(set) var results: [String: [String: PathAtHead]] = [:]
    private var started: Set<String> = []
    private let readGit: @Sendable (String, [String]) -> String?

    init(readGit: (@Sendable (String, [String]) -> String?)? = nil) {
        self.readGit = readGit ?? { repo, args in Self.git(repo, args) }
    }

    nonisolated static func key(repo: String, head: String, shown: String? = nil, paths: [String]) -> String {
        "\(repo)\u{0}\(head)\u{0}\(shown ?? "")\u{0}\(paths.sorted().joined(separator: "\u{1}"))"
    }

    func status(repo: String, head: String, shown: String? = nil, paths: [String]) -> [String: PathAtHead]? {
        results[Self.key(repo: repo, head: head, shown: shown, paths: paths)]
    }

    @discardableResult
    func load(repo: String, head: String, shown: String?, paths: [String]) -> Task<Void, Never>? {
        let key = Self.key(repo: repo, head: head, shown: shown, paths: paths)
        guard !paths.isEmpty, results[key] == nil, !started.contains(key) else { return nil }
        started.insert(key)
        return Task.detached(priority: .utility) { [readGit] in
            let span = HubPerf.begin("review.headFiles", "\(paths.count) paths at \(head.prefix(8))")
            guard let listed = readGit(repo, ["ls-tree", "-r", "--name-only", head, "--"] + paths) else {
                span.end("head not local")
                await self.complete(key: key, result: nil)
                return
            }
            let present = Set(listed.split(separator: "\n").map(String.init))
            let missing = paths.filter { !present.contains($0) }
            var renames: [String: String] = [:]
            if !missing.isEmpty, let shown, let diff = readGit(repo, ["diff", "--name-status", "-M", "--diff-filter=R", shown, head]) {
                renames = PRHeadPresence.renames(diff)
            }
            let decided = PRHeadPresence.decide(paths: paths, present: present, renames: renames)
            span.end("\(missing.count) not at head")
            await self.complete(key: key, result: decided)
        }
    }

    private func complete(key: String, result: [String: PathAtHead]?) {
        started.remove(key)
        if let result { results[key] = result }
    }

    /// Blocking: only from the detached task above.
    nonisolated private static func git(_ repo: String, _ args: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-C", repo] + args
        process.standardInput = FileHandle.nullDevice
        let result: ProcessCapture
        do {
            // A deadline: a stuck git must not hold `started` for this key for the life of the process.
            result = try process.runCapturing(timeout: 30)
        } catch {
            HubPerf.log("review.headFiles git failed: \(error)")
            return nil
        }
        guard result.status == 0 else {
            HubPerf.log("review.headFiles git \(args.prefix(2).joined(separator: " ")) exited \(result.status)")
            return nil
        }
        return String(decoding: result.stdout, as: UTF8.self)
    }
}

// MARK: - A click on a PR/MR reference

/// What a click on a PR/MR link does: a small menu with the host's page, the hub at that PR, and its
/// review in a window of its own. Every other link opens in the browser.
enum PRRefMenu {
    struct Target: Equatable {
        let url: String
        let number: Int
        let gitlab: Bool

        var label: String { gitlab ? "!\(number)" : "#\(number)" }
    }

    /// `…/-/merge_requests/12` or `…/pull/12`, nothing after the number but a fragment or query.
    static func target(_ url: URL) -> Target? {
        let path = url.path
        let patterns: [(String, Bool)] = [("/-/merge_requests/(\\d+)/?$", true), ("/pull/(\\d+)/?$", false)]
        for (pattern, gitlab) in patterns {
            guard let regex = try? NSRegularExpression(pattern: pattern),
                  let match = regex.firstMatch(in: path, range: NSRange(location: 0, length: (path as NSString).length)),
                  let number = Int((path as NSString).substring(with: match.range(at: 1))) else { continue }
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
            components?.fragment = nil
            components?.query = nil
            return Target(url: components?.string ?? url.absoluteString, number: number, gitlab: gitlab)
        }
        return nil
    }

    /// A link from a comment: a PR/MR asks where to open it, anything else opens in the browser.
    @MainActor
    static func open(_ url: URL, model: ReviewModel) {
        if let sha = CommitMenu.sha(url) {
            CommitMenu.open(url, sha: sha, model: model)
            return
        }

        guard let target = target(url) else {
            ExternalOpener.open(url)
            return
        }

        let menu = NSMenu()
        menu.addItem(ClosureMenuItem("Open \(target.label) in \(target.gitlab ? "GitLab" : "GitHub")") { ExternalOpener.open(url) })
        menu.addItem(ClosureMenuItem("Open \(target.label) in Hub") { openInHub(target, model: model) })
        menu.addItem(ClosureMenuItem("Open \(target.label) in Hub Review") { openInReview(target, model: model) })
        HubPerf.log("review.prRef menu \(target.url)")
        menu.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil)
    }

    /// The running hub at that PR; a second hub hands its flags to the running one.
    @MainActor
    static func openInHub(_ target: Target, model: ReviewModel) {
        launch(["--hub", "--pr", target.url], model: model)
    }

    /// The PR's diff in a review window of its own, as the hub's "Open in review window" does: its base
    /// and head from `tools hub pr threads`, the head fetched into this repository first when it is not
    /// here. A PR of another project, or a fetch that fails, opens in the hub instead.
    @MainActor
    static func openInReview(_ target: Target, model: ReviewModel) {
        let repo = model.repo.path
        let ownProject = model.pr?.payload?.pr
        model.notice = "Opening \(target.label) in a review window…"
        Task.detached(priority: .userInitiated) {
            let span = HubPerf.begin("review.prRef.open", target.url, awaits: true)
            let plan = reviewArgs(target, repo: repo, own: ownProject)
            span.end(plan.args == nil ? "hub" : "review")
            await MainActor.run {
                if let args = plan.args {
                    model.notice = nil
                    launch(args, model: model)
                } else {
                    model.notice = plan.why.map { "\($0) Opened \(target.label) in the hub instead." }
                    openInHub(target, model: model)
                }
            }
        }
    }

    /// Blocking (`tools` and `git`): only from the detached task.
    nonisolated private static func reviewArgs(_ target: Target, repo: String, own: PRInfo?) -> (args: [String]?, why: String?) {
        let info: PRInfo
        do {
            let data = try PRCLI.run(PRCommand.threads(.ref(target.url)))
            info = try JSONDecoder().decode(PRThreadsPayload.self, from: data).pr
        } catch {
            HubPerf.log("review.prRef threads failed: \(error)")
            return (nil, "\(target.label) did not load.")
        }
        // Only this repository's project can hold the head; another project's PR goes to the hub.
        if let own, own.host != info.host || own.project != info.project {
            return (nil, "\(target.label) belongs to \(info.project).")
        }
        guard var head = info.headSha, var base = info.baseSha else {
            return (nil, "The host named no head or base for \(target.label).")
        }
        if !commitIsLocal(head, repo: repo) || !commitIsLocal(base, repo: repo) {
            var args = ["hub", "pr", "fetch", "\(repo)#\(info.number)", "--json", "--provider", info.provider, "--head", head, "--base", base]
            if let branch = info.targetBranch, !branch.isEmpty {
                args += ["--base-branch", branch]
            }
            guard case .fetched(let fetched) = PRFetch.run(args) else {
                return (nil, "\(target.label)'s head could not be fetched.")
            }
            head = fetched.head
            base = fetched.base ?? base
            guard commitIsLocal(base, repo: repo) else {
                return (nil, "\(target.label)'s base is not here.")
            }
        }
        let label = "\(target.label) \(info.title.prefix(40))"
        return (["--review", "--repo", repo, "--pr", target.url, "--range", "\(base)..\(head)", "--label", label], nil)
    }

    nonisolated private static func commitIsLocal(_ sha: String, repo: String) -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-C", repo, "cat-file", "-e", "\(sha)^{commit}"]
        process.standardInput = FileHandle.nullDevice
        return (try? process.runCapturing(timeout: 15))?.status == 0
    }

    @MainActor
    private static func launch(_ args: [String], model: ReviewModel) {
        guard let executable = Bundle.main.executableURL else { return }
        let process = Process()
        process.executableURL = executable
        process.arguments = args
        do {
            try process.run()
            HubPerf.log("review.prRef launch \(args.joined(separator: " "))")
        } catch {
            model.notice = "Could not open \(args.first ?? "it"): \(error.localizedDescription)"
        }
    }
}

// MARK: - A click on a commit id

/// What a click on a linked commit id offers: the commit on the host, this review showing only that
/// commit (`DiffScope.commit`), or a review window of its own. The review entries need the commit in
/// this repository: it is looked up first, fetched by id from origin when it is not here (GitLab and
/// GitHub serve any commit of the project by id), and the entries are off, saying why, when neither works.
enum CommitMenu {
    struct Item: Equatable {
        enum Action: Equatable { case host, thisReview, newWindow }

        let action: Action
        let title: String
        let enabled: Bool
        let tooltip: String?
    }

    /// The commit a link points at: `…/-/commit/<sha>` (GitLab) or `…/commit/<sha>` (GitHub).
    static func sha(_ url: URL) -> String? {
        let path = url.path
        guard let regex = try? NSRegularExpression(pattern: "/commit/([0-9a-fA-F]{7,40})/?$"),
              let match = regex.firstMatch(in: path, range: NSRange(location: 0, length: (path as NSString).length)) else { return nil }
        return (path as NSString).substring(with: match.range(at: 1))
    }

    /// `missing`: why the commit is not in this repository (nil: it is), which turns the review entries off.
    static func items(short: String, gitlab: Bool, missing: String?) -> [Item] {
        let off = missing.map { "\($0) The diff needs the commit in this repository." }
        return [
            Item(action: .host, title: "Open \(short) on \(gitlab ? "GitLab" : "GitHub")", enabled: true, tooltip: nil),
            Item(action: .thisReview, title: "Show \(short) in this review", enabled: missing == nil,
                 tooltip: off ?? "This window shows only that commit's changes (the scope menu goes back)"),
            Item(action: .newWindow, title: "Open \(short) in a new review window", enabled: missing == nil,
                 tooltip: off ?? "A review window of its own with that commit's changes"),
        ]
    }

    /// The commit as this repository knows it, after one fetch by id when it is not here.
    struct Lookup: Equatable {
        var full: String?
        var subject: String = ""
        var missing: String?
    }

    @MainActor
    static func open(_ url: URL, sha: String, model: ReviewModel) {
        let at = NSEvent.mouseLocation
        let repo = model.repo.path
        let short = String(sha.prefix(10))
        let gitlab = url.path.contains("/-/commit/")
        Task.detached(priority: .userInitiated) {
            let span = HubPerf.begin("review.commitRef", short, awaits: true)
            let found = lookup(sha, repo: repo)
            span.end(found.missing == nil ? "found" : "missing")
            await MainActor.run {
                show(items(short: short, gitlab: gitlab, missing: found.missing), at: at, url: url, found: found, model: model)
            }
        }
    }

    @MainActor
    private static func show(_ items: [Item], at point: NSPoint, url: URL, found: Lookup, model: ReviewModel) {
        let menu = NSMenu()
        menu.autoenablesItems = false
        for item in items {
            let entry = ClosureMenuItem(item.title) { run(item.action, url: url, found: found, model: model) }
            entry.isEnabled = item.enabled
            entry.toolTip = item.tooltip
            menu.addItem(entry)
        }
        HubPerf.log("review.commitRef menu \(url.lastPathComponent) missing=\(found.missing ?? "no")")
        menu.popUp(positioning: nil, at: point, in: nil)
    }

    @MainActor
    private static func run(_ action: Item.Action, url: URL, found: Lookup, model: ReviewModel) {
        guard action != .host else {
            ExternalOpener.open(url)
            return
        }

        guard let full = found.full else { return }
        switch action {
        case .thisReview:
            model.setScope(.commit(sha: full, title: found.subject))
        case .newWindow:
            guard let executable = Bundle.main.executableURL else { return }
            let process = Process()
            process.executableURL = executable
            process.arguments = newWindowArguments(repo: model.repo.path, sha: full, subject: found.subject)
            do {
                try process.run()
                HubPerf.log("review.commitRef new window \(full.prefix(10))")
            } catch {
                model.notice = "Could not open a review window: \(error.localizedDescription)"
            }
        case .host:
            break
        }
    }

    /// A review window on one commit. `--commit`, not `<sha>^..<sha>`: a root commit has no parent, and
    /// the commit scope diffs it against the empty tree.
    static func newWindowArguments(repo: String, sha: String, subject: String) -> [String] {
        ["--review", "--repo", repo, "--commit", sha, "--label", subject]
    }

    /// Blocking git: only from the detached task.
    nonisolated private static func lookup(_ sha: String, repo: String) -> Lookup {
        if git(repo, ["cat-file", "-e", "\(sha)^{commit}"]) == nil {
            // --no-write-fetch-head: a `git pull` running in this checkout reads FETCH_HEAD for what to merge.
            _ = git(repo, ["fetch", "--no-tags", "--quiet", "--no-write-fetch-head", "--end-of-options", "origin", sha])
            guard git(repo, ["cat-file", "-e", "\(sha)^{commit}"]) != nil else {
                return Lookup(full: nil, missing: "\(sha.prefix(10)) is not in \(URL(fileURLWithPath: repo).lastPathComponent), and origin did not give it.")
            }
        }
        let full = git(repo, ["rev-parse", "\(sha)^{commit}"])?.trimmingCharacters(in: .whitespacesAndNewlines)
        let subject = git(repo, ["log", "-1", "--format=%s", sha])?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return Lookup(full: full, subject: subject, missing: full == nil ? "\(sha.prefix(10)) could not be read." : nil)
    }

    nonisolated private static func git(_ repo: String, _ args: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-C", repo] + args
        process.standardInput = FileHandle.nullDevice
        // A fetch must fail rather than wait on a credential prompt nobody can see.
        process.environment = ProcessInfo.processInfo.environment.merging(["GIT_TERMINAL_PROMPT": "0"]) { _, new in new }
        let result: ProcessCapture
        do {
            result = try process.runCapturing(timeout: 30)
        } catch {
            HubPerf.log("review.commitRef git failed: \(error)")
            return nil
        }
        return result.status == 0 ? String(decoding: result.stdout, as: UTF8.self) : nil
    }
}
