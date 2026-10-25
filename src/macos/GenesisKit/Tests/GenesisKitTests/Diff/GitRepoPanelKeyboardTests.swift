import XCTest
@testable import GenesisKit

/// The repository panel from the keyboard: the keys walk the rows in drawn order (headings too: they fold), and the branch says its counts in words.
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
        lists.untrackedTotal = 3

        func keys(_ order: GitChangeOrder, untracked: Bool, open: Bool) -> [String] {
            GitRepoPanel.keyRows(GitRepoPanel.rows(lists, order: order, untracked: untracked, isOpen: { _ in open }))
        }
        XCTAssertEqual(keys(.name, untracked: true, open: false), ["section:staged", "staged:a.md", "section:changes", "changes:b.md",
                                                            "section:untracked", "folder-row:data", "untracked:c.md"])
        XCTAssertEqual(keys(.name, untracked: true, open: true),
                       ["section:staged", "staged:a.md", "section:changes", "changes:b.md", "section:untracked", "folder-row:data",
                        "folder:data:data/1.json", "folder:data:data/2.json", "untracked:c.md"],
                       "an open folder lists every file: the table builds only the rows on screen, so there are no pages")
        XCTAssertEqual(keys(.name, untracked: false, open: true), ["section:staged", "staged:a.md", "section:changes", "changes:b.md"])
    }

    /// Martin, 2026-10-25: the changes section topped out at a note 5 h old while untracked files a minute old sat below.
    func testLastUpdateIsOneListNewestFirst() {
        let now = Date()
        let entries = [
            GitStatusEntry(path: "Dev/Index.md", unstaged: .modified),
            GitStatusEntry(path: "Health/new.md", unstaged: .untracked),
            GitStatusEntry(path: "data/run/1.json", unstaged: .untracked),
            GitStatusEntry(path: "data/run/2.json", unstaged: .untracked),
            GitStatusEntry(path: "staged.md", staged: .added),
        ]
        let dates = ["Dev/Index.md": now.addingTimeInterval(-5 * 3600), "Health/new.md": now.addingTimeInterval(-60),
                     "data/run/1.json": now.addingTimeInterval(-7200), "data/run/2.json": now.addingTimeInterval(-600),
                     "staged.md": now]
        let lists = GitRepoPanelLists.derive(entries, dates: dates, inputs: .init(root: URL(fileURLWithPath: "/r"), order: .lastUpdate, filter: "", untracked: true))
        let rows = GitRepoPanel.rows(lists, order: .lastUpdate, untracked: true, isOpen: { _ in false })
        XCTAssertEqual(rows.map(\.id), ["section:staged", "staged:staged.md", "section:changes",
                                       "untracked:Health/new.md", "folder-row:data", "changes:Dev/Index.md"])
        XCTAssertEqual(lists.places["data/run/2.json"], .init(id: "folder:data:data/run/2.json", folder: "data"), "the reveal button's lookup")
        guard case .folder(_, let count, let newest, _) = rows[4] else { return XCTFail("a folder row") }
        XCTAssertEqual(count, 2)
        XCTAssertEqual(newest, dates["data/run/2.json"], "a folder ranks by its newest file")
    }

    func testTheKeyboardWalksEveryRowAndLetsEscapeThroughWhenNothingIsKeyed() {
        let rows: [GitPanelRow] = [
            .section(key: "changes", title: "Changes · 2", open: true),
            .file(entry: GitStatusEntry(path: "a.md", unstaged: .modified), staged: false, id: "changes:a.md", indent: false, date: nil),
            .folder(folder: "data", count: 2, newest: nil, open: false),
            .section(key: "untracked", title: "Untracked · 0", open: false),
        ]
        XCTAssertEqual(GitPanelRow.action(for: .escape, rows: rows, cursor: nil), .none, "Esc reaches the window or a sheet")
        XCTAssertEqual(GitPanelRow.action(for: .escape, rows: rows, cursor: 1), .clear)
        XCTAssertEqual(GitPanelRow.action(for: .down, rows: rows, cursor: nil), .select(0))
        XCTAssertEqual(GitPanelRow.action(for: .down, rows: rows, cursor: 1), .select(2))
        XCTAssertEqual(GitPanelRow.action(for: .down, rows: rows, cursor: 3), .select(3), "the last row stays")
        XCTAssertEqual(GitPanelRow.action(for: .up, rows: rows, cursor: 1), .select(0), "a heading is keyed: it folds")
        XCTAssertEqual(GitPanelRow.action(for: .right, rows: rows, cursor: 2), .setOpen(2, true))
        XCTAssertEqual(GitPanelRow.action(for: .left, rows: rows, cursor: 2), .select(0), "Left on a closed folder keys its heading")
        XCTAssertEqual(GitPanelRow.action(for: .left, rows: rows, cursor: 0), .setOpen(0, false), "Left folds an open section")
        XCTAssertEqual(GitPanelRow.action(for: .left, rows: rows, cursor: 3), .none, "a folded section does not fold again")
        XCTAssertEqual(GitPanelRow.action(for: .right, rows: rows, cursor: 3), .setOpen(3, true))
        XCTAssertEqual(GitPanelRow.action(for: .left, rows: rows, cursor: 1), .select(0), "Left on a file keys its heading")
        let inFolder: [GitPanelRow] = [
            .section(key: "untracked", title: "Untracked · 2", open: true),
            .folder(folder: "data", count: 2, newest: nil, open: true),
            .file(entry: GitStatusEntry(path: "data/1.json", unstaged: .untracked), staged: false, id: "folder:data:data/1.json", indent: true, date: nil),
        ]
        XCTAssertEqual(GitPanelRow.action(for: .left, rows: inFolder, cursor: 2), .select(1), "a folder's file keys its folder")
        XCTAssertEqual(GitPanelRow.action(for: .left, rows: inFolder, cursor: 1), .setOpen(1, false), "Left folds an open folder")
        XCTAssertEqual(GitPanelRow.action(for: .right, rows: inFolder, cursor: 1), .none, "an open folder stays open")
        XCTAssertEqual(GitPanelRow.action(for: .open, rows: rows, cursor: 1), .activate(1))
        XCTAssertEqual(rows[3].spoken, "Untracked · 0, section, collapsed")
    }

    /// Martin, 2026-10-25: "i should be able to fold the Changes". A folded section keeps its heading and drops its rows,
    /// in both layouts.
    func testAFoldedSectionKeepsOnlyItsHeading() {
        var lists = GitRepoPanelLists.Lists()
        lists.staged = [GitStatusEntry(path: "a.md", staged: .modified)]
        lists.changed = [GitStatusEntry(path: "b.md", unstaged: .modified)]
        lists.loose = [GitStatusEntry(path: "c.md", unstaged: .untracked)]
        lists.untrackedTotal = 1
        lists.recent = [.file(lists.changed[0]), .file(lists.loose[0])]
        let byName = GitRepoPanel.rows(lists, order: .name, untracked: true, folded: ["changes"], isOpen: { _ in false })
        XCTAssertEqual(byName.map(\.id), ["section:staged", "staged:a.md", "section:changes", "section:untracked", "untracked:c.md"])
        guard case .section(_, _, let open) = byName[2] else { return XCTFail("the changes heading") }
        XCTAssertFalse(open)
        let byDate = GitRepoPanel.rows(lists, order: .lastUpdate, untracked: true, folded: ["staged", "changes"], isOpen: { _ in false })
        XCTAssertEqual(byDate.map(\.id), ["section:staged", "section:changes"])
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
