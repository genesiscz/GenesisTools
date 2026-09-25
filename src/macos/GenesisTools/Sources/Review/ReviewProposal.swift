import Foundation

/// The window's side of `src/hub/lib/proposal.ts`. Read and written through JSONSerialization so
/// a write-back (status, edited text) keeps every field the TypeScript side knows and this does not.
final class ProposalDocument {
    struct Draft {
        var id: String
        var path: String
        var side: DiffSide
        var line: Int
        var startLine: Int
        var severity: String
        var body: String
        var editedBody: String?
        var status: String
        var verdict: String
        var proof: String?
        var confidence: Int?
        var reasoning: String?
    }

    /// A thread that already exists on the PR, with the agent's read of it when it gave one.
    struct Thread {
        var id: String
        var path: String
        var line: Int
        var author: String
        var body: String
        var noteCount: Int
        var resolved: Bool
        var verdict: String?
        var proof: String?
        var suggestedReply: String?
        var editedReply: String?
        var replyStatus: String?
        var confidence: Int?
        var reasoning: String?
        var fix: String?

        /// The reply as it would be sent now: Martin's wording when he changed it, else the agent's.
        var reply: String? { editedReply ?? suggestedReply }
    }

    let url: URL
    private var root: [String: Any]

    init(url: URL) throws {
        self.url = url
        root = try Self.read(url)
    }

    private static func read(_ url: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: url)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ReviewError.git("\(url.path) is not a proposal object")
        }
        return object
    }

    var baseSha: String { root["baseSha"] as? String ?? "" }
    var headSha: String { root["headSha"] as? String ?? "" }
    var repoPath: String? { root["repoPath"] as? String }
    var number: Int { root["number"] as? Int ?? 0 }
    var provider: String { root["provider"] as? String ?? "" }
    var title: String { root["title"] as? String ?? (root["project"] as? String ?? "") }
    var url_: String? { root["url"] as? String }

    private var verdict: [String: Any] { root["verdict"] as? [String: Any] ?? [:] }
    var decision: String { verdict["decision"] as? String ?? "comment" }
    var summary: String { verdict["summary"] as? String ?? "" }
    var confidence: Int? { verdict["confidence"] as? Int }
    var agent: String { (root["author"] as? [String: Any])?["agent"] as? String ?? "agent" }

    var label: String { "\(provider == "gitlab" ? "!" : "#")\(number)" }

    var drafts: [Draft] {
        (root["drafts"] as? [[String: Any]] ?? []).compactMap { raw in
            guard let id = raw["id"] as? String, let path = raw["path"] as? String, let line = raw["line"] as? Int else { return nil }
            let meta = raw["meta"] as? [String: Any] ?? [:]
            return Draft(
                id: id,
                path: path,
                side: DiffSide(rawValue: raw["side"] as? String ?? "") ?? .additions,
                line: line,
                startLine: raw["startLine"] as? Int ?? line,
                severity: raw["severity"] as? String ?? "minor",
                body: raw["body"] as? String ?? "",
                editedBody: raw["editedBody"] as? String,
                status: raw["status"] as? String ?? "proposed",
                verdict: meta["verdict"] as? String ?? "",
                proof: meta["proof"] as? String,
                confidence: meta["confidence"] as? Int,
                reasoning: meta["reasoning"] as? String
            )
        }
    }

    /// Threads without a file and line (a top-level note) have no place on the diff; the banner
    /// counts them instead.
    var threads: [Thread] {
        (root["threads"] as? [[String: Any]] ?? []).compactMap { raw in
            guard let id = raw["threadId"] as? String else { return nil }
            return Thread(
                id: id,
                path: raw["path"] as? String ?? "",
                line: raw["line"] as? Int ?? 0,
                author: raw["author"] as? String ?? "reviewer",
                body: raw["body"] as? String ?? "",
                noteCount: raw["noteCount"] as? Int ?? 1,
                resolved: raw["resolved"] as? Bool ?? false,
                verdict: raw["verdict"] as? String,
                proof: raw["proof"] as? String,
                suggestedReply: raw["suggestedReply"] as? String,
                editedReply: raw["editedReply"] as? String,
                replyStatus: raw["replyStatus"] as? String,
                confidence: raw["confidence"] as? Int,
                reasoning: raw["reasoning"] as? String,
                fix: raw["fix"] as? String
            )
        }
    }

    var host: String { root["host"] as? String ?? "" }
    var project: String { root["project"] as? String ?? "" }

    var identity: PRIdentity { PRIdentity(provider: provider, host: host, project: project, number: number) }

    /// How `tools hub pr` finds this proposal's PR: its URL, else `<repoPath>#<n>` (the review
    /// worktree is often detached, so its branch cannot name the PR).
    var prTarget: PRTarget? {
        if let url = url_, !url.isEmpty {
            return .ref(url)
        }

        if let repoPath, number > 0 {
            return .ref("\(repoPath)#\(number)")
        }

        return nil
    }

    /// The window's reply to an existing thread: reworded text, and where it went.
    /// Under the same lock as `update(draftID:)` and `tools hub proposal push`.
    func update(threadID: String, editedReply: String? = nil, replyStatus: String? = nil, providerId: String? = nil) throws {
        try FileLock.withLock(url) {
            root = try Self.read(url)
            guard var threads = root["threads"] as? [[String: Any]],
                  let index = threads.firstIndex(where: { $0["threadId"] as? String == threadID })
            else { return }

            if let editedReply { threads[index]["editedReply"] = editedReply }
            if let replyStatus { threads[index]["replyStatus"] = replyStatus }
            if let providerId { threads[index]["providerId"] = providerId }
            root["threads"] = threads
            try write()
        }
    }

    /// `decidedAt`, never `updatedAt`: `updatedAt` is the agent's push stamp, and the hub rebuilds a PR's
    /// review when it moves (`HubPR.proposalStamp`); a click in this window must not do that.
    private func write() throws {
        root["decidedAt"] = ISO8601DateFormatter().string(from: Date())
        let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: .atomic)
    }

    /// accept / reject / restore / edit: the decisions that belong to the window, never to the agent.
    /// Re-reads the file first, under the lock `tools hub proposal push` also takes: the agent may have
    /// pushed new drafts since the window loaded it, and must not push while this write is in flight.
    func update(draftID: String, status: String, editedBody: String? = nil, providerId: String? = nil) throws {
        try FileLock.withLock(url) {
            root = try Self.read(url)
            guard var drafts = root["drafts"] as? [[String: Any]],
                  let index = drafts.firstIndex(where: { $0["id"] as? String == draftID })
            else { return }

            drafts[index]["status"] = status
            if let editedBody {
                drafts[index]["editedBody"] = editedBody
            }
            if let providerId {
                drafts[index]["providerId"] = providerId
            }
            root["drafts"] = drafts
            try write()
        }
    }

    /// The draft's own thread on the PR, when the agent wrote it as a reply instead of a new thread.
    func replyToThread(draftID: String) -> String? {
        (root["drafts"] as? [[String: Any]])?.first { $0["id"] as? String == draftID }?["replyToThread"] as? String
    }

    func rendered(for files: [DiffFile]) -> [RenderedComment] {
        renderedThreads(for: files) + renderedDrafts(for: files)
    }

    /// Existing PR threads, read-only: blue avatar, open / resolved, the agent's verdict below.
    private func renderedThreads(for files: [DiffFile]) -> [RenderedComment] {
        threads.compactMap { thread in
            guard thread.line > 0, let file = files.first(where: { $0.path == thread.path }) else { return nil }
            let notes = thread.noteCount > 1 ? " · \(thread.noteCount) notes" : ""
            let meta = thread.verdict.map { verdict in
                RenderedMeta(verdict: Self.threadVerdictLabel(verdict), proof: thread.proof, confidence: thread.confidence,
                             reasoning: thread.reasoning, fix: thread.fix)
            }
            return RenderedComment(
                id: "thread:\(thread.id)",
                fileId: file.id,
                side: .additions,
                startLine: thread.line,
                endLine: thread.line,
                body: thread.body,
                author: "@\(thread.author)",
                when: notes,
                state: thread.resolved ? "resolved" : "open",
                remote: true,
                kind: "thread",
                severity: nil,
                meta: meta,
                reply: thread.reply,
                replyStatus: thread.replyStatus
            )
        }
    }

    private static func threadVerdictLabel(_ verdict: String) -> String {
        switch verdict {
        case "valid": return "Agent: the point stands"
        case "invalid": return "Agent: the point does not hold"
        case "already-fixed": return "Agent: already fixed at this head"
        case "needs-discussion": return "Agent: needs a discussion"
        case "out-of-scope": return "Agent: out of scope for this PR"
        default: return "Agent: \(verdict)"
        }
    }

    private func renderedDrafts(for files: [DiffFile]) -> [RenderedComment] {
        drafts.compactMap { draft in
            guard let file = files.first(where: { $0.path == draft.path }) else { return nil }
            return RenderedComment(
                id: "draft:\(draft.id)",
                fileId: file.id,
                side: draft.side,
                startLine: min(draft.startLine, draft.line),
                endLine: draft.line,
                body: draft.editedBody ?? draft.body,
                author: agent,
                when: "",
                state: draft.status,
                remote: false,
                kind: "draft",
                severity: draft.severity,
                meta: RenderedMeta(verdict: draft.verdict, proof: draft.proof, confidence: draft.confidence, reasoning: draft.reasoning)
            )
        }
    }

    /// Drafts whose file is not in the diff (wrong path, or outside base..head): shown in the banner.
    func unplaced(in files: [DiffFile]) -> Int {
        drafts.filter { draft in !files.contains { $0.path == draft.path } }.count
    }
}
