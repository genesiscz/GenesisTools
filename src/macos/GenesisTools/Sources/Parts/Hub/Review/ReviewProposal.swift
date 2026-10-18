import Foundation

/// The window's side of `src/hub/lib/proposal.ts`. Read and written through JSONSerialization so
/// a write-back (status, edited text) keeps every field the TypeScript side knows and this does not.
package final class ProposalDocument {
    package struct Draft {
        package var id: String
        package var path: String
        package var side: DiffSide
        package var line: Int
        package var startLine: Int
        package var severity: String
        package var body: String
        package var editedBody: String?
        package var status: String
        package var verdict: String
        package var proof: String?
        package var confidence: Int?
        package var reasoning: String?
    }

    /// A thread that already exists on the PR, with the agent's read of it when it gave one.
    package struct Thread {
        package var id: String
        package var path: String
        package var line: Int
        package var author: String
        package var body: String
        package var noteCount: Int
        package var resolved: Bool
        package var verdict: String?
        package var proof: String?
        package var suggestedReply: String?
        package var editedReply: String?
        package var replyStatus: String?
        package var confidence: Int?
        package var reasoning: String?
        package var fix: String?

        /// The reply as it would be sent now: Martin's wording when he changed it, else the agent's.
        package var reply: String? { editedReply ?? suggestedReply }
    }

    package let url: URL
    private var root: [String: Any]

    package init(url: URL) throws {
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

    package var baseSha: String { root["baseSha"] as? String ?? "" }
    package var headSha: String { root["headSha"] as? String ?? "" }
    package var repoPath: String? { root["repoPath"] as? String }
    package var number: Int { root["number"] as? Int ?? 0 }
    package var provider: String { root["provider"] as? String ?? "" }
    package var title: String { root["title"] as? String ?? (root["project"] as? String ?? "") }
    package var url_: String? { root["url"] as? String }

    private var verdict: [String: Any] { root["verdict"] as? [String: Any] ?? [:] }
    package var decision: String { verdict["decision"] as? String ?? "comment" }
    package var summary: String { verdict["summary"] as? String ?? "" }
    package var confidence: Int? { verdict["confidence"] as? Int }
    package var agent: String { (root["author"] as? [String: Any])?["agent"] as? String ?? "agent" }

    package var label: String { "\(provider == "gitlab" ? "!" : "#")\(number)" }

    package var drafts: [Draft] {
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
    package var threads: [Thread] {
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

    package var host: String { root["host"] as? String ?? "" }
    package var project: String { root["project"] as? String ?? "" }

    package var identity: PRIdentity { PRIdentity(provider: provider, host: host, project: project, number: number) }

    /// How `tools hub pr` finds this proposal's PR: its URL, else `<repoPath>#<n>` (the review
    /// worktree is often detached, so its branch cannot name the PR).
    package var prTarget: PRTarget? {
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
    package func update(threadID: String, editedReply: String? = nil, replyStatus: String? = nil, providerId: String? = nil) throws {
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
    package func update(draftID: String, status: String, editedBody: String? = nil, providerId: String? = nil) throws {
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

    package func reconcileSubmitted(pr: PRIdentity, ids: Set<String>) throws {
        guard identity == pr, !ids.isEmpty else { return }
        try FileLock.withLock(url) {
            root = try Self.read(url)
            guard identity == pr else { return }
            var changed = false
            for key in ["drafts", "threads"] {
                guard var rows = root[key] as? [[String: Any]] else { continue }
                let status = key == "drafts" ? "status" : "replyStatus"
                for index in rows.indices {
                    guard let providerID = rows[index]["providerId"] as? String, ids.contains(providerID),
                          ["draft", "drafted"].contains(rows[index][status] as? String ?? "") else { continue }
                    rows[index][status] = "posted"
                    changed = true
                }
                root[key] = rows
            }
            if changed { try write() }
        }
    }

    /// The draft's own thread on the PR, when the agent wrote it as a reply instead of a new thread.
    package func replyToThread(draftID: String) -> String? {
        (root["drafts"] as? [[String: Any]])?.first { $0["id"] as? String == draftID }?["replyToThread"] as? String
    }

    package func permitsDraftSend(displayedHead: String, pr: PRIdentity?) -> Bool {
        !headSha.isEmpty && headSha == displayedHead && identity == pr
    }

    /// `shownHead` / `prHead` as in `PRThreadRendering.belongs`.
    package func rendered(for files: [DiffFile], liveThreads: [PRThread]? = nil, shownHead: String? = nil, prHead: String? = nil) -> [RenderedComment] {
        renderedThreads(for: files, liveThreads: liveThreads, shownHead: shownHead, prHead: prHead) + renderedDrafts(for: files)
    }

    /// Existing PR threads, read-only: blue avatar, open / resolved, the agent's verdict below.
    /// A live thread whose lines belong to another head (a push after the proposal) keeps the
    /// proposal's own line while the diff shows the commit the proposal was read on; on any other
    /// diff it has no line to sit on.
    private func renderedThreads(for files: [DiffFile], liveThreads: [PRThread]?, shownHead: String?, prHead: String?) -> [RenderedComment] {
        let live = Dictionary((liveThreads ?? []).map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let onOwnHead = shownHead.map { PRThreadRendering.sameCommit(headSha, $0) } ?? false
        return threads.compactMap { thread in
            let found = live[thread.id]
            if liveThreads != nil && found == nil { return nil }
            let placed = found.map { PRThreadRendering.belongs($0, shownHead: shownHead, prHead: prHead) } ?? true
            if !placed && !onOwnHead { return nil }
            let current = placed ? found : nil
            let path = current?.path ?? thread.path
            let line = current?.line ?? thread.line
            guard line > 0, let file = files.first(where: { $0.path == path || (current?.oldPath != nil && $0.oldPath == current?.oldPath) }) else { return nil }
            let notes = thread.noteCount > 1 ? " · \(thread.noteCount) notes" : ""
            let meta = thread.verdict.map { verdict in
                RenderedMeta(verdict: Self.threadVerdictLabel(verdict), proof: thread.proof, confidence: thread.confidence,
                             reasoning: thread.reasoning, fix: thread.fix)
            }
            return RenderedComment(
                id: "thread:\(thread.id)",
                fileId: file.id,
                side: current?.side ?? .additions,
                startLine: min(current?.startLine ?? line, line),
                endLine: line,
                body: thread.body,
                author: "@\(thread.author)",
                when: notes,
                state: (found?.resolved ?? thread.resolved) ? "resolved" : "open",
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
    package func unplaced(in files: [DiffFile]) -> Int {
        drafts.filter { draft in !files.contains { $0.path == draft.path } }.count
    }
}
