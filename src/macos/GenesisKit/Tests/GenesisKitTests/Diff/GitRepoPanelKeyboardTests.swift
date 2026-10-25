import XCTest
@testable import GenesisKit

/// The repository panel from the keyboard: the keys walk the rows in drawn order, and the branch says its counts in words.
@MainActor
final class GitRepoPanelKeyboardTests: XCTestCase {
    func testTheKeysWalkTheRowsInTheOrderThePanelDrawsThem() {
        var lists = GitRepoPanelLists.Lists()
        lists.staged = [GitStatusEntry(path: "a.md", staged: .modified)]
        lists.changed = [GitStatusEntry(path: "b.md", unstaged: .modified)]
        lists.groups = [GitUntrackedGroup(folder: "data", files: [
            GitStatusEntry(path: "data/1.json", unstaged: .untracked), GitStatusEntry(path: "data/2.json", unstaged: .untracked),
        ])]
        lists.loose = [GitStatusEntry(path: "c.md", unstaged: .untracked)]

        let closed = GitRepoPanel.keyRows(lists, untracked: true, isOpen: { _ in false }, limit: { _ in 100 }).map(\.id)
        XCTAssertEqual(closed, ["staged:a.md", "changes:b.md", "folder-row:data", "untracked:c.md"])

        let open = GitRepoPanel.keyRows(lists, untracked: true, isOpen: { _ in true }, limit: { _ in 1 }).map(\.id)
        XCTAssertEqual(open, ["staged:a.md", "changes:b.md", "folder-row:data", "folder:data:data/1.json", "untracked:c.md"],
                       "an open folder's shown page only")

        let hidden = GitRepoPanel.keyRows(lists, untracked: false, isOpen: { _ in true }, limit: { _ in 100 }).map(\.id)
        XCTAssertEqual(hidden, ["staged:a.md", "changes:b.md"])
    }

    func testAheadAndBehindAreWords() {
        let root = URL(fileURLWithPath: "/tmp/repo")
        XCTAssertEqual(GitRepoPanel.trackingText(GitRepoStatus(root: root, branch: "main")), "No upstream branch")
        XCTAssertEqual(GitRepoPanel.trackingText(GitRepoStatus(root: root, branch: "main", upstream: "origin/main")),
                       "Tracks origin/main, up to date")
        XCTAssertEqual(GitRepoPanel.trackingText(GitRepoStatus(root: root, branch: "main", upstream: "origin/main", ahead: 2, behind: 1)),
                       "Tracks origin/main: 2 commits ahead, 1 commit behind")
    }
}
