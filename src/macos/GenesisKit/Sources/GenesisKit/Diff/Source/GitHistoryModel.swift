//
//  GitHistoryModel.swift
//  GenesisKit
//
//  A list of commits kept current: one file's (`git log --follow`) or its repository's recent ones. It reloads when
//  the repository changes, so a commit made elsewhere appears without a refresh.
//

import Foundation

@MainActor
public final class GitHistoryModel: ObservableObject {
    public enum Subject: Equatable {
        /// The commits that changed this file.
        case file(URL)
        /// The newest commits of the repository holding this folder.
        case repository(URL)

        var url: URL {
            switch self {
            case .file(let url), .repository(let url): return url
            }
        }
    }

    @Published public private(set) var commits: [GitCommit] = []
    @Published public private(set) var loaded = false
    @Published public private(set) var failure: GitFailure?
    public let limit: Int
    private var subject: Subject?
    /// A history changes only when HEAD moves: a stage or a save of the repository reads nothing.
    private lazy var follower = GitRepoFollower { [weak self] in self?.repositoryChanged() }
    private var ticket = 0
    /// The commit HEAD named when the history was last read.
    private var readAtHead: String?

    public init(limit: Int = 60) {
        self.limit = limit
    }

    public func follow(_ subject: Subject?) {
        guard subject != self.subject else { return }
        ticket += 1
        self.subject = subject
        commits = []
        loaded = false
        failure = nil
        readAtHead = nil
        switch subject {
        case .file(let url): follower.follow(url)
        case .repository(let folder): follower.follow(folder: folder)
        case nil: follower.follow(folder: nil)
        }
    }

    private func repositoryChanged() {
        guard loaded, failure == nil, let readAtHead, readAtHead == currentHead() else { return reload() }
    }

    /// The commit HEAD names in the shared status of the subject's repository.
    private func currentHead() -> String? {
        let folder: URL?
        switch subject {
        case .file(let url): folder = url.deletingLastPathComponent()
        case .repository(let root): folder = root
        case nil: folder = nil
        }
        return folder.flatMap { GitRepos.shared.model(for: $0)?.status?.head }
    }

    public func reload() {
        guard let subject else { return }
        ticket += 1
        let ticket = self.ticket
        let provider = GenesisKitGT.provider
        let limit = self.limit
        let at = currentHead()
        DispatchQueue.global(qos: .utility).async {
            let result = Result<[GitCommit], Error> {
                switch subject {
                case .file(let url):
                    return try provider.history(of: url, limit: limit)
                case .repository(let folder):
                    return try provider.repoStatus(folder, commits: limit)?.commits ?? []
                }
            }
            DispatchQueue.main.async { [weak self] in
                guard let self, self.ticket == ticket, self.subject == subject else { return }
                switch result {
                case .success(let commits):
                    self.commits = commits
                    self.failure = nil
                    self.readAtHead = at
                case .failure(let error):
                    self.failure = GitFailure(error, fallback: "Git could not read the history. Try again.")
                }
                self.loaded = true
            }
        }
    }
}
