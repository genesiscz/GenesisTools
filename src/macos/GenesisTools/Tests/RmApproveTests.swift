import GenesisKit
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
            title: "Delete 2 items asked by session shop-admin?", lines: ["/x"], caller: "Claude Code · shop-admin", folder: "/elsewhere",
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

        XCTAssertEqual(content.title, "Delete 2 items asked by session shop-admin?")
        XCTAssertEqual(content.purpose, "Claude Code in shop-web (develop) wants to delete these. They go to the trash, and tools rm restore brings them back for 1 hour.")
        XCTAssertEqual(content.facts.map(\.label), ["Reason", "Asked from"])
        XCTAssertEqual(content.facts.last?.value, "~/Projects/shop-web")
        XCTAssertEqual(content.footnote, "Request abc234. Every decision is written to the tools rm ledger.")
        XCTAssertTrue(content.details.isEmpty)

        XCTAssertEqual(content.items.map(\.name), ["Dark 2", "Export.md", "old.txt"])
        XCTAssertEqual(content.items.map(\.folder), ["~/Notes/Design", "~/Notes/Design", "~/Notes"])
        XCTAssertEqual(content.items.map(\.size), [ByteFormat.file(0), "12 kB", "Already gone"])
        XCTAssertEqual(content.items.first?.notes.map(\.word), ["empty folder"])
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
        XCTAssertEqual(size("dir", 0, empty: true), ByteFormat.file(0))
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
        XCTAssertEqual(content.facts.map(\.label), ["Reason", "Asked from", "Asked"])
        XCTAssertEqual(content.facts.last?.value.hasPrefix("3 minutes ago (2026-10-30 "), true, content.facts.last?.value ?? "")
        XCTAssertEqual(content.summary, "3 items, 34 kB, 1 already gone")
        XCTAssertTrue(content.selectable)
        XCTAssertEqual(content.disposals.map(\.id), ["trash", "permanent"])
        XCTAssertEqual(content.disposals.first?.detail, "deleted after 1 hour; tools rm restore brings it back until then")
        XCTAssertEqual(RmWindowContent.disposals(graceMinutes: 10).first?.detail, "deleted after 10 minutes; tools rm restore brings it back until then")

        XCTAssertEqual(RmWindowContent.title(selected: 3, total: 3, who: "session shop-admin"), "Delete 3 items asked by session shop-admin?")
        XCTAssertEqual(RmWindowContent.title(selected: 1, total: 3, who: "session shop-admin"), "Delete 1 of 3 items asked by session shop-admin?")
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
        let model = ApprovalDialogModel(title: "Delete 2 items asked by session shop?", purpose: "p", symbol: "trash.fill", facts: [], details: [],
                                        warning: nil, footnote: "f", rememberChoices: [], rememberNote: nil, allowTitle: "a",
                                        deadline: nil, identifier: "rm-approve", items: items,
                                        disposals: RmWindowContent.disposals(graceMinutes: 10), selectable: true)
        model.titleForSelection = { selected, total in RmWindowContent.title(selected: selected, total: total, who: "session shop") }
        XCTAssertEqual(model.displayTitle, "Delete 2 items asked by session shop?")
        XCTAssertEqual(model.disposal, "trash")
        model.setSelected(items[0], false)
        XCTAssertEqual(model.displayTitle, "Delete 1 of 2 items asked by session shop?")
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
        XCTAssertEqual(build(ended).summary, "1 item, 1 size unknown")
    }

    /// A row whose size never came (the walk failed, or the CLI closed stdin first) must not let the known sizes read
    /// as the whole total.
    func testAnUnknownSizeKeepsTheTotalFromReadingAsComplete() {
        let items = [
            RmApproveItem(path: "/w/cache", kind: "dir", bytes: nil, empty: nil, storedAt: nil, reason: "Holds a repository", measuring: false),
            RmApproveItem(path: "/w/out.bin", kind: "file", bytes: 2_000, empty: nil, storedAt: nil, reason: "Outside"),
            RmApproveItem(path: "/w/empty", kind: "dir", bytes: nil, empty: true, storedAt: nil, reason: "Outside"),
        ]
        XCTAssertEqual(RmWindowContent.summary(items), "3 items, at least 2 kB, 1 size unknown")
        XCTAssertEqual(RmWindowContent.summary(Array(items.dropFirst())), "2 items, 2 kB")
    }

    /// Each size that arrives rebuilds the rows; the icons come from the window's cache, read once per path.
    func testARebuildReadsEachIconOnce() throws {
        let items = [
            RmApproveItem(path: "/w/cache", kind: "dir", bytes: nil, empty: nil, storedAt: nil, reason: "r", measuring: true),
            RmApproveItem(path: "/w/out.bin", kind: "file", bytes: 2_000, empty: nil, storedAt: nil, reason: "r"),
            RmApproveItem(path: "/w/old.txt", kind: "missing", bytes: nil, empty: nil, storedAt: nil, reason: "r"),
        ]
        let cache = RmIconCache()
        var params = request(items)
        let first = RmWindowContent.build(params, home: "/Users/someone", markdownApp: false, iconCache: cache)
        params = params.applying(RmApproveItemUpdate(path: "/w/cache", bytes: 4_096, measuring: false))
        let second = RmWindowContent.build(params, home: "/Users/someone", markdownApp: false, iconCache: cache)

        XCTAssertEqual(cache.loads, 3)
        XCTAssertEqual(second.items.map(\.size), ["4 kB", "2 kB", "Already gone"])
        let before = try XCTUnwrap(first.items.first?.icon)
        XCTAssertTrue(second.items.first?.icon === before)
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

    /// A row's folder reads from the asking session's folder ("./", "./Design/Admin"); outside it the `~` path stays,
    /// and a sibling whose name starts like the folder is outside too.
    func testARowsFolderReadsFromTheAskingSessionsFolder() {
        let cwd = "/Users/someone/Projects/shop-web"
        let items = [
            RmApproveItem(path: "\(cwd)/notes.txt", kind: "file", bytes: 10, empty: nil, storedAt: nil, reason: "r"),
            RmApproveItem(path: "\(cwd)/Design/Admin/Dark 2", kind: "dir", bytes: 10, empty: false, storedAt: nil, reason: "r"),
            RmApproveItem(path: "/Users/someone/Notes/old.txt", kind: "file", bytes: 10, empty: nil, storedAt: nil, reason: "r"),
            RmApproveItem(path: "/Users/someone/Projects/shop-web-2/a.txt", kind: "file", bytes: 10, empty: nil, storedAt: nil, reason: "r"),
        ]
        let content = RmWindowContent.build(request(items), home: "/Users/someone", icons: false, markdownApp: false)

        XCTAssertEqual(content.items.map(\.folder), ["./", "./Design/Admin", "~/Notes", "~/Projects/shop-web-2"])
        XCTAssertEqual(content.items[1].path, "\(cwd)/Design/Admin/Dark 2", "the tooltip keeps the full path")
        XCTAssertEqual(RmWindowContent.folderLabel("\(cwd)/Design", cwd: "\(cwd)/", home: "/Users/someone"), "./Design")
        XCTAssertEqual(RmWindowContent.folderLabel("/Users/someone/Design", cwd: nil, home: "/Users/someone"), "~/Design")
    }

    /// A name that repeats its folder's (`ReservineBack/ReservineBack`) or the repository's gets an orange chip; the
    /// repository's own folder and the folder the session works in do not.
    func testANameLikeItsFolderOrTheRepositoryGetsAWarningChip() {
        let cwd = "/Users/someone/Projects/shop-web"
        let items = [
            RmApproveItem(path: "\(cwd)/Design/design", kind: "dir", bytes: 4096, empty: false, storedAt: nil, reason: "r"),
            RmApproveItem(path: "\(cwd)/apps/shop-web", kind: "dir", bytes: 4096, empty: false, storedAt: nil, reason: "r"),
            RmApproveItem(path: "/Users/someone/Notes/archive/Notes", kind: "dir", bytes: 4096, empty: false, storedAt: nil, reason: "r",
                          git: RmApproveGit(state: "untracked", repo: "/Users/someone/Notes")),
            RmApproveItem(path: "/Users/someone/Notes", kind: "dir", bytes: 4096, empty: false, storedAt: nil, reason: "r",
                          git: RmApproveGit(state: "clean", repo: "/Users/someone/Notes")),
            RmApproveItem(path: cwd, kind: "dir", bytes: 4096, empty: false, storedAt: nil, reason: "r"),
            RmApproveItem(path: "\(cwd)/Design/old", kind: "dir", bytes: 4096, empty: false, storedAt: nil, reason: "r"),
            RmApproveItem(path: "\(cwd)/old/old", kind: "missing", bytes: nil, empty: nil, storedAt: nil, reason: "r"),
        ]
        let content = RmWindowContent.build(request(items), home: "/Users/someone", icons: false, markdownApp: false)

        XCTAssertEqual(content.items.map { $0.notes.map(\.word) }, [
            ["same name as its folder"], ["same name as the repository"], ["same name as the repository"], [], [], [], [],
        ])
        let chip = content.items.first?.notes.first
        XCTAssertEqual(chip?.tone, .warning)
        XCTAssertEqual(chip?.help.contains("stray copy left by a wrong cd or a doubled path"), true)
    }

    /// A folder with nothing inside gets a grey "empty folder" chip, whether the CLI says `empty` or counts 0 files; the
    /// reason line then does not say it again.
    func testAnEmptyFolderGetsAChip() {
        let items = [
            RmApproveItem(path: "/w/a", kind: "dir", bytes: 0, empty: true, storedAt: nil, reason: "r"),
            RmApproveItem(path: "/w/b", kind: "dir", bytes: 4096, empty: nil, storedAt: nil, reason: "r", folderStats: RmApproveFolderStats(files: 0)),
            RmApproveItem(path: "/w/c", kind: "dir", bytes: 4096, empty: false, storedAt: nil, reason: "r", folderStats: RmApproveFolderStats(files: 12)),
            RmApproveItem(path: "/w/d.txt", kind: "file", bytes: 0, empty: nil, storedAt: nil, reason: "r"),
        ]
        let content = RmWindowContent.build(request(items), home: "/Users/someone", icons: false, markdownApp: false)

        XCTAssertEqual(content.items.map { $0.notes.map(\.word) }, [["empty folder"], ["empty folder"], [], []])
        XCTAssertEqual(content.items[0].notes.first?.tone, .quiet)
        XCTAssertEqual(content.items[1].reasonLine, "r.")
    }

    /// The folder the request came from is labelled "Asked from", with rows and without.
    func testTheRequestsFolderIsLabelledAskedFrom() {
        let rows = RmWindowContent.build(request([]), home: "/Users/someone", icons: false, markdownApp: false)
        XCTAssertEqual(rows.facts.map(\.label), ["Reason", "Asked from"])
        XCTAssertEqual(rows.facts.last?.value, "~/Projects/shop-web")

        let lines = RmWindowContent.build(RmApproveParams(title: "t", lines: ["/w/a"], caller: "codex · fix-build", folder: "/Users/someone/w"),
                                          home: "/Users/someone")
        XCTAssertEqual(lines.facts.map(\.label), ["Asked by", "Asked from", "1"])
        XCTAssertEqual(lines.facts[1].value, "~/w")
    }

    /// The title says who asked: "asked by session <name>", else "<agent> in <project>", else the agent.
    func testTheTitleSaysWhichSessionAsked() {
        XCTAssertEqual(RmWindowContent.askedBy(RmApproveAsker(agent: "Claude Code", session: "shop-admin", project: "shop-web")), "session shop-admin")
        XCTAssertEqual(RmWindowContent.askedBy(RmApproveAsker(agent: "Codex", session: "", project: "shop-web")), "Codex in shop-web")
        XCTAssertEqual(RmWindowContent.askedBy(RmApproveAsker(agent: "Codex")), "Codex")

        let who = RmWindowContent.askedBy(RmApproveAsker(agent: "Claude Code", session: "shop-admin"))
        XCTAssertEqual(RmWindowContent.title(selected: 3, total: 5, who: who), "Delete 3 of 5 items asked by session shop-admin?")
        XCTAssertEqual(RmWindowContent.title(selected: 5, total: 5, who: who), "Delete 5 items asked by session shop-admin?")
        XCTAssertEqual(RmWindowContent.title(selected: 1, total: 2, who: "Codex in shop-web"), "Delete 1 of 2 items asked by Codex in shop-web?")
    }

    /// Grey when nothing can be lost, red when the work may exist only here, amber when no rule allowed it. The CLI's
    /// `rule` decodes when sent and is absent from an older CLI.
    func testTheRiskChipFollowsGitAndTheRule() throws {
        func level(_ kind: String, bytes: Int64? = 100, empty: Bool? = nil, git: String? = nil, rule: String? = nil,
                   files: Int? = nil) -> ApprovalRisk.Level {
            RmWindowContent.risk(RmApproveItem(path: "/w/x", kind: kind, bytes: bytes, empty: empty, storedAt: nil, reason: "r", rule: rule,
                                               git: git.map { RmApproveGit(state: $0) }, folderStats: files.map { RmApproveFolderStats(files: $0) })).level
        }
        XCTAssertEqual(level("missing", git: "untracked"), .low)
        XCTAssertEqual(level("dir", empty: true), .low)
        XCTAssertEqual(level("dir", files: 0), .low)
        XCTAssertEqual(level("file", bytes: 0), .low)
        XCTAssertEqual(level("file", git: "ignored"), .low)
        XCTAssertEqual(level("file", git: "clean"), .low)
        XCTAssertEqual(level("file", git: "untracked"), .unsaved)
        XCTAssertEqual(level("file", git: "modified"), .unsaved)
        for rule in ["git-history", "unsaved-clone", "git-untracked", "nested-repos"] {
            XCTAssertEqual(level("dir", git: "clean", rule: rule), .unsaved, rule)
        }
        XCTAssertEqual(level("dir", rule: "default"), .review)
        XCTAssertEqual(level("file"), .review)
        XCTAssertEqual(level("file", git: "none"), .review)

        XCTAssertEqual(ApprovalRisk(.low, why: "w").chip, ApprovalChip("low risk", help: "w", tone: .quiet))
        XCTAssertEqual(ApprovalRisk(.review, why: "w").chip, ApprovalChip("review", help: "w", tone: .caution))
        XCTAssertEqual(ApprovalRisk(.unsaved, why: "w").chip, ApprovalChip("unsaved work", help: "w", tone: .danger))

        let decoded = try JSONDecoder().decode(RmApproveItem.self, from: Data(#"{"path":"/w/a","kind":"dir","reason":"r","rule":"nested-repos"}"#.utf8))
        XCTAssertEqual(decoded.rule, "nested-repos")
        XCTAssertNil(try JSONDecoder().decode(RmApproveItem.self, from: Data(#"{"path":"/w/a","kind":"dir","reason":"r"}"#.utf8)).rule)
        let content = RmWindowContent.build(request([decoded]), home: "/Users/someone", icons: false, markdownApp: false)
        XCTAssertEqual(content.items.first?.risk?.level, .unsaved)
        XCTAssertEqual(content.items.first?.risk?.why, "Holds a git repository of its own: its work may exist only here.")
    }

    /// Rows moved aside sit under "Moved aside, waiting for you · N" and the others under "In place · N" (one header
    /// without a count when all are aside, none when all are in place); gone rows stay last in each group, and the row
    /// no longer repeats that it waits.
    func testAsideRowsSitUnderTheirOwnHeader() throws {
        let items = [
            RmApproveItem(path: "/w/a.txt", kind: "file", bytes: 10, empty: nil, storedAt: nil, reason: "Outside"),
            RmApproveItem(path: "/w/old.txt", kind: "missing", bytes: nil, empty: nil, storedAt: nil, reason: "Gone"),
            RmApproveItem(path: "/w/b.png", kind: "file", bytes: 10, empty: nil, storedAt: "/tmp/cc/aside/b.png", reason: "Outside"),
            RmApproveItem(path: "/w/c.png", kind: "missing", bytes: nil, empty: nil, storedAt: "/tmp/cc/aside/c.png", reason: "Gone"),
            RmApproveItem(path: "/w/d.png", kind: "file", bytes: 10, empty: nil, storedAt: "/tmp/cc/aside/d.png", reason: "Outside"),
        ]
        let content = RmWindowContent.build(request(items), home: "/Users/someone", icons: false, markdownApp: false)

        let groups = ApprovalItemGroup.groups(content.items)
        XCTAssertEqual(groups.map(\.title), ["Moved aside, waiting for you · 3", "In place · 2"])
        XCTAssertEqual(groups.map { $0.items.map(\.name) }, [["b.png", "d.png", "c.png"], ["a.txt", "old.txt"]])
        let aside = try XCTUnwrap(content.items.first { $0.name == "b.png" })
        XCTAssertEqual(aside.reasonLine, "Outside.")

        XCTAssertEqual(ApprovalItemGroup.groups(content.items.filter(\.aside)).map(\.title), ["Moved aside, waiting for you"])
        XCTAssertEqual(ApprovalItemGroup.groups(content.items.filter { !$0.aside }).map(\.title), [nil])
    }

    /// A sensor that is ready and never answers a touch; a password dialog that is cancelled at once.
    @MainActor private final class ReadyEvaluator: ApprovalBiometricEvaluator {
        func unavailableReason(_ context: LAContext) -> String? { nil }
        func evaluateBiometrics(_ context: LAContext, reason: String, reply: @escaping @Sendable (Bool, Error?) -> Void) {}
        func evaluatePassword(reason: String, reply: @escaping @Sendable (Bool, Error?) -> Void) { reply(false, LAError(.userCancel)) }
    }

    /// A window an agent opened (`arm: "click"`) starts with the sensor off. Unticking every row and ticking one again
    /// does not arm it, nor does a cancelled password; the click does, and after it the window behaves as before. nil
    /// and "open" keep the sensor listening from the first frame.
    @MainActor func testAWindowAnAgentOpenedListensOnlyAfterTheClick() throws {
        let json = #"""
        {"title":"Delete 2 items asked by session fix-build?","lines":[],"arm":"click","request":{"id":"abc234","kind":"delete",
        "cwd":"/w","graceMinutes":10,"asker":{"agent":"Codex","session":"fix-build"},
        "items":[{"path":"/w/a","kind":"file","bytes":10,"reason":"Outside"},{"path":"/w/b","kind":"file","bytes":10,"reason":"Outside"}]}}
        """#
        let params = try JSONDecoder().decode(RmApproveParams.self, from: Data(json.utf8))
        XCTAssertEqual(params.arm, "click")
        func window(_ params: RmApproveParams) -> (RmWindowContent, ApprovalVerifier, ApprovalDialogModel) {
            let content = RmWindowContent.build(params, home: "/Users/someone", icons: false, markdownApp: false)
            let verifier = ApprovalVerifier(reason: "approve: test", evaluator: ReadyEvaluator())
            let model = content.dialogModel(items: content.items, rememberChoices: [], verifier: verifier, links: [],
                                            deadline: Date().addingTimeInterval(60), who: "session fix-build")
            return (content, verifier, model)
        }

        let (content, verifier, model) = window(params)
        XCTAssertTrue(content.touchIDWaitsForClick)
        XCTAssertTrue(content.purpose.hasSuffix(" Codex opened this window; Touch ID listens only after you click Approve with Touch ID."), content.purpose)
        XCTAssertEqual(verifier.state, .paused)
        XCTAssertTrue(verifier.waitsForClick)

        model.setSelected(model.items[0], false)
        model.setSelected(model.items[1], false)
        model.setSelected(model.items[0], true)
        verifier.resume()
        XCTAssertEqual(verifier.state, .paused, "a tick or a resume must not arm a sensor nobody clicked")
        verifier.usePassword()
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        XCTAssertEqual(verifier.state, .paused, "a cancelled password goes back to waiting for the click, never to Try again")

        model.armTouchID()
        XCTAssertEqual(verifier.state, .listening)
        XCTAssertFalse(verifier.waitsForClick)
        model.setSelected(model.items[0], false)
        XCTAssertEqual(verifier.state, .paused)
        model.setSelected(model.items[1], true)
        XCTAssertEqual(verifier.state, .listening, "after the click a tick listens again, as in any window")

        // A click with nothing ticked arms the sensor for the first tick.
        let (_, idle, empty) = window(params)
        empty.setSelected(empty.items[0], false)
        empty.setSelected(empty.items[1], false)
        empty.armTouchID()
        XCTAssertEqual(idle.state, .paused)
        empty.setSelected(empty.items[0], true)
        XCTAssertEqual(idle.state, .listening)

        for arm in [nil, "open"] {
            var plain = params
            plain.arm = arm
            let (content, verifier, _) = window(plain)
            XCTAssertFalse(content.touchIDWaitsForClick)
            XCTAssertFalse(content.purpose.contains("opened this window"))
            XCTAssertEqual(verifier.state, .idle, "the sensor starts with the first frame, as before")
            XCTAssertFalse(verifier.waitsForClick)
        }
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
