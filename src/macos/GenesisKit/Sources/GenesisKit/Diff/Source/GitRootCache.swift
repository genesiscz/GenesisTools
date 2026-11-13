//
//  GitRootCache.swift
//  GenesisKit
//
//  Folder → repository root, for every git component in the process. Each view used to find its repository with its
//  own `git rev-parse --show-toplevel` at every refresh (the status bar, the gutter, each history), so Genesis Markdown
//  ran as many `rev-parse` as `git status` (56,304 against 53,246 in one perf log, 2026-11-12). A remembered root is
//  checked with a few `stat` calls instead: it still has its `.git`, and no folder between it and the asked folder
//  has become a repository of its own (a `git init`, a submodule, a linked worktree inside the checkout).
//

import Foundation

final class GitRootCache: @unchecked Sendable {
    static let shared = GitRootCache()

    private let lock = NSLock()
    /// Standardized folder path → its root, the real path git names.
    private var roots: [String: URL] = [:]

    /// The remembered root of `folder`, nil when none is known or it no longer holds.
    func root(of folder: URL) -> URL? {
        let key = folder.standardizedFileURL.path
        lock.lock()
        let root = roots[key]
        lock.unlock()
        guard let root else { return nil }
        guard Self.stillHolds(root, for: key) else {
            forget(key)
            return nil
        }
        return root
    }

    func remember(_ root: URL, for folder: URL) {
        lock.lock()
        roots[folder.standardizedFileURL.path] = root
        lock.unlock()
    }

    private func forget(_ key: String) {
        lock.lock()
        roots[key] = nil
        lock.unlock()
    }

    /// `root` still has its `.git`, and no folder from `folder` up to it has one: git would name the same root. Both
    /// through `realpath`: Foundation names a root under /tmp or /var without /private.
    static func stillHolds(_ root: URL, for folder: String) -> Bool {
        let files = FileManager.default
        let rootPath = GitWorkingTreeSource.realPath(root.path)
        guard files.fileExists(atPath: rootPath + "/.git") else { return false }
        var current = GitWorkingTreeSource.realPath(folder)
        while current != rootPath {
            guard current.hasPrefix(rootPath + "/") else { return false }
            if files.fileExists(atPath: current + "/.git") { return false }
            current = (current as NSString).deletingLastPathComponent
        }
        return true
    }
}
