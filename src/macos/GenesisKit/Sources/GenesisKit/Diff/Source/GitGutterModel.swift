//
//  GitGutterModel.swift
//  GenesisKit
//
//  The hunks of the file on screen against HEAD, for the gutter: HEAD's copy is read when the file opens and again
//  when its repository changes (a commit, a checkout), the hunks a beat after the text stops changing. A file
//  outside a repository, or not in HEAD yet, has none.
//

import Combine
import Foundation

@MainActor
public final class GitGutterModel: ObservableObject {
    @Published public private(set) var hunks: [GitHunk] = []
    private var url: URL?
    private var text = ""
    private var head: String?
    /// A commit or a checkout changes HEAD's copy; a stage does not, but reading it again is cheap.
    private lazy var follower = GitRepoFollower(skipFirst: true) { [weak self] in self?.loadHead() }
    private var pending: DispatchWorkItem?
    /// One per kind of load, so a text change never drops a HEAD read in flight, nor the reverse.
    private var headTicket = 0
    private var hunkTicket = 0
    var computeHunks: @Sendable (String, String) -> [GitHunk] = { GitHunks.between(old: $0, new: $1) }

    public init() {}

    /// Follows `url` with its current `text` (nil url: nothing).
    public func follow(_ url: URL?, text: String) {
        self.text = text
        guard url != self.url else {
            schedule()
            return
        }
        headTicket += 1
        hunkTicket += 1
        pending?.cancel()
        self.url = url
        head = nil
        hunks = []
        follower.follow(url)
        if url != nil { loadHead() }
    }

    /// The text changed (typing, a reload): the hunks follow a beat later.
    public func textChanged(_ text: String) {
        guard text != self.text else { return }
        self.text = text
        schedule()
    }

    private func loadHead() {
        guard let url else { return }
        headTicket += 1
        let ticket = headTicket
        let provider = GenesisKitGT.provider
        DispatchQueue.global(qos: .utility).async {
            let head = (try? provider.contents(of: url, at: .head)) ?? nil
            DispatchQueue.main.async { [weak self] in
                guard let self, self.headTicket == ticket, self.url == url else { return }
                self.head = head
                self.compute()
            }
        }
    }

    private func schedule() {
        hunkTicket += 1
        pending?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.compute() }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: work)
    }

    private func compute() {
        hunkTicket += 1
        guard let head else {
            if !hunks.isEmpty { hunks = [] }
            return
        }
        let text = self.text
        let url = self.url
        let computeHunks = self.computeHunks
        let ticket = hunkTicket
        DispatchQueue.global(qos: .userInitiated).async {
            let hunks = computeHunks(head, text)
            DispatchQueue.main.async { [weak self] in
                guard let self, self.hunkTicket == ticket, self.url == url, self.text == text,
                      self.head == head, self.hunks != hunks else { return }
                self.hunks = hunks
            }
        }
    }
}
