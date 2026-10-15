import AppKit
import SwiftUI
import Vision
import XCTest
@testable import GenesisKit

/// The Changes mode's scope picker and the commit chooser: nothing of a list exists until it opens, the open list
/// builds only the rows on screen, the filter and the keys work, the details come from one `git log`, and the scope
/// list shows the counts it is given.
@MainActor
final class GitPickerTests: XCTestCase {
    override func setUp() async throws {
        try await super.setUp()
        RenderProbe.enabled = true
        _ = RenderProbe.take()
    }

    override func tearDown() async throws {
        RenderProbe.enabled = false
        _ = RenderProbe.take()
        try await super.tearDown()
    }

    /// `count` commits, newest first; every hundredth from the eighth on is alice's, the rest bob's.
    static func choices(_ count: Int) -> [GitCommitChoice] {
        (0..<count).map { (index: Int) -> GitCommitChoice in
            let sha: String = String(format: "%08x", index + 0x1000) + String(repeating: "a", count: 32)
            let age: TimeInterval = Double(index) * 3600
            let author: String = index % 100 == 7 ? "alice" : "bob"
            return GitCommitChoice(sha: sha, subject: "Change number \(index)", author: author,
                                   date: Date(timeIntervalSince1970: 1_760_000_000 - age))
        }
    }

    static func history(_ count: Int) -> [GitCommit] {
        choices(count).map { GitCommit(sha: $0.sha, short: $0.short, subject: $0.subject, author: $0.author ?? "", date: $0.date ?? Date()) }
    }

    private func read(_ view: NSView) throws -> String {
        let image = try XCTUnwrap(HostedShot.bitmap(view)?.cgImage)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }

    private func count<T: NSView>(_ kind: T.Type, in view: NSView) -> Int {
        (view is T ? 1 : 0) + view.subviews.reduce(0) { $0 + count(kind, in: $1) }
    }

    func testTheFilterKeepsEveryWordInTheSubjectTheAuthorOrTheStartOfTheID() {
        let choices = [
            GitCommitChoice(sha: "3f9a2c1" + String(repeating: "0", count: 33), subject: "Fix the table that lost its row", author: "Alice"),
            GitCommitChoice(sha: "8b04d7e" + String(repeating: "0", count: 33), subject: "Add the review checklist", author: "Bob", badge: "#2"),
            GitCommitChoice(sha: "c51e990" + String(repeating: "0", count: 33), subject: "Résumé of the plan", author: "Carol"),
        ]
        func subjects(_ query: String) -> [String] { GitCommitFilter.matches(choices, query: query).map(\.subject) }
        XCTAssertEqual(subjects(""), choices.map(\.subject))
        XCTAssertEqual(subjects("  "), choices.map(\.subject))
        XCTAssertEqual(subjects("TABLE"), ["Fix the table that lost its row"], "case does not matter")
        XCTAssertEqual(subjects("resume"), ["Résumé of the plan"], "accents do not matter")
        XCTAssertEqual(subjects("bob"), ["Add the review checklist"], "the author counts")
        XCTAssertEqual(subjects("8b04"), ["Add the review checklist"], "the start of the id counts")
        XCTAssertEqual(subjects("04d7"), [], "the middle of the id does not")
        XCTAssertEqual(subjects("#2"), ["Add the review checklist"], "the tag counts")
        XCTAssertEqual(subjects("the alice"), ["Fix the table that lost its row"], "every word must match")
        XCTAssertEqual(subjects("the dave"), [])
    }

    func testTheKeysMoveTheHighlightAndTheFilterStartsItAtTheTop() {
        let choices = Self.choices(20)
        var state = GitCommitPickerState(choices: choices, selection: choices[5].sha)
        XCTAssertEqual(state.highlighted, choices[5].id, "the list opens on the commit shown now")
        state.move(1)
        XCTAssertEqual(state.highlightedChoice?.subject, "Change number 6")
        state.move(-100)
        XCTAssertEqual(state.highlightedChoice?.subject, "Change number 0", "Page Up stops at the top")
        state.move(100)
        XCTAssertEqual(state.highlightedChoice?.subject, "Change number 19", "Page Down stops at the end")
        state.query = "alice"
        XCTAssertEqual(state.rows.map(\.subject), ["Change number 7"])
        XCTAssertEqual(state.highlightedChoice?.subject, "Change number 7", "a new filter starts at its first row")
        state.query = "nobody"
        XCTAssertNil(state.highlightedChoice)
        state.move(1)
        XCTAssertNil(state.highlightedChoice, "no row, no highlight")
        state.query = ""
        XCTAssertEqual(state.rows.count, 20)

        var unpicked = GitCommitPickerState(choices: choices, selection: nil)
        XCTAssertEqual(unpicked.highlighted, choices[0].id)
        unpicked.highlighted = nil
        unpicked.move(1)
        XCTAssertEqual(unpicked.highlighted, choices[0].id, "Down from nothing starts at the top")
    }

    func testTheDetailsComeFromOneGitLogWithTheFileAndTheCommitCounts() throws {
        let repo = FileManager.default.temporaryDirectory.appendingPathComponent("commit-details-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo.appendingPathComponent("notes"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: repo) }
        let provider = GenesisKitGTCLIProvider()
        func git(_ args: [String]) throws -> String {
            let result = try provider.git(["-c", "commit.gpgsign=false"] + args, in: repo, input: nil, gitDirectory: nil, environment: [
                "GIT_AUTHOR_NAME": "Alice", "GIT_AUTHOR_EMAIL": "alice@example.com", "GIT_AUTHOR_DATE": "2026-10-01T10:00:00Z",
                "GIT_COMMITTER_NAME": "Alice", "GIT_COMMITTER_EMAIL": "alice@example.com", "GIT_COMMITTER_DATE": "2026-10-01T10:00:00Z",
            ])
            XCTAssertEqual(result.status, 0, String(decoding: result.stderr, as: UTF8.self))
            return String(decoding: result.stdout, as: UTF8.self).trimmed
        }
        _ = try git(["init", "-q", "-b", "main"])
        try "one\ntwo\nthree\n".write(to: repo.appendingPathComponent("notes/plan.md"), atomically: true, encoding: .utf8)
        try Data([0, 1, 2, 0, 255]).write(to: repo.appendingPathComponent("picture.bin"))
        _ = try git(["add", "."])
        _ = try git(["commit", "-q", "-m", "First notes"])
        let first = try git(["rev-parse", "HEAD"])
        try "one\n2\nthree\n".write(to: repo.appendingPathComponent("notes/plan.md"), atomically: true, encoding: .utf8)
        try "a\nb\n".write(to: repo.appendingPathComponent("other.md"), atomically: true, encoding: .utf8)
        _ = try git(["add", "."])
        _ = try git(["commit", "-q", "-m", "Second"])
        let second = try git(["rev-parse", "HEAD"])

        let missing = String(repeating: "d", count: 40)
        let choices = [
            GitCommitChoice(sha: second, subject: "Second", path: "notes/plan.md"),
            GitCommitChoice(sha: first, subject: "First notes", path: "notes/plan.md"),
            GitCommitChoice(sha: missing, subject: "Not in this repository"),
            GitCommitChoice(sha: "HEAD", subject: "A name, never asked about"),
        ]
        XCTAssertEqual(GitCommitDetailsLoader.arguments([second]).filter { $0 == second }.count, 1)
        let details = try GitCommitDetailsLoader(folder: repo.appendingPathComponent("notes")).load(choices)
        XCTAssertEqual(Set(details.keys), [first, second], "an id the repository lacks is skipped, not fatal")
        XCTAssertEqual(details[second]?.author, "Alice")
        XCTAssertEqual(details[second]?.date, ISO8601DateFormatter().date(from: "2026-10-01T10:00:00Z"))
        XCTAssertEqual(details[second]?.stat, GitCommitStat(files: 2, additions: 3, deletions: 1, fileAdditions: 1, fileDeletions: 1))
        XCTAssertEqual(details[first]?.stat, GitCommitStat(files: 2, additions: 3, deletions: 0, fileAdditions: 3, fileDeletions: 0),
                       "a binary file counts as a file with no lines")

        let filled = choices[2].filled(by: details[second])
        XCTAssertEqual(filled.author, "Alice", "the details fill what the source lacks")
        let kept = GitCommitChoice(sha: second, subject: "Second", author: "Source").filled(by: details[second])
        XCTAssertEqual(kept.author, "Source", "and never replace what it gave")
    }

    func testAClosedPickerBuildsNoListAndNoNativeMenu() throws {
        let choices = Self.choices(800)
        let view = VStack(alignment: .leading) {
            GitCommitPicker(choices: choices, selection: choices[3].sha) { _ in }
            GitScopePicker(scope: .constant(.lastCommit), commit: .constant(nil), history: Self.history(800), shown: nil)
            GitScopePicker(scope: .constant(.uncommitted), commit: .constant(nil), history: Self.history(800), shown: nil)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.white)
        .environment(\.colorScheme, .light)
        let (window, host) = HostedShot.host(view, size: CGSize(width: 640, height: 120))
        defer { window.close() }
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        let seen = try read(host)
        let counts = RenderProbe.take()
        XCTAssertNil(counts["git.commitPicker.list"], "a closed commit picker built its list: \(counts)")
        XCTAssertNil(counts["git.commitPicker.row"], "a closed commit picker built rows: \(counts)")
        XCTAssertNil(counts["git.scopePicker.list"], "a closed scope picker built its list: \(counts)")
        XCTAssertEqual(count(NSPopUpButton.self, in: host), 0, "a native pop-up button builds its menu items with the pane")
        XCTAssertTrue(seen.contains("Change number 3"), "the chip names the commit shown now; read: \(seen)")
        XCTAssertTrue(seen.contains("Uncommitted"), "read: \(seen)")
    }

    func testTheOpenListBuildsOnlyTheRowsOnScreenAndOnlyTheMatches() throws {
        let choices = Self.choices(800)
        do {
            let (window, host) = HostedShot.host(
                GitCommitPickerList(choices: choices, selection: nil, title: "Commits", details: nil) { _ in }.background(Color.white).environment(\.colorScheme, .light),
                size: CGSize(width: GitCommitPickerList.width, height: 480))
            defer { window.close() }
            RunLoop.main.run(until: Date().addingTimeInterval(0.3))
            _ = HostedShot.bitmap(host)
            let rows = RenderProbe.take()["git.commitPicker.row"] ?? 0
            print("open list of \(choices.count) commits: \(rows) row bodies")
            XCTAssertGreaterThan(rows, 0, "the open list shows rows")
            XCTAssertLessThan(rows, 80, "800 commits built \(rows) row bodies: the list must build only what is on screen")
        }
        do {
            let (window, host) = HostedShot.host(
                GitCommitPickerList(choices: choices, selection: nil, title: nil, details: nil, query: "alice") { _ in }.background(Color.white).environment(\.colorScheme, .light),
                size: CGSize(width: GitCommitPickerList.width, height: 480))
            defer { window.close() }
            RunLoop.main.run(until: Date().addingTimeInterval(0.3))
            let seen = try read(host)
            XCTAssertTrue(seen.contains("8 of 800 commits"), "read: \(seen)")
            XCTAssertTrue(seen.contains("Change number 707"), "read: \(seen)")
            XCTAssertFalse(seen.contains("Change number 1\n"), "a commit the filter drops is not drawn; read: \(seen)")
            XCTAssertFalse(seen.contains("bob"), "read: \(seen)")
        }
    }

    func testOneFilesScopeCountsComeFromTheStatusAndTheDiffOnScreen() {
        let root = URL(fileURLWithPath: "/fixture/repo")
        let file = root.appendingPathComponent("notes/plan.md")
        let status = GitRepoStatus(root: root, branch: "main", entries: [GitStatusEntry(path: "notes/plan.md", staged: .modified)])
        let diff = GitFileDiffModel.diffFile(path: "notes/plan.md", old: "a\nb\n", new: "a\nB\nc\n")
        var counts = GitScopeStat.forFile(status: status, file: file, current: .staged, phase: .ready, diff: diff)
        XCTAssertEqual(counts[.staged], GitScopeStat(additions: diff.additions, deletions: diff.deletions))
        XCTAssertEqual(counts[.unstaged], .clean)
        XCTAssertEqual(counts[.uncommitted], .changed)
        XCTAssertNil(counts[.branch], "unknown stays unknown")
        XCTAssertNil(counts[.lastCommit])

        counts = GitScopeStat.forFile(status: status, file: file, unsaved: true, current: .branch, phase: .empty("same"), diff: nil)
        XCTAssertEqual(counts[.unstaged], .changed, "a draft on screen differs from the file on disk")
        XCTAssertEqual(counts[.branch], .clean, "an empty diff on screen is a known clean scope")

        let clean = GitRepoStatus(root: root, branch: "main")
        counts = GitScopeStat.forFile(status: clean, file: file, current: .uncommitted, phase: .loading, diff: nil)
        XCTAssertEqual(counts[.uncommitted], .clean)
        XCTAssertEqual(GitScopeStat.forFile(status: nil, file: file, current: .unstaged, phase: .loading, diff: nil), [:],
                       "no status yet, no counts")
    }

    func testTheScopeListShowsWhatEachScopeComparesAndItsCounts() throws {
        let counts: [GitFileScope: GitScopeStat] = [
            .unstaged: GitScopeStat(additions: 12, deletions: 3),
            .staged: .clean,
            .uncommitted: .changed,
        ]
        let list = GitScopeList(selection: .uncommitted, counts: counts, base: "origin/main", shown: nil) { _ in }
            .background(Color(nsColor: .windowBackgroundColor))
            .environment(\.colorScheme, .light)
        let (window, host) = HostedShot.host(list, size: CGSize(width: GitScopeList.width, height: 300))
        defer { window.close() }
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        let seen = try read(host)
        for text in ["Unstaged", "Staged", "Uncommitted", "Last commit", "Branch", "+12", "No changes", "Changed", "origin/main"] {
            XCTAssertTrue(seen.contains(text), "\(text) missing; read: \(seen)")
        }
        XCTAssertEqual(RenderProbe.take()["git.scopePicker.list"].map { $0 > 0 }, true)
    }
}
