import Foundation
import SwiftUI

// The review window's side of `tools hub pr` (src/hub/lib/pr/*): the PR/MR's live review threads,
// and every write the window makes to them. Swift only builds argv and reads JSON; the host rules
// (GitHub GraphQL, GitLab discussions and draft notes) stay in TypeScript.

/// Where a `tools hub pr` verb finds its PR/MR: its URL or `<repoPath>#<n>` (`--pr`), or the
/// checkout whose branch names it (`--repo`).
package enum PRTarget: Equatable {
    case ref(String)
    case repo(String)

    package var argv: [String] {
        switch self {
        case .ref(let ref): return ["--pr", ref]
        case .repo(let path): return ["--repo", path]
        }
    }
}

/// The PR's host, project and number: its label, and whether GitLab's words apply.
package struct PRIdentity: Codable, Equatable {
    package var provider: String
    package var host: String
    package var project: String
    package var number: Int

    package var isGitLab: Bool { provider == "gitlab" }
    package var label: String { isGitLab ? "!\(number)" : "#\(number)" }
}

package struct PRDraftOwnership: Codable, Equatable {
    package let pr: PRIdentity
    package let headSha: String
    package let draftID: String

    package func permits(pr selected: PRIdentity?, draftID selectedID: String?) -> Bool {
        pr == selected && draftID == selectedID
    }
}

package enum PRReviewEvent: String, CaseIterable, Identifiable {
    case comment, approve, requestChanges

    package var id: String { rawValue }

    package var title: String {
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
package enum PRCommand {
    package static func threads(_ target: PRTarget, noCache: Bool = false) -> [String] {
        ["hub", "pr", "threads"] + target.argv + ["--json"] + (noCache ? ["--no-cache"] : ["--max-cache-age", "30"])
    }

    /// A reply in an existing thread: a draft in the pending review, or published at once.
    package static func reply(_ target: PRTarget, thread: String, bodyFile: String, draft: Bool) -> [String] {
        ["hub", "pr", "reply"] + target.argv + ["--thread", thread, "--body-file", bodyFile, "--json"] + (draft ? ["--draft"] : [])
    }

    /// A new draft comment on a line or a range; `startLine` counts only when it is above `line`.
    package static func draftAdd(_ target: PRTarget, path: String, line: Int, startLine: Int?, side: DiffSide, bodyFile: String) -> [String] {
        lineComment(["draft", "add"], target, path: path, line: line, startLine: startLine, side: side, bodyFile: bodyFile)
    }

    /// A NEW comment published at once, alone (`hub pr comment`): my other pending drafts stay pending,
    /// where `draft add` followed by `publish` would send them all. Both hosts, both sides, ranges too.
    package static func comment(_ target: PRTarget, path: String, line: Int, startLine: Int?, side: DiffSide, bodyFile: String) -> [String] {
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

    package static func draftUpdate(_ target: PRTarget, draftId: String, bodyFile: String) -> [String] {
        ["hub", "pr", "draft", "update", draftId] + target.argv + ["--body-file", bodyFile, "--json"]
    }

    package static func draftDelete(_ target: PRTarget, draftId: String) -> [String] {
        ["hub", "pr", "draft", "delete", draftId] + target.argv + ["--json"]
    }

    package static func resolve(_ target: PRTarget, thread: String, resolved: Bool) -> [String] {
        ["hub", "pr", "resolve", thread] + target.argv + ["--json"] + (resolved ? [] : ["--unresolve"])
    }

    package static func publish(_ target: PRTarget, event: PRReviewEvent, bodyFile: String?) -> [String] {
        ["hub", "pr", "publish"] + target.argv + event.flags + (bodyFile.map { ["--body-file", $0] } ?? []) + ["--json"]
    }

    /// A thread card's button (or the threads list's) as argv; nil when the input lacks what the verb
    /// needs. There is no case for `publish`: a card cannot submit the review.
    package static func threadAction(_ input: ThreadActionInput, target: PRTarget, bodyFile: String) -> [String]? {
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
    package static func postPendingDraft(_ target: PRTarget, draftId: String, path: String, line: Int, startLine: Int?,
                                 side: DiffSide, bodyFile: String) -> [[String]] {
        [comment(target, path: path, line: line, startLine: startLine, side: side, bodyFile: bodyFile),
         draftDelete(target, draftId: draftId)]
    }
}

// MARK: - JSON

package struct PRInfo: Decodable, Equatable {
    package let provider: String
    package let host: String
    package let project: String
    package let number: Int
    package let url: String
    package let webUrl: String?
    package let title: String
    package let state: String?
    package let draft: Bool?
    package let author: String?
    /// The author's picture on the host (GitLab `avatar_url`, GitHub's profile `.png`); nil from an older `tools`.
    package var authorAvatarUrl: String? = nil
    package let sourceBranch: String?
    package let targetBranch: String?
    /// The head branch lives in a fork; `headRepo` is its `owner/repo` when the host named it. Both
    /// nil from a `tools` that does not send them: the links then read the PR's own project.
    package let crossRepository: Bool?
    package let headRepo: String?
    package var headSha: String? = nil
    /// The commit the PR's diff starts from (GitLab `diff_refs.base_sha`, GitHub the base ref's sha).
    package var baseSha: String? = nil

    package var identity: PRIdentity { PRIdentity(provider: provider, host: host, project: project, number: number) }
    /// The PR's project on the host, for user and branch pages; nil for a host that is not GitHub or GitLab.
    package var forge: ForgeWeb? { ForgeWeb(kind: provider, web: "https://\(host)/\(project)") }
    /// The source branch's page, in the fork for a fork PR (the same rule as `HubPR.headBranchURL`).
    package var sourceBranchURL: URL? {
        sourceBranch.flatMap { forge?.head(crossRepository: crossRepository, headRepo: headRepo)?.branch($0) }
    }

    package var compareURL: URL? {
        guard let sourceBranch, let targetBranch else { return nil }
        return forge?.compare(base: targetBranch, head: sourceBranch, crossRepository: crossRepository, headRepo: headRepo)
    }
}

package struct PRThreadComment: Decodable, Identifiable, Equatable {
    package struct Author: Decodable, Equatable {
        package let name: String
        package let username: String
        package let role: String?
        /// The author's picture on the host (GitHub `avatarUrl`, GitLab `avatar_url`); nil from an older `tools`.
        package var avatarUrl: String? = nil
    }

    package let id: String
    package let author: Author
    package let bodyMarkdown: String
    package let createdAt: String
    package let editedAt: String?
    /// My pending review comment: only I see it until the review is submitted.
    package let isDraft: Bool
    /// The comment on the host's web page (GitHub `#discussion_r…`, GitLab `#note_…`); nil for a draft.
    package let url: String?
}

package struct PRThread: Decodable, Identifiable, Equatable {
    package let id: String
    package let path: String
    package let oldPath: String?
    package let side: DiffSide
    package let line: Int
    package let startLine: Int?
    /// The commit whose line numbers `line` and `startLine` are; nil from a `tools` that does not send it.
    package var commitSha: String? = nil
    package let outdated: Bool
    package let resolved: Bool
    package let resolvable: Bool
    package let comments: [PRThreadComment]

    /// A thread whose first comment is my pending draft: it does not exist for anyone else yet.
    package var isMyDraft: Bool { comments.first?.isDraft ?? false }
}

package struct PRThreadsPayload: Decodable, Equatable {
    package let pr: PRInfo
    package let threads: [PRThread]
    /// Every draft `publish` would send, including GitLab drafts that have no line.
    package let draftCount: Int
    package let viewer: String?
    package let cached: Bool?
    package let fetchedAt: String?
}

package struct PRReplyResult: Decodable {
    package let threadId: String
    package let commentId: String
}

package struct PRDraftAddResult: Decodable {
    package let draftId: String
    package let threadId: String?
}

package struct PRPublishResult: Decodable {
    package let event: String
    package let published: Int
    package let url: String?
    package let submittedIds: [String]?
    package let pr: PRIdentity?
    package let warning: String?
}

/// `{error, code}`: what a `tools hub pr … --json` failure prints on stdout.
package struct PRCLIError: Decodable, Error, CustomStringConvertible {
    package let error: String
    package let code: String

    package var description: String { error }
}

package enum PRCLI {
    /// Blocking: call it off the main thread only.
    package static func run(_ args: [String]) throws -> Data {
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

package enum PRThreadRendering {
    /// The diff card of a live PR thread.
    package static func cardID(thread id: String) -> String {
        "live:\(id)"
    }

    /// Whether a thread's line numbers belong to the diff on screen. Without `shownHead` (the
    /// working-tree scopes) that is every thread that is not outdated. A diff pinned to a commit (a
    /// proposal's range) takes the threads made on that commit, outdated or not, and the current ones
    /// only when the PR's head is that commit: GitLab moves a thread whose line did not change to the
    /// newest head, so its line numbers belong to that head and not to an older diff.
    package static func belongs(_ thread: PRThread, shownHead: String?, prHead: String?) -> Bool {
        guard let shownHead, !shownHead.isEmpty else { return !thread.outdated }
        if let sha = thread.commitSha, sameCommit(sha, shownHead) { return true }
        return !thread.outdated && prHead.map { sameCommit($0, shownHead) } == true
    }

    /// Either side may be an abbreviated id.
    package static func sameCommit(_ a: String, _ b: String) -> Bool {
        !a.isEmpty && !b.isEmpty && (a.hasPrefix(b) || b.hasPrefix(a))
    }

    /// Live threads as diff cards (`kind: "thread"` with `live`: the notes, Reply, Resolve, and Edit /
    /// Delete on my drafts). A thread whose lines belong to another head (`belongs`) stays in the
    /// threads list only. `skip` holds the thread ids the proposal already shows with the agent's read.
    package static func rendered(_ threads: [PRThread], files: [DiffFile], skip: Set<String> = [], shownHead: String? = nil, prHead: String? = nil, forge: ForgeWeb? = nil, now: Date = Date()) -> [RenderedComment] {
        threads.compactMap { thread in
            guard belongs(thread, shownHead: shownHead, prHead: prHead), !skip.contains(thread.id), let first = thread.comments.first,
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
    /// The note's text with its commit ids and PR/MR references linked (`PRRefLinker`); nil when nothing
    /// changed, so the page renders `body` as it is.
    package static func display(_ body: String, forge: ForgeWeb?) -> String? {
        let linked = PRRefLinker.linkify(body, forge: forge)
        return linked == body ? nil : linked
    }

    package static func live(_ thread: PRThread, forge: ForgeWeb? = nil, now: Date = Date()) -> RenderedLiveThread {
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
                    authorUrl: forge?.user(comment.author.username)?.absoluteString,
                    url: comment.url,
                    avatarUrl: comment.author.avatarUrl,
                    display: display(comment.bodyMarkdown, forge: forge)
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
    ///
    /// `proposalOnShownHead`: the diff shows the commit the proposal was read on. A live thread that
    /// moved on to a newer head (a push after the proposal) then keeps the proposal's own line, which
    /// was read on this very diff, instead of leaving the diff: the card does not vanish under the
    /// reader, and the reply typed in it stays in view.
    package static func refresh(_ proposalComments: [RenderedComment], with threads: [PRThread], files: [DiffFile], shownHead: String? = nil, prHead: String? = nil, proposalOnShownHead: Bool = false, forge: ForgeWeb? = nil, now: Date = Date()) -> [RenderedComment] {
        let anchors = Dictionary(rendered(threads, files: files, shownHead: shownHead, prHead: prHead, forge: forge, now: now).map {
            (String($0.id.dropFirst(5)), $0)
        }, uniquingKeysWith: { first, _ in first })
        let byID = Dictionary(threads.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return proposalComments.compactMap { comment in
            guard comment.id.hasPrefix("thread:") else { return comment }
            let id = String(comment.id.dropFirst(7))
            guard let anchor = anchors[id] else {
                guard proposalOnShownHead, let thread = byID[id], files.contains(where: { $0.id == comment.fileId }) else { return nil }
                var copy = comment
                copy.state = thread.isMyDraft ? "draft" : thread.resolved ? "resolved" : "open"
                copy.live = live(thread, forge: forge, now: now)
                return copy
            }
            var copy = comment
            copy.fileId = anchor.fileId
            copy.side = anchor.side
            copy.startLine = anchor.startLine
            copy.endLine = anchor.endLine
            copy.state = anchor.state
            copy.live = anchor.live
            return copy
        }
    }

    /// A card without Reply and Resolve, for threads read from the disk cache.
    package static func readOnly(_ comment: RenderedComment) -> RenderedComment {
        guard comment.live != nil else { return comment }
        var copy = comment
        copy.live?.canReply = false
        copy.live?.resolvable = false
        return copy
    }

    package static func ago(_ iso: String, now: Date = Date()) -> String {
        guard let date = HubFormat.date(iso) else { return iso }
        return HubFormat.relative.localizedString(for: date, relativeTo: now)
    }
}

// MARK: - Store

/// The live review threads of one PR/MR, loaded off the main thread. It loads when the window
/// shows it, after every write, and when the app becomes active again more than 30 s after the
/// last load (the CLI keeps its own 30 s cache, and a write drops it). No timer.
/// The first load paints the last answer from disk (`ReviewCache.threads`) while it asks the host.
package final class PRThreadsStore: ObservableObject {
    package static let staleAfter: TimeInterval = 30

    package let target: PRTarget
    @Published package private(set) var payload: PRThreadsPayload?
    @Published package private(set) var loading = false
    /// The threads on screen came from the disk cache and the host has not answered yet. 🛑 Every write
    /// waits for the fresh answer: a stale thread id or state must never reach the host.
    @Published package private(set) var stale = false
    /// Threads that are new or whose notes or state moved in the last refresh; they flash once.
    @Published package private(set) var changed: Set<String> = []
    /// A write in flight ("Resolving…"); the thread buttons wait for it.
    @Published package private(set) var busy: String?
    @Published package var notice: String?
    @Published package private(set) var error: String?
    /// Called on the main thread after new threads land (the model re-renders the diff's cards).
    package var onChange: (() -> Void)?
    package var onSubmitted: ((PRIdentity, Set<String>) -> Void)?

    private var lastLoad: Date?
    private var loadAgain = false
    private var loadAgainNoCache = false

    package init(target: PRTarget) {
        self.target = target
    }

    package var pr: PRInfo? { payload?.pr }
    package var label: String { payload?.pr.identity.label ?? "the PR" }
    /// Loaded at least once, or failed: a `--snapshot` waits for this before it captures.
    package var settled: Bool { !loading && (payload != nil || error != nil) }
    /// Submit review, Fix and every thread write: only on the host's fresh answer.
    package var canWrite: Bool { payload != nil && !stale }

    package func load(noCache: Bool = false) {
        if loading {
            loadAgain = true
            loadAgainNoCache = loadAgainNoCache || noCache
            return
        }

        loading = true
        let args = PRCommand.threads(target, noCache: noCache)
        let cacheKey = ReviewCache.threadsKey(target)
        let seed = payload == nil
        DispatchQueue.global(qos: .userInitiated).async {
            let cached = seed ? HubPerf.measure("pr.threads.cache") { Self.cached(cacheKey) } : nil
            if let cached {
                // Queued before the fresh answer below, so it can never land after it.
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.payload == nil else { return }
                    HubPerf.log("pr.threads paint cached \(cached.threads.count) threads")
                    self.stale = true
                    self.payload = cached
                    self.onChange?()
                }
            }
            let span = HubPerf.begin("pr.threads", args.suffix(from: 3).joined(separator: " "))
            let result = Result { () -> PRThreadsPayload in
                let data = try PRCLI.run(args)
                let payload = try JSONDecoder().decode(PRThreadsPayload.self, from: data)
                ReviewCache.threads.writeData(data, key: cacheKey)
                return payload
            }
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
                    let wasStale = self.stale
                    self.stale = payload.cached == true
                    if payload != self.payload {
                        self.show(payload)
                        self.onChange?()
                    } else if wasStale {
                        // The same threads: the diff's cards get their buttons back.
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

    private static func cached(_ key: String) -> PRThreadsPayload? {
        guard let data = ReviewCache.threads.readData(key: key) else { return nil }
        do {
            return try JSONDecoder().decode(PRThreadsPayload.self, from: data)
        } catch {
            HubPerf.log("pr.threads cache unreadable, ignored: \(error)")
            return nil
        }
    }

    /// Shows a fresh answer, animating threads in and out; the ones that moved flash once.
    private func show(_ next: PRThreadsPayload) {
        let before = Dictionary((payload?.threads ?? []).map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let moved: Set<String> = before.isEmpty ? [] : Set(next.threads.filter { before[$0.id] != $0 }.map(\.id))
        let removed = Set(before.keys).subtracting(next.threads.map(\.id)).count
        // `show` runs on the main queue (load's completion), so the busy reading can start here.
        MainActor.assumeIsolated { HubMainBusy.measure("prs.threads.show") }
        // Animate only a few threads changing in a list already on screen. A first load (or a refresh that
        // changes most threads) under a spring made SwiftUI build an animated insertion for every row of
        // the non-lazy list at once: a 1.4 s main-thread stall opening a PR (2026-10-08).
        if before.isEmpty || moved.count + removed > Self.animatedChangeLimit {
            payload = next
            changed = moved
        } else {
            withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) {
                payload = next
                changed = moved
            }
        }
        guard !moved.isEmpty else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in
            guard let self, self.changed == moved else { return }
            withAnimation(.easeOut(duration: 0.6)) { self.changed = [] }
        }
    }

    /// More changed threads than this appear without the spring (see `show`).
    package static let animatedChangeLimit = 8

    /// The app became active again: load only when the last answer is older than the CLI's cache.
    package func reloadIfStale() {
        guard let lastLoad, Date().timeIntervalSince(lastLoad) >= Self.staleAfter else { return }
        load()
    }

    // MARK: Writes

    /// One thread write, from a diff card or the threads list, through `PRCommand.threadAction`.
    /// The caller asked first when it publishes or deletes. `finished` gets true when the host took
    /// the write (the diff card then clears its box).
    package func perform(_ input: ThreadActionInput, finished: ((Bool) -> Void)? = nil) {
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

    package func reply(thread: String, body: String, draft: Bool, finished: ((Bool) -> Void)? = nil) {
        perform(ThreadActionInput(id: "live:\(thread)", action: .reply, draft: draft, body: body), finished: finished)
    }

    package func resolve(thread: String, resolved: Bool) {
        perform(ThreadActionInput(id: "live:\(thread)", action: resolved ? .resolve : .unresolve))
    }

    package func updateDraft(thread: String, note: String, body: String, finished: ((Bool) -> Void)? = nil) {
        perform(ThreadActionInput(id: "live:\(thread)", action: .noteUpdate, noteID: note, body: body), finished: finished)
    }

    package func deleteDraft(thread: String, note: String) {
        perform(ThreadActionInput(id: "live:\(thread)", action: .noteDelete, noteID: note))
    }

    /// 🛑 Publishes every pending draft as one review. Only the Submit review button calls this,
    /// after its NSAlert confirmation named the PR and the draft count.
    package func submitReview(event: PRReviewEvent, summary: String) {
        let summary = summary.trimmed
        let identity = payload?.pr.identity
        write("Submitting the review…", body: summary.isEmpty ? nil : summary, args: { [target] in
            PRCommand.publish(target, event: event, bodyFile: summary.isEmpty ? nil : $0)
        }) { [weak self] result in
            guard let self else { return }
            if case .success(let data) = result, let published = try? JSONDecoder().decode(PRPublishResult.self, from: data) {
                if let owner = published.pr, owner == identity, let ids = published.submittedIds {
                    self.onSubmitted?(owner, Set(ids))
                }
                self.notice = published.warning ?? "Review submitted on \(self.label) (\(event.title.lowercased()), \(Plural.count(published.published, "comment")))."
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
    package func write(_ status: String, body: String?, args: @escaping (String) -> [String], then: @escaping (Result<Data, Error>) -> Void) {
        if stale {
            // The threads on screen are the disk cache's: wait for the host's answer before any write.
            then(.failure(PRThreadsStale()))
            return
        }

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

private struct PRThreadsStale: Error, CustomStringConvertible {
    var description: String { "refresh the thread list from the host before writing." }
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
