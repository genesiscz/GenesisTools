import Foundation

/// What a file's diff compares (the markdown viewer's Changes mode, `GitFileDiffModel`). A single past commit is a
/// separate pick: `lastCommit` with a commit id.
public enum GitFileScope: String, CaseIterable, Sendable {
    /// The working copy against the staged copy.
    case unstaged
    /// The staged copy against HEAD.
    case staged
    /// The working copy against HEAD.
    case uncommitted
    /// What the last commit that touched the file changed in it.
    case lastCommit
    /// The working copy against the merge base with the branch's base.
    case branch

    public var title: String {
        switch self {
        case .unstaged: return "Unstaged"
        case .staged: return "Staged"
        case .uncommitted: return "Uncommitted"
        case .lastCommit: return "Last commit"
        case .branch: return "Branch"
        }
    }
}
