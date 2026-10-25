import GenesisKitFixtures
import XCTest
@testable import GenesisKit

/// Moves git does not report (a folder moved without `git mv`): the shared pairing rule on the contract both languages
/// pass, then a scratch repository through every reader that shows working-tree changes.
final class GitWorktreeRenamesTests: XCTestCase {
    private struct Contract: Decodable {
        struct Side: Decodable {
            let path: String
            let oid: String
        }
        struct Case: Decodable {
            let name: String
            let deleted: [Side]
            let untracked: [Side]
            let pairs: [[String]]
        }
        let cases: [Case]
    }

    func testEveryContractCasePairsAsTheCLIDoes() throws {
        let contract = try JSONDecoder().decode(Contract.self, from: KitFixture.data("contract-worktree-renames.json", in: "Git"))
        XCTAssertGreaterThanOrEqual(contract.cases.count, 6)
        for item in contract.cases {
            let pairs = GitWorktreeRenames.pair(deleted: item.deleted.map { .init(path: $0.path, oid: $0.oid) },
                                                untracked: item.untracked.map { .init(path: $0.path, oid: $0.oid) })
            XCTAssertEqual(pairs.map { [$0.old, $0.new] }, item.pairs, item.name)
        }
    }

    private let provider = GenesisKitGTCLIProvider()

    private func git(_ args: [String], in repo: URL) throws {
        let result = try provider.git(args, in: repo, input: nil, gitDirectory: nil, environment: [
            "GIT_AUTHOR_NAME": "Alice", "GIT_AUTHOR_EMAIL": "alice@example.com",
            "GIT_COMMITTER_NAME": "Alice", "GIT_COMMITTER_EMAIL": "alice@example.com",
        ])
        XCTAssertEqual(result.status, 0, String(decoding: result.stderr, as: UTF8.self))
    }

    /// A repository whose `data/run` folder moved to `moved/run` outside git, with one file edited after the move, one
    /// empty file and one file really deleted.
    private func movedFolderRepository() throws -> URL {
        let repo = FileManager.default.temporaryDirectory.appendingPathComponent("gitrenames-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo.appendingPathComponent("data/run"), withIntermediateDirectories: true)
        try "export const compiler = 1\n".write(to: repo.appendingPathComponent("data/run/compiler.ts"), atomically: true, encoding: .utf8)
        try "line one\nline two\n".write(to: repo.appendingPathComponent("data/run/notes.md"), atomically: true, encoding: .utf8)
        try "".write(to: repo.appendingPathComponent("data/run/empty.err"), atomically: true, encoding: .utf8)
        try "bye\n".write(to: repo.appendingPathComponent("gone.md"), atomically: true, encoding: .utf8)
        try git(["init", "-q", "-b", "main"], in: repo)
        try git(["add", "."], in: repo)
        try git(["commit", "-q", "-m", "First"], in: repo)
        try FileManager.default.createDirectory(at: repo.appendingPathComponent("moved"), withIntermediateDirectories: true)
        try FileManager.default.moveItem(at: repo.appendingPathComponent("data/run"), to: repo.appendingPathComponent("moved/run"))
        try "line one\nline two, edited\n".write(to: repo.appendingPathComponent("moved/run/notes.md"), atomically: true, encoding: .utf8)
        try FileManager.default.removeItem(at: repo.appendingPathComponent("gone.md"))
        return repo
    }

    func testTheRepositoryStatusShowsAMovedFolderAsRenames() throws {
        let repo = try movedFolderRepository()
        defer { try? FileManager.default.removeItem(at: repo) }
        let status = try XCTUnwrap(try provider.repoStatus(repo, commits: 0))
        let byPath = Dictionary(uniqueKeysWithValues: status.entries.map { ($0.path, $0) })
        XCTAssertEqual(byPath["moved/run/compiler.ts"]?.unstaged, .renamed)
        XCTAssertEqual(byPath["moved/run/compiler.ts"]?.oldPath, "data/run/compiler.ts")
        XCTAssertNil(byPath["data/run/compiler.ts"], "the old path is not listed again as deleted")
        // Exact content only: an edited file and an empty file stay deleted plus untracked, as git itself reports them.
        XCTAssertEqual(byPath["data/run/notes.md"]?.unstaged, .deleted)
        XCTAssertEqual(byPath["moved/run/notes.md"]?.unstaged, .untracked)
        XCTAssertEqual(byPath["data/run/empty.err"]?.unstaged, .deleted)
        XCTAssertEqual(byPath["moved/run/empty.err"]?.unstaged, .untracked)
        XCTAssertEqual(byPath["gone.md"]?.unstaged, .deleted)
    }

    func testTheWorkingTreeDiffTheHubShowsPairsTheMoveToo() throws {
        let repo = try movedFolderRepository()
        defer { try? FileManager.default.removeItem(at: repo) }
        let snapshot = try GitWorkingTreeSource(repo: repo).load(scope: .uncommitted)
        let file = try XCTUnwrap(snapshot.files.first { $0.path == "moved/run/compiler.ts" })
        XCTAssertEqual(file.status, .renamed)
        XCTAssertEqual(file.oldPath, "data/run/compiler.ts")
        XCTAssertEqual(file.oldContents, "export const compiler = 1\n")
        XCTAssertEqual(file.newContents, "export const compiler = 1\n")
        XCTAssertEqual(file.additions, 0)
        XCTAssertEqual(file.deletions, 0)
        XCTAssertFalse(snapshot.files.contains { $0.path == "data/run/compiler.ts" })
        XCTAssertEqual(snapshot.files.first { $0.path == "gone.md" }?.status, .deleted)
        let unstaged = try GitWorkingTreeSource(repo: repo).load(scope: .unstaged)
        XCTAssertEqual(unstaged.files.first { $0.path == "moved/run/compiler.ts" }?.status, .renamed)
    }

    /// `GIT_RENAMES_REAL=<repository>`: the pairs and the cost on a real working tree, read only.
    func testARealRepositorysMovesAndTheirCost() throws {
        guard let path = ProcessInfo.processInfo.environment["GIT_RENAMES_REAL"] else { throw XCTSkip("GIT_RENAMES_REAL is not set") }
        let root = URL(fileURLWithPath: path)
        let raw = GitQueries.parseStatus(String(decoding: try provider.git(
            ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
            in: root, input: nil, gitDirectory: nil, environment: nil).stdout, as: UTF8.self)).entries
        let started = Date()
        let cpu = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
        let paired = GitWorktreeRenames.paired(raw, in: root, provider: provider)
        let renamed = paired.filter { $0.unstaged == .renamed }
        print("worktree renames: \(raw.filter { $0.unstaged == .deleted }.count) deleted, \(raw.filter { $0.unstaged == .untracked }.count) untracked"
              + " → \(renamed.count) renames in \(Int(Date().timeIntervalSince(started) * 1000)) ms wall, "
              + "\((clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) - cpu) / 1_000_000) ms thread CPU")
        for entry in renamed.prefix(3) { print("  \(entry.oldPath ?? "") → \(entry.path)") }
        XCTAssertEqual(paired.count, raw.count - renamed.count, "each rename replaces a deleted and an untracked entry")
    }

    func testAMovedFilesStateSaysWhereItCameFrom() throws {
        let repo = try movedFolderRepository()
        defer { try? FileManager.default.removeItem(at: repo) }
        let state = try XCTUnwrap(try provider.fileState(repo.appendingPathComponent("moved/run/compiler.ts")))
        XCTAssertEqual(state.entry?.unstaged, .renamed)
        XCTAssertEqual(state.summary, "Moved from data/run/compiler.ts")
        let edited = try XCTUnwrap(try provider.fileState(repo.appendingPathComponent("moved/run/notes.md")))
        XCTAssertEqual(edited.summary, "new file, not in git", "an edited copy is not an exact move")
    }

    func testOpeningTheMovedFileShowsItsOldSide() throws {
        let repo = try movedFolderRepository()
        defer { try? FileManager.default.removeItem(at: repo) }
        let moved = repo.appendingPathComponent("moved/run/compiler.ts")
        let text = try String(contentsOf: moved, encoding: .utf8)
        let sides = try GitFileDiffModel.sides(moved, text: text, scope: .unstaged, pick: nil, provider: provider,
                                               renamedFrom: "data/run/compiler.ts")
        XCTAssertEqual(sides.old, text, "the old side is the file at its old path")
        XCTAssertEqual(sides.emptyReason, "Moved from data/run/compiler.ts without changes.")
        let uncommitted = try GitFileDiffModel.sides(moved, text: text, scope: .uncommitted, pick: nil, provider: provider,
                                                     renamedFrom: "data/run/compiler.ts")
        XCTAssertEqual(uncommitted.old, text)
        XCTAssertEqual(GitFileDiffModel.diffFile(path: sides.path, old: "a\n", new: "b\n", oldPath: "data/run/compiler.ts").status, .renamed)
    }
}
