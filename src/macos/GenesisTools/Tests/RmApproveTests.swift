import LocalAuthentication
import XCTest
@testable import GenesisToolsHost

/// What the `tools rm` approval window (Sources/Host/RmApprove.swift) shows. With the request's rows: a title and a
/// purpose that name who asks, one row per item (name, folder, size, the reason in words), and the request id in the
/// footnote. Without rows (a settings change, an older CLI): who asked, the first lines, and the rest folded into
/// Details, so a long request never grows the window past the screen.
final class RmApproveTests: XCTestCase {
    private func request(_ items: [RmApproveItem], asker: RmApproveAsker? = RmApproveAsker(agent: "Claude Code", session: "shop-admin", project: "shop-web", branch: "develop"),
                         kind: String = "delete", grace: Int? = 60) -> RmApproveParams {
        RmApproveParams(
            title: "Delete 2 items for shop-admin?", lines: ["/x"], caller: "Claude Code · shop-admin", folder: "/elsewhere",
            request: RmApproveRequest(id: "abc234", kind: kind, why: "the old exports are replaced", cwd: "/Users/someone/Projects/shop-web",
                                      graceMinutes: grace, asker: asker, items: items))
    }

    func testRowsNameTheItemWhereItSitsItsSizeAndWhy() {
        let items = [
            RmApproveItem(path: "/Users/someone/Notes/Design/Dark 2", kind: "dir", bytes: 0, empty: true, storedAt: nil,
                          reason: "Outside this session's scratch, its own files and the trusted folders"),
            RmApproveItem(path: "/Users/someone/Notes/Design/Export.md", kind: "file", bytes: 12_400, empty: nil,
                          storedAt: "/tmp/cc/aside/Export.md", reason: "Holds 3 files git does not track in ~/Notes"),
            RmApproveItem(path: "/Users/someone/Notes/old.txt", kind: "missing", bytes: nil, empty: nil, storedAt: nil, reason: "Gone"),
        ]
        let content = RmWindowContent.build(request(items), home: "/Users/someone", icons: false, markdownApp: true)

        XCTAssertEqual(content.title, "Delete 2 items for shop-admin?")
        XCTAssertEqual(content.purpose, "Claude Code in shop-web (develop) wants to delete these. They go to the trash, and tools rm restore brings them back for 1 hour.")
        XCTAssertEqual(content.facts.map(\.label), ["Reason", "Folder"])
        XCTAssertEqual(content.facts.last?.value, "~/Projects/shop-web")
        XCTAssertEqual(content.footnote, "Request abc234. Every decision is written to the tools rm ledger.")
        XCTAssertTrue(content.details.isEmpty)

        XCTAssertEqual(content.items.map(\.name), ["Dark 2", "Export.md", "old.txt"])
        XCTAssertEqual(content.items.map(\.folder), ["~/Notes/Design", "~/Notes/Design", "~/Notes"])
        XCTAssertEqual(content.items.map(\.size), ["Empty folder", "12 kB", "Already gone"])
        XCTAssertEqual(content.items.map(\.gone), [false, false, true])
        XCTAssertEqual(content.items.map(\.reason).first, "Outside this session's scratch, its own files and the trusted folders")
        // An aside item opens where it waits; only a markdown file that is there offers Genesis Markdown.
        XCTAssertEqual(content.items[1].location, "/tmp/cc/aside/Export.md")
        XCTAssertTrue(content.items[1].aside)
        XCTAssertEqual(content.items.map(\.opensInMarkdown), [false, true, false])
        XCTAssertFalse(RmWindowContent.build(request(items), home: "/Users/someone", icons: false, markdownApp: false).items[1].opensInMarkdown)
    }

    func testSizesAndGraceAreWords() {
        func size(_ kind: String, _ bytes: Int64?, empty: Bool? = nil) -> String? {
            RmWindowContent.size(RmApproveItem(path: "/x", kind: kind, bytes: bytes, empty: empty, storedAt: nil, reason: ""))
        }
        XCTAssertEqual(size("dir", 0, empty: true), "Empty folder")
        XCTAssertEqual(size("file", 0), "Empty file")
        XCTAssertEqual(size("dir", 3_210_000_000), "3.21 GB")
        XCTAssertEqual(size("missing", 10), "Already gone")
        XCTAssertNil(size("file", nil))

        XCTAssertEqual(RmWindowContent.graceSentence(90), "They go to the trash, and tools rm restore brings them back for 90 minutes.")
        XCTAssertEqual(RmWindowContent.graceSentence(0), "They go to the trash, which is emptied right away.")
    }

    func testAPersonRunAndARootRequestSayWhatHappens() {
        let person = RmWindowContent.build(request([], asker: nil, grace: 120), icons: false, markdownApp: false)
        XCTAssertEqual(person.purpose, "No rule allows deleting these, so they need you. They go to the trash, and tools rm restore brings them back for 2 hours.")

        let root = RmWindowContent.build(request([], kind: "root", grace: nil), icons: false, markdownApp: false)
        XCTAssertEqual(root.purpose, "Claude Code in shop-web (develop) wants you to trust this folder. Agents may then delete anything inside it without asking.")
    }

    func testWithoutRowsItShowsTheCallerAndFoldsLongLists() {
        let lines = (1...9).map { "/tmp/item-\($0)" }
        let params = RmApproveParams(title: "Delete 9 paths?", lines: lines, caller: "codex · fix-build", folder: "/Users/someone/Projects/app")
        let content = RmWindowContent.build(params, home: "/Users/someone")

        XCTAssertEqual(content.facts.first?.label, "Asked by")
        XCTAssertEqual(content.facts.first?.value, "codex · fix-build")
        XCTAssertEqual(content.facts.filter(\.monospaced).map(\.value), Array(lines.prefix(6)))
        XCTAssertEqual(content.facts.last?.value, "3 more items in Details")
        XCTAssertEqual(content.details.map(\.value), Array(lines.suffix(3)))
        XCTAssertEqual(content.details.map(\.label), ["7", "8", "9"])
        XCTAssertEqual(Set(content.facts.map(\.id)).count, content.facts.count)
        XCTAssertTrue(content.items.isEmpty)
    }

    func testAPersonRunHasNoCallerAndNoDetails() {
        let params = RmApproveParams(title: "Set approval to code?", lines: ["approval = code"], caller: nil, folder: nil)
        let content = RmWindowContent.build(params)

        XCTAssertEqual(content.facts.map(\.value), ["approval = code"])
        XCTAssertTrue(content.details.isEmpty)
    }

    func testTheRequestDecodesFromTheCLIPayload() throws {
        let json = #"""
        {"title":"Delete 1 item for shop?","lines":["a"],"folder":"/w","request":{"id":"abc234","kind":"delete","why":null,
        "cwd":"/w","graceMinutes":60,"asker":{"agent":"Codex"},"items":[{"path":"/w/a","kind":"dir","bytes":0,"empty":true,
        "reason":"Outside"}]}}
        """#
        let params = try JSONDecoder().decode(RmApproveParams.self, from: Data(json.utf8))
        XCTAssertEqual(params.request?.items.first?.empty, true)
        XCTAssertEqual(params.request?.asker?.agent, "Codex")
        XCTAssertNil(params.request?.why)
        let old = try JSONDecoder().decode(RmApproveParams.self, from: Data(#"{"title":"t","lines":["a"]}"#.utf8))
        XCTAssertNil(old.request)
    }

    /// ❓ DECISION 183: a checkbox per row with the title following, a total line, the two ways out, the git state, a
    /// folder's contents, the other requests naming a path, when it was asked, and gone items last.
    func testTheRowsCarryTheirStateAndTheWindowOffersTheWaysOut() {
        let now = RmWindowContent.parseDate("2026-10-30T15:00:00Z")!
        let items = [
            RmApproveItem(path: "/Users/someone/Notes/old.txt", kind: "missing", bytes: nil, empty: nil, storedAt: nil, reason: "Gone"),
            RmApproveItem(path: "/Users/someone/Notes/Design/Dark 2", kind: "dir", bytes: 4096, empty: false, storedAt: nil,
                          reason: "Outside this session's scratch", git: RmApproveGit(state: "untracked", repo: "/Users/someone/Notes", lastCommit: nil),
                          folderStats: RmApproveFolderStats(files: 12, newestAt: "2026-10-30T13:00:00Z"), alsoIn: ["6xwa9r"]),
            RmApproveItem(path: "/Users/someone/Notes/Design/Export.md", kind: "file", bytes: 30_000, empty: nil, storedAt: nil,
                          reason: "Holds 3 files", git: RmApproveGit(state: "clean", repo: "/Users/someone/Notes", lastCommit: "a5fed04 2 days ago: exports")),
        ]
        var params = request(items)
        params.request?.askedAt = "2026-10-30T14:57:00Z"
        params.request?.asker?.sessionId = "2f320c19-ff19-4746-9b67-6cbab603080e"
        let content = RmWindowContent.build(params, home: "/Users/someone", icons: false, markdownApp: false, now: now)

        XCTAssertEqual(content.items.map(\.name), ["Dark 2", "Export.md", "old.txt"], "gone items last")
        XCTAssertEqual(content.items[0].git, ApprovalGitState(state: "untracked", lastCommit: nil))
        XCTAssertEqual(content.items[1].git?.lastCommit, "a5fed04 2 days ago: exports")
        XCTAssertEqual(content.items[0].detail, "12 files, newest 2 hours ago.")
        XCTAssertNil(content.items[1].detail, "a file has no folder detail")
        XCTAssertEqual(content.items[0].alsoIn, ["6xwa9r"])
        XCTAssertEqual(content.facts.map(\.label), ["Reason", "Folder", "Asked"])
        XCTAssertEqual(content.facts.last?.value.hasPrefix("3 minutes ago (2026-10-30 "), true, content.facts.last?.value ?? "")
        XCTAssertEqual(content.summary, "3 items, 34 kB, 1 already gone")
        XCTAssertTrue(content.selectable)
        XCTAssertEqual(content.disposals.map(\.id), ["trash", "permanent"])
        XCTAssertEqual(content.disposals.first?.detail, "deleted after 1 hour; tools rm restore brings it back until then")
        XCTAssertEqual(RmWindowContent.disposals(graceMinutes: 10).first?.detail, "deleted after 10 minutes; tools rm restore brings it back until then")

        XCTAssertEqual(RmWindowContent.title(selected: 3, total: 3, who: "shop-admin"), "Delete 3 items for shop-admin?")
        XCTAssertEqual(RmWindowContent.title(selected: 1, total: 3, who: "shop-admin"), "Delete 1 of 3 items for shop-admin?")
        XCTAssertEqual(RmWindowContent.title(selected: 1, total: 3, who: nil), "Delete 1 of 3 items?")
        XCTAssertEqual(RmWindowContent.ago(now.addingTimeInterval(-2), now: now), "just now")

        let noReason = RmWindowContent.build(RmApproveParams(
            title: "t", lines: [], caller: nil, folder: nil,
            request: RmApproveRequest(id: "x", kind: "delete", why: "  ", cwd: "/w", graceMinutes: 10, askedAt: nil,
                                      asker: RmApproveAsker(agent: "Codex"), items: [])), home: "/Users/someone", icons: false, markdownApp: false)
        XCTAssertEqual(noReason.facts.first?.value, "No reason given")
        XCTAssertTrue(noReason.facts.first?.dimmed ?? false)
        XCTAssertFalse(noReason.selectable, "one row or none has nothing to untick")

        let root = RmWindowContent.build(request([], kind: "root", grace: nil), icons: false, markdownApp: false)
        XCTAssertTrue(root.disposals.isEmpty)
        XCTAssertNil(root.summary)
    }

    @MainActor func testTheSelectionDrivesTheTitleAndPausesTheSensor() {
        let items = ["a", "b"].map {
            ApprovalItem(path: "/w/\($0)", name: $0, folder: "/w", size: nil, reason: "r", gone: false, isFolder: false)
        }
        let model = ApprovalDialogModel(title: "Delete 2 items for shop?", purpose: "p", symbol: "trash.fill", facts: [], details: [],
                                        warning: nil, footnote: "f", rememberChoices: [], rememberNote: nil, allowTitle: "a",
                                        deadline: nil, identifier: "rm-approve", items: items,
                                        disposals: RmWindowContent.disposals(graceMinutes: 10), selectable: true)
        model.titleForSelection = { selected, total in RmWindowContent.title(selected: selected, total: total, who: "shop") }
        XCTAssertEqual(model.displayTitle, "Delete 2 items for shop?")
        XCTAssertEqual(model.disposal, "trash")
        model.setSelected(items[0], false)
        XCTAssertEqual(model.displayTitle, "Delete 1 of 2 items for shop?")
        XCTAssertEqual(model.selectedItems.map(\.name), ["b"])
    }

    /// The CLI opens the window before it walks a tree: such a row says "Measuring…" and the total waits, until an
    /// `rm.item` line on stdin brings the size. EOF clears a row whose size never came.
    func testASizeMeasuredAfterTheWindowOpenedReplacesMeasuring() throws {
        let items = [
            RmApproveItem(path: "/w/cache", kind: "dir", bytes: nil, empty: nil, storedAt: nil, reason: "Holds a repository", measuring: true),
            RmApproveItem(path: "/w/out.bin", kind: "file", bytes: 2_000, empty: nil, storedAt: nil, reason: "Outside"),
        ]
        func build(_ params: RmApproveParams) -> RmWindowContent {
            RmWindowContent.build(params, home: "/Users/someone", icons: false, markdownApp: false)
        }
        var params = request(items)
        XCTAssertEqual(build(params).items.map(\.size), ["Measuring…", "2 kB"])
        XCTAssertEqual(build(params).summary, "2 items, measuring 1 size")

        let line = #"{"method":"rm.item","params":{"path":"/w/cache","bytes":3210000000,"empty":false,"folderStats":{"files":12},"measuring":false}}"#
        params = params.applying(try XCTUnwrap(RmApproveParams.update(fromLine: Data(line.utf8))))
        XCTAssertEqual(build(params).items.map(\.size), ["3.21 GB", "2 kB"])
        XCTAssertEqual(build(params).items.first?.detail, "12 files.")
        XCTAssertEqual(build(params).summary, "2 items, 3.21 GB")

        // Another method, and a path the request does not name, change nothing.
        XCTAssertNil(RmApproveParams.update(fromLine: Data(#"{"method":"rm.other","params":{"path":"/w/cache"}}"#.utf8)))
        XCTAssertEqual(params.applying(RmApproveItemUpdate(path: "/elsewhere", bytes: 1)).request?.items.map(\.bytes), [3_210_000_000, 2_000])

        let ended = request([items[0]]).endingUpdates()
        XCTAssertNil(build(ended).items.first?.size)
        XCTAssertEqual(build(ended).summary, "1 item")
    }

    /// A refresh replaces the rows and the total, and the ticks stay as the person left them.
    @MainActor func testARefreshKeepsTheTicks() {
        func rows(_ size: String?) -> [ApprovalItem] {
            ["a", "b"].map { ApprovalItem(path: "/w/\($0)", name: $0, folder: "/w", size: size, reason: "r", gone: false, isFolder: true) }
        }
        let model = ApprovalDialogModel(title: "t", purpose: "p", symbol: "trash.fill", facts: [], details: [], warning: nil, footnote: "f",
                                        rememberChoices: [], rememberNote: nil, allowTitle: "a", deadline: nil, identifier: "rm-approve",
                                        items: rows("Measuring…"), summary: "2 items, measuring 2 sizes", selectable: true)
        model.setSelected(model.items[0], false)
        model.refresh(items: rows("1 GB"), summary: "2 items, 2 GB")
        XCTAssertEqual(model.items.map(\.size), ["1 GB", "1 GB"])
        XCTAssertEqual(model.summary, "2 items, 2 GB")
        XCTAssertEqual(model.selectedItems.map(\.name), ["b"])
    }

    func testTheNewKeysDecodeAndOldPayloadsStillDo() throws {
        let json = #"""
        {"title":"t","lines":[],"request":{"id":"abc234","kind":"delete","cwd":"/w","graceMinutes":10,"askedAt":"2026-10-30T14:57:00Z",
        "asker":{"agent":"Claude Code","sessionId":"2f32","provider":"claude"},
        "items":[{"path":"/w/a","kind":"dir","bytes":4096,"reason":"Outside","git":{"state":"untracked"},
        "folderStats":{"files":12,"newestAt":"2026-10-30T13:00:00Z"},"alsoIn":["6xwa9r"]}]},
        "remember":[{"id":"once","title":"Just this once"},{"id":"folder","title":"Always for this folder"}]}
        """#
        let params = try JSONDecoder().decode(RmApproveParams.self, from: Data(json.utf8))
        XCTAssertEqual(params.request?.items.first?.git?.state, "untracked")
        XCTAssertEqual(params.request?.items.first?.folderStats?.files, 12)
        XCTAssertEqual(params.request?.items.first?.alsoIn, ["6xwa9r"])
        XCTAssertEqual(params.request?.asker?.sessionId, "2f32")
        XCTAssertEqual(params.remember?.map(\.id), ["once", "folder"])
    }

    /// A failed or cancelled touch lets the person try again; only Touch ID being out sends them to the password.
    func testAFailedTouchNeverDenies() {
        XCTAssertEqual(ApprovalVerifier.outcome(for: .authenticationFailed),
                       .retry("Touch ID did not recognize the finger. Try again, or use your password."))
        XCTAssertEqual(ApprovalVerifier.outcome(for: .userCancel), .retry("Touch ID stopped listening. Try again, or use your password."))
        XCTAssertEqual(ApprovalVerifier.outcome(for: .systemCancel), .retry("Touch ID stopped listening. Try again, or use your password."))
        XCTAssertEqual(ApprovalVerifier.outcome(for: .appCancel), .ignore)
        XCTAssertEqual(ApprovalVerifier.outcome(for: .userFallback), .password)
        XCTAssertEqual(ApprovalVerifier.outcome(for: .biometryLockout), .passwordOnly("Touch ID is locked after too many tries. Use your password."))
    }
}
