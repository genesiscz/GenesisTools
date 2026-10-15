import Foundation

// Hover a new line of the diff to see the agent session and turn that wrote it; its button opens
// that session in the hub with the transcript searched for the turn's prompt. The data is
// `tools agents blame` (src/agents/lib/changes/blame.ts): the agents change logs of every checkout
// of the repository, each line owned by the last change that added its text.

public struct AgentBlameSource: Codable, Equatable {
    public let provider: String
    public let session: String
    public let turn: String
    public let ts: String
    public let prompt: String?

    public init(provider: String, session: String, turn: String, ts: String, prompt: String?) {
        self.provider = provider
        self.session = session
        self.turn = turn
        self.ts = ts
        self.prompt = prompt
    }
}

public struct AgentBlameFile: Decodable, Equatable {
    public let path: String
    /// `[startLine, endLine, sourceIndex]` on the file's current text.
    public let ranges: [[Int]]

    public init(path: String, ranges: [[Int]]) {
        self.path = path
        self.ranges = ranges
    }
}

public struct AgentBlameResult: Decodable, Equatable {
    public let sources: [AgentBlameSource]
    public let files: [AgentBlameFile]
    public let elapsedMs: Int?

    public init(sources: [AgentBlameSource], files: [AgentBlameFile], elapsedMs: Int?) {
        self.sources = sources
        self.files = files
        self.elapsedMs = elapsedMs
    }
}

/// What the page gets: the ranges keyed by the diff's file ids, and every file already asked about.
public struct AgentBlamePayload: Encodable, Equatable {
    public let sources: [AgentBlameSource]
    public let files: [String: [[Int]]]
    public let loaded: [String]

    public init(sources: [AgentBlameSource], files: [String: [[Int]]], loaded: [String]) {
        self.sources = sources
        self.files = files
        self.loaded = loaded
    }
}

/// The blame of the files hovered so far. It is computed per file on the first hover (`blame.need`),
/// because a whole large diff took 1.6 to 5 s in `tools` on every reload, and most files are never hovered.
public struct AgentBlameState: Equatable {
    public private(set) var sources: [AgentBlameSource] = []
    public private(set) var ranges: [String: [[Int]]] = [:]
    public private(set) var loaded: Set<String> = []

    public var payload: AgentBlamePayload {
        AgentBlamePayload(sources: sources, files: ranges, loaded: loaded.sorted())
    }

    public func source(at index: Int) -> AgentBlameSource? {
        sources.indices.contains(index) ? sources[index] : nil
    }

    /// Adds one answer: its sources join the list once per session turn, and its ranges point at them.
    public mutating func merge(_ result: AgentBlameResult, files: [DiffFile], asked: Set<String>) {
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

    public init(sources: [AgentBlameSource] = [], ranges: [String: [[Int]]] = [:], loaded: Set<String> = []) {
        self.sources = sources
        self.ranges = ranges
        self.loaded = loaded
    }
}

extension DiffScope {
    /// The diff's new side is the files on disk (GitWorkingTreeSource: "the new side may be the working tree").
    public var newSideIsWorkingTree: Bool {
        switch self {
        case .lastTurns, .uncommitted, .unstaged, .branch: return true
        case .staged, .commit, .range, .compare: return false
        }
    }
}

public enum AgentBlame {
    /// At most this many files per call: the argv stays short and the scan bounded.
    public static let maxFiles = 400

    /// The files whose new side is the working tree (a deleted or skipped file has no lines to own).
    /// `tools agents blame` numbers the lines of the file ON DISK, and the page looks them up by the
    /// diff's new-side line: a scope whose new side is a commit or the index gets no blame, since its
    /// line numbers would name other lines.
    public static func arguments(repo: String, files: [DiffFile], scope: DiffScope) -> [String]? {
        paths(files: files, scope: scope).map { arguments(repo: repo, paths: $0) }
    }

    /// The repo-relative paths `arguments(repo:files:scope:)` asks about; nil when there are none.
    public static func paths(files: [DiffFile], scope: DiffScope) -> [String]? {
        guard scope.newSideIsWorkingTree else { return nil }
        let paths = files.filter { $0.status != .deleted && $0.skipped == nil && $0.additions > 0 }.prefix(maxFiles).map(\.path)
        return paths.isEmpty ? nil : Array(paths)
    }

    public static func arguments(repo: String, paths: [String]) -> [String] {
        ["agents", "blame", "--repo", repo, "--files"] + paths + ["--json"]
    }

    /// The hub's session with its transcript searched for the turn's first words (`--transcript-query`).
    /// A running hub takes the arguments (HubSingleInstance); otherwise this starts one.
    public static func hubArguments(for source: AgentBlameSource) -> [String] {
        var args = ["--hub", "--session", source.session, "--tab", "transcript"]
        if let query = query(source.prompt) {
            args += ["--transcript-query", query]
        }
        return args
    }

    /// Up to six words of the prompt as it reads, stopping before the first quote, bracket or tag
    /// ("[Image #3]", "<pasted_content …>"), so the transcript search matches the turn's own text.
    public static func query(_ prompt: String?) -> String? {
        guard let prompt else { return nil }
        let marks = CharacterSet(charactersIn: "\"“”<>[]")
        let head = prompt.unicodeScalars.firstIndex(where: marks.contains).map { String(prompt.unicodeScalars[..<$0]) } ?? prompt
        let words = head.split(whereSeparator: \.isWhitespace).prefix(6)
        return words.isEmpty ? nil : words.joined(separator: " ")
    }

    /// Shows the session that wrote a line, through `GenesisKitGT.provider`.
    public static func open(_ source: AgentBlameSource) {
        GenesisKitGT.provider.openAgentSession(source)
    }
}
