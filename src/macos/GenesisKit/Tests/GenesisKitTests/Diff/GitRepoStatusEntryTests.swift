import XCTest
@testable import GenesisKit

/// A file mark asks `entry(for:)` on every render, so a path spelled under the root skips `realpath`; any other
/// spelling of the same file still finds its entry through the real path.
final class GitRepoStatusEntryTests: XCTestCase {
    func testAnEntryIsFoundByTheRootsSpellingAndByAnotherSpellingOfTheSamePath() {
        let status = GitRepoStatus(root: URL(fileURLWithPath: "/private/tmp/vault"), branch: "main",
                                   entries: [GitStatusEntry(path: "notes/a.md", unstaged: .modified)])
        XCTAssertEqual(status.entry(for: URL(fileURLWithPath: "/private/tmp/vault/notes/a.md"))?.unstaged, .modified)
        XCTAssertEqual(status.entry(for: URL(fileURLWithPath: "/tmp/vault/notes/a.md"))?.unstaged, .modified,
                       "/tmp is a link to /private/tmp: the real-path fallback still applies")
        XCTAssertNil(status.entry(for: URL(fileURLWithPath: "/private/tmp/vault/notes/clean.md")))
        XCTAssertNil(status.entry(for: URL(fileURLWithPath: "/private/tmp/vaulted/notes/a.md")), "a sibling folder is outside")
    }
}
