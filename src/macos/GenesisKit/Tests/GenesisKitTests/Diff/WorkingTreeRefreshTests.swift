import CoreServices
import XCTest
@testable import GenesisKit

/// The live reload of an Uncommitted diff (Martin, 2026-11-05: the hub's Changes view re-read the whole repository
/// for every file event of a busy checkout). Each refresh answer is checked against a full load of the same state.
final class WorkingTreeRefreshTests: XCTestCase {
    private final class CountingProvider: GenesisKitGTCLIProvider {
        var commands: [String] = []
        override func git(_ arguments: [String], in repo: URL, input: Data? = nil, gitDirectory: String? = nil,
                          environment: [String: String]? = nil) throws -> GitRunResult {
            commands.append(arguments.first { !$0.hasPrefix("-") } ?? "")
            return try super.git(arguments, in: repo, input: input, gitDirectory: gitDirectory, environment: environment)
        }
    }

    private let plain = GenesisKitGTCLIProvider()
    private var repo: URL!

    override func setUpWithError() throws {
        repo = FileManager.default.temporaryDirectory.appendingPathComponent("gk-refresh-\(UUID().uuidString)").resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        try write("a.txt", "one\ntwo\n")
        try write("b.txt", "bee\n")
        try write(".gitignore", "dist/\n*.log\n")
        try git(["init", "-q", "-b", "main"])
        try git(["add", "."])
        try commit("start")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: repo)
    }

    private func write(_ path: String, _ text: String) throws {
        let url = repo.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
    }

    private func git(_ args: [String]) throws {
        let result = try plain.git(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"] + args, in: repo, input: nil,
                                   gitDirectory: nil, environment: [
            "GIT_AUTHOR_NAME": "Alice", "GIT_AUTHOR_EMAIL": "alice@example.com",
            "GIT_COMMITTER_NAME": "Alice", "GIT_COMMITTER_EMAIL": "alice@example.com",
        ])
        XCTAssertEqual(result.status, 0, String(decoding: result.stderr, as: UTF8.self))
    }

    private func commit(_ message: String) throws {
        try git(["commit", "-q", "-m", message])
    }

    private func load() throws -> GitWorkingTreeSource.Snapshot {
        try GitWorkingTreeSource(repo: repo).load(scope: .uncommitted)
    }

    private func layout() throws -> ReviewRepositoryLayout {
        try GitWorkingTreeSource(repo: repo).repositoryLayout()
    }

    private func batch(_ paths: String..., index: Bool = false, refs: Bool = false) -> ReviewWatchBatch {
        var batch = ReviewWatchBatch()
        paths.forEach { batch.add(.path($0)) }
        if index { batch.add(.index) }
        if refs { batch.add(.refs) }
        return batch
    }

    /// The refresh's answer and the git commands it ran.
    private func refresh(_ previous: GitWorkingTreeSource.Snapshot, _ batch: ReviewWatchBatch) throws -> (WorkingTreeRefresh, [String]) {
        // The hub keeps the layout from the last load, so its `rev-parse` is not part of a refresh.
        let layout = try layout()
        let counting = CountingProvider()
        let before = GenesisKitGT.provider
        GenesisKitGT.provider = counting
        defer { GenesisKitGT.provider = before }
        let answer = GitWorkingTreeSource(repo: repo).refresh(previous, batch: batch, layout: layout)
        return (answer, counting.commands)
    }

    private func names(_ files: [DiffFile]) -> [String] {
        files.map { "\($0.status) \($0.path) +\($0.additions) -\($0.deletions)" }
    }

    func testAnEditReadsOnlyItsPathAndMatchesAFullLoad() throws {
        try write("a.txt", "one\nTWO\n")
        let first = try load()
        XCTAssertNotNil(first.marks)
        try write("a.txt", "one\nTWO\nthree\n")

        let (answer, commands) = try refresh(first, batch("a.txt"))
        guard case .updated(let next) = answer else { return XCTFail("\(answer)") }
        let full = try load()
        XCTAssertEqual(next.files, full.files)
        XCTAssertEqual(names(next.files), ["modified a.txt +2 -1"])
        // HEAD's side of a.txt was already in the answer: no cat-file.
        XCTAssertEqual(commands, ["status", "diff"])
    }

    func testAStatOnlyIndexWriteAndAnotherRefChangeNothingWithoutAGitRun() throws {
        try write("a.txt", "changed\n")
        let first = try load()
        try git(["status", "--porcelain"])
        try git(["branch", "other"])
        try git(["pack-refs", "--all"])
        let (answer, commands) = try refresh(first, batch(index: true, refs: true))
        guard case .same = answer else { return XCTFail("\(answer)") }
        XCTAssertEqual(commands, [], "HEAD came from packed-refs and the index header")
    }

    func testAnIgnoredPathIsRememberedAndCostsNothingTheSecondTime() throws {
        let first = try load()
        try write("dist/out.js", "built\n")
        let (answer, _) = try refresh(first, batch("dist/out.js"))
        guard case .same(let marks) = answer else { return XCTFail("\(answer)") }
        XCTAssertTrue(marks.ignores("dist/out.js"), "\(marks.ignored)")

        var known = first
        known.marks = marks
        try write("dist/out.js", "built again\n")
        let (again, commands) = try refresh(known, batch("dist/out.js"))
        guard case .same = again else { return XCTFail("\(again)") }
        XCTAssertEqual(commands, [])
    }

    func testANewFileAndAFileEditedBackToHeadMatchAFullLoad() throws {
        try write("a.txt", "edited\n")
        var snapshot = try load()
        try write("notes/c.md", "new\nfile\n")
        guard case .updated(let added) = try refresh(snapshot, batch("notes")).0 else { return XCTFail("new file") }
        XCTAssertEqual(added.files, try load().files)
        XCTAssertEqual(names(added.files), ["modified a.txt +1 -2", "added notes/c.md +2 -0"])
        snapshot = added

        try write("a.txt", "one\ntwo\n")
        guard case .updated(let reverted) = try refresh(snapshot, batch("a.txt")).0 else { return XCTFail("reverted file") }
        XCTAssertEqual(reverted.files, try load().files)
        XCTAssertEqual(names(reverted.files), ["added notes/c.md +2 -0"])
    }

    func testACommitAStagedNewFileAndADeletionBesideAnAddedFileLoadInFull() throws {
        try write("c.md", "new\n")
        let first = try load()

        try FileManager.default.removeItem(at: repo.appendingPathComponent("b.txt"))
        guard case .full(let pair) = try refresh(first, batch("b.txt")).0 else { return XCTFail("deletion") }
        XCTAssertTrue(pair.contains("rename"), pair)

        try git(["add", "c.md"])
        guard case .full(let index) = try refresh(first, batch(index: true)).0 else { return XCTFail("staged new file") }
        XCTAssertTrue(index.contains("index"), index)

        try commit("more")
        guard case .full(let head) = try refresh(first, batch(refs: true)).0 else { return XCTFail("commit") }
        XCTAssertEqual(head, "HEAD moved")
    }

    func testOnlyEventsThatChangeContentCount() {
        let root = URL(fileURLWithPath: "/repo/wt")
        let layout = ReviewRepositoryLayout(root: root, gitDirectory: URL(fileURLWithPath: "/repo/main/.git/worktrees/wt"),
                                            commonDirectory: URL(fileURLWithPath: "/repo/main/.git"))
        let file = UInt32(kFSEventStreamEventFlagItemIsFile)
        let dir = UInt32(kFSEventStreamEventFlagItemIsDir)
        let modified = UInt32(kFSEventStreamEventFlagItemModified)
        let created = UInt32(kFSEventStreamEventFlagItemCreated)
        let cloned = UInt32(kFSEventStreamEventFlagItemCloned)
        let xattr = UInt32(kFSEventStreamEventFlagItemXattrMod)

        XCTAssertEqual(layout.classify("/repo/wt/src/app.ts", flags: file | modified), .path("src/app.ts"))
        XCTAssertNil(layout.classify("/repo/wt/src/app.ts", flags: file | cloned), "the diff hook's clone of a dirty file")
        XCTAssertNil(layout.classify("/repo/wt/src/app.ts", flags: file | xattr))
        XCTAssertNil(layout.classify("/repo/wt/src", flags: dir | modified), "a folder's own modified time")
        XCTAssertEqual(layout.classify("/repo/wt/src/moved", flags: dir | created), .path("src/moved"))
        XCTAssertNil(layout.classify("/repo/wt/node_modules/pkg/index.js", flags: file | modified))
        XCTAssertNil(layout.classify("/repo/wt/.git", flags: file | modified))
        XCTAssertEqual(layout.classify("/repo/main/.git/worktrees/wt/index", flags: file | modified), .index)
        XCTAssertNil(layout.classify("/repo/main/.git/index", flags: file | modified), "the main checkout's index")
        XCTAssertNil(layout.classify("/repo/main/.git/worktrees/wt/index.lock", flags: file | created))
        XCTAssertEqual(layout.classify("/repo/main/.git/worktrees/other/HEAD", flags: file | modified), .refs)
        XCTAssertNil(layout.classify("/repo/main/.git/worktrees/other/HEAD", flags: file | cloned))
        XCTAssertEqual(layout.classify("/repo/wt/src", flags: UInt32(kFSEventStreamEventFlagMustScanSubDirs)), .rescan)
    }
}
