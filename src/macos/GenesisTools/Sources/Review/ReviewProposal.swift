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

    /// accept / reject / restore / edit: the decisions that belong to the window, never to the agent.
    /// Re-reads the file first, under the lock `tools hub proposal push` also takes: the agent may have
    /// pushed new drafts since the window loaded it, and must not push while this write is in flight.
    func update(draftID: String, status: String, editedBody: String? = nil) throws {
        try FileLock.withLock(url) {
            root = try Self.read(url)
            guard var drafts = root["drafts"] as? [[String: Any]],
                  let index = drafts.firstIndex(where: { $0["id"] as? String == draftID })
            else { return }

            drafts[index]["status"] = status
            if let editedBody {
                drafts[index]["editedBody"] = editedBody
            }
            root["drafts"] = drafts
            root["updatedAt"] = ISO8601DateFormatter().string(from: Date())
            let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: url, options: .atomic)
        }
    }

    func rendered(for files: [DiffFile]) -> [RenderedComment] {
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
