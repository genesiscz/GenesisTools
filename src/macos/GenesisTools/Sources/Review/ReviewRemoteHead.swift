import Foundation

/// A diff whose new side is a commit that no checkout on disk holds: a PR whose branch has no local
/// worktree, its head fetched into the main checkout (Hub/HubPRFetch.swift). The main checkout is on
/// another branch, so its copy of a file is another version: file actions open the host's copy at the
/// head, the working-tree scopes are off, and the commits list is the PR's.
struct ReviewRemoteHead {
    /// The PR's head branch and the commit the diff shows.
    let branch: String
    let sha: String
    /// The PR's merge base; nil when the fetch found none.
    let base: String?
    /// The host's page of a repo-relative file at `sha`, at a line when given.
    let hostURL: (_ path: String, _ line: Int?) -> URL?

    /// `git log` arguments for the PR's own commits.
    var commitRange: [String] {
        base.map { ["\($0)..\(sha)"] } ?? [sha]
    }

    /// What an agent message says instead of the main checkout's branch.
    var branchNote: String {
        "\(branch) at \(sha.prefix(10)), not checked out in this folder"
    }
}

extension DiffScope {
    /// The scope shows the working tree or the index, so it needs the checkout of the branch.
    var readsTheCheckout: Bool {
        switch self {
        case .lastTurns, .uncommitted, .unstaged, .staged, .branch: return true
        case .commit, .range: return false
        }
    }
}
