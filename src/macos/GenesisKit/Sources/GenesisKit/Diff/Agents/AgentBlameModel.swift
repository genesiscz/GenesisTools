//
//  AgentBlameModel.swift
//  GenesisKit
//
//  Which agent session and turn wrote the lines of the file on screen (`GenesisKitGT.provider.agentBlame`, GenesisTools'
//  `tools agents blame`), for the gutter card and the Changes mode's diff. Read when the file opens, again when its
//  repository changes or it is saved. The blame is of the file on disk: an unsaved draft's lines may have moved.
//

import Foundation

@MainActor
public final class AgentBlameModel: ObservableObject {
    @Published public private(set) var state = AgentBlameState()
    /// The file's repo-relative path, which is also its id in a `GitFileDiffModel` diff.
    public private(set) var path: String?
    private var url: URL?
    private lazy var follower = GitRepoFollower(skipFirst: true) { [weak self] in self?.reload() }
    private var ticket = 0

    public init() {}

    /// Follows `url` (nil: nothing, as when attribution is off).
    public func follow(_ url: URL?) {
        guard url != self.url else { return }
        ticket += 1
        self.url = url
        state = AgentBlameState()
        path = nil
        follower.follow(url)
        reload()
    }

    /// Asks again. The blame runs once per repository for every file that asked meanwhile (`AgentBlameQueue`).
    public func reload() {
        guard let url else { return }
        ticket += 1
        AgentBlameQueue.shared.request(.init(model: self, ticket: ticket, url: url))
    }

    /// The part of a shared blame result that is this file's, unless a newer request or another file replaced it.
    func apply(_ result: AgentBlameResult, path: String, ticket: Int, url: URL) {
        guard self.ticket == ticket, self.url == url else { return }
        let file = DiffFile(id: path, path: path, status: .modified, additions: 0, deletions: 0)
        var state = AgentBlameState()
        state.merge(result, files: [file], asked: [path])
        self.path = path
        self.state = state
    }

    /// The session that wrote most of these 0-based lines, nil when no agent wrote any of them.
    public func source(forLines lines: ClosedRange<Int>) -> AgentBlameSource? {
        guard let path, let ranges = state.ranges[path] else { return nil }
        var counts: [Int: Int] = [:]
        for range in ranges where range.count == 3 {
            // Ranges are 1-based and inclusive.
            let start = range[0] - 1, end = range[1] - 1
            let overlap = min(end, lines.upperBound) - max(start, lines.lowerBound) + 1
            if overlap > 0 { counts[range[2], default: 0] += overlap }
        }
        guard let best = counts.max(by: { $0.value < $1.value })?.key else { return nil }
        return state.source(at: best)
    }
}

extension AgentBlameSource {
    /// "Claude · session 1b4001ba", for a card.
    public var title: String {
        "\(provider.prefix(1).uppercased() + provider.dropFirst()) · session \(session.prefix(8))"
    }
}
