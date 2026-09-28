import XCTest
@testable import GenesisTools

/// The hub's pure rules: pane order, request flags, the scratch settings of scripted runs, and the
/// proposal document the review window reads and writes back.
final class HubLogicTests: XCTestCase {
    override class func setUp() {
        super.setUp()
        HubDefaults.isolate()
    }

    override func setUp() {
        super.setUp()
        HubDefaults.store.removeObject(forKey: "hub.tabOrder")
        HubDefaults.store.removeObject(forKey: "hub.panes")
    }

    // MARK: Pane order

    func testDroppingAButtonOnAnotherSwapsTheTwoAndNothingElse() {
        let model = HubModel(wantedSession: nil, tab: .transcript)
        XCTAssertEqual(model.tabOrder, [.transcript, .changes, .files, .decisions])

        model.swapTabs(.transcript, .decisions)
        XCTAssertEqual(model.tabOrder, [.decisions, .changes, .files, .transcript])

        model.swapTabs(.changes, .changes)
        XCTAssertEqual(model.tabOrder, [.decisions, .changes, .files, .transcript], "a drop on itself changes nothing")
    }

    func testTheOrderIsSavedAndATabAddedLaterIsAppendedNotDropped() {
        HubDefaults.store.set(["decisions", "transcript"], forKey: "hub.tabOrder")
        let model = HubModel(wantedSession: nil, tab: .transcript)
        XCTAssertEqual(model.tabOrder, [.decisions, .transcript, .changes, .files])

        model.swapTabs(.changes, .decisions)
        XCTAssertEqual(HubDefaults.store.stringArray(forKey: "hub.tabOrder"), ["changes", "transcript", "decisions", "files"])
    }

    func testOpenPanesFollowTheButtonOrder() {
        let model = HubModel(wantedSession: nil, tab: .transcript)
        model.swapTabs(.transcript, .decisions)
        model.togglePane(.changes)
        model.togglePane(.decisions)
        XCTAssertEqual(model.panes, [.decisions, .changes, .transcript])
    }

    // MARK: Request flags

    func testScriptedRunsParseTheirFlags() {
        let request = HubRequest(["--snapshot", "/tmp/x.png", "--panes", "transcript,files,bogus", "--width", "1200",
                                  "--file", "src/a.ts", "--style", "unified", "--glass", "on", "--mode", "prs", "--pr", "!7457"])
        XCTAssertTrue(request.isScripted)
        XCTAssertEqual(request.panes, [.transcript, .files])
        XCTAssertEqual(request.width, 1200)
        XCTAssertEqual(request.file, "src/a.ts")
        XCTAssertEqual(request.style, .unified)
        XCTAssertEqual(request.glass, true)
        XCTAssertEqual(request.mode, .prs)
        XCTAssertEqual(request.pr, HubPRRef("!7457"))
        XCTAssertEqual(request.pr?.number, 7457)
    }

    func testAPRRefNamesItsProjectOnlyWhenGiven() {
        XCTAssertEqual(HubPRRef("42")?.number, 42)
        XCTAssertNil(HubPRRef("42")?.project)
        XCTAssertNil(HubPRRef("#42")?.project)
        XCTAssertEqual(HubPRRef("group/app#42")?.project, "group/app")
        XCTAssertEqual(HubPRRef("app!12")?.number, 12)
        XCTAssertEqual(HubPRRef("app!12")?.label, "app#12")
        XCTAssertNil(HubPRRef("app#x"))
        XCTAssertNil(HubPRRef("seven"))
    }

    /// The browser extension and pasted links hand the hub a page URL, often with a tab suffix.
    func testAPRRefReadsAPRorMRPageURL() {
        XCTAssertEqual(HubPRRef("https://github.com/acme/App/pull/424/files"), HubPRRef(project: "acme/App", number: 424))
        XCTAssertEqual(HubPRRef("https://gitlab.example/group/sub/app/-/merge_requests/12"), HubPRRef(project: "group/sub/app", number: 12))
        XCTAssertNil(HubPRRef("https://github.com/acme/app/issues/3"))
        XCTAssertNil(HubPRRef("https://github.com/acme/app"))
    }

    func testAPRRefMatchesItsProjectInAnyLetterCase() throws {
        let json = """
        {"repo":"GenesisTools","repoRoot":null,"origin":{"kind":"github","host":"github.com","web":"https://github.com/genesiscz/GenesisTools"},
         "number":424,"title":"t","state":"OPEN","draft":false,"author":"a","headBranch":"feat/x","baseBranch":"master",
         "url":"https://github.com/genesiscz/GenesisTools/pull/424","labels":[],"reviewers":[],"headSha":null,"crossRepository":false,"headRepo":null}
        """
        let pr = try JSONDecoder().decode(HubPR.self, from: Data(json.utf8))
        XCTAssertTrue(try XCTUnwrap(HubPRRef("genesiscz/genesistools#424")).matches(pr))
        XCTAssertTrue(try XCTUnwrap(HubPRRef("genesistools#424")).matches(pr))
        XCTAssertTrue(try XCTUnwrap(HubPRRef("https://github.com/GenesisCZ/GenesisTools/pull/424")).matches(pr))
        XCTAssertFalse(try XCTUnwrap(HubPRRef("genesiscz/other#424")).matches(pr))
    }

    func testRevealNamesAFileOnlyTogetherWithAPR() {
        let request = HubRequest(["--pr", "acme/app#7", "--reveal", "src/parse.ts"])
        XCTAssertEqual(request.prReveal, PRReveal(ref: HubPRRef(project: "acme/app", number: 7), path: "src/parse.ts", threadID: nil))
        XCTAssertNil(HubRequest(["--reveal", "src/parse.ts"]).prReveal)
    }

    func testALiveLaunchIsNotScripted() {
        let request = HubRequest(["--session", "abc", "--no-activate"])
        XCTAssertFalse(request.isScripted)
        XCTAssertNil(request.panes)
        XCTAssertFalse(request.activate)
    }

    // MARK: Scratch settings

    func testScriptedRunsWriteToTheScratchSuiteNeverTheStandardOne() {
        XCTAssertTrue(HubDefaults.isolated)
        XCTAssertFalse(HubDefaults.store === UserDefaults.standard)
        UserDefaults.standard.removeObject(forKey: "hub.panes")
        HubDefaults.store.set(["files"], forKey: "hub.panes")
        XCTAssertNil(UserDefaults.standard.stringArray(forKey: "hub.panes"), "a scripted write must not reach the live hub's settings")
    }

    // MARK: Proposal document

    private func proposalFile(_ object: [String: Any]) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("hub-proposal-\(UUID().uuidString).json")
        try JSONSerialization.data(withJSONObject: object).write(to: url)
        return url
    }

    private let files = [
        DiffFile(id: "f1", path: "src/a.ts", status: .modified, additions: 3, deletions: 1),
    ]

    private func sample() -> [String: Any] {
        [
            "version": 1, "provider": "gitlab", "host": "gitlab.example.com", "project": "group/app", "number": 42,
            "baseSha": "aaa", "headSha": "bbb", "author": ["agent": "claude"],
            "verdict": ["decision": "comment", "summary": "Two points."],
            "drafts": [[
                "id": "01", "path": "src/a.ts", "line": 12, "side": "additions", "severity": "nit",
                "body": "Rename it.", "status": "proposed", "meta": ["verdict": "Naming", "confidence": 80],
            ]],
            "threads": [
                [
                    "threadId": "t1", "path": "src/a.ts", "line": 3, "author": "reviewer", "body": "Why?",
                    "noteCount": 2, "resolved": true, "verdict": "valid", "confidence": 75,
                    "fix": "Do this:\n```ts\nx()\n```", "suggestedReply": "Opravím to.",
                ],
                ["threadId": "t2", "path": "src/gone.ts", "line": 5, "author": "reviewer", "body": "Elsewhere"],
                ["threadId": "t3", "author": "reviewer", "body": "A top-level note"],
            ],
        ]
    }

    func testThreadsLandOnTheirLinesWithTheAgentsReadAndSuggestedReply() throws {
        let document = try ProposalDocument(url: try proposalFile(sample()))
        let rendered = document.rendered(for: files)

        let thread = try XCTUnwrap(rendered.first { $0.id == "thread:t1" })
        XCTAssertEqual(thread.kind, "thread")
        XCTAssertTrue(thread.remote)
        XCTAssertEqual(thread.state, "resolved")
        XCTAssertEqual(thread.author, "@reviewer")
        XCTAssertEqual(thread.startLine, 3)
        XCTAssertEqual(thread.meta?.confidence, 75)
        XCTAssertEqual(thread.meta?.fix, "Do this:\n```ts\nx()\n```")
        XCTAssertEqual(thread.reply, "Opravím to.")

        XCTAssertNil(rendered.first { $0.id == "thread:t2" }, "a thread on a file outside the diff has no line to sit on")
        XCTAssertNil(rendered.first { $0.id == "thread:t3" }, "a top-level note has no line either")
        XCTAssertNotNil(rendered.first { $0.id == "draft:01" })
    }

    func testRewordingAReplyIsKeptAndSendingItRecordsWhereItWent() throws {
        let url = try proposalFile(sample())
        let document = try ProposalDocument(url: url)
        try document.update(threadID: "t1", editedReply: "Opravím to v dalším commitu.")
        try document.update(threadID: "t1", replyStatus: "drafted")

        let reread = try ProposalDocument(url: url)
        let thread = try XCTUnwrap(reread.threads.first { $0.id == "t1" })
        XCTAssertEqual(thread.reply, "Opravím to v dalším commitu.", "the rewording wins over the agent's text")
        XCTAssertEqual(thread.replyStatus, "drafted")
        XCTAssertEqual(reread.rendered(for: files).first { $0.id == "thread:t1" }?.replyStatus, "drafted")
    }

    func testADraftSentToThePRKeepsItsProviderID() throws {
        let url = try proposalFile(sample())
        try ProposalDocument(url: url).update(draftID: "01", status: "drafted", providerId: "note-9")
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let draft = try XCTUnwrap((raw["drafts"] as? [[String: Any]])?.first)
        XCTAssertEqual(draft["status"] as? String, "drafted")
        XCTAssertEqual(draft["providerId"] as? String, "note-9")
        XCTAssertEqual(raw["host"] as? String, "gitlab.example.com", "a write-back keeps every field it does not own")
    }

    func testPaletteMatchesProjectsByNamePrefixAndInitials() {
        XCTAssertEqual(HubPaletteEngine.initialsOf("GenesisTools"), "gt")
        XCTAssertEqual(HubPaletteEngine.initialsOf("acme-web"), "aw")
        XCTAssertEqual(HubPaletteEngine.initialsOf("ReviewUI2"), "ru2")
        XCTAssertNotNil(HubPaletteEngine.projectScore("gt", "GenesisTools"))
        XCTAssertGreaterThan(HubPaletteEngine.projectScore("genesistools", "GenesisTools")!, HubPaletteEngine.projectScore("gt", "GenesisTools")!)
        XCTAssertNil(HubPaletteEngine.projectScore("zq", "GenesisTools"))
    }

    func testPaletteParsesProjectKeywordAndId() {
        let context = HubPaletteContext(projects: [
            HubPaletteProject(name: "GenesisTools", path: "/tmp/fixture/GenesisTools"),
            HubPaletteProject(name: "GenesisDocs", path: "/tmp/fixture/GenesisDocs"),
            HubPaletteProject(name: "acme-web", path: "/tmp/fixture/acme-web"),
        ])
        let open = HubPaletteEngine.suggestions(for: "gt pr 424", context: context).first
        XCTAssertEqual(open?.action, .openPR(HubPRRef(project: "GenesisTools", number: 424)))
        let viaName = HubPaletteEngine.suggestions(for: "acme-web mr !12", context: context).first
        XCTAssertEqual(viaName?.action, .openPR(HubPRRef(project: "acme-web", number: 12)))

        // "genesis" names two projects equally well: the rows are those projects to pick, not a guess.
        let ambiguous = HubPaletteEngine.suggestions(for: "genesis pr 5", context: context)
        XCTAssertEqual(Set(ambiguous.map(\.title)), ["GenesisTools", "GenesisDocs"])
        XCTAssertTrue(ambiguous.allSatisfy { $0.action == nil && $0.completion?.hasSuffix("pr 5 ") == true })

        XCTAssertGreaterThanOrEqual(HubPaletteEngine.suggestions(for: "", context: context).count, 10)
        XCTAssertEqual(HubPaletteEngine.suggestions(for: "gt cursor", context: context).first?.action, .openCursor("/tmp/fixture/GenesisTools"))
        XCTAssertEqual(HubPaletteEngine.suggestions(for: "pane ch", context: context).first?.action, .togglePane(.changes))
        // "<project> grep" searches the project it names, not the one the hub has selected.
        XCTAssertEqual(HubPaletteEngine.suggestions(for: "acme-web grep needle", context: context).first?.action,
                       .findInFiles("needle", root: "/tmp/fixture/acme-web"))
        XCTAssertEqual(HubPaletteEngine.suggestions(for: "grep needle", context: context).first?.action, .findInFiles("needle", root: nil))

        // A project holds its own folder and what is inside it, never a sibling that shares a prefix.
        let app = HubPaletteProject(name: "app", path: "/tmp/fixture/app")
        XCTAssertTrue(app.contains("/tmp/fixture/app"))
        XCTAssertTrue(app.contains("/tmp/fixture/app/packages/api"))
        XCTAssertFalse(app.contains("/tmp/fixture/app-web"))
    }

    func testTurnLineCountsCountOnlyTheChangedLines() {
        let counts = GitWorkingTreeSource.lineCounts(old: "a\nb\nc\n", new: "a\nB\nc\nd\n")
        XCTAssertEqual(counts.additions, 2)
        XCTAssertEqual(counts.deletions, 1)
        let created = GitWorkingTreeSource.lineCounts(old: "", new: "x\ny")
        XCTAssertEqual(created.additions, 2)
    }

    func testFindTakesHitsUpToTheRoomLeftAndKeepsTheRest() {
        var buffer = Data("a.ts:1:one\nnot a hit\nb.ts:2:two\nc.ts:3:three\nd.ts:4:fo".utf8)
        let first = HubFindModel.drain(&buffer, room: 2)
        XCTAssertEqual(first.map(\.path), ["a.ts", "b.ts"], "the cap stops the parse, not a later flush")
        XCTAssertEqual(String(decoding: buffer, as: UTF8.self), "c.ts:3:three\nd.ts:4:fo")
        let rest = HubFindModel.drain(&buffer, room: 10)
        XCTAssertEqual(rest.map(\.line), [3])
        XCTAssertEqual(String(decoding: buffer, as: UTF8.self), "d.ts:4:fo", "a partial line waits for its newline")
    }

    func testTurnPathsMatchARepoOpenedThroughASymlinkAndKeepADeletedFile() throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("real-path-\(UUID().uuidString)")
        let repo = base.appendingPathComponent("repo")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: base) }
        let link = base.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: repo)

        let root = GitWorkingTreeSource.realPath(link.path) + "/"
        let deleted = GitWorkingTreeSource.realPath(repo.appendingPathComponent("gone/a.ts").path)
        XCTAssertTrue(deleted.hasPrefix(root), "\(deleted) under \(root)")
        XCTAssertTrue(deleted.hasSuffix("/repo/gone/a.ts"))
        XCTAssertEqual(GitWorkingTreeSource.realPath("/var"), "/private/var")
    }

    // MARK: Tool changes

    /// `tools agents changes --tool --json` names an unknown after-state instead of a deletion; the
    /// transcript row must show that reason, never a "+0 −N" drawn from the before blob alone.
    func testASkippedFileKeepsItsReasonAndDrawsNoDiff() async {
        let json = """
        {"files":[
          {"path":"/tmp/a.ts","beforeOid":"abc","afterOid":null,"status":"modified","skipped":"no-after-state","diff":null,"diffSkipped":"no-after-state"},
          {"path":"/tmp/b.ts","beforeOid":null,"afterOid":null,"status":"modified","skipped":null,"diff":"@@ -1 +1 @@\\n-a\\n+b","added":1,"removed":1}
        ]}
        """
        let files = CLIToolChangeSource.decode(json)
        XCTAssertEqual(files.map(\.skipReason), ["no-after-state", nil])
        XCTAssertEqual(files[0].skipLabel, "no diff: state after the call unknown")
        XCTAssertEqual(files[1].counts.additions, 1)
    }

    /// The same before blob draws a deletion when nothing says the after-state is unknown (the
    /// control), and nothing once the log says it was skipped.
    func testExpandedDiffDrawsNothingForASkippedFile() async throws {
        let objects = FileManager.default.temporaryDirectory.appendingPathComponent("gt-hub-objects-\(UUID().uuidString)").path
        func git(_ args: [String], input: String? = nil) throws -> String {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            process.arguments = args
            let stdout = Pipe()
            let stdin = Pipe()
            process.standardOutput = stdout
            process.standardInput = stdin
            try process.run()
            if let input { stdin.fileHandleForWriting.write(Data(input.utf8)) }
            try stdin.fileHandleForWriting.close()
            process.waitUntilExit()
            return String(decoding: stdout.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        _ = try git(["init", "--bare", "-q", objects])
        let oid = try git(["--git-dir", objects, "hash-object", "-w", "--stdin"], input: "one\ntwo\n")
        let source = CLIToolChangeSource(toolsBinary: "/nonexistent/tools", objectsDir: objects)
        var change = ToolFileChange(path: "/tmp/a.ts", status: "modified", unifiedDiff: nil, beforeBlob: oid, afterBlob: nil)
        let control = await source.expandedDiff(for: change, context: 3)
        XCTAssertEqual(control?.hasPrefix("@@ -1,"), true)
        change.skipReason = "no-after-state"
        let skipped = await source.expandedDiff(for: change, context: 3)
        XCTAssertNil(skipped)
    }

    /// A failed lookup is not cached, and the run gets ToolsBridge's scrubbed PATH (a GUI app's own
    /// PATH has no bun, so `#!/usr/bin/env bun` failed).
    func testAFailedChangeLookupIsAskedAgainWithTheScrubbedPath() async throws {
        // A stand-in `tools`: fails on its first run, then prints one file whose path is its PATH.
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("tool-changes-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let script = dir.appendingPathComponent("tools")
        try """
        #!/bin/sh
        if [ -f "$0.ran" ]; then printf '{"files":[{"path":"%s","diff":"@@ -1 +1 @@"}]}' "$PATH"; else touch "$0.ran"; exit 1; fi
        """.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)

        let source = CLIToolChangeSource(toolsBinary: script.path, objectsDir: dir.path)
        let first = await source.changes(sessionId: "s", toolUseId: "t")
        XCTAssertTrue(first.isEmpty)
        let second = await source.changes(sessionId: "s", toolUseId: "t")
        XCTAssertEqual(second.count, 1, "the failed run was not cached")
        XCTAssertTrue(second.first?.path.contains("/.bun/bin") == true, "the run gets ToolsBridge's scrubbed PATH")
    }

    // MARK: Session Details rendering and usage

    /// A section ends at the next section's first turn; a turn the scan never indexed is not the end
    /// of the file (that summed every later section's calls into this one).
    func testNativeUsageStopsOnlyAtATurnInTheFile() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("native-usage-\(UUID().uuidString).jsonl")
        try """
        {"type":"user","uuid":"u1","message":{"role":"user","content":"hi"}}
        {"type":"assistant","uuid":"a1","message":{"id":"m1","model":"claude-opus-5-5","content":[],"usage":{"input_tokens":1,"output_tokens":2}}}
        {"type":"assistant","uuid":"a2","message":{"id":"m2","model":"claude-opus-5-5","content":[],"usage":{"input_tokens":1,"output_tokens":2}}}
        """.write(to: file, atomically: true, encoding: .utf8)
        let summary = try XCTUnwrap(SessionNativeLog.scan(path: file.path)).summary

        XCTAssertEqual(summary.usage(fromTurn: "a1", untilTurn: nil)?.modelCalls, 2, "nil runs to the end of the file")
        XCTAssertEqual(summary.usage(fromTurn: "a1", untilTurn: "a2")?.modelCalls, 1)
        XCTAssertNil(summary.usage(fromTurn: "a1", untilTurn: "not-in-the-file"), "an unknown end is not the end of the file")
    }

    /// A JSONL writer that puts spaces around the colon still gets its turns read (Claude Code
    /// writes minified lines; the prefilter used to require that spelling).
    func testNativeLogReadsLinesWithSpacesAroundTheColon() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("native-spaced-\(UUID().uuidString).jsonl")
        try """
        {"type": "user", "uuid": "u1", "message": {"role": "user", "content": "hi"}}
        {"type" : "assistant", "uuid": "a1", "message": {"id": "m1", "model": "claude-opus-5-5", "content": [], "usage": {"input_tokens": 1, "output_tokens": 2}}}
        """.write(to: file, atomically: true, encoding: .utf8)
        let summary = try XCTUnwrap(SessionNativeLog.scan(path: file.path)).summary
        XCTAssertEqual(summary.total.modelCalls, 1)
        XCTAssertEqual(summary.model(forTurn: "a1"), "opus")
        XCTAssertEqual(summary.usage(fromTurn: "u1", untilTurn: nil)?.outputTokens, 2)
    }

    /// A search hit in a reply keeps its section's prompt as context; a section with no hit goes.
    func testASearchKeepsThePromptOfEachHit() throws {
        let json = """
        [{"id":"u1","role":"user","text":"fix the export","tools":[],"index":0},
         {"id":"a1","role":"assistant","text":"PrintButton was the cause","tools":[],"index":1},
         {"id":"u2","role":"user","text":"thanks","tools":[],"index":2},
         {"id":"a2","role":"assistant","text":"you are welcome","tools":[],"index":3}]
        """
        let document = TranscriptDocument.build(try JSONDecoder().decode([TranscriptTurn].self, from: Data(json.utf8)))
        let hits = document.filtered([], query: "printbutton")
        XCTAssertEqual(hits.flatMap(\.rows).map(\.id), ["p-u1", "a-a1"])
    }

    /// The plain draw on the main thread gives text to the first lines only, with the full height.
    func testFirstDrawGivesTextToTheFirstLinesAndKeepsTheHeight() {
        let block = CodeBlockBuilder.numbered((1...500).map { "line \($0)" }.joined(separator: "\n"), language: .plain)
        let full = CodeBlockRenderer.attributed(block, limit: nil, highlight: false)
        let first = CodeBlockRenderer.attributed(block, limit: nil, highlight: false, drawn: 200)
        func lines(_ text: AttributedString) -> [String] {
            String(text.characters).split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        }

        XCTAssertEqual(lines(first.body).count, 500, "the block keeps its full height")
        XCTAssertEqual(Array(lines(first.body).prefix(200)), Array(lines(full.body).prefix(200)))
        XCTAssertEqual(lines(first.body)[200], "")
        XCTAssertEqual(lines(first.gutter).first, "  1", "the gutter is as wide as the last number")
        XCTAssertEqual(lines(first.gutter).count, 500)
        XCTAssertEqual(
            lines(CodeBlockRenderer.attributed(block, limit: 10, highlight: false, drawn: 200).body).count, 10,
            "a limit below the first draw draws every shown line"
        )
    }

    /// The code block's cache key comes from this fingerprint, hashed once when the block is made.
    func testTheFingerprintFollowsTheContent() {
        let block = CodeBlockBuilder.numbered("a\nb", language: .plain)
        XCTAssertEqual(block.fingerprint, CodeBlockBuilder.numbered("a\nb", language: .plain).fingerprint)
        XCTAssertNotEqual(block.fingerprint, CodeBlockBuilder.numbered("a\nc", language: .plain).fingerprint, "same line count, new text")
        XCTAssertNotEqual(block.fingerprint, CodeBlockBuilder.numbered("a\nb", language: .swift).fingerprint)
        XCTAssertNotEqual(block.fingerprint, CodeBlockBuilder.numbered("a\nb", language: .plain, failed: true).fingerprint)
    }

    /// VoiceOver hears a diff's marks: the gutter that shows them is hidden from it.
    func testDiffSpeaksItsMarks() {
        let diff = CodeBlockBuilder.unifiedDiff("@@ -3,2 +3,2 @@\n keep\n-old\n+new", language: .plain)
        XCTAssertEqual(CodeBlockRenderer.attributed(diff, limit: nil, highlight: false).spoken, "keep\nremoved: old\nadded: new")

        let plain = CodeBlockBuilder.numbered("a\nb", language: .plain)
        XCTAssertNil(CodeBlockRenderer.attributed(plain, limit: nil, highlight: false).spoken, "a block that is not a diff reads its text")
    }

    // MARK: Tool-change batches

    /// Records what the batcher sends, and answers each call with one file named after it.
    private actor FetchLog {
        var batches: [[String]] = []
        var fail = false
        /// Calls left out of the answer, as cut or unreadable output leaves them out.
        var omit: Set<String> = []

        func record(_ ids: [String]) -> [String: [ToolFileChange]]? {
            batches.append(ids)
            if fail { return nil }
            return Dictionary(uniqueKeysWithValues: ids.filter { !omit.contains($0) }.map { ($0, [ToolFileChange(path: "/tmp/\($0).ts", status: "modified", unifiedDiff: "@@ -1 +1 @@", beforeBlob: nil, afterBlob: nil)]) })
        }

        func setFail(_ value: Bool) { fail = value }
        func setOmit(_ value: Set<String>) { omit = value }
    }

    func testRowsThatAskTogetherShareOneRunAndAnAnswerIsKept() async {
        let log = FetchLog()
        let batcher = ToolChangeBatcher { _, ids in await log.record(ids) }
        let answers = await withTaskGroup(of: (String, [ToolFileChange]).self) { group in
            for id in ["a", "b", "c", "d", "e"] {
                group.addTask { (id, await batcher.request(sessionId: "s1", toolUseId: id)) }
            }
            var all: [String: [ToolFileChange]] = [:]
            for await (id, files) in group { all[id] = files }
            return all
        }
        XCTAssertEqual(answers["c"]?.first?.path, "/tmp/c.ts")
        let batches = await log.batches
        XCTAssertEqual(batches.count, 1)
        XCTAssertEqual(Set(batches[0]), ["a", "b", "c", "d", "e"])

        _ = await batcher.request(sessionId: "s1", toolUseId: "c")
        let after = await log.batches
        XCTAssertEqual(after.count, 1, "a kept answer starts no run")
    }

    func testARowThatLeavesBeforeItsBatchIsNotSent() async {
        let log = FetchLog()
        let batcher = ToolChangeBatcher { _, ids in await log.record(ids) }
        let gone = Task { await batcher.request(sessionId: "s1", toolUseId: "gone") }
        let stays = Task { await batcher.request(sessionId: "s1", toolUseId: "stays") }
        try? await Task.sleep(for: .milliseconds(20))
        gone.cancel()
        let goneFiles = await gone.value
        let staysFiles = await stays.value
        XCTAssertEqual(goneFiles.count, 0)
        XCTAssertEqual(staysFiles.count, 1)
        let batches = await log.batches
        XCTAssertEqual(batches, [["stays"]])
    }

    func testAFailedRunIsNotKeptSoTheRowAsksAgain() async {
        let log = FetchLog()
        await log.setFail(true)
        let batcher = ToolChangeBatcher { _, ids in await log.record(ids) }
        let first = await batcher.request(sessionId: "s1", toolUseId: "a")
        XCTAssertEqual(first.count, 0)
        await log.setFail(false)
        let second = await batcher.request(sessionId: "s1", toolUseId: "a")
        XCTAssertEqual(second.count, 1)
        let batches = await log.batches
        XCTAssertEqual(batches.count, 2)
    }

    func testACallMissingFromTheAnswerIsNotKeptSoTheRowAsksAgain() async {
        let log = FetchLog()
        await log.setOmit(["a"])
        let batcher = ToolChangeBatcher { _, ids in await log.record(ids) }
        let first = await batcher.request(sessionId: "s1", toolUseId: "a")
        XCTAssertEqual(first.count, 0)
        await log.setOmit([])
        let second = await batcher.request(sessionId: "s1", toolUseId: "a")
        XCTAssertEqual(second.count, 1)
        let batches = await log.batches
        XCTAssertEqual(batches.count, 2)
    }

    func testTheBatchOutputDecodesPerToolCall() {
        let json = """
        {"session":"s1","tools":[
          {"toolUseId":"t1","files":[{"path":"/tmp/a.ts","beforeOid":"x","afterOid":"y","status":"modified","diff":"@@ -1 +1 @@\\n-a\\n+b"}],"excluded":[]},
          {"toolUseId":"t2","files":[],"excluded":[]}
        ]}
        """
        let decoded = HubToolChangeSource.decode(json)
        XCTAssertEqual(decoded["t1"]?.map(\.path), ["/tmp/a.ts"])
        XCTAssertEqual(decoded["t1"]?.first?.counts.additions, 1)
        XCTAssertEqual(decoded["t2"]?.count, 0)
    }

}
