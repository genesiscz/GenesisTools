import XCTest
@testable import GenesisTools

/// The worktree cleanup panel and the Today mode decode `tools hub worktrees list|size|remove --json`
/// and `tools hub timeline --json` (src/hub/lib/worktrees.ts, src/hub/lib/timeline.ts). The samples
/// are real CLI output from a scratch repository (the timeline's strings replaced by invented ones,
/// every key, type and null kept), so a renamed or retyped field fails here, not in the hub.
final class HubWorktreeTimelineDecodeTests: XCTestCase {
    private let listJSON = """
    {
      "rows": [
        {
          "path": "/private/tmp/fable-wt/ignored",
          "repoRoot": "/private/tmp/fable-wt/main",
          "repo": "main",
          "branch": "ignored",
          "head": "a9bffbc4ac596b45eb41206acf5d90e2175f54e6",
          "present": true,
          "locked": null,
          "prunable": null,
          "verdict": "EMPTY",
          "how": "-",
          "verdictError": null,
          "statusError": null,
          "base": "main",
          "changedCount": 0,
          "changed": [],
          "untrackedCount": 0,
          "untracked": [],
          "ignored": [
            "node_modules"
          ],
          "stashes": [],
          "processes": [],
          "sessions": [],
          "sessionsError": null,
          "lastCommitAt": 1790286118000,
          "lastActivityAt": 1790286118790.9465,
          "removable": true,
          "blockers": []
        },
        {
          "path": "/private/tmp/fable-wt/detached",
          "repoRoot": "/private/tmp/fable-wt/main",
          "repo": "main",
          "branch": null,
          "head": "a9bffbc4ac596b45eb41206acf5d90e2175f54e6",
          "present": true,
          "locked": null,
          "prunable": null,
          "verdict": "EMPTY",
          "how": "-",
          "verdictError": null,
          "statusError": null,
          "base": "main",
          "changedCount": 0,
          "changed": [],
          "untrackedCount": 0,
          "untracked": [],
          "ignored": [],
          "stashes": [
            "stash@{0}"
          ],
          "processes": [],
          "sessions": [],
          "sessionsError": null,
          "lastCommitAt": 1790286118000,
          "lastActivityAt": 1790286118733.1418,
          "removable": false,
          "blockers": [
            {
              "kind": "stash",
              "text": "A stash names it: stash@{0}"
            }
          ]
        },
        {
          "path": "/private/tmp/fable-wt/dirty",
          "repoRoot": "/private/tmp/fable-wt/main",
          "repo": "main",
          "branch": "dirty",
          "head": "a9bffbc4ac596b45eb41206acf5d90e2175f54e6",
          "present": true,
          "locked": null,
          "prunable": null,
          "verdict": "EMPTY",
          "how": "-",
          "verdictError": null,
          "statusError": null,
          "base": "main",
          "changedCount": 1,
          "changed": [
            "a.txt"
          ],
          "untrackedCount": 1,
          "untracked": [
            "untracked.txt"
          ],
          "ignored": [],
          "stashes": [],
          "processes": [],
          "sessions": [],
          "sessionsError": null,
          "lastCommitAt": 1790286118000,
          "lastActivityAt": 1790286118677.9727,
          "removable": false,
          "blockers": [
            {
              "kind": "changed",
              "text": "1 uncommitted change: a.txt"
            },
            {
              "kind": "untracked",
              "text": "1 untracked entry: untracked.txt"
            }
          ]
        },
        {
          "path": "/private/tmp/fable-wt/unmerged",
          "repoRoot": "/private/tmp/fable-wt/main",
          "repo": "main",
          "branch": "unmerged",
          "head": "6693846c760f32b74865afc99ecb79f57acbf4cf",
          "present": true,
          "locked": null,
          "prunable": null,
          "verdict": "UNMERGED",
          "how": "none",
          "verdictError": null,
          "statusError": null,
          "base": "main",
          "changedCount": 0,
          "changed": [],
          "untrackedCount": 0,
          "untracked": [],
          "ignored": [],
          "stashes": [],
          "processes": [],
          "sessions": [],
          "sessionsError": null,
          "lastCommitAt": 1790286118000,
          "lastActivityAt": 1790286118648.255,
          "removable": false,
          "blockers": [
            {
              "kind": "unmerged",
              "text": "The branch is not merged into main"
            }
          ]
        },
        {
          "path": "/private/tmp/fable-wt/gone",
          "repoRoot": "/private/tmp/fable-wt/main",
          "repo": "main",
          "branch": "gone",
          "head": "a9bffbc4ac596b45eb41206acf5d90e2175f54e6",
          "present": false,
          "locked": null,
          "prunable": "gitdir file points to non-existent location",
          "verdict": "EMPTY",
          "how": "-",
          "verdictError": null,
          "statusError": null,
          "base": "main",
          "changedCount": 0,
          "changed": [],
          "untrackedCount": 0,
          "untracked": [],
          "ignored": [],
          "stashes": [],
          "processes": [],
          "sessions": [],
          "sessionsError": null,
          "lastCommitAt": 1790286118000,
          "lastActivityAt": 1790286118000,
          "removable": false,
          "blockers": [
            {
              "kind": "missing",
              "text": "The folder is gone; `git worktree prune` clears the entry"
            }
          ]
        }
      ],
      "bases": [
        {
          "repoRoot": "/private/tmp/fable-wt/main",
          "base": "main",
          "source": "inferred",
          "detail": "local main"
        }
      ],
      "warnings": [],
      "elapsedMs": 527
    }
    """

    private let sizeJSON = """
    [
      {
        "path": "/private/tmp/fable-wt/gone",
        "bytes": 0,
        "freeableBytes": null,
        "files": 0,
        "elapsedMs": 0,
        "error": "The folder does not exist"
      },
      {
        "path": "/private/tmp/fable-wt/detached",
        "bytes": 12288,
        "freeableBytes": 12288,
        "files": 3,
        "elapsedMs": 9
      }
    ]
    """

    private let removeJSON = """
    [
      {
        "path": "/private/tmp/fable-wt/gone",
        "removed": false,
        "reasons": [
          "The folder is gone; `git worktree prune` clears the entry"
        ],
        "branch": "gone"
      },
      {
        "path": "/private/tmp/fable-wt/main",
        "removed": false,
        "reasons": [
          "Not a linked worktree of a known repository (the main checkout is never removed)"
        ],
        "branch": null
      },
      {
        "path": "/private/tmp/fable-wt/detached",
        "removed": true,
        "reasons": [],
        "branch": null
      }
    ]
    """

    private let timelineJSON = """
    {
      "since": "2026-09-23T22:00:00.000Z",
      "until": "2026-09-24T21:43:16.484Z",
      "events": [
        {
          "project": "app",
          "repo": "/tmp/gt/app",
          "sessionId": "s-alpha",
          "provider": "claude",
          "branch": "feat/parser",
          "id": "turn:x0",
          "kind": "session.turn",
          "at": "2026-09-24T21:38:31.890Z",
          "title": "title 0",
          "detail": "detail 0"
        },
        {
          "project": "app",
          "repo": "/tmp/gt/app",
          "pr": {
            "ref": "acme/app#7",
            "number": 7,
            "url": "https://example.com/acme/app/pull/7"
          },
          "url": "https://example.com/acme/app/pull/7",
          "branch": "feat/parser",
          "author": "alice",
          "id": "pr-updated:x1",
          "kind": "pr",
          "at": "2026-09-24T21:37:36.000Z",
          "title": "title 1",
          "detail": "detail 1"
        },
        {
          "id": "push:x2",
          "kind": "push",
          "at": "2026-09-24T21:36:36.000Z",
          "title": "title 2",
          "detail": "detail 2",
          "project": "app",
          "repo": "/tmp/gt/app",
          "sha": "abababababababababababababababababababab",
          "branch": "feat/parser"
        },
        {
          "id": "commit:x3",
          "kind": "commit",
          "at": "2026-09-24T21:36:06.000Z",
          "title": "title 3",
          "detail": "detail 3",
          "project": "app",
          "repo": "/tmp/gt/app",
          "sha": "abababababababababababababababababababab",
          "author": "alice"
        },
        {
          "id": "thread:x4",
          "kind": "thread",
          "at": "2026-09-24T21:24:30.000Z",
          "title": "title 4",
          "detail": "detail 4",
          "project": "app",
          "repo": "/tmp/gt/app",
          "author": "alice",
          "pr": {
            "ref": "acme/app#7",
            "number": 7,
            "url": "https://example.com/acme/app/pull/7"
          },
          "url": "https://example.com/acme/app/pull/7",
          "branch": "feat/parser"
        },
        {
          "project": "app",
          "repo": "/tmp/gt/app",
          "sessionId": "s-alpha",
          "provider": "grok",
          "id": "start:x5",
          "kind": "session.start",
          "at": "2026-09-24T18:00:36.232Z",
          "title": "title 5",
          "detail": "detail 5"
        },
        {
          "project": null,
          "repo": null,
          "sessionId": "s-beta",
          "provider": "codex",
          "id": "turn:s-beta",
          "kind": "session.turn",
          "at": "2026-09-24T17:00:00.000Z",
          "title": "s-beta",
          "detail": null
        },
        {
          "id": "decision:d_1_s-alpha",
          "kind": "decision",
          "at": "2026-09-24T12:00:00.000Z",
          "title": "Keep the cache?",
          "detail": "#1 waiting",
          "project": "app",
          "repo": null,
          "sessionId": "s-alpha",
          "mine": true,
          "needsMe": true,
          "state": "open"
        },
        {
          "id": "ci:github.com/acme/app#7:2026-09-24T12:30:00.000Z",
          "kind": "ci",
          "at": "2026-09-24T12:30:00.000Z",
          "title": "Parser rewrite",
          "detail": "CI failed · acme/app#7",
          "project": "app",
          "repo": "/tmp/gt/app",
          "pr": { "ref": "acme/app#7", "number": 7, "url": "https://github.com/acme/app/pull/7" },
          "url": "https://github.com/acme/app/pull/7",
          "state": "failed",
          "mine": true,
          "needsMe": true
        }
      ],
      "repos": [
        "/tmp/gt/app"
      ],
      "counts": {
        "session.start": 18,
        "session.turn": 39,
        "commit": 219,
        "push": 142,
        "pr": 82,
        "thread": 300
      },
      "warnings": [],
      "elapsedMs": 2613,
      "cached": false
    }
    """

    func testCleanupReportDecodesEveryRowShape() throws {
        let report = try JSONDecoder().decode(CleanupReport.self, from: Data(listJSON.utf8))
        XCTAssertEqual(report.rows.count, 5)
        let byName = Dictionary(uniqueKeysWithValues: report.rows.map { ($0.name, $0) })
        XCTAssertEqual(byName["ignored"]?.removable, true)
        XCTAssertEqual(byName["ignored"]?.ignored, ["node_modules"])
        XCTAssertEqual(byName["ignored"]?.mergedHow, "no commits of its own")
        XCTAssertEqual(byName["detached"]?.branch, nil)
        XCTAssertTrue(byName["detached"]?.title.hasPrefix("detached ") == true)
        XCTAssertEqual(byName["unmerged"]?.mergedHow, "not merged")
        XCTAssertEqual(byName["gone"]?.blockers.map(\.kind), ["missing"])
        XCTAssertEqual(byName["dirty"]?.blockers.map(\.kind), ["changed", "untracked"])
        XCTAssertNotNil(byName["dirty"]?.lastActivity, "epoch ms with a fraction decodes as a date")
    }

    func testCleanupSizesAndOutcomesDecode() throws {
        let sizes = try JSONDecoder().decode([CleanupSize].self, from: Data(sizeJSON.utf8))
        XCTAssertEqual(sizes.first?.error, "The folder does not exist")
        XCTAssertNil(sizes.first?.freeableBytes)
        XCTAssertEqual(sizes.last?.bytes, 12288)
        let outcomes = try JSONDecoder().decode([CleanupOutcome].self, from: Data(removeJSON.utf8))
        XCTAssertEqual(outcomes.map(\.removed), [false, false, true])
        XCTAssertEqual(outcomes.first?.branch, "gone")
        XCTAssertNil(outcomes.last?.branch)
    }

    func testTimelineEnvelopeDecodesEveryKind() throws {
        let envelope = try JSONDecoder().decode(TimelineEnvelope.self, from: Data(timelineJSON.utf8))
        XCTAssertEqual(Set(envelope.events.map(\.kind)), Set(TimelineKind.allCases.map(\.rawValue)))
        XCTAssertTrue(envelope.events.allSatisfy { $0.date != nil }, "every at is an ISO time the hub reads")
        XCTAssertNotNil(HubFormat.date(envelope.since))
        let pr = envelope.events.first { $0.kind == "pr" }?.pr
        XCTAssertEqual(pr.flatMap { HubPRRef($0.ref) }, HubPRRef(project: "acme/app", number: 7))
        let outside = envelope.events.first { $0.sessionId == "s-beta" }
        XCTAssertNil(outside?.repo)
        XCTAssertNil(outside?.detail)
        XCTAssertEqual(outside?.timelineKind, .session)
    }
}
