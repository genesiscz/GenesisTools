import Foundation

// Hover a new line of the diff to see the agent session and turn that wrote it; its button opens
// that session in the hub with the transcript searched for the turn's prompt. The data is
// `tools agents blame` (src/agents/lib/changes/blame.ts): the agents change logs of every checkout
// of the repository, each line owned by the last change that added its text.

struct AgentBlameSource: Codable, Equatable {
    let provider: String
    let session: String
    let turn: String
    let ts: String
    let prompt: String?
}

struct AgentBlameFile: Decodable, Equatable {
    let path: String
    /// `[startLine, endLine, sourceIndex]` on the file's current text.
    let ranges: [[Int]]
}

struct AgentBlameResult: Decodable, Equatable {
    let sources: [AgentBlameSource]
    let files: [AgentBlameFile]
    let elapsedMs: Int?
}

/// What the page gets: the ranges keyed by the diff's file ids, and every file already asked about.
struct AgentBlamePayload: Encodable, Equatable {
    let sources: [AgentBlameSource]
    let files: [String: [[Int]]]
    let loaded: [String]
}

/// The blame of the files hovered so far. It is computed per file on the first hover (`blame.need`),
/// because a whole large diff took 1.6 to 5 s in `tools` on every reload, and most files are never hovered.
struct AgentBlameState: Equatable {
    private(set) var sources: [AgentBlameSource] = []
    private(set) var ranges: [String: [[Int]]] = [:]
    private(set) var loaded: Set<String> = []

    var payload: AgentBlamePayload {
        AgentBlamePayload(sources: sources, files: ranges, loaded: loaded.sorted())
    }

    func source(at index: Int) -> AgentBlameSource? {
        sources.indices.contains(index) ? sources[index] : nil
    }

    /// Adds one answer: its sources join the list once per session turn, and its ranges point at them.
    mutating func merge(_ result: AgentBlameResult, files: [DiffFile], asked: Set<String>) {
        let ids = Dictionary(files.map { ($0.path, $0.id) }, uniquingKeysWith: { first, _ in first })
        let remap = result.sources.map { source -> Int in
            if let known = sources.firstIndex(where: { $0.session == source.session && $0.turn == source.turn }) {
                return known
            }
            sources.append(source)
            return sources.count - 1
        }
        for file in result.files {
            guard let id = ids[file.path] else { continue }
            ranges[id] = file.ranges.compactMap { range in
                guard range.count == 3, remap.indices.contains(range[2]) else { return nil }
                return [range[0], range[1], remap[range[2]]]
            }
        }
        loaded.formUnion(asked)
    }
}

extension DiffScope {
    /// The diff's new side is the files on disk (GitWorkingTreeSource: "the new side may be the working tree").
    var newSideIsWorkingTree: Bool {
        switch self {
        case .lastTurns, .uncommitted, .unstaged, .branch: return true
        case .staged, .commit, .range: return false
        }
    }
}

enum AgentBlame {
    /// At most this many files per call: the argv stays short and the scan bounded.
    static let maxFiles = 400

    /// The files whose new side is the working tree (a deleted or skipped file has no lines to own).
    /// `tools agents blame` numbers the lines of the file ON DISK, and the page looks them up by the
    /// diff's new-side line: a scope whose new side is a commit or the index gets no blame, since its
    /// line numbers would name other lines.
    static func arguments(repo: String, files: [DiffFile], scope: DiffScope) -> [String]? {
        guard scope.newSideIsWorkingTree else { return nil }
        let paths = files.filter { $0.status != .deleted && $0.skipped == nil && $0.additions > 0 }.prefix(maxFiles).map(\.path)
        guard !paths.isEmpty else { return nil }
        return ["agents", "blame", "--repo", repo, "--files"] + paths + ["--json"]
    }

    /// The hub's session with its transcript searched for the turn's first words (`--transcript-query`).
    /// A running hub takes the arguments (HubSingleInstance); otherwise this starts one.
    static func hubArguments(for source: AgentBlameSource) -> [String] {
        var args = ["--hub", "--session", source.session, "--tab", "transcript"]
        if let query = query(source.prompt) {
            args += ["--transcript-query", query]
        }
        return args
    }

    /// Up to six words of the prompt as it reads, stopping before the first quote, bracket or tag
    /// ("[Image #3]", "<pasted_content …>"), so the transcript search matches the turn's own text.
    static func query(_ prompt: String?) -> String? {
        guard let prompt else { return nil }
        let marks = CharacterSet(charactersIn: "\"“”<>[]")
        let head = prompt.unicodeScalars.firstIndex(where: marks.contains).map { String(prompt.unicodeScalars[..<$0]) } ?? prompt
        let words = head.split(whereSeparator: \.isWhitespace).prefix(6)
        return words.isEmpty ? nil : words.joined(separator: " ")
    }

    static func open(_ source: AgentBlameSource) {
        guard let executable = Bundle.main.executablePath else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = hubArguments(for: source)
        HubPerf.log("review.blame open \(source.session.prefix(8)) turn \(source.turn.prefix(8))")
        do {
            try process.run()
        } catch {
            HubPerf.log("review.blame open failed: \(error)")
        }
    }
}
