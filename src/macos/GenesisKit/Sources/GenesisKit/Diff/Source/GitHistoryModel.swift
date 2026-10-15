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
    public let limit: Int
    private var subject: Subject?
    private lazy var follower = GitRepoFollower { [weak self] in self?.reload() }
    private var ticket = 0

    public init(limit: Int = 60) {
        self.limit = limit
    }

    public func follow(_ subject: Subject?) {
        guard subject != self.subject else { return }
        self.subject = subject
        commits = []
        loaded = false
        switch subject {
        case .file(let url): follower.follow(url)
        case .repository(let folder): follower.follow(folder: folder)
        case nil: follower.follow(folder: nil)
        }
    }

    public func reload() {
        guard let subject else { return }
        ticket += 1
        let ticket = self.ticket
        let provider = GenesisKitGT.provider
        let limit = self.limit
        DispatchQueue.global(qos: .utility).async {
            let commits: [GitCommit]
            switch subject {
            case .file(let url):
                commits = (try? provider.history(of: url, limit: limit)) ?? []
            case .repository(let folder):
                commits = ((try? provider.repoStatus(folder, commits: limit)) ?? nil)?.commits ?? []
            }
            DispatchQueue.main.async { [weak self] in
                guard let self, self.ticket == ticket else { return }
                self.commits = commits
                self.loaded = true
            }
        }
    }
}
