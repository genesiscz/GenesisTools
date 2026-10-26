import Combine
import XCTest
@testable import GenesisToolsHost
@testable import GenesisToolsHub

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
        XCTAssertEqual(HubPRRef("app!12")?.label, "app!12")
        XCTAssertEqual(HubPRRef("#42")?.label, "#42")
        XCTAssertNil(HubPRRef("app#x"))
        XCTAssertNil(HubPRRef("seven"))
    }

    /// A ref outside the list goes to `tools hub pr show` as the project name, which the CLI finds among
    /// every checkout under the repo roots; the hub's own project index may not have loaded yet.
    func testAPRRefOutsideTheListOpensByItsProjectName() {
        XCTAssertEqual(HubPRRef("group/sub/app!12")?.showArg, "group/sub/app!12")
        XCTAssertEqual(HubPRRef("acme/app#42")?.showArg, "acme/app#42")
        XCTAssertEqual(HubPRRef("https://gitlab.example/group/app/-/merge_requests/3")?.showArg, "https://gitlab.example/group/app/-/merge_requests/3")
        XCTAssertNil(HubPRRef("#42")?.showArg)
        XCTAssertNil(HubPRRef("--flag#12")?.showArg, "the CLI would read it as an option, not as the ref")
        XCTAssertTrue(PRsModel.notListed(HubPRRef("!7")!).text.contains("<project>!7"))
    }

    /// The browser extension and pasted links hand the hub a page URL, often with a tab suffix.
    func testAPRRefReadsAPRorMRPageURL() {
        XCTAssertEqual(HubPRRef("https://github.com/acme/App/pull/424/files")?.project, "acme/App")
        XCTAssertEqual(HubPRRef("https://github.com/acme/App/pull/424/files")?.number, 424)
        XCTAssertEqual(HubPRRef("https://github.com/acme/App/pull/424/files")?.pageURL, "https://github.com/acme/App/pull/424/files")
        XCTAssertEqual(HubPRRef("https://gitlab.example/group/sub/app/-/merge_requests/12")?.project, "group/sub/app")
        XCTAssertEqual(HubPRRef("https://gitlab.example/group/sub/app/-/merge_requests/12")?.number, 12)
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

    // MARK: Commit links

    func testACommitLinkCarriesThePRAndTheCommitWithAnEncodedHash() throws {
        let args = try XCTUnwrap(HubRequest.arguments(fromLink: "genesis-tools://hub?pr=acme%2Fapp%237&commit=ABC1234"))
        XCTAssertEqual(args, ["--pr", "acme/app#7", "--commit", "ABC1234"])
        let request = HubRequest(args)
        XCTAssertEqual(request.pr, HubPRRef(project: "acme/app", number: 7))
        XCTAssertEqual(request.commit.flatMap(HubCommitSha.normalized), "abc1234")
    }

    func testACommitLinkWithoutAPRNamesItsProject() throws {
        let args = try XCTUnwrap(HubRequest.arguments(fromLink: "genesis-tools://hub?repo=%2Ftmp%2Fmy%20app&commit=0123456789abcdef"))
        XCTAssertEqual(args, ["--repo", "/tmp/my app", "--commit", "0123456789abcdef"])
        XCTAssertNil(HubRequest(args).pr)
        XCTAssertEqual(HubRequest(["--repo", "acme/app", "--commit", "abc1234"]).repo, "acme/app")
    }

    func testACommitIsSevenToFortyHexCharactersMatchedAsAPrefix() {
        XCTAssertEqual(HubCommitSha.normalized(" ABCDEF0 "), "abcdef0")
        XCTAssertNil(HubCommitSha.normalized("abcdef"), "six characters name no commit reliably")
        XCTAssertNil(HubCommitSha.normalized("abcdefg"))
        XCTAssertNil(HubCommitSha.normalized(String(repeating: "a", count: 41)))
        let commits = [
            HubPRDetail.Commit(sha: "1111111aaaa", title: "first", author: nil, authorLogin: nil, date: nil, body: nil),
            HubPRDetail.Commit(sha: "ABCDEF0123", title: "second", author: nil, authorLogin: nil, date: nil, body: nil),
        ]
        XCTAssertEqual(HubCommitSha.find("abcdef0", in: commits)?.title, "second")
        XCTAssertNil(HubCommitSha.find("abcdef9", in: commits))
    }

    /// `commit=<from>..<to>`: a run of a PR's commits, both ends included, in either order.
    /// A link may name commits an agent made but did not push yet (2026-10-23): the forge does not list
    /// them, the PR's checkout has them, so the range comes from the checkout instead of the whole MR.
    func testALinkRangeOfUnpushedCommitsResolvesFromTheCheckout() throws {
        let repo = FileManager.default.temporaryDirectory.appendingPathComponent("hub-local-range-\(UUID().uuidString)").path
        try FileManager.default.createDirectory(atPath: repo, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: repo) }
        func git(_ args: String...) throws -> String {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            process.arguments = ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com",
                                 "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"] + args
            let out = Pipe()
            process.standardOutput = out
            try process.run()
            let data = out.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            XCTAssertEqual(process.terminationStatus, 0, "git \(args.joined(separator: " "))")
            return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        _ = try git("init", "-q", "-b", "main")
        var shas: [String] = []
        for index in 0 ..< 6 {
            _ = try git("commit", "-q", "--allow-empty", "-m", "commit \(index)")
            shas.append(try git("rev-parse", "HEAD"))
        }
        let pushedHead = shas[2]
        let pushed = Set(shas[1 ... 2])
        let range = try XCTUnwrap(try? HubLocalCommits.resolve(
            ends: [String(shas[2].prefix(10)), String(shas[4].prefix(10))], repo: repo, head: pushedHead, pushed: pushed).get())
        XCTAssertEqual(range, HubLocalCommits(first: shas[2], last: shas[4], count: 3, unpushed: 2, title: "commit 4"))
        let reversed = try? HubLocalCommits.resolve(ends: [shas[4], shas[2]], repo: repo, head: pushedHead, pushed: pushed).get()
        XCTAssertEqual(reversed?.first, shas[2], "either order")
        XCTAssertEqual(try? HubLocalCommits.resolve(ends: [shas[3]], repo: repo, head: pushedHead).get().unpushed, 1)
        XCTAssertEqual(try? HubLocalCommits.resolve(ends: [shas[4]], repo: repo, head: pushedHead).get().unpushed, 1,
                       "a later single commit does not include earlier unpushed commits")
        let localOnly = try HubLocalCommits.resolve(ends: [shas[3], shas[4]], repo: repo, head: pushedHead).get()
        XCTAssertEqual(localOnly.count, 2)
        XCTAssertEqual(localOnly.unpushed, 2, "both unpushed endpoints count")
        let laterRange = try HubLocalCommits.resolve(ends: [shas[4], shas[4]], repo: repo, head: pushedHead).get()
        XCTAssertEqual(laterRange.unpushed, 1, "equal endpoints include that commit once")
        let pushedOnly = try HubLocalCommits.resolve(ends: [shas[2]], repo: repo, head: pushedHead, pushed: pushed).get()
        XCTAssertEqual(pushedOnly.unpushed, 0)
        let laterPair = try HubLocalCommits.resolve(ends: [shas[4], shas[5]], repo: repo, head: pushedHead).get()
        XCTAssertEqual(laterPair.unpushed, 2, "earlier unpushed commits before this range do not count")
        XCTAssertEqual(try HubLocalCommits.resolve(ends: [shas[5], shas[4]], repo: repo, head: pushedHead).get().unpushed, 2)
        let tree = try git("rev-parse", pushedHead + "^{tree}")
        let parallel = try git("commit-tree", tree, "-p", pushedHead, "-m", "parallel")
        let merged = try git("commit-tree", tree, "-p", shas[5], "-p", parallel, "-m", "merged")
        let mergedRange = try HubLocalCommits.resolve(ends: [shas[4], merged], repo: repo, head: pushedHead).get()
        XCTAssertEqual(mergedRange.count, 3)
        XCTAssertEqual(mergedRange.unpushed, 3, "exclude a merged side commit outside the first endpoint's ancestry path")
        guard case .failure(.offBranch) = HubLocalCommits.resolve(ends: [shas[0], shas[4]], repo: repo, head: pushedHead, pushed: pushed) else {
            return XCTFail("a first commit from before the PR would show the base's changes")
        }
        guard case .failure(.unknown("0123456789")) = HubLocalCommits.resolve(ends: ["0123456789"], repo: repo, head: pushedHead) else {
            return XCTFail("an end the checkout lacks is named")
        }
        _ = try git("checkout", "-q", "-b", "side", shas[0])
        _ = try git("commit", "-q", "--allow-empty", "-m", "side")
        let side = try git("rev-parse", "HEAD")
        guard case .failure(.unrelated) = HubLocalCommits.resolve(ends: [side, shas[4]], repo: repo, head: pushedHead) else {
            return XCTFail("ends on two lines are refused")
        }
        guard case .failure(.offBranch) = HubLocalCommits.resolve(ends: [side], repo: repo, head: pushedHead) else {
            return XCTFail("a commit off the PR's line is refused")
        }
    }

    func testACommitRangeLinkShowsItsCommitsFromTheParentOfTheFirst() throws {
        XCTAssertEqual(HubCommitSpan("abcdef0"), HubCommitSpan(from: "abcdef0"))
        XCTAssertEqual(HubCommitSpan("67AD51671E..3cac936e2f"), HubCommitSpan(from: "67ad51671e", to: "3cac936e2f"))
        XCTAssertNil(HubCommitSpan("abcdef0..xyz"))
        XCTAssertNil(HubCommitSpan("abcdef0...1234567"))
        let commit = { (sha: String) in HubPRDetail.Commit(sha: sha, title: sha, author: nil, authorLogin: nil, date: nil, body: nil) }
        let commits = ["a000000", "b000000", "c000000", "d000000"].map(commit)
        let json = """
        {"repo":"app","repoRoot":"/work/app","origin":{"kind":"gitlab","host":"git.example","web":"https://git.example/group/app"},
         "number":7,"title":"t","state":"OPEN","draft":false,"author":"a","headBranch":"feat/x","baseBranch":"main",
         "url":"https://git.example/group/app/-/merge_requests/7","labels":[],"reviewers":[],"headSha":"d000000","crossRepository":false,"headRepo":null}
        """
        let pr = try JSONDecoder().decode(HubPR.self, from: Data(json.utf8))
        let whole = DiffScope.range(base: "base000", head: "d000000", label: "whole", fallbackBase: "origin/main")
        let middle = PRsModel.rangeScope(commits, first: 1, last: 2, parent: "a000000", pr: pr, whole: whole)
        XCTAssertEqual(middle.scope, .range(base: "a000000", head: "c000000", label: "!7 b000000..c000000 (2 commits)"))
        XCTAssertEqual(PRsModel.rangeShas(middle.scope, linked: middle), ["b000000", "c000000"])
        let opening = PRsModel.rangeScope(commits, first: 0, last: 1, parent: nil, pr: pr, whole: whole)
        XCTAssertEqual(opening.scope, .range(base: "base000", head: "b000000", label: "!7 a000000..b000000 (2 commits)", fallbackBase: "origin/main"))
        XCTAssertEqual(PRsModel.rangeShas(opening.scope, linked: opening), ["a000000", "b000000"])
        // A link over every commit of the PR marks them all; the whole PR itself, or another range, marks none.
        let span = PRsModel.rangeScope(commits, first: 0, last: 3, parent: nil, pr: pr, whole: whole)
        XCTAssertEqual(PRsModel.rangeShas(span.scope, linked: span), Set(commits.map(\.sha)))
        XCTAssertEqual(PRsModel.rangeShas(whole, linked: span), [], "the whole PR marks no commit")
        XCTAssertEqual(PRsModel.rangeShas(whole, linked: nil), [])
        XCTAssertEqual(PRsModel.rangeShas(middle.scope, linked: opening), [], "only the range the link set")
        XCTAssertEqual(PRsModel.rangeShas(.commit(sha: "b000000", title: "b"), linked: span), [])
    }

    /// A PR with a side branch merged in: the forge lists its commits oldest first, so the side commit sits between
    /// two commits of the main line. A range that starts after it diffs from the first commit's parent in git, not
    /// from the listed commit before it, whose fork point would bring in a commit the range does not hold.
    func testARangeLinkInABranchedPRDiffsFromItsFirstCommitsParent() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("hub-branched-range-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let path = folder.resolvingSymlinksInPath().path
        // No hooks and no signing from the machine's global git config.
        let git = { (args: [String]) -> String? in
            WorktreeDiscovery.git(path, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "core.hooksPath=/dev/null",
                                         "-c", "commit.gpgsign=false"] + args)?.trimmed
        }
        func commitFile(_ name: String) throws -> String {
            try "\(name)\n".write(toFile: "\(path)/\(name)", atomically: true, encoding: .utf8)
            XCTAssertNotNil(git(["add", name]))
            XCTAssertNotNil(git(["commit", "-q", "-m", name]))
            return try XCTUnwrap(git(["rev-parse", "HEAD"]))
        }
        XCTAssertNotNil(git(["init", "-q", "-b", "main"]))
        let root = try commitFile("base.txt")
        let first = try commitFile("a1.txt")
        let second = try commitFile("a2.txt")
        let third = try commitFile("a3.txt")
        XCTAssertNotNil(git(["checkout", "-q", "-b", "side", root]))
        let side = try commitFile("s.txt")
        XCTAssertNotNil(git(["checkout", "-q", "main"]))
        XCTAssertNotNil(git(["merge", "-q", "--no-ff", "--no-edit", "side"]))
        let merge = try XCTUnwrap(git(["rev-parse", "HEAD"]))

        XCTAssertEqual(HubCommitLookup.parent(of: second, in: path), first)
        XCTAssertEqual(HubCommitLookup.parent(of: root, in: path), HubCommitLookup.emptyTree, "a root commit starts from the empty tree")

        let commit = { (sha: String) in HubPRDetail.Commit(sha: sha, title: sha, author: nil, authorLogin: nil, date: nil, body: nil) }
        let commits = [first, side, second, third, merge].map(commit)
        let json = """
        {"repo":"app","repoRoot":null,"origin":{"kind":"github","host":"github.com","web":"https://github.com/acme/app"},
         "number":7,"title":"t","state":"OPEN","draft":false,"author":"a","headBranch":"feat/x","baseBranch":"main",
         "url":"https://github.com/acme/app/pull/7","labels":[],"reviewers":[],"headSha":"\(merge)","crossRepository":false,"headRepo":null}
        """
        let pr = try JSONDecoder().decode(HubPR.self, from: Data(json.utf8))
        let whole = DiffScope.range(base: root, head: merge, label: "whole")
        let range = PRsModel.rangeScope(commits, first: 2, last: 3, parent: HubCommitLookup.parent(of: second, in: path), pr: pr, whole: whole)
        XCTAssertEqual(PRsModel.rangeShas(range.scope, linked: range), [second, third])
        let snapshot = try GitWorkingTreeSource(repo: URL(fileURLWithPath: path)).load(scope: range.scope)
        XCTAssertEqual(snapshot.files.map(\.path).sorted(), ["a2.txt", "a3.txt"], "the side commit's fork point would add a1.txt")
    }

    func testAForgePathFindsItsCheckoutInAnyCaseAndForm() {
        let projects = [
            HubPRProject(project: "https://github.com/acme/App", repo: "App", root: "/fixture/app", kind: "github"),
            HubPRProject(project: "https://gitlab.example.test/group/sub/tool", repo: "tool", root: "/fixture/tool", kind: "gitlab"),
        ]
        XCTAssertEqual(PRsModel.projectRoot("acme/app", in: projects), "/fixture/app")
        XCTAssertEqual(PRsModel.projectRoot("https://github.com/acme/app.git", in: projects), "/fixture/app")
        XCTAssertEqual(PRsModel.projectRoot("group/sub/tool/", in: projects), "/fixture/tool")
        XCTAssertNil(PRsModel.projectRoot("acme/other", in: projects))
        XCTAssertNil(PRsModel.projectRoot("", in: projects))
    }

    func testACommitLinkResolvesItsCheckoutAndSubjectFromGit() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("hub-commit-link-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let path = folder.resolvingSymlinksInPath().path
        // No hooks and no signing from the machine's global git config.
        let commit = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "core.hooksPath=/dev/null",
                      "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "the subject line"]
        for args in [["init", "-q"], commit] {
            XCTAssertNotNil(WorktreeDiscovery.git(path, args), "git \(args.joined(separator: " "))")
        }
        let head = try XCTUnwrap(WorktreeDiscovery.git(path, ["rev-parse", "HEAD"])?.trimmed)
        // git names the temporary folder by its real path (/private/var, not /var).
        let root = try XCTUnwrap(WorktreeDiscovery.git(path, ["rev-parse", "--show-toplevel"])?.trimmed)
        let short = String(head.prefix(9))
        let found = HubCommitLookup.Outcome.found(.init(root: root, sha: head, title: "the subject line"))

        XCTAssertEqual(HubCommitLookup.resolve(repo: path + "/", sha: short, known: []), found)
        let projects = [HubPRProject(project: "https://example.test/acme/app", repo: "app", root: path, kind: "github")]
        XCTAssertEqual(HubCommitLookup.resolve(repo: "acme/app", sha: short, known: projects), found)
        // The link names the upstream, the checkout is a fork: the same last name with the commit is the checkout.
        let fork = [HubPRProject(project: "https://example.test/other/app", repo: "app", root: "/fixture/none", kind: "gitlab"),
                    HubPRProject(project: "https://example.test/me/app", repo: "app", root: path, kind: "gitlab")]
        XCTAssertEqual(HubCommitLookup.resolve(repo: "group/sub/app", sha: short, known: fork), found)
        guard case .failed = HubCommitLookup.resolve(repo: "group/sub/app", sha: "0000000", known: fork) else {
            return XCTFail("a same-name project without the commit is no match")
        }
        guard case .failed(let message) = HubCommitLookup.resolve(repo: path, sha: "0000000", known: []) else {
            return XCTFail("a commit the checkout lacks must be said")
        }
        XCTAssertTrue(message.contains("is not in"), message)

        // A range, named in either order: from the parent of the older end to the newer one.
        for _ in 0..<2 {
            XCTAssertNotNil(WorktreeDiscovery.git(path, commit))
        }
        let newest = try XCTUnwrap(WorktreeDiscovery.git(path, ["rev-parse", "HEAD"])?.trimmed)
        let middle = try XCTUnwrap(WorktreeDiscovery.git(path, ["rev-parse", "HEAD^"])?.trimmed)
        let range = HubCommitLookup.Found(root: root, sha: newest, title: "\(middle.prefix(10))..\(newest.prefix(10)) (2 commits)", base: head)
        XCTAssertEqual(HubCommitLookup.resolve(repo: path, sha: String(middle.prefix(8)), to: String(newest.prefix(8)), known: []), .found(range))
        XCTAssertEqual(HubCommitLookup.resolve(repo: path, sha: String(newest.prefix(8)), to: String(middle.prefix(8)), known: []), .found(range))

        // Two same-name forks hold the older end; only the second holds the newer one, so the range opens there.
        let stale = path + "-stale"
        XCTAssertNotNil(WorktreeDiscovery.git(path, ["clone", "-q", "--no-local", path, stale]))
        defer { try? FileManager.default.removeItem(atPath: stale) }
        XCTAssertNotNil(WorktreeDiscovery.git(path, commit))
        let latest = try XCTUnwrap(WorktreeDiscovery.git(path, ["rev-parse", "HEAD"])?.trimmed)
        let forks = [HubPRProject(project: "https://example.test/old/app", repo: "app", root: stale, kind: "gitlab"),
                     HubPRProject(project: "https://example.test/me/app", repo: "app", root: path, kind: "gitlab")]
        guard case .found(let ranged) = HubCommitLookup.resolve(repo: "group/sub/app", sha: String(middle.prefix(8)),
                                                                to: String(latest.prefix(8)), known: forks) else {
            return XCTFail("the fork holding both ends of the range must open it")
        }
        XCTAssertEqual(ranged.root, root)
        XCTAssertEqual(ranged.sha, latest)

        // The upstream itself is checked out but lacks the linked commit: the fork that holds it opens instead.
        let upstream = [HubPRProject(project: "https://example.test/group/sub/app", repo: "app", root: stale, kind: "gitlab"),
                        HubPRProject(project: "https://example.test/me/app", repo: "app", root: path, kind: "gitlab")]
        guard case .found(let viaFork) = HubCommitLookup.resolve(repo: "group/sub/app", sha: String(latest.prefix(8)), known: upstream) else {
            return XCTFail("the fork holding the commit must open it when the upstream checkout lacks it")
        }
        XCTAssertEqual(viaFork.root, root)
        // No checkout holds it: the miss names the upstream checkout, where the link pointed.
        guard case .failed(let lacking) = HubCommitLookup.resolve(repo: "group/sub/app", sha: "0000000", known: upstream) else {
            return XCTFail("a commit no checkout holds must be said")
        }
        XCTAssertTrue(lacking.contains("is not in"), lacking)
    }

    @MainActor
    func testLinkedCheckoutJoinsAnEmptyWorktreeDiscoveryResult() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("hub-empty-worktrees-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        // Git names the checkout by its real path (/private/var/…); resolvingSymlinksInPath() gives /var/….
        XCTAssertNotNil(WorktreeDiscovery.git(folder.path, ["init", "-q"]))
        let root = try XCTUnwrap(WorktreeDiscovery.git(folder.path, ["rev-parse", "--show-toplevel"])?.trimmed)
        let commit = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "core.hooksPath=/dev/null",
                      "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "linked commit"]
        XCTAssertNotNil(WorktreeDiscovery.git(root, commit))
        let sha = try XCTUnwrap(WorktreeDiscovery.git(root, ["rev-parse", "HEAD"])?.trimmed)
        let model = HubModel(wantedSession: nil, tab: .transcript)
        model.initialMode = .worktrees
        model.mode = .worktrees
        model.loadingWorktrees = true
        let added = expectation(description: "linked checkout is in the sidebar")
        let observation = model.$worktrees.filter { rows in rows.contains { $0.path == root } }.prefix(1).sink { _ in
            added.fulfill()
        }
        defer { observation.cancel() }

        // The commit resolves after discovery captured its inputs, but before its empty result lands.
        model.showCommit(repo: root, sha: sha, title: "linked commit")
        model.worktrees = []
        model.loadingWorktrees = false
        model.addWorktreesIfMissing(root, intoEmptyList: true)
        await fulfillment(of: [added], timeout: 5)

        XCTAssertEqual(model.selectedWorktree, root)
        XCTAssertNotNil(model.worktrees.first { $0.path == model.selectedWorktree })
        XCTAssertEqual(model.review?.scope, .commit(sha: sha, title: "linked commit"))
        XCTAssertNil(model.error)
    }

    /// Before the first discovery a link must leave the list empty: opening Worktrees discovers only while the
    /// list is empty, so one repository's rows would stand in for the whole list.
    @MainActor
    func testALinkDoesNotFillTheWorktreeListBeforeDiscovery() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("hub-unloaded-worktrees-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        XCTAssertNotNil(WorktreeDiscovery.git(folder.path, ["init", "-q"]))
        let root = try XCTUnwrap(WorktreeDiscovery.git(folder.path, ["rev-parse", "--show-toplevel"])?.trimmed)
        let model = HubModel(wantedSession: nil, tab: .transcript)
        model.addWorktreesIfMissing(root)
        try await Task.sleep(nanoseconds: 1_500_000_000)
        XCTAssertTrue(model.worktrees.isEmpty, "the full discovery fills an empty list")
    }

    @MainActor
    func testCommitLookupIgnoresOlderLinksAndBothKindsOfStaleAnswer() {
        let model = HubModel(wantedSession: nil, tab: .transcript)
        model.openCommitLink("invalid-first", repo: nil)
        let older = model.commitLinkRequest
        model.openCommitLink("invalid-second", repo: nil)
        let latest = model.commitLinkRequest
        let notice = model.notice
        XCTAssertNotEqual(older, latest)
        model.applyCommitLink(.found(.init(root: "/fixture/app", sha: "abcdef0", title: "old")), request: older)
        model.applyCommitLink(.failed("old error"), request: older)
        XCTAssertNil(model.review)
        XCTAssertEqual(model.notice, notice)
        model.applyCommitLink(.failed("current error"), request: latest)
        XCTAssertEqual(model.notice, "current error")
    }

    @MainActor
    func testEveryNavigationSelectionInvalidatesAPendingCommitLookup() {
        let model = HubModel(wantedSession: nil, tab: .transcript)
        let changes: [() -> Void] = [
            { model.selectedID = "session" },
            { model.prs.selectedID = "pr" },
            { model.selectedWorktree = "/fixture/app" },
            { model.mode = .timeline },
            { model.inbox.selectedID = "item" },
            { model.agents.selectedID = "agent" },
        ]
        for change in changes {
            let request = model.commitLinkRequest
            change()
            XCTAssertNotEqual(model.commitLinkRequest, request)
            model.notice = "later navigation"
            model.applyCommitLink(.found(.init(root: "/fixture/app", sha: "abcdef0", title: "old")), request: request)
            model.applyCommitLink(.failed("old error"), request: request)
            XCTAssertNil(model.review)
            XCTAssertEqual(model.notice, "later navigation")
        }
    }

    @MainActor
    func testColdLaunchSelectionPreservesADelayedCommitLookup() async throws {
        let model = HubModel(wantedSession: nil, tab: .transcript)
        model.initialMode = .worktrees
        model.loadingWorktrees = true // No worktree discovery in this logic test.
        model.readSessionCache = { _ in nil }
        let session = HubSession(sessionId: "fixture-launch")
        model.readSessions = { _ in [session] }
        let loaded = expectation(description: "launch sessions loaded")
        model.writeSessionCache = { _, _ in loaded.fulfill() }
        let request = model.commitLinkRequest
        model.loadSessions()
        await fulfillment(of: [loaded], timeout: 2)

        XCTAssertEqual(model.selectedID, session.id)
        XCTAssertEqual(model.mode, .worktrees)
        XCTAssertEqual(model.commitLinkRequest, request, "automatic startup selection must keep the pending lookup")
        let defaultWorktree = HubWorktree(path: "/fixture/default", repo: "default", commonDir: "/fixture/default/.git", branch: "main", isMain: true)
        model.selectDefaultWorktree([defaultWorktree])
        XCTAssertEqual(model.commitLinkRequest, request, "automatic discovery must also keep the pending lookup")
        model.applyCommitLink(.found(.init(root: "/fixture/app", sha: "abcdef0", title: "linked")), request: request)
        XCTAssertEqual(model.selectedWorktree, "/fixture/app")
        XCTAssertEqual(model.review?.scope, .commit(sha: "abcdef0", title: "linked"))

        let later = model.commitLinkRequest
        model.selectedID = "another-session"
        XCTAssertNotEqual(model.commitLinkRequest, later, "later navigation must still cancel old lookups")
        model.applyCommitLink(.failed("stale"), request: later)
        XCTAssertNil(model.notice)
    }

    @MainActor
    func testReopeningTheSelectedCommitRevealsTheDiffAndScrollsAgain() throws {
        let diffKey = "hub.prs.showDiff", foldKey = "hub.prs.fold.commits"
        let previousDiff = HubDefaults.store.object(forKey: diffKey)
        let previousFold = HubDefaults.store.object(forKey: foldKey)
        defer {
            HubDefaults.store.set(previousDiff, forKey: diffKey)
            HubDefaults.store.set(previousFold, forKey: foldKey)
        }
        let model = PRsModel()
        let review = ReviewModel(repo: URL(fileURLWithPath: "/fixture/app"), options: DiffViewOptions(), renderer: NullRenderer())
        let commit = HubPRDetail.Commit(sha: "abcdef0123", title: "linked", author: nil, authorLogin: nil, date: nil, body: nil)
        review.scope = .commit(sha: commit.sha, title: commit.title)
        var previousScroll: PRCommitScroll?

        for _ in 0..<2 {
            HubDefaults.store.set(false, forKey: diffKey)
            HubDefaults.store.set(true, forKey: foldKey)
            model.showLinkedCommit(commit, prID: "fixture-pr", review: review)

            XCTAssertTrue(HubDefaults.store.bool(forKey: diffKey))
            XCTAssertFalse(HubDefaults.store.bool(forKey: foldKey))
            let scroll = try XCTUnwrap(model.commitScroll)
            XCTAssertEqual(scroll.prID, "fixture-pr")
            XCTAssertEqual(scroll.sha, commit.sha)
            XCTAssertNotEqual(scroll.id, previousScroll?.id)
            XCTAssertEqual(review.scope, .commit(sha: commit.sha, title: commit.title))
            previousScroll = scroll
        }
    }

    @MainActor
    func testANewRequestClearsThePreviousNoticeForTheSamePR() throws {
        let model = PRsModel()
        // A bare ref with no rows or known project starts no CLI fetch in this logic test.
        let ref = try XCTUnwrap(HubPRRef("7"))
        model.notice = PRNotice(ref: ref, text: "previous commit missing; whole PR shows")
        model.request(ref, commit: "abcdef0")
        XCTAssertNil(model.notice)
        XCTAssertEqual(model.pendingCommit?.sha, "abcdef0")

        let review = ReviewModel(repo: URL(fileURLWithPath: "/fixture/app"), options: DiffViewOptions(), renderer: NullRenderer())
        let commit = HubPRDetail.Commit(sha: "abcdef0123", title: "linked", author: nil, authorLogin: nil, date: nil, body: nil)
        review.scope = .commit(sha: commit.sha, title: commit.title)
        model.showLinkedCommit(commit, prID: "fixture-pr", review: review)
        XCTAssertNil(model.notice, "a successful same-PR link must not retain the old missing-commit warning")

        model.request(ref, commit: "invalid")
        XCTAssertEqual(model.notice?.text, HubCommitSha.invalid("invalid"), "new validation errors still show")
        XCTAssertNil(model.pendingCommit)
        model.request(ref)
        XCTAssertNil(model.notice, "a whole-PR request clears the previous validation error too")
    }

    @MainActor
    func testANewPRLinkDiscardsBothOutcomesOfAnOlderLocalLookup() throws {
        let model = PRsModel()
        let ref = try XCTUnwrap(HubPRRef("7"))
        // Bare refs and no rows keep these requests off the CLI.
        for commit in ["abcdef0", "abcdef0..1234567", "invalid", ""] {
            let old = model.beginRangeLookup()
            model.request(ref, commit: commit.isEmpty ? nil : commit)
            var applied: [String] = []
            model.finishRangeLookup(old) { applied.append("stale success") }
            model.finishRangeLookup(old) { applied.append("stale failure") }
            XCTAssertTrue(applied.isEmpty, "old results cannot change scope or reset it to the whole PR")
            let current = model.beginRangeLookup()
            model.finishRangeLookup(old) { applied.append("stale while newer lookup runs") }
            model.finishRangeLookup(current) { applied.append("current") }
            XCTAssertEqual(applied, ["current"], "discarding old results must preserve the newer lookup")
            model.finishRangeLookup(current) { applied.append("duplicate") }
            XCTAssertEqual(applied, ["current"])
        }
    }

    @MainActor
    func testAMissingPRCommitReplacesThePreviousCommitScopeWithTheWholePR() throws {
        let json = """
        {"repo":"app","repoRoot":"/fixture/app","origin":{"kind":"github","host":"github.com","web":"https://github.com/acme/app"},
         "number":7,"title":"t","state":"OPEN","draft":false,"author":"alice","headBranch":"feature","baseBranch":"develop",
         "url":"https://github.com/acme/app/pull/7","labels":[],"reviewers":[],"headSha":"abcdef0123","crossRepository":false,"headRepo":null}
        """
        let pr = try JSONDecoder().decode(HubPR.self, from: Data(json.utf8))
        let model = PRsModel()
        let review = ReviewModel(repo: URL(fileURLWithPath: "/fixture/app"), options: DiffViewOptions(), renderer: NullRenderer())
        review.scope = .commit(sha: "1111111", title: "previous")
        let missing = PRCommitPick(ref: HubPRRef(project: "acme/app", number: 7), sha: "0000000", asked: Date())

        model.showMissingCommit(missing, in: pr, review: review)

        XCTAssertEqual(review.scope, PRsModel.scope(pr, detail: nil))
        XCTAssertTrue(model.notice?.text.contains("so the whole PR shows") == true)
        XCTAssertEqual(model.notice?.ref, missing.ref)
    }

    /// A range link waits for a fresh detail when the cached one predates its newer end; when that detail
    /// fails, the missing end is said, never dropped with the old diff left on screen.
    @MainActor
    func testAFailedDetailSaysTheMissingEndOfARange() throws {
        let json = """
        {"repo":"app","repoRoot":"/fixture/app","origin":{"kind":"github","host":"github.com","web":"https://github.com/acme/app"},
         "number":7,"title":"t","state":"OPEN","draft":false,"author":"alice","headBranch":"feature","baseBranch":"develop",
         "url":"https://github.com/acme/app/pull/7","labels":[],"reviewers":[],"headSha":"abcdef0123","crossRepository":false,"headRepo":null}
        """
        let pr = try JSONDecoder().decode(HubPR.self, from: Data(json.utf8))
        let model = PRsModel()
        // A bare ref with no rows or known project starts no CLI fetch in this logic test.
        let ref = try XCTUnwrap(HubPRRef("7"))
        let cached = [HubPRDetail.Commit(sha: "aaaaaaa111", title: "from", author: nil, authorLogin: nil, date: nil, body: nil)]

        model.request(ref, commit: "aaaaaaa..bbbbbbb")
        model.detailFailed(pr, cached: cached)
        XCTAssertNil(model.pendingCommit)
        XCTAssertEqual(model.notice?.text, "Could not load the commits of #7 to select bbbbbbb")

        model.request(ref, commit: "aaaaaaa")
        model.detailFailed(pr, cached: cached)
        XCTAssertNil(model.notice, "a cached commit is already selectable, so nothing is missing")
    }

    /// A deep link's failure is the only word on why the link opened nothing: a list load that lands after it,
    /// answered or failed, replaces the list's own notices and keeps that one until it is dismissed.
    @MainActor
    func testADeepLinkFailureSurvivesAnsweredAndFailedListLoads() {
        struct ListDown: LocalizedError { var errorDescription: String? { "gh: network down" } }
        let model = PRsModel()
        let direct = PRListNotice("Could not open #7: no such PR")
        let stale = PRListNotice("app: rate limited")
        model.listAnswered([stale])
        model.directFailed(direct)

        model.listAnswered([PRListNotice("web: Cannot resolve git.example.org")])
        XCTAssertEqual(model.errors.map(\.text), ["web: Cannot resolve git.example.org", direct.text])

        model.listFailed(ListDown())
        XCTAssertEqual(model.errors.map(\.text), ["Could not list the PRs/MRs: gh: network down", direct.text])

        model.dismissError(direct)
        model.listFailed(ListDown())
        XCTAssertEqual(model.errors.map(\.text), ["Could not list the PRs/MRs: gh: network down"])
    }

    /// The next link replaces a failed link's notice, also when a listed row opens it without a direct fetch, and a
    /// list that lands later does not bring the old notice back.
    @MainActor
    func testALinkOpenedFromAListedRowClearsTheFailedLinkBeforeIt() throws {
        // No checkout (repoRoot null): selecting the row starts no CLI fetch in this logic test.
        let json = """
        {"prs":[{"repo":"app","repoRoot":null,"origin":{"kind":"github","host":"github.com","web":"https://github.com/acme/app"},
         "number":7,"title":"t","state":"OPEN","draft":false,"author":"alice","headBranch":"feature","baseBranch":"develop",
         "url":"https://github.com/acme/app/pull/7","labels":[],"reviewers":[],"headSha":null,"crossRepository":false,"headRepo":null}],
         "repos":[]}
        """
        let list = try JSONDecoder().decode(HubPRList.self, from: Data(json.utf8))
        let model = PRsModel()
        model.apply(list, key: "fixture", flash: false)
        let failed = PRListNotice("Could not open acme/app#99: no such PR")
        model.directFailed(failed)
        XCTAssertEqual(model.errors, [failed])

        model.request(try XCTUnwrap(HubPRRef("acme/app#7")))
        XCTAssertEqual(model.selected?.number, 7)
        XCTAssertEqual(model.errors, [], "the link opened its PR, so the previous link's failure no longer shows")
        model.apply(list, key: "fixture", flash: false)
        XCTAssertEqual(model.errors, [], "a list that lands after the newer link does not bring the old failure back")
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

    /// A review model over one repository whose diff shows `src/a.ts`, with a proposal whose drafts sit on `paths`.
    private func draftModel(drafts paths: [String]) throws -> ReviewModel {
        var object = sample()
        object["drafts"] = paths.enumerated().map { index, path in
            ["id": "0\(index + 1)", "path": path, "line": 2, "side": "additions", "severity": "nit",
             "body": "Rename it.", "status": "proposed"] as [String: Any]
        }
        let model = ReviewModel(repo: URL(fileURLWithPath: "/work/shop"), options: DiffViewOptions(), renderer: NullRenderer())
        model.proposal = try ProposalDocument(url: try proposalFile(object))
        // Another folder than the model's default root, so setRoots takes these files instead of keeping that root's.
        var root = ReviewRoot(folder: "/work/shop-review", repo: URL(fileURLWithPath: "/work/shop"))
        root.files = [DiffFile(id: "src/a.ts", path: "src/a.ts", oldPath: nil, status: .modified, additions: 1, deletions: 0,
                               oldContents: "a\n", newContents: "a\nb\n", skipped: nil)]
        model.setRoots([root])
        return model
    }

    func testAnOffDiffDraftSaysSoAndQueuesNoLaterReveal() throws {
        let model = try draftModel(drafts: ["src/elsewhere.ts"])
        model.revealDraft("01")
        XCTAssertEqual(model.notice, "elsewhere.ts has no change in this scope.")
        XCTAssertNil(model.pendingRevealPath, "a later load must not open the draft's file unasked")
    }

    func testAStoredReviewIsReadOffTheMainThreadAndThenShown() throws {
        let model = ReviewModel(repo: URL(fileURLWithPath: "/work/shop"), options: DiffViewOptions(), renderer: NullRenderer())
        // Already on the review's head, so no reload starts in the test.
        model.scope = .commit(sha: "bbb", title: "head")
        model.attachProposal(path: try proposalFile(sample()).path)
        XCTAssertNil(model.proposal, "the read runs in the background; the click returns at once")
        let shown = expectation(for: NSPredicate { _, _ in model.proposal != nil }, evaluatedWith: nil)
        wait(for: [shown], timeout: 10)
        XCTAssertEqual(model.proposal?.headSha, "bbb")
        XCTAssertEqual(model.scope, .commit(sha: "bbb", title: "head"))
    }

    func testTheAutomaticAttachKeepsAScopeThatNamesCommits() throws {
        let document = try ProposalDocument(url: try proposalFile(sample()))
        let newer = DiffScope.range(base: "aaa", head: "ccc1234", label: "#42 newer push")
        XCTAssertNil(ReviewModel.scope(showing: document, over: newer, chosen: false), "a --range launch at a newer head stays")
        XCTAssertNil(ReviewModel.scope(showing: document, over: .commit(sha: "ddd5678", title: "one commit"), chosen: false))
        XCTAssertNil(ReviewModel.scope(showing: document, over: .commit(sha: "bbb", title: "the head"), chosen: true),
                     "a scope already on the review's head stays")
        for (current, chosen) in [(DiffScope.uncommitted, false), (newer, true)] {
            if case .range(let base, let head, _, _) = ReviewModel.scope(showing: document, over: current, chosen: chosen) {
                XCTAssertEqual([base, head], ["aaa", "bbb"])
            } else {
                XCTFail("\(current) chosen=\(chosen) must move to the review's range")
            }
        }
    }

    func testAReusedReviewWindowFollowsTheProposalsNewCheckout() throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("review-checkout-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: base) }
        let old = base.appendingPathComponent("old"), new = base.appendingPathComponent("new")
        try FileManager.default.createDirectory(at: new, withIntermediateDirectories: true)
        let model = ReviewModel(repo: old, options: DiffViewOptions(), renderer: NullRenderer())
        model.adoptProposalCheckout(base.appendingPathComponent("missing"), prTarget: nil)
        XCTAssertEqual(model.repo.path, old.path, "a checkout that does not exist is never adopted")
        model.adoptProposalCheckout(new, prTarget: nil)
        XCTAssertEqual(model.repo.path, new.path, "the agent's old worktree is gone: the window moves to the new one")

        try FileManager.default.createDirectory(at: old, withIntermediateDirectories: true)
        let picked = ReviewModel(repo: old, options: DiffViewOptions(), renderer: NullRenderer())
        picked.switchWorktree(to: old.path)
        picked.adoptProposalCheckout(new, prTarget: nil)
        XCTAssertEqual(picked.repo.path, old.path, "a checkout the reader picked, and that still exists, stays")
    }

    func testNextDraftShowsOnlyWhenAnUndecidedDraftHasACardOnThisDiff() throws {
        XCTAssertFalse(try draftModel(drafts: ["src/elsewhere.ts"]).hasOpenDraftOnDiff)
        XCTAssertTrue(try draftModel(drafts: ["src/a.ts"]).hasOpenDraftOnDiff)
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

    /// An opened tool call shows what the transcript envelope clipped (Martin, 2026-09-28: "show me the
    /// entire input … the entire output"): the whole command and all 33 output lines of a Bash call
    /// whose preview kept one line of output, and every argument of an Agent call whose preview is its
    /// description.
    func testAnOpenedToolCallCarriesItsWholeInputAndOutput() throws {
        let command = "cd /tmp/atlas && swift build 2>&1 \\\n  | rg -n 'error:' \\\n  | head -40"
        let output = (1...33).map { "line \($0)" }.joined(separator: "\n")
        let prompt = "Read every file under src/parser and list the functions that take more than three parameters."
        func json(_ object: Any) throws -> String {
            String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
        }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("native-detail-\(UUID().uuidString).jsonl")
        try [
            json(["type": "assistant", "uuid": "a1", "message": ["id": "m1", "role": "assistant", "content": [
                ["type": "tool_use", "id": "bash1", "name": "Bash", "input": ["command": command, "description": "Build"]],
                ["type": "tool_use", "id": "short1", "name": "Bash", "input": ["command": "git status --short"]],
                ["type": "tool_use", "id": "agent1", "name": "Agent", "input": ["description": "List long signatures", "prompt": prompt, "subagent_type": "Explore"]],
            ]]]),
            json(["type": "user", "uuid": "u1", "message": ["role": "user", "content": [
                ["type": "tool_result", "tool_use_id": "bash1", "content": output],
                ["type": "tool_result", "tool_use_id": "short1", "content": "M a.swift"],
                ["type": "tool_result", "tool_use_id": "agent1", "content": "Done."],
            ]]]),
        ].joined(separator: "\n").write(to: file, atomically: true, encoding: .utf8)
        let log = try XCTUnwrap(SessionNativeLog.scan(path: file.path))
        func line(_ id: String, _ name: String, input: String, result: String) -> TranscriptToolLine {
            TranscriptToolLine(
                toolId: id, name: name, displayName: name, symbol: "terminal", keyArgument: input, input: input, result: result,
                status: .ok, exitCode: nil, resultChars: nil, duration: nil
            )
        }
        func present(_ line: TranscriptToolLine) throws -> ToolPresentation {
            ToolPresentation.make(line: line, loaded: ToolLoaded(detail: try XCTUnwrap(log.detail(for: line.toolId))), context: 0, cwd: nil)
        }

        let bash = try present(line("bash1", "Bash", input: command, result: "line 1\nline 2…"))
        XCTAssertEqual(bash.block?.lines.count, 33, "the whole output, not the envelope's clipped one")
        XCTAssertEqual(bash.block?.lines.last?.text, "line 33")
        XCTAssertEqual(bash.input?.lines.map(\.text).joined(separator: "\n"), command, "the whole command, line for line")
        // Martin, 2026-09-30: the header held the first line after the paren and the next lines under it,
        // then the numbered input repeated them all. The header keeps the first line and counts the rest.
        XCTAssertEqual(bash.argument, "cd /tmp/atlas && swift build 2>&1 \\", "only the first line goes in the header")
        XCTAssertEqual(bash.moreInputLines, 2)
        XCTAssertTrue(bash.inputRepeatsArgument, "an open call shows the command once, in the numbered input")

        let short = try present(line("short1", "Bash", input: "git status --short", result: "M a.swift"))
        XCTAssertNil(short.input, "a one-line command is shown whole in the header, not repeated below it")
        XCTAssertEqual(short.moreInputLines, 0)

        let agent = try present(line("agent1", "Agent", input: "List long signatures", result: "Done."))
        let arguments = try XCTUnwrap(agent.input?.lines.map(\.text).joined(separator: "\n"), "an Agent call opens to all of its input")
        XCTAssertTrue(arguments.contains(prompt), "the prompt the preview left out")
        XCTAssertTrue(arguments.contains("\"subagent_type\" : \"Explore\""), arguments)
        XCTAssertFalse(agent.inputRepeatsArgument, "an Agent's header names its description, which its JSON input does not repeat")
    }

    /// A call the live tail brought in after the session file was scanned still opens to its whole
    /// output, and a call that was running at the first look gets its result once it is written.
    func testACallWrittenAfterTheScanHasItsDetail() throws {
        func json(_ object: Any) throws -> String {
            String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
        }
        func use(_ id: String, _ command: String) throws -> String {
            try json(["type": "assistant", "uuid": "a-\(id)", "message": ["id": "m-\(id)", "role": "assistant", "content": [
                ["type": "tool_use", "id": id, "name": "Bash", "input": ["command": command]],
            ]]])
        }
        func result(_ id: String, _ text: String) throws -> String {
            try json(["type": "user", "uuid": "r-\(id)", "message": ["role": "user", "content": [
                ["type": "tool_result", "tool_use_id": id, "content": text],
            ]]])
        }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("native-appended-\(UUID().uuidString).jsonl")
        try [use("early", "ls"), result("early", "a.swift")].joined(separator: "\n").write(to: file, atomically: true, encoding: .utf8)
        let log = try XCTUnwrap(SessionNativeLog.scan(path: file.path))
        let output = (1...40).map { "compiled module \($0)" }.joined(separator: "\n")

        let handle = try FileHandle(forWritingTo: file)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(("\n" + [use("late", "swift build"), result("late", output), use("running", "sleep 5")].joined(separator: "\n")).utf8))
        XCTAssertEqual(log.detail(for: "late")?.fullResult, output, "a call written after the scan")
        XCTAssertEqual(log.detail(for: "late")?.command, "swift build")
        XCTAssertNil(log.detail(for: "running")?.fullResult)

        try handle.write(contentsOf: Data(("\n" + result("running", "done")).utf8))
        try handle.close()
        XCTAssertEqual(log.detail(for: "running")?.fullResult, "done", "a running call is not cached without its result")
        XCTAssertNil(log.detail(for: "never"), "an unknown id has no detail")
    }

    /// The lines written after the scan are read once each, however often the rows of a running call
    /// ask for its detail (PR #429 t21: each ask scanned the whole appended part again), and a line
    /// still being written is read once it is whole.
    func testLinesWrittenAfterTheScanAreReadOnce() throws {
        func json(_ object: Any) throws -> String {
            String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
        }
        let use = try json(["type": "assistant", "uuid": "a1", "message": ["id": "m1", "role": "assistant", "content": [
            ["type": "tool_use", "id": "running", "name": "Bash", "input": ["command": "sleep 5"]],
        ]]]) + "\n"
        let result = try json(["type": "user", "uuid": "r1", "message": ["role": "user", "content": [
            ["type": "tool_result", "tool_use_id": "running", "content": "done"],
        ]]]) + "\n"
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("native-once-\(UUID().uuidString).jsonl")
        try "{\"type\":\"user\",\"uuid\":\"u0\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n".write(to: file, atomically: true, encoding: .utf8)
        let log = try XCTUnwrap(SessionNativeLog.scan(path: file.path))
        let handle = try FileHandle(forWritingTo: file)
        defer { try? handle.close() }
        try handle.seekToEnd()

        try handle.write(contentsOf: Data(use.utf8))
        for _ in 0..<5 {
            XCTAssertEqual(log.detail(for: "running")?.command, "sleep 5")
        }
        XCTAssertEqual(log.appendedBytesRead, use.utf8.count, "five asks read the appended line once")

        let half = result.utf8.count / 2
        try handle.write(contentsOf: Data(result.utf8.prefix(half)))
        XCTAssertNil(log.detail(for: "running")?.fullResult)
        XCTAssertEqual(log.appendedBytesRead, use.utf8.count, "a line still being written is left for later")

        try handle.write(contentsOf: Data(result.utf8.dropFirst(half)))
        XCTAssertEqual(log.detail(for: "running")?.fullResult, "done")
        XCTAssertEqual(log.appendedBytesRead, use.utf8.count + result.utf8.count)
    }

    /// A tool row the reader opened shows its whole body; one open by its level's default or by Expand
    /// all stays trimmed, and "… +N lines" / "Show fewer lines" flips either.
    @MainActor
    func testARowOpenedByHandShowsItsWholeBody() {
        let expansion = TranscriptExpansion()
        XCTAssertFalse(expansion.showsAll("t-closed", byDefault: false))

        expansion.toggle("t-hand")
        XCTAssertTrue(expansion.showsAll("t-hand", byDefault: false), "opened by a click")
        expansion.toggle("t-hand#all")
        XCTAssertFalse(expansion.showsAll("t-hand", byDefault: false), "Show fewer lines")

        XCTAssertFalse(expansion.showsAll("t-default", byDefault: true), "open at Inputs + output: trimmed")
        expansion.toggle("t-default#all")
        XCTAssertTrue(expansion.showsAll("t-default", byDefault: true), "… +N lines")

        expansion.setAll(true)
        XCTAssertFalse(expansion.showsAll("t-hand", byDefault: false), "Expand all does not untrim every output")
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

    /// Wrapped code draws one row per line, so the rendered columns split into matching lines, empty
    /// lines and a line's colours kept.
    func testWrappedCodeSplitsTheColumnsLineForLine() {
        let block = CodeBlockBuilder.numbered("kill -TERM -58225\n\nsleep 2", language: .shell)
        let rendered = CodeBlockRenderer.attributed(block, limit: nil, highlight: true)
        let bodies = CodeBlockRenderer.lines(of: rendered.body)
        let gutters = CodeBlockRenderer.lines(of: rendered.gutter)

        XCTAssertEqual(bodies.map { String($0.characters) }, ["kill -TERM -58225", "", "sleep 2"])
        XCTAssertEqual(gutters.map { String($0.characters) }, ["1", "2", "3"])
        XCTAssertEqual(bodies[0].runs.count, rendered.body[rendered.body.range(of: "kill -TERM -58225")!].runs.count, "the line keeps its colours")
    }

    /// Wrap mode splits only the first lines into rows; the rest comes back as one block.
    func testWrappedCodeSplitsOnlyTheFirstLinesIntoRows() {
        let text = AttributedString((1...5).map { "line \($0)" }.joined(separator: "\n"))
        let split = CodeBlockRenderer.lines(of: text, limit: 2)
        XCTAssertEqual(split.map { String($0.characters) }, ["line 1", "line 2"])

        let short = CodeBlockRenderer.lines(of: AttributedString("a\nb"), limit: 2)
        XCTAssertEqual(short.map { String($0.characters) }, ["a", "b"])
    }

    /// The rest past the first rows is built with the block: a diff line keeps its mark, no line numbers.
    func testTheWrapTailKeepsDiffMarksAndLeavesNumbersOut() {
        let limit = CodeBlockRenderer.firstDrawLimit
        let diff = CodeBlock(
            lines: (1...(limit + 2)).map { CodeLine(number: $0, mark: $0 == limit + 1 ? .added : $0 == limit + 2 ? .removed : .context, text: "l\($0)") },
            language: .plain
        )
        let rendered = CodeBlockRenderer.attributed(diff, limit: nil, highlight: false)
        XCTAssertEqual(rendered.wrapTail.map { String($0.characters).replacingOccurrences(of: " ", with: "") }, "+l\(limit + 1)\n-l\(limit + 2)")

        let plain = CodeBlockBuilder.numbered((1...(limit + 2)).map { "c\($0)" }.joined(separator: "\n"), language: .plain)
        let numbered = CodeBlockRenderer.attributed(plain, limit: nil, highlight: false)
        XCTAssertEqual(numbered.wrapTail.map { String($0.characters) }, "c\(limit + 1)\nc\(limit + 2)", "copying the tail copies only the code")
        XCTAssertNil(CodeBlockRenderer.attributed(CodeBlockBuilder.numbered("a\nb", language: .plain), limit: nil, highlight: false).wrapTail)

        let firstDraw = CodeBlockRenderer.attributed(plain, limit: nil, highlight: false, drawn: limit)
        XCTAssertEqual(firstDraw.wrapTail.map { String($0.characters) }, "\n", "the first draw keeps the tail's height, blank")
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

    /// The bounded first draw leaves lines blank, and VoiceOver still hears every shown line of them.
    func testFirstDrawStillSpeaksEveryShownLine() {
        let changes = (1...300).map { "+line \($0)" }.joined(separator: "\n")
        let diff = CodeBlockBuilder.unifiedDiff("@@ -1,0 +1,300 @@\n\(changes)", language: .plain)
        let spokenDiff = CodeBlockRenderer.attributed(diff, limit: nil, highlight: false, drawn: 200).spoken ?? ""
        XCTAssertEqual(spokenDiff.split(separator: "\n").count, 300)
        XCTAssertTrue(spokenDiff.hasSuffix("added: line 300"), "the lines past the first draw are read too")

        let plain = CodeBlockBuilder.numbered((1...300).map { "line \($0)" }.joined(separator: "\n"), language: .plain)
        let spokenPlain = CodeBlockRenderer.attributed(plain, limit: nil, highlight: false, drawn: 200).spoken ?? ""
        XCTAssertTrue(spokenPlain.hasSuffix("line 300"), "a cut plain block reads its hidden lines too")
        XCTAssertEqual(
            CodeBlockRenderer.attributed(plain, limit: 10, highlight: false, drawn: 200).spoken, nil,
            "a block the first draw shows whole reads its text"
        )
    }

    private func hostPR(host: String, web: String, number: Int) throws -> HubPR {
        let json = """
        {"repo":"app","repoRoot":null,"origin":{"kind":"github","host":"\(host)","web":"\(web)"},
         "number":\(number),"title":"t","state":"open","draft":false,"author":"a","headBranch":"x","baseBranch":"main",
         "url":"\(web)/pull/\(number)","labels":[],"reviewers":[]}
        """
        return try JSONDecoder().decode(HubPR.self, from: Data(json.utf8))
    }

    func testAPageRefMatchesOnlyTheRowOfItsOwnForgeHost() throws {
        let ref = try XCTUnwrap(HubPRRef("https://github.com/team/app/pull/7"))
        let onGitHub = try hostPR(host: "github.com", web: "https://github.com/team/app", number: 7)
        let elsewhere = try hostPR(host: "gitlab.example.test", web: "https://gitlab.example.test/team/app", number: 7)
        XCTAssertEqual(ref.host, "github.com")
        XCTAssertTrue(ref.matches(onGitHub))
        XCTAssertFalse(ref.matches(elsewhere))
        XCTAssertTrue(HubPRRef(project: "team/app", number: 7).matches(elsewhere), "a path-only ref has no host to compare")
    }

    private func queryPR(number: Int, title: String, author: String) throws -> HubPR {
        let json = """
        {"repo":"app","repoRoot":null,"origin":{"kind":"gitlab","host":"h","web":"https://gitlab.example.test/group/app"},
         "number":\(number),"title":"\(title)","state":"opened","draft":false,"author":"\(author)","headBranch":"feature/x","baseBranch":"main",
         "url":"https://gitlab.example.test/group/app/-/merge_requests/\(number)","labels":[],"reviewers":[]}
        """
        return try JSONDecoder().decode(HubPR.self, from: Data(json.utf8))
    }

    func testPRQueryReadsAuthorIdsAndText() throws {
        let query = PRQuery("author:Alice !7412 login")
        XCTAssertEqual(query.author, "alice")
        XCTAssertEqual(query.numbers, [7412])
        XCTAssertEqual(query.text, ["login"])
        XCTAssertEqual(PRQuery("@bob").author, "bob")
        // A bare number is an id and title text at once.
        XCTAssertEqual(PRQuery("Expo 57").numbers, [57])
        XCTAssertEqual(PRQuery("Expo 57").text, ["expo", "57"])
        XCTAssertTrue(PRQuery("  ").isEmpty)
    }

    func testPRQueryMatchesByIdAuthorOrTitle() throws {
        let pr = try queryPR(number: 7412, title: "Fix the login form", author: "alice")
        XCTAssertTrue(PRQuery("!7412").matches(pr))
        XCTAssertTrue(PRQuery("7412").matches(pr))
        XCTAssertFalse(PRQuery("#12").matches(pr))
        XCTAssertTrue(PRQuery("author:ali").matches(pr))
        XCTAssertFalse(PRQuery("author:bob").matches(pr))
        XCTAssertTrue(PRQuery("author:alice login").matches(pr))
        XCTAssertFalse(PRQuery("author:alice signup").matches(pr))
        XCTAssertTrue(PRQuery("login 57").matches(try queryPR(number: 3, title: "login 57", author: "bob")))
    }
}
