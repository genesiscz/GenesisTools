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

    func testCommitAndFileKeysSelectAndRevealTheSameRow() {
        for ids in [(0..<60).map { "commit-\($0)" }, (0..<200).map { "file-\($0)" }] {
            var current: String?
            var revealed: [String] = []
            for _ in ids {
                let result = GitHistoryKeys.move(ids, from: current, by: 1) { id in
                    current = id
                    revealed.append(id)
                }
                if case .ignored = result { XCTFail("the key must select and reveal a row") }
            }
            XCTAssertEqual(revealed, ids, "every key step reveals its row, including rows past the visible page")
            XCTAssertEqual(current, ids.last)
            revealed = []
            _ = GitHistoryKeys.move(ids, from: current, by: 1) { revealed.append($0) }
            XCTAssertEqual(revealed, [ids.last!], "Down at the end keeps the last row visible")
            revealed = []
            _ = GitHistoryKeys.move(ids, from: current, by: -1) { revealed.append($0) }
            XCTAssertEqual(revealed, [ids[ids.count - 2]])
            revealed = []
            _ = GitHistoryKeys.move(ids, from: nil, by: -1) { revealed.append($0) }
            XCTAssertEqual(revealed, [ids.last!], "Up with no keyed row starts at the end")
        }
        var revealed: [String] = []
        let empty = GitHistoryKeys.move([], from: nil, by: 1) { revealed.append($0) }
        if case .handled = empty { XCTFail("an empty list must leave the key unhandled") }
        XCTAssertTrue(revealed.isEmpty)
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
