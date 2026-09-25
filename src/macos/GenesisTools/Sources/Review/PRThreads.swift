import Foundation

// The review window's side of `tools hub pr` (src/hub/lib/pr/*): the PR/MR's live review threads,
// and every write the window makes to them. Swift only builds argv and reads JSON; the host rules
// (GitHub GraphQL, GitLab discussions and draft notes) stay in TypeScript.

/// Where a `tools hub pr` verb finds its PR/MR: its URL or `<repoPath>#<n>` (`--pr`), or the
/// checkout whose branch names it (`--repo`).
enum PRTarget: Equatable {
    case ref(String)
    case repo(String)

    var argv: [String] {
        switch self {
        case .ref(let ref): return ["--pr", ref]
        case .repo(let path): return ["--repo", path]
        }
    }
}

/// The PR's host, project and number: its label, and whether GitLab's words apply.
struct PRIdentity: Equatable {
    var provider: String
    var host: String
    var project: String
    var number: Int

    var isGitLab: Bool { provider == "gitlab" }
    var label: String { isGitLab ? "!\(number)" : "#\(number)" }
}

enum PRReviewEvent: String, CaseIterable, Identifiable {
    case comment, approve, requestChanges

    var id: String { rawValue }

    var title: String {
        switch self {
        case .comment: return "Comment"
        case .approve: return "Approve"
        case .requestChanges: return "Request changes"
        }
    }

    fileprivate var flags: [String] {
        switch self {
        case .comment: return []
        case .approve: return ["--approve"]
        case .requestChanges: return ["--request-changes"]
        }
    }
}

/// Every `tools` argv the window builds for a PR/MR. Pure, so the tests check each one.
/// 🛑 Only `publish` submits the pending review (every draft at once, visible to everyone). Its one
/// caller is `PRThreadsStore.submitReview`, reached only from the Submit review confirmation.
enum PRCommand {
    static func threads(_ target: PRTarget, noCache: Bool = false) -> [String] {
        ["hub", "pr", "threads"] + target.argv + ["--json"] + (noCache ? ["--no-cache"] : [])
    }

    /// A reply in an existing thread: a draft in the pending review, or published at once.
    static func reply(_ target: PRTarget, thread: String, bodyFile: String, draft: Bool) -> [String] {
        ["hub", "pr", "reply"] + target.argv + ["--thread", thread, "--body-file", bodyFile, "--json"] + (draft ? ["--draft"] : [])
    }

    /// A new draft comment on a line or a range; `startLine` counts only when it is above `line`.
    static func draftAdd(_ target: PRTarget, path: String, line: Int, startLine: Int?, side: DiffSide, bodyFile: String) -> [String] {
        lineComment(["draft", "add"], target, path: path, line: line, startLine: startLine, side: side, bodyFile: bodyFile)
    }

    /// A NEW comment published at once, alone (`hub pr comment`): my other pending drafts stay pending,
    /// where `draft add` followed by `publish` would send them all. Both hosts, both sides, ranges too.
    static func comment(_ target: PRTarget, path: String, line: Int, startLine: Int?, side: DiffSide, bodyFile: String) -> [String] {
        lineComment(["comment"], target, path: path, line: line, startLine: startLine, side: side, bodyFile: bodyFile)
    }

    /// `draft add` and `comment` take the same line flags (src/hub/index.ts `lineCommentVerb`).
    private static func lineComment(_ verb: [String], _ target: PRTarget, path: String, line: Int, startLine: Int?,
                                    side: DiffSide, bodyFile: String) -> [String] {
        var args = ["hub", "pr"] + verb + target.argv + ["--path", path, "--line", "\(line)"]
        if let startLine, startLine < line {
            args += ["--start-line", "\(startLine)"]
        }
        return args + ["--side", side.rawValue, "--body-file", bodyFile, "--json"]
    }

    static func draftUpdate(_ target: PRTarget, draftId: String, bodyFile: String) -> [String] {
        ["hub", "pr", "draft", "update", draftId] + target.argv + ["--body-file", bodyFile, "--json"]
    }

    static func draftDelete(_ target: PRTarget, draftId: String) -> [String] {
        ["hub", "pr", "draft", "delete", draftId] + target.argv + ["--json"]
    }

    static func resolve(_ target: PRTarget, thread: String, resolved: Bool) -> [String] {
        ["hub", "pr", "resolve", thread] + target.argv + ["--json"] + (resolved ? [] : ["--unresolve"])
    }

    static func publish(_ target: PRTarget, event: PRReviewEvent, bodyFile: String?) -> [String] {
        ["hub", "pr", "publish"] + target.argv + event.flags + (bodyFile.map { ["--body-file", $0] } ?? []) + ["--json"]
    }

    /// A thread card's button (or the threads list's) as argv; nil when the input lacks what the verb
    /// needs. There is no case for `publish`: a card cannot submit the review.
    static func threadAction(_ input: ThreadActionInput, target: PRTarget, bodyFile: String) -> [String]? {
        guard let thread = input.threadID else { return nil }
        switch input.action {
        case .reply:
            return reply(target, thread: thread, bodyFile: bodyFile, draft: input.draft)
        case .resolve, .unresolve:
            return resolve(target, thread: thread, resolved: input.action == .resolve)
        case .noteUpdate:
            return input.noteID.map { draftUpdate(target, draftId: $0, bodyFile: bodyFile) }
        case .noteDelete:
            return input.noteID.map { draftDelete(target, draftId: $0) }
        }
    }

    /// Post on a comment that is already my pending draft on the PR: the comment is published alone
    /// (`comment`), then that draft is deleted, so the PR shows it once. `publish` would also send
    /// every other pending draft.
    static func postPendingDraft(_ target: PRTarget, draftId: String, path: String, line: Int, startLine: Int?,
                                 side: DiffSide, bodyFile: String) -> [[String]] {
        [comment(target, path: path, line: line, startLine: startLine, side: side, bodyFile: bodyFile),
         draftDelete(target, draftId: draftId)]
    }
}

// MARK: - JSON

struct PRInfo: Decodable, Equatable {
    let provider: String
    let host: String
    let project: String
    let number: Int
    let url: String
    let webUrl: String?
    let title: String
    let state: String?
    let draft: Bool?
    let author: String?
    let sourceBranch: String?
    let targetBranch: String?
    /// The head branch lives in a fork; `headRepo` is its `owner/repo` when the host named it. Both
    /// nil from a `tools` that does not send them: the links then read the PR's own project.
    let crossRepository: Bool?
    let headRepo: String?

    var identity: PRIdentity { PRIdentity(provider: provider, host: host, project: project, number: number) }
    /// The PR's project on the host, for user and branch pages; nil for a host that is not GitHub or GitLab.
    var forge: ForgeWeb? { ForgeWeb(kind: provider, web: "https://\(host)/\(project)") }
    /// The source branch's page, in the fork for a fork PR (the same rule as `HubPR.headBranchURL`).
    var sourceBranchURL: URL? {
        sourceBranch.flatMap { forge?.head(crossRepository: crossRepository, headRepo: headRepo)?.branch($0) }
    }

    var compareURL: URL? {
        guard let sourceBranch, let targetBranch else { return nil }
        return forge?.compare(base: targetBranch, head: sourceBranch, crossRepository: crossRepository, headRepo: headRepo)
    }
}

struct PRThreadComment: Decodable, Identifiable, Equatable {
    struct Author: Decodable, Equatable {
        let name: String
        let username: String
        let role: String?
    }

    let id: String
    let author: Author
    let bodyMarkdown: String
    let createdAt: String
    let editedAt: String?
    /// My pending review comment: only I see it until the review is submitted.
    let isDraft: Bool
}

struct PRThread: Decodable, Identifiable, Equatable {
    let id: String
    let path: String
    let oldPath: String?
    let side: DiffSide
    let line: Int
    let startLine: Int?
    let outdated: Bool
    let resolved: Bool
    let resolvable: Bool
    let comments: [PRThreadComment]

    /// A thread whose first comment is my pending draft: it does not exist for anyone else yet.
    var isMyDraft: Bool { comments.first?.isDraft ?? false }
}

struct PRThreadsPayload: Decodable, Equatable {
    let pr: PRInfo
    let threads: [PRThread]
    /// Every draft `publish` would send, including GitLab drafts that have no line.
    let draftCount: Int
    let viewer: String?
    let cached: Bool?
    let fetchedAt: String?
}

struct PRReplyResult: Decodable {
    let threadId: String
    let commentId: String
}

struct PRDraftAddResult: Decodable {
    let draftId: String
    let threadId: String?
}

struct PRPublishResult: Decodable {
    let event: String
    let published: Int
    let url: String?
}

/// `{error, code}`: what a `tools hub pr … --json` failure prints on stdout.
struct PRCLIError: Decodable, Error, CustomStringConvertible {
    let error: String
    let code: String

    var description: String { error }
}

enum PRCLI {
    /// Blocking: call it off the main thread only.
    static func run(_ args: [String]) throws -> Data {
        let result = try ToolsCLIRunner.capture(args)
        guard result.status == 0 else {
            if let failure = try? JSONDecoder().decode(PRCLIError.self, from: result.stdout) {
                throw failure
            }
            let message = String(decoding: result.stderr, as: UTF8.self)
            throw ReviewError.git("tools \(args.prefix(3).joined(separator: " ")) exited \(result.status): \(message.trimmed.suffix(300))")
        }

        return result.stdout
    }
}

// MARK: - Rendering on the diff

enum PRThreadRendering {
    /// The diff card of a live PR thread.
    static func cardID(thread id: String) -> String {
        "live:\(id)"
    }

    /// Live threads as diff cards (`kind: "thread"` with `live`: the notes, Reply, Resolve, and Edit /
    /// Delete on my drafts). Outdated threads point at lines of an older head, so they stay in the
    /// threads list only. `skip` holds the thread ids the proposal already shows with the agent's read.
    static func rendered(_ threads: [PRThread], files: [DiffFile], skip: Set<String> = [], forge: ForgeWeb? = nil, now: Date = Date()) -> [RenderedComment] {
        threads.compactMap { thread in
            guard !thread.outdated, !skip.contains(thread.id), let first = thread.comments.first,
                  let file = files.first(where: { $0.path == thread.path || (thread.oldPath != nil && $0.oldPath == thread.oldPath) })
            else { return nil }
            let count = thread.comments.count > 1 ? " · \(thread.comments.count) comments" : ""
            return RenderedComment(
                id: cardID(thread: thread.id),
                fileId: file.id,
                side: thread.side,
                startLine: min(thread.startLine ?? thread.line, thread.line),
                endLine: thread.line,
                body: first.bodyMarkdown,
                author: "@\(first.author.username)",
                when: " · \(ago(first.createdAt, now: now))\(count)",
                state: thread.isMyDraft ? "draft" : thread.resolved ? "resolved" : "open",
                remote: true,
                kind: "thread",
                live: live(thread, forge: forge, now: now)
            )
        }
    }

    /// `forge` makes each author a link to their profile on the host.
    static func live(_ thread: PRThread, forge: ForgeWeb? = nil, now: Date = Date()) -> RenderedLiveThread {
        RenderedLiveThread(
            notes: thread.comments.map { comment in
                RenderedLiveThread.Note(
                    id: comment.id,
                    author: comment.author.name,
                    username: comment.author.username,
                    when: ago(comment.createdAt, now: now),
                    at: comment.createdAt,
                    body: comment.bodyMarkdown,
                    isDraft: comment.isDraft,
                    edited: comment.editedAt != nil,
                    authorUrl: forge?.user(comment.author.username)?.absoluteString
                )
            },
            resolved: thread.resolved,
            resolvable: thread.resolvable && !thread.isMyDraft,
            // A thread that is still my pending draft does not exist for the host yet: no replies to it.
            canReply: !thread.isMyDraft
        )
    }

    /// The proposal's copy of a thread was read when the agent pushed; the live thread wins its
    /// state, and the card gets the live notes and buttons beside the agent's read.
    static func refresh(_ proposalComments: [RenderedComment], with threads: [PRThread], forge: ForgeWeb? = nil, now: Date = Date()) -> [RenderedComment] {
        guard !threads.isEmpty else { return proposalComments }
        let byID = Dictionary(threads.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return proposalComments.map { comment in
            guard comment.id.hasPrefix("thread:"), let thread = byID[String(comment.id.dropFirst(7))] else { return comment }
            var copy = comment
            copy.state = thread.resolved ? "resolved" : "open"
            copy.live = live(thread, forge: forge, now: now)
            return copy
        }
    }

    static func ago(_ iso: String, now: Date = Date()) -> String {
        guard let date = HubFormat.date(iso) else { return iso }
        return HubFormat.relative.localizedString(for: date, relativeTo: now)
    }
}

// MARK: - Store

/// The live review threads of one PR/MR, loaded off the main thread. It loads when the window
/// shows it, after every write, and when the app becomes active again more than 30 s after the
/// last load (the CLI keeps its own 30 s cache, and a write drops it). No timer.
final class PRThreadsStore: ObservableObject {
    static let staleAfter: TimeInterval = 30

    let target: PRTarget
    @Published private(set) var payload: PRThreadsPayload?
    @Published private(set) var loading = false
    /// A write in flight ("Resolving…"); the thread buttons wait for it.
    @Published private(set) var busy: String?
    @Published var notice: String?
    @Published private(set) var error: String?
    /// Called on the main thread after new threads land (the model re-renders the diff's cards).
    var onChange: (() -> Void)?

    private var lastLoad: Date?
    private var loadAgain = false
    private var loadAgainNoCache = false

    init(target: PRTarget) {
        self.target = target
    }

    var pr: PRInfo? { payload?.pr }
    var label: String { payload?.pr.identity.label ?? "the PR" }
    /// Loaded at least once, or failed: a `--snapshot` waits for this before it captures.
    var settled: Bool { !loading && (payload != nil || error != nil) }

    func load(noCache: Bool = false) {
        if loading {
            loadAgain = true
            loadAgainNoCache = loadAgainNoCache || noCache
            return
        }

        loading = true
        let args = PRCommand.threads(target, noCache: noCache)
        DispatchQueue.global(qos: .userInitiated).async {
            let span = HubPerf.begin("pr.threads", args.suffix(from: 3).joined(separator: " "))
            let result = Result { try JSONDecoder().decode(PRThreadsPayload.self, from: PRCLI.run(args)) }
            if case .success(let payload) = result {
                span.end("\(payload.threads.count) threads\(payload.cached == true ? " cached" : "")")
            } else {
                span.end("failed")
            }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.loading = false
                self.lastLoad = Date()
                switch result {
                case .success(let payload):
                    self.error = nil
                    if payload != self.payload {
                        self.payload = payload
                        self.onChange?()
                    }
                case .failure(let failure):
                    self.error = "\(failure)"
                    HubPerf.log("pr.threads failed: \(failure)")
                }
                if self.loadAgain {
                    let noCache = self.loadAgainNoCache
                    self.loadAgain = false
                    self.loadAgainNoCache = false
                    self.load(noCache: noCache)
                }
            }
        }
    }

    /// The app became active again: load only when the last answer is older than the CLI's cache.
    func reloadIfStale() {
        guard let lastLoad, Date().timeIntervalSince(lastLoad) >= Self.staleAfter else { return }
        load()
    }

    // MARK: Writes

    /// One thread write, from a diff card or the threads list, through `PRCommand.threadAction`.
    /// The caller asked first when it publishes or deletes. `finished` gets true when the host took
    /// the write (the diff card then clears its box).
    func perform(_ input: ThreadActionInput, finished: ((Bool) -> Void)? = nil) {
        let target = target
        guard PRCommand.threadAction(input, target: target, bodyFile: "-") != nil else {
            notice = "Failed: \(input.action.rawValue) needs a thread and a note"
            finished?(false)
            return
        }

        let text = input.body?.trimmed
        let needsBody = input.action == .reply || input.action == .noteUpdate
        if needsBody, text?.isEmpty ?? true {
            finished?(false)
            return
        }

        let (status, done): (String, String) = {
            switch input.action {
            case .reply: return input.draft
                ? ("Saving the draft reply…", "Draft reply saved; Submit review publishes it.")
                : ("Posting the reply…", "Reply posted on \(label).")
            case .resolve: return ("Resolving…", "Thread resolved.")
            case .unresolve: return ("Reopening…", "Thread reopened.")
            case .noteUpdate: return ("Saving the draft…", "Draft updated.")
            case .noteDelete: return ("Deleting the draft…", "Draft deleted.")
            }
        }()
        write(status, body: needsBody ? text : nil, args: { bodyFile in
            PRCommand.threadAction(input, target: target, bodyFile: bodyFile) ?? []
        }) { [weak self] result in
            self?.report(result, done: done)
            finished?(result.isSuccess)
        }
    }

    func reply(thread: String, body: String, draft: Bool, finished: ((Bool) -> Void)? = nil) {
        perform(ThreadActionInput(id: "live:\(thread)", action: .reply, draft: draft, body: body), finished: finished)
    }

    func resolve(thread: String, resolved: Bool) {
        perform(ThreadActionInput(id: "live:\(thread)", action: resolved ? .resolve : .unresolve))
    }

    func updateDraft(thread: String, note: String, body: String, finished: ((Bool) -> Void)? = nil) {
        perform(ThreadActionInput(id: "live:\(thread)", action: .noteUpdate, noteID: note, body: body), finished: finished)
    }

    func deleteDraft(thread: String, note: String) {
        perform(ThreadActionInput(id: "live:\(thread)", action: .noteDelete, noteID: note))
    }

    /// 🛑 Publishes every pending draft as one review. Only the Submit review button calls this,
    /// after its NSAlert confirmation named the PR and the draft count.
    func submitReview(event: PRReviewEvent, summary: String) {
        let summary = summary.trimmed
        write("Submitting the review…", body: summary.isEmpty ? nil : summary, args: { [target] in
            PRCommand.publish(target, event: event, bodyFile: summary.isEmpty ? nil : $0)
        }) { [weak self] result in
            guard let self else { return }
            if case .success(let data) = result, let published = try? JSONDecoder().decode(PRPublishResult.self, from: data) {
                self.notice = "Review submitted on \(self.label) (\(event.title.lowercased()), \(published.published) comments)."
            } else {
                self.report(result, done: "Review submitted on \(self.label).")
            }
        }
    }

    private func report(_ result: Result<Data, Error>, done: String) {
        switch result {
        case .success: notice = done
        case .failure(let failure): notice = "Failed: \(failure)"
        }
    }

    /// Runs one write off the main thread with the text in a temp file, then reloads the threads
    /// (the write dropped the CLI's cache). `then` runs on the main thread.
    func write(_ status: String, body: String?, args: @escaping (String) -> [String], then: @escaping (Result<Data, Error>) -> Void) {
        if let busy {
            // One write at a time: a second click on a draft reply would save it twice, and the
            // first write to end would clear the status of the one still running.
            then(.failure(PRWriteBusy(running: busy)))
            return
        }

        var bodyFile: URL?
        if let body {
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("hub-pr-\(UUID().uuidString.prefix(8)).md")
            do {
                try body.write(to: file, atomically: true, encoding: .utf8)
            } catch {
                then(.failure(error))
                return
            }
            bodyFile = file
        }

        let argv = args(bodyFile?.path ?? "")
        busy = status
        DispatchQueue.global(qos: .userInitiated).async {
            let span = HubPerf.begin("pr.write", argv.prefix(4).joined(separator: " "))
            let result = Result { try PRCLI.run(argv) }
            span.end(result.isSuccess ? "" : "failed")
            if let bodyFile {
                try? FileManager.default.removeItem(at: bodyFile)
            }
            DispatchQueue.main.async { [weak self] in
                self?.busy = nil
                if case .failure(let failure) = result {
                    HubPerf.log("pr.write failed \(argv.prefix(4).joined(separator: " ")): \(failure)")
                }
                then(result)
                self?.load()
            }
        }
    }
}

private struct PRWriteBusy: Error, CustomStringConvertible {
    let running: String
    var description: String { "\(running) is still running; try again when it ends." }
}

private extension Result {
    var isSuccess: Bool {
        if case .success = self { return true }
        return false
    }
}
