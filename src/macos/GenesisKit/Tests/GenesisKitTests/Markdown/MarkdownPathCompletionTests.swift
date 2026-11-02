import XCTest
@testable import GenesisKit

/// The list under "Go to Location…" (⇧⌘G): what the typed path names, which entries of its folder match and in what
/// order, the hidden and file filters, the recent files, Tab and Return. Temporary folders, or an injected listing.
final class MarkdownPathCompletionTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        let made = FileManager.default.temporaryDirectory.appendingPathComponent("path-completion-\(UUID().uuidString)")
        for folder in ["notes/daily", "notes/drafts", ".obsidian"] {
            try FileManager.default.createDirectory(at: made.appendingPathComponent(folder), withIntermediateDirectories: true)
        }
        for file in ["notes/plan.md", "notes/data.json", "notes/photo.png", ".hidden.md", "visible.md"] {
            try "x".write(to: made.appendingPathComponent(file), atomically: true, encoding: .utf8)
        }
        // Compared with paths the code builds from the folder: one spelling (`/private/var/...`) on both sides.
        root = made.resolvingSymlinksInPath()
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func names(_ suggestions: MarkdownPathSuggestions) -> [String] {
        suggestions.entries.map { $0.isFolder ? $0.name + "/" : $0.name }
    }

    func testATildeExpandsAndTheTextSplitsIntoItsFolderAndTheNameBeingTyped() {
        let base = URL(fileURLWithPath: "/tmp/base")
        XCTAssertEqual(MarkdownPathCompletion.query("~/notes/pl", base: base),
                       MarkdownPathQuery(folder: NSHomeDirectory() + "/notes", segment: "pl", head: "~/notes/"))
        XCTAssertEqual(MarkdownPathCompletion.query("~", base: base),
                       MarkdownPathQuery(folder: NSHomeDirectory(), segment: "", head: "~/"))
        XCTAssertEqual(MarkdownPathCompletion.query("drafts/to", base: base),
                       MarkdownPathQuery(folder: "/tmp/base/drafts", segment: "to", head: "drafts/"))
        XCTAssertEqual(MarkdownPathCompletion.query("plan", base: base),
                       MarkdownPathQuery(folder: "/tmp/base", segment: "plan", head: ""))
        XCTAssertEqual(MarkdownPathCompletion.display(folder: URL(fileURLWithPath: NSHomeDirectory() + "/notes")), "~/notes/")
    }

    func testAPastedPathWithQuotesOrAsAFileUrlListsItsFolder() {
        let quoted = MarkdownPathCompletion.suggest("'\(root.path)/notes/plan.md'\n", base: root)
        XCTAssertEqual(quoted.query.folder, root.path + "/notes")
        XCTAssertEqual(quoted.entries.first?.name, "plan.md")
        XCTAssertEqual(quoted.entries.first?.matched, Array(0..<7), "the whole name matched")

        let url = MarkdownPathCompletion.suggest("file://\(root.path)/notes/", base: root)
        XCTAssertEqual(url.query, MarkdownPathQuery(folder: root.path + "/notes", segment: "", head: root.path + "/notes/"))
        XCTAssertEqual(names(url), ["daily/", "drafts/", "plan.md"])
    }

    func testAPathToAFolderListsThatFolderAndTabPutsAFolderInTheFieldWithItsSlash() throws {
        // No closing slash: the folder is a row of the folder it is in, first, beside the other matches, and Return
        // goes into it.
        try "x".write(to: root.appendingPathComponent("notes.md"), atomically: true, encoding: .utf8)
        let named = MarkdownPathCompletion.suggest(root.path + "/notes", base: root)
        XCTAssertEqual(named.query, MarkdownPathQuery(folder: root.path, segment: "notes", head: root.path + "/"))
        XCTAssertEqual(names(named), ["notes/", "notes.md"], "the note beside the folder stays in the list")
        XCTAssertEqual(named.automaticIndex, 0)
        let notes = try XCTUnwrap(named.entries.first)
        XCTAssertEqual(MarkdownPathCompletion.action(text: named.text, base: root, pick: .automatic(notes),
                                                     query: named.query, reveal: false),
                       .complete(root.path + "/notes/"), "Return goes into the folder")
        XCTAssertEqual(MarkdownPathCompletion.action(text: named.text, base: root, pick: .automatic(notes),
                                                     query: named.query, reveal: true),
                       .reveal(URL(fileURLWithPath: root.path + "/notes")), "⌘Return shows it in the sidebar")

        // With the slash: the folder's own entries, folders first, and Tab continues inside it.
        let folder = MarkdownPathCompletion.suggest(root.path + "/notes/", base: root)
        XCTAssertEqual(folder.query, MarkdownPathQuery(folder: root.path + "/notes", segment: "", head: root.path + "/notes/"))
        XCTAssertEqual(names(folder), ["daily/", "drafts/", "plan.md"])
        XCTAssertNil(folder.automaticIndex, "Return on a folder the field holds shows that folder, it does not go into a row")

        let daily = try XCTUnwrap(folder.entries.first)
        XCTAssertEqual(MarkdownPathCompletion.completion(of: daily, in: folder.query), root.path + "/notes/daily/")
        let plan = try XCTUnwrap(folder.entries.last)
        XCTAssertEqual(MarkdownPathCompletion.completion(of: plan, in: folder.query), root.path + "/notes/plan.md")

        // A typed `~` stays in the field after Tab.
        let home = MarkdownPathQuery(folder: NSHomeDirectory(), segment: "no", head: "~/")
        let row = MarkdownPathSuggestion(path: NSHomeDirectory() + "/notes", name: "notes", isFolder: true, source: .folder)
        XCTAssertEqual(MarkdownPathCompletion.completion(of: row, in: home), "~/notes/")

        let parent = MarkdownPathCompletion.suggest(root.path + "/notes/..", base: root)
        XCTAssertEqual(parent.query.folder, root.path)
    }

    func testNotesAndFoldersAreListedUnlessEveryFileTheViewerOpensIsAsked() {
        let notes = MarkdownPathCompletion.suggest(root.path + "/notes/", base: root)
        XCTAssertEqual(names(notes), ["daily/", "drafts/", "plan.md"])
        XCTAssertEqual(notes.filteredOut, 2, "data.json and photo.png")

        let every = MarkdownPathCompletion.suggest(root.path + "/notes/", base: root,
                                                   options: MarkdownPathOptions(files: .readable))
        XCTAssertEqual(names(every), ["daily/", "drafts/", "data.json", "plan.md"])
        XCTAssertEqual(every.filteredOut, 1, "a picture is no file the viewer opens")
    }

    func testTheLastPartMatchesFuzzilyWholeNameThenStartThenWordStartThenInsideThenLettersInOrder() {
        let listing = ["explanation.md", "p-l-a-n.md", "replan.md", "myPlan.md", "2026-10-01-plan.md", "PlanReview.md",
                       "plan.md", "unrelated.md"].map { MarkdownPathEntry(name: $0, isFolder: false) }
            + [MarkdownPathEntry(name: "planning", isFolder: true)]
        let result = MarkdownPathCompletion.suggest("/vault/plan", base: root, read: { _ in listing })
        XCTAssertEqual(names(result), ["plan.md", "planning/", "PlanReview.md", "myPlan.md", "2026-10-01-plan.md",
                                       "replan.md", "explanation.md", "p-l-a-n.md"])
        XCTAssertEqual(result.entries.last?.matched, [0, 2, 4, 6])
        XCTAssertEqual(result.entries[3].matched, [2, 3, 4, 5], "myPlan matched at its capital")

        XCTAssertEqual(MarkdownPathCompletion.match("plan.md", in: "plan.md")?.score, 0)
        XCTAssertEqual(MarkdownPathCompletion.match("PLAN", in: "plan.md")?.score, 1, "case does not count")
        XCTAssertNil(MarkdownPathCompletion.match("plans", in: "plan.md"))
        XCTAssertNil(MarkdownPathCompletion.match("abc", in: "ab"), "a name shorter than the typed part")
        XCTAssertNil(MarkdownPathCompletion.match("ba", in: "ab"), "the same length and no match must not crash")
    }

    func testHiddenEntriesAreListedOnlyOnceTheNameStartsWithADotOrTheSettingAsks() {
        let plain = MarkdownPathCompletion.suggest(root.path + "/", base: root)
        XCTAssertEqual(names(plain), ["notes/", "visible.md"])
        XCTAssertEqual(plain.hiddenOut, 2)

        // The names that start with the dot first; `visible.md` holds one too, further in.
        let dotted = MarkdownPathCompletion.suggest(root.path + "/.", base: root)
        XCTAssertEqual(names(dotted), [".obsidian/", ".hidden.md", "visible.md"])

        let always = MarkdownPathCompletion.suggest(root.path + "/", base: root,
                                                    options: MarkdownPathOptions(showsHidden: true))
        XCTAssertEqual(Set(names(always)), [".obsidian/", "notes/", ".hidden.md", "visible.md"])
        XCTAssertEqual(always.hiddenOut, 0)
    }

    func testAPathThatDoesNotExistSaysWhyAndReturnNamesTheProblem() {
        let missing = MarkdownPathCompletion.suggest(root.path + "/nope/x", base: root)
        XCTAssertEqual(missing.problem, .missing)
        XCTAssertTrue(missing.rows.isEmpty)
        XCTAssertEqual(MarkdownPathCompletion.suggest(root.path + "/visible.md/x", base: root).problem, .notAFolder)

        let nothing = MarkdownPathCompletion.action(
            text: root.path + "/nope.md", base: root, pick: .automatic(nil),
            query: MarkdownPathCompletion.query(root.path + "/nope.md", base: root), reveal: false)
        guard case .problem(let text) = nothing else { return XCTFail("\(nothing)") }
        XCTAssertTrue(text.hasPrefix("Nothing at "), text)

        let picture = MarkdownPathCompletion.action(
            text: root.path + "/notes/photo.png", base: root, pick: .text,
            query: MarkdownPathCompletion.query(root.path + "/notes/photo.png", base: root), reveal: false)
        XCTAssertEqual(picture, .problem("\u{201C}photo.png\u{201D} is not a file this viewer opens."))
    }

    func testReturnTakesTheChosenRowThenATypedFileThenTheFirstRowThenATypedFolder() throws {
        let typing = MarkdownPathCompletion.suggest(root.path + "/notes/pl", base: root)
        let plan = try XCTUnwrap(typing.entries.first)
        XCTAssertEqual(typing.automaticIndex, 0)
        let planURL = URL(fileURLWithPath: plan.path)
        XCTAssertEqual(MarkdownPathCompletion.action(text: typing.text, base: root, pick: .automatic(plan),
                                                     query: typing.query, reveal: false), .open(planURL))

        let folder = MarkdownPathCompletion.suggest(root.path + "/notes/", base: root)
        let daily = try XCTUnwrap(folder.entries.first)
        XCTAssertEqual(MarkdownPathCompletion.action(text: folder.text, base: root, pick: .chosen(daily),
                                                     query: folder.query, reveal: false),
                       .complete(root.path + "/notes/daily/"), "a folder row goes into the field")
        XCTAssertEqual(MarkdownPathCompletion.action(text: folder.text, base: root, pick: .automatic(nil),
                                                     query: folder.query, reveal: false),
                       .reveal(URL(fileURLWithPath: root.path + "/notes")), "the folder the field names shows in the sidebar")
        XCTAssertEqual(MarkdownPathCompletion.action(text: folder.text, base: root, pick: .chosen(plan),
                                                     query: folder.query, reveal: true),
                       .reveal(planURL), "⌘Return shows the pick in the sidebar")

        // A pasted full path to a file opens that file, whatever row is first.
        let exact = root.path + "/notes/plan.md"
        XCTAssertEqual(MarkdownPathCompletion.action(text: exact, base: root, pick: .automatic(daily),
                                                     query: MarkdownPathCompletion.query(exact, base: root), reveal: false),
                       .open(URL(fileURLWithPath: exact)))
    }

    func testRecentFilesLeadTheListAndAGoneOneIsLeftOut() throws {
        let recents = [root.path + "/notes/plan.md", root.path + "/gone.md", root.path + "/visible.md"]
        let result = MarkdownPathCompletion.suggest(root.path + "/notes/", base: root, recents: recents)
        XCTAssertEqual(result.recents.map(\.name), ["plan.md", "visible.md"])
        XCTAssertEqual(result.rows.first?.id, "recent:" + root.path + "/notes/plan.md")
        XCTAssertNotEqual(result.rows.first?.id, result.entries.last?.id, "a recent file in the folder is a row of its own")
        XCTAssertEqual(result.automaticIndex, 0, "with recent files shown, Return opens the newest")

        let recent = try XCTUnwrap(result.recents.last)
        XCTAssertEqual(MarkdownPathCompletion.completion(of: recent, in: result.query),
                       (root.path as NSString).abbreviatingWithTildeInPath + "/visible.md")
    }

    func testALargeFolderIsReadOnceRankedAndCappedAndAStaleRequestStops() throws {
        let big = root.appendingPathComponent("big")
        try FileManager.default.createDirectory(at: big, withIntermediateDirectories: true)
        for index in 0..<3_000 {
            FileManager.default.createFile(atPath: big.appendingPathComponent(String(format: "note-%04d.md", index)).path,
                                           contents: nil)
        }
        FileManager.default.createFile(atPath: big.appendingPathComponent("target-plan.md").path, contents: nil)

        var reads = 0
        let cache = MarkdownPathCache()
        let counted: (String) -> [MarkdownPathEntry]? = { folder in
            reads += 1
            return cache.read(folder)
        }
        let started = Date()
        let all = MarkdownPathCompletion.suggest(big.path + "/", base: root, read: counted)
        XCTAssertEqual(all.entries.count, 200)
        XCTAssertEqual(all.total, 3_001)
        XCTAssertTrue(all.truncated)

        let typed = MarkdownPathCompletion.suggest(big.path + "/target", base: root, read: counted)
        XCTAssertEqual(typed.entries.map(\.name), ["target-plan.md"])
        let fuzzy = MarkdownPathCompletion.suggest(big.path + "/n0001", base: root, read: counted)
        XCTAssertEqual(fuzzy.entries.first?.name, "note-0001.md", "the tightest match of n, 0, 0, 0, 1 first")
        XCTAssertLessThan(Date().timeIntervalSince(started), 2, "three requests over 3,001 entries")
        XCTAssertEqual(reads, 3)

        var staleReads = 0
        let stale = MarkdownPathCompletion.suggest(big.path + "/", base: root, isCancelled: { true }, read: { folder in
            staleReads += 1
            return cache.read(folder)
        })
        XCTAssertTrue(stale.entries.isEmpty, "a cancelled request stops")
        XCTAssertEqual(staleReads, 0, "a cancelled request starts no folder read")

        // One read per request: a folder named without its slash is a row of its parent, and `..` reads only the
        // folder above.
        var folders: [String] = []
        let reading: (String) -> [MarkdownPathEntry]? = { folder in
            folders.append(folder)
            return MarkdownPathCompletion.read(folder)
        }
        _ = MarkdownPathCompletion.suggest(root.path + "/notes", base: root, read: reading)
        let up = MarkdownPathCompletion.suggest(root.path + "/notes/daily/..", base: root, read: reading)
        XCTAssertEqual(folders, [root.path, root.path + "/notes"])
        XCTAssertEqual(names(up), ["daily/", "drafts/", "plan.md"])
    }

    /// Fast typing over a slow folder: a request that asks for a folder while another request reads it waits for that
    /// read, so the folder is listed once.
    func testARequestForAFolderThatIsBeingReadWaitsForThatRead() {
        let calls = LockedValue(0)
        let started = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let cache = MarkdownPathCache(read: { _ in
            let call = calls.update { count -> Int in
                count += 1
                return count
            }
            if call == 1 {
                started.signal()
                _ = release.wait(timeout: .now() + 5)
            }
            return [MarkdownPathEntry(name: "plan.md", isFolder: false)]
        })

        let results = LockedValue<[[String]?]>([])
        let finished = DispatchGroup()
        func request() {
            finished.enter()
            DispatchQueue.global().async {
                let names = cache.read("/slow")?.map(\.name)
                results.update { $0.append(names) }
                finished.leave()
            }
        }
        request()
        XCTAssertEqual(started.wait(timeout: .now() + 5), .success, "the first read started")
        request()
        // The second request reaches the cache while the first read is held.
        Thread.sleep(forTimeInterval: 0.2)
        release.signal()
        XCTAssertEqual(finished.wait(timeout: .now() + 5), .success)

        XCTAssertEqual(calls.value, 1, "the second request waited for the first read instead of reading again")
        XCTAssertEqual(results.value.compactMap { $0 }, [["plan.md"], ["plan.md"]])
        XCTAssertEqual(cache.read("/slow")?.map(\.name), ["plan.md"])
        XCTAssertEqual(calls.value, 1, "the listing is kept")

        // A folder that could not be read is asked again by the next request.
        let tries = LockedValue(0)
        let later = MarkdownPathCache(read: { _ in
            tries.update { count -> Int in
                count += 1
                return count
            } == 1 ? nil : []
        })
        XCTAssertNil(later.read("/later"))
        XCTAssertEqual(later.read("/later"), [])
    }

    @MainActor
    func testTheLoaderDeliversOnlyTheNewestText() async throws {
        let loader = MarkdownGoToLoader()
        loader.load(root.path + "/notes/", base: root, recents: [], options: MarkdownPathOptions())
        loader.load(root.path + "/notes/pl", base: root, recents: [], options: MarkdownPathOptions())
        let deadline = Date().addingTimeInterval(5)
        while loader.suggestions == nil, Date() < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(loader.suggestions?.text, root.path + "/notes/pl")
        XCTAssertEqual(loader.suggestions?.entries.map(\.name), ["plan.md"])
    }

    /// While a newer request loads, the older list stays on screen and is not the current one, so nothing acts on it.
    /// A list equal to the one before it still counts as delivered, so a key that waited for it runs.
    @MainActor
    func testWhileANewerRequestLoadsTheOlderListIsNotCurrent() async throws {
        let loader = MarkdownGoToLoader()
        let notes = root.path + "/notes/"
        loader.load(notes, base: root, recents: [], options: MarkdownPathOptions())
        XCTAssertNil(loader.current)
        try await waitForDelivery(loader, after: 0)
        XCTAssertEqual(loader.current?.text, notes)

        loader.load(notes + "pl", base: root, recents: [], options: MarkdownPathOptions())
        XCTAssertNil(loader.current, "the older list shows, but nothing acts on it")
        XCTAssertEqual(loader.suggestions?.text, notes, "it stays on screen")
        try await waitForDelivery(loader, after: 1)
        XCTAssertEqual(loader.current?.text, notes + "pl")

        // New options with the same text: the list on screen stops being current until the new one arrives.
        let shown = loader.suggestions
        loader.load(notes + "pl", base: root, recents: [], options: MarkdownPathOptions(showsHidden: true))
        XCTAssertNil(loader.current)
        try await waitForDelivery(loader, after: 2)
        XCTAssertEqual(loader.suggestions, shown, "an equal list")
        XCTAssertEqual(loader.current, shown, "still delivered")
    }

    @MainActor
    private func waitForDelivery(_ loader: MarkdownGoToLoader, after count: Int) async throws {
        let deadline = Date().addingTimeInterval(5)
        while loader.deliveries <= count, Date() < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertGreaterThan(loader.deliveries, count, "no list arrived within 5 s")
    }
}

/// A value several threads change, behind a lock.
private final class LockedValue<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value

    init(_ value: Value) { stored = value }

    var value: Value { lock.withLock { stored } }

    @discardableResult
    func update<Result>(_ change: (inout Value) -> Result) -> Result {
        lock.withLock { change(&stored) }
    }
}
