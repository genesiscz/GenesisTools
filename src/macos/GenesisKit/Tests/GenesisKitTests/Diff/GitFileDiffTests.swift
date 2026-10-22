import SwiftUI
import WebKit
import XCTest
@testable import GenesisKit

/// A file's two sides per scope (GitFileDiffModel), and the rendered diff the Changes mode shows for a note.
@MainActor
final class GitFileDiffTests: XCTestCase {
    private func git(_ args: [String], in repo: URL) throws -> String {
        let result = try GenesisKitGTCLIProvider().git(args, in: repo, input: nil, gitDirectory: nil, environment: [
            "GIT_AUTHOR_NAME": "Alice", "GIT_AUTHOR_EMAIL": "alice@example.com",
            "GIT_COMMITTER_NAME": "Alice", "GIT_COMMITTER_EMAIL": "alice@example.com",
        ])
        XCTAssertEqual(result.status, 0, String(decoding: result.stderr, as: UTF8.self))
        return String(decoding: result.stdout, as: UTF8.self).trimmed
    }

    /// A changed and an added PNG carry their sides' sources, and the page's image URLs serve those bytes.
    func testAnImageInTheDiffNamesItsSidesAndTheirBytesAreServed() throws {
        let repo = FileManager.default.temporaryDirectory.appendingPathComponent("gk-diff-image-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: repo) }
        let before = Data([0x89, 0x50, 0x4E, 0x47, 0, 1, 2])
        let after = Data([0x89, 0x50, 0x4E, 0x47, 0, 3, 4, 5])
        _ = try git(["init", "-q"], in: repo)
        try before.write(to: repo.appendingPathComponent("logo.png"))
        _ = try git(["add", "logo.png"], in: repo)
        _ = try git(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "logo"], in: repo)
        try after.write(to: repo.appendingPathComponent("logo.png"))
        try after.write(to: repo.appendingPathComponent("new.png"))
        try Data([0, 1]).write(to: repo.appendingPathComponent("blob.bin"))
        try "<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n".write(to: repo.appendingPathComponent("icon.svg"), atomically: true, encoding: .utf8)

        let files = try GitWorkingTreeSource(repo: repo).load(scope: .uncommitted).files
        let changed = try XCTUnwrap(files.first { $0.path == "logo.png" }?.image)
        let added = try XCTUnwrap(files.first { $0.path == "new.png" }?.image)
        XCTAssertNil(files.first { $0.path == "blob.bin" }?.image, "a binary file that is no image has no picture")
        XCTAssertNil(added.old, "an added image has no before side")
        let svg = try XCTUnwrap(files.first { $0.path == "icon.svg" })
        XCTAssertNotNil(svg.newContents, "an SVG keeps its code")
        XCTAssertEqual(svg.image?.new, .file(repo.appendingPathComponent("icon.svg").path), "and names its picture too")

        let load = { (source: DiffImage.Source?) in try XCTUnwrap(source.flatMap { DiffImageRegistry.load($0) }).data }
        XCTAssertEqual(try load(changed.old), before, "the before side comes from HEAD")
        XCTAssertEqual(try load(changed.new), after, "the after side is the working-tree file")
        XCTAssertEqual(try load(added.new), after)

        let url = try XCTUnwrap(URL(string: DiffImageRegistry.url(try XCTUnwrap(changed.old))))
        XCTAssertTrue(url.path.hasPrefix(DiffImageRegistry.prefix))
        XCTAssertEqual(DiffImageRegistry.source(String(url.path.dropFirst(DiffImageRegistry.prefix.count))), changed.old)
        XCTAssertEqual(DiffImageRegistry.mimeType(for: "a/B.PNG"), "image/png")

        // Overwritten while its diff stays open: the image is a new value with a new URL, so the page loads it again.
        try Data([0x89, 0x50, 0x4E, 0x47, 9, 9, 9, 9, 9]).write(to: repo.appendingPathComponent("logo.png"))
        let reread = try XCTUnwrap(GitWorkingTreeSource(repo: repo).load(scope: .uncommitted).files.first { $0.path == "logo.png" }?.image)
        XCTAssertEqual(reread.new, changed.new, "the same place")
        XCTAssertNotEqual(reread, changed, "but another revision")
        XCTAssertNotEqual(DiffImageRegistry.url(try XCTUnwrap(reread.new), revision: reread.revision),
                          DiffImageRegistry.url(try XCTUnwrap(changed.new), revision: changed.revision))

        // HEAD moves while the working file stays: the before side `HEAD:logo.png` names other bytes now.
        let other = repo.deletingLastPathComponent().appendingPathComponent("gk-diff-other-\(UUID().uuidString).png")
        // A zero byte keeps it binary, as the text diff decides.
        try Data([0x89, 0x50, 0x4E, 0x47, 0, 7, 7]).write(to: other)
        defer { try? FileManager.default.removeItem(at: other) }
        let oid = try git(["hash-object", "-w", other.path], in: repo)
        _ = try git(["update-index", "--cacheinfo", "100644,\(oid),logo.png"], in: repo)
        _ = try git(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "logo 2"], in: repo)
        let moved = try XCTUnwrap(GitWorkingTreeSource(repo: repo).load(scope: .uncommitted).files.first { $0.path == "logo.png" }?.image)
        XCTAssertNotEqual(moved.old, reread.old, "another object")
        XCTAssertNotEqual(moved.revision, reread.revision)
        XCTAssertEqual(try load(moved.old), Data([0x89, 0x50, 0x4E, 0x47, 0, 7, 7]))
        XCTAssertEqual(try load(reread.old), before, "a side read before HEAD moved still loads the bytes it showed")
        XCTAssertEqual(DiffImageRegistry.load(try XCTUnwrap(reread.old))?.path, "logo.png", "named by its file, for its type")
    }

    /// A picture over the budget is not read, from disk or from git; under it, the same call reads it through the
    /// provider (the host's, when it set one).
    func testAnImageOverTheBudgetIsNotLoaded() throws {
        let repo = FileManager.default.temporaryDirectory.appendingPathComponent("gk-diff-budget-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: repo) }
        let bytes = Data([0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4, 5])
        _ = try git(["init", "-q"], in: repo)
        try bytes.write(to: repo.appendingPathComponent("big.png"))
        _ = try git(["add", "big.png"], in: repo)
        let file = DiffImage.Source.file(repo.appendingPathComponent("big.png").path)
        let blob = DiffImage.Source.blob(repo: repo.path, object: ":big.png", path: "big.png")
        XCTAssertNil(DiffImageRegistry.load(file, maxBytes: 4))
        XCTAssertNil(DiffImageRegistry.load(blob, maxBytes: 4))
        XCTAssertEqual(DiffImageRegistry.load(file, maxBytes: 9)?.data, bytes)

        final class RecordingGitProvider: GenesisKitGTCLIProvider {
            var calls: [[String]] = []
            override func git(_ arguments: [String], in repo: URL, input: Data? = nil, gitDirectory: String? = nil,
                              environment: [String: String]? = nil) throws -> GitRunResult {
                calls.append(arguments)
                return try super.git(arguments, in: repo, input: input, gitDirectory: gitDirectory, environment: environment)
            }
        }
        let recording = RecordingGitProvider()
        let previous = GenesisKitGT.provider
        GenesisKitGT.provider = recording
        defer { GenesisKitGT.provider = previous }
        XCTAssertEqual(DiffImageRegistry.load(blob, maxBytes: 9)?.data, bytes)
        XCTAssertEqual(recording.calls, [["cat-file", "-s", ":big.png"], ["cat-file", "blob", ":big.png"]])
    }

    /// An SVG symlinked out of the repository shows its target path as code and has no picture: the picture would
    /// be the file outside.
    func testASymlinkedSVGHasNoPicture() throws {
        let repo = FileManager.default.temporaryDirectory.appendingPathComponent("gk-diff-link-\(UUID().uuidString)")
        let outside = repo.deletingLastPathComponent().appendingPathComponent("gk-diff-outside-\(UUID().uuidString).svg")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: repo)
            try? FileManager.default.removeItem(at: outside)
        }
        try "<svg xmlns=\"http://www.w3.org/2000/svg\"><title>outside</title></svg>\n"
            .write(to: outside, atomically: true, encoding: .utf8)
        _ = try git(["init", "-q"], in: repo)
        _ = try git(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "start"],
                    in: repo)
        try FileManager.default.createSymbolicLink(at: repo.appendingPathComponent("icon.svg"), withDestinationURL: outside)

        let svg = try XCTUnwrap(GitWorkingTreeSource(repo: repo).load(scope: .uncommitted).files.first { $0.path == "icon.svg" })
        XCTAssertEqual(svg.newContents, outside.path, "the code diff is the link's target")
        XCTAssertNil(svg.image)
        XCTAssertNil(DiffImageRegistry.load(.file(repo.appendingPathComponent("icon.svg").path)), "served bytes refuse it too")
    }

    func testUntrackedColorContrastsWithBothPageSchemes() throws {
        for (name, background) in [(NSAppearance.Name.aqua, 1.0), (.darkAqua, 0.0)] {
            let appearance = try XCTUnwrap(NSAppearance(named: name))
            appearance.performAsCurrentDrawingAppearance {
                guard let color = NSColor(GitChangeKind.untracked.color).usingColorSpace(.sRGB) else {
                    return XCTFail("untracked color must resolve to RGB")
                }
                func linear(_ value: CGFloat) -> Double {
                    let channel = Double(value * color.alphaComponent) + background * Double(1 - color.alphaComponent)
                    return channel <= 0.04045 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4)
                }
                let luminance = 0.2126 * linear(color.redComponent) + 0.7152 * linear(color.greenComponent) + 0.0722 * linear(color.blueComponent)
                let contrast = (max(luminance, background) + 0.05) / (min(luminance, background) + 0.05)
                XCTAssertGreaterThanOrEqual(contrast, 3, "untracked filenames must remain visible in \(name)")
            }
        }
    }

    func testPanelRetargetsEqualGenerationsAndRejectsOldDates() async throws {
        let first = URL(fileURLWithPath: "/fixture/first"), second = URL(fileURLWithPath: "/fixture/second")
        let a = [GitStatusEntry(path: "a.md", unstaged: .modified)]
        let b = [GitStatusEntry(path: "b.md", unstaged: .modified)]
        let dates = GitChangeDates()
        let started = expectation(description: "old dates started"), finished = expectation(description: "old dates finished")
        let gate = DispatchSemaphore(value: 0)
        dates.readDates = { root, paths in
            if root == first {
                started.fulfill()
                _ = gate.wait(timeout: .now() + 5)
                finished.fulfill()
            }
            return [paths[0]: .distantPast]
        }
        dates.load(root: first, entries: a, generation: 1)
        await fulfillment(of: [started], timeout: 3)
        dates.load(root: second, entries: b, generation: 1)
        let deadline = Date().addingTimeInterval(3)
        while dates.dates["b.md"] == nil, Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(Set(dates.dates.keys), ["b.md"])
        gate.signal()
        await fulfillment(of: [finished], timeout: 3)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(Set(dates.dates.keys), ["b.md"])
        XCTAssertNotEqual(GitChangeDates.Key(root: first, generation: 1), GitChangeDates.Key(root: second, generation: 1))

        let lists = GitRepoPanelLists()
        let inputs = GitRepoPanelLists.Inputs(root: first, generation: 1, datesVersion: 1, order: .name, filter: "", untracked: true)
        lists.update(inputs, entries: a, dates: [:])
        let loaded = Date().addingTimeInterval(3)
        while lists.lists.changed.isEmpty, Date() < loaded { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(lists.lists(for: first).changed.map(\.path), ["a.md"])
        XCTAssertTrue(lists.lists(for: second).changed.isEmpty, "a new root must never offer old paths")
        var next = inputs
        next.root = second
        lists.update(next, entries: b, dates: [:])
        let updated = Date().addingTimeInterval(3)
        while lists.lists.changed.isEmpty, Date() < updated { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(lists.lists(for: second).changed.map(\.path), ["b.md"])
    }

    func testRenderedMarksAreComputedOffMainCachedAndFenced() async throws {
        let model = MarkdownDiffMarksModel()
        let first = MarkdownDiffMarksModel.Input(old: "old", new: "first")
        let second = MarkdownDiffMarksModel.Input(old: "old", new: "second")
        let started = expectation(description: "old marks started")
        let computed = expectation(description: "new marks computed once")
        let gate = DispatchSemaphore(value: 0)
        model.compute = { old, new in
            XCTAssertFalse(Thread.isMainThread)
            if new == "first" {
                started.fulfill()
                _ = gate.wait(timeout: .now() + 5)
            } else { computed.fulfill() }
            return MarkdownWebView.DiffMark.between(old: old, new: new)
        }
        let pending = Task { await model.load(first) }
        await fulfillment(of: [started], timeout: 3)
        await model.load(second)
        await fulfillment(of: [computed], timeout: 3)
        let marks = model.marks(for: second)
        XCTAssertFalse(marks.isEmpty)
        XCTAssertTrue(model.marks(for: first).isEmpty)
        gate.signal()
        await pending.value
        XCTAssertEqual(model.marks(for: second), marks, "an older result cannot replace the selected pair")
        await model.load(second)
        XCTAssertEqual(model.marks(for: second), marks, "unchanged text reuses cached marks")
    }

    func testUntrackedFilesFoldUnderTheShallowestFolderWithNoOtherChange() {
        let entries = [
            GitStatusEntry(path: "notes/plan.md", unstaged: .modified),
            GitStatusEntry(path: "notes/new.md", unstaged: .untracked),
            GitStatusEntry(path: "data/run1/a.json", unstaged: .untracked),
            GitStatusEntry(path: "data/run1/b.json", unstaged: .untracked),
            GitStatusEntry(path: "data/run2/c.json", unstaged: .untracked),
            GitStatusEntry(path: "misc/deep/only.md", unstaged: .untracked),
            GitStatusEntry(path: "loose.md", unstaged: .untracked),
        ]
        let fold = GitChangeList.foldUntracked(entries)
        XCTAssertEqual(fold.groups.map(\.folder), ["data"])
        XCTAssertEqual(fold.groups.first?.files.count, 3)
        XCTAssertEqual(Set(fold.files.map(\.path)), ["notes/new.md", "misc/deep/only.md", "loose.md"], "a changed folder and a one-file folder stay as files")
    }

    func testTheSortButtonCyclesAndEachOrderSorts() {
        XCTAssertEqual(GitChangeOrder.lastUpdate.next, .name)
        XCTAssertEqual(GitChangeOrder.kind.next, .lastUpdate)
        let entries = [
            GitStatusEntry(path: "b/zeta.md", unstaged: .deleted),
            GitStatusEntry(path: "a/alpha.md", unstaged: .modified),
            GitStatusEntry(path: "c/beta.md", unstaged: .added),
        ]
        let now = Date()
        let dates = ["b/zeta.md": now, "a/alpha.md": now.addingTimeInterval(-3600), "c/beta.md": now.addingTimeInterval(-60)]
        XCTAssertEqual(GitChangeList.sorted(entries, by: .lastUpdate, dates: dates, staged: false).map(\.path), ["b/zeta.md", "c/beta.md", "a/alpha.md"])
        XCTAssertEqual(GitChangeList.sorted(entries, by: .name, dates: dates, staged: false).map(\.path), ["a/alpha.md", "c/beta.md", "b/zeta.md"])
        XCTAssertEqual(GitChangeList.sorted(entries, by: .folder, dates: dates, staged: false).map(\.path), ["a/alpha.md", "b/zeta.md", "c/beta.md"])
        XCTAssertEqual(GitChangeList.sorted(entries, by: .kind, dates: dates, staged: false).map(\.path), ["a/alpha.md", "c/beta.md", "b/zeta.md"])
    }

    func testADiffRequestReadsEveryScopeAndRefusesTheRest() {
        XCTAssertEqual(MarkdownDiffRequest.parse("staged"), MarkdownDiffRequest(scope: .staged))
        XCTAssertEqual(MarkdownDiffRequest.parse(" Uncommitted "), MarkdownDiffRequest(scope: .uncommitted))
        XCTAssertEqual(MarkdownDiffRequest.parse("last"), MarkdownDiffRequest(scope: .lastCommit))
        XCTAssertEqual(MarkdownDiffRequest.parse("commit:A1B2C3D"), MarkdownDiffRequest(scope: .lastCommit, commit: "a1b2c3d"))
        for bad in [nil, "", "head", "commit:", "commit:xyz"] {
            XCTAssertNil(MarkdownDiffRequest.parse(bad), "\(bad ?? "nil")")
        }
        for request in [MarkdownDiffRequest(scope: .branch), MarkdownDiffRequest(scope: .lastCommit), MarkdownDiffRequest(scope: .lastCommit, commit: "abc123")] {
            XCTAssertEqual(MarkdownDiffRequest.parse(request.queryValue), request)
        }
        XCTAssertEqual(MarkdownDiffRequest.fromQuery([URLQueryItem(name: "diff", value: "unstaged")])?.scope, .unstaged)
    }

    func testEveryScopeReadsTheRightSides() throws {
        let repo = FileManager.default.temporaryDirectory.appendingPathComponent("filediff-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: repo) }
        let note = repo.appendingPathComponent("plan.md")
        _ = try git(["init", "-q", "-b", "main"], in: repo)
        try "v1\n".write(to: note, atomically: true, encoding: .utf8)
        _ = try git(["add", "."], in: repo)
        _ = try git(["commit", "-q", "-m", "First"], in: repo)
        _ = try git(["checkout", "-q", "-b", "feat/x"], in: repo)
        try "v2\n".write(to: note, atomically: true, encoding: .utf8)
        _ = try git(["commit", "-q", "-am", "Second"], in: repo)
        try "v3\n".write(to: note, atomically: true, encoding: .utf8)
        _ = try git(["add", "plan.md"], in: repo)
        // The working side is the text on screen, an unsaved draft included.
        let draft = "v4 draft\n"
        let provider = GenesisKitGTCLIProvider()
        func sides(_ scope: GitFileScope, pick: String? = nil) throws -> GitFileDiffModel.Sides {
            try GitFileDiffModel.sides(note, text: draft, scope: scope, pick: pick, provider: provider)
        }
        XCTAssertEqual(try sides(.unstaged).old, "v3\n")
        XCTAssertEqual(try sides(.unstaged).new, draft)
        XCTAssertEqual(try sides(.staged).old, "v2\n")
        XCTAssertEqual(try sides(.staged).new, "v3\n")
        XCTAssertEqual(try sides(.uncommitted).old, "v2\n")
        let last = try sides(.lastCommit)
        XCTAssertEqual(last.commit?.subject, "Second")
        XCTAssertEqual(last.old, "v1\n")
        XCTAssertEqual(last.new, "v2\n")
        XCTAssertEqual(last.history.map(\.subject), ["Second", "First"])
        let first = try sides(.lastCommit, pick: last.history[1].sha)
        XCTAssertNil(first.old, "the first commit added the file")
        XCTAssertEqual(first.new, "v1\n")
        XCTAssertEqual(GitFileDiffModel.diffFile(path: first.path, old: first.old, new: first.new).status, .added)
        // The branch against its base: main is the base here, merge base is First.
        XCTAssertEqual(try sides(.branch).old, "v1\n")
    }

    func testExplicitCommitsAreNotLimitedToTheChooserOrItsAbbreviation() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("diff-pick-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let note = root.appendingPathComponent("note.md")
        _ = try git(["init", "-q", "-b", "main"], in: root)
        var first = ""
        for index in 0..<32 {
            try "version \(index)\n".write(to: note, atomically: true, encoding: .utf8)
            _ = try git(["add", "note.md"], in: root)
            _ = try git(["commit", "-q", "-m", "Version \(index)"], in: root)
            if index == 0 { first = try git(["rev-parse", "HEAD"], in: root) }
        }
        let provider = GenesisKitGTCLIProvider()
        for pick in [first, String(first.prefix(12))] {
            let result = try GitFileDiffModel.sides(note, text: "draft", scope: .lastCommit, pick: pick, provider: provider)
            XCTAssertEqual(result.commit?.sha, first)
            XCTAssertEqual(result.new, "version 0\n")
            XCTAssertEqual(result.history.count, 30, "the chooser remains bounded")
        }
        XCTAssertThrowsError(try GitFileDiffModel.sides(note, text: "", scope: .lastCommit, pick: "deadbeef", provider: provider))
        try "other".write(to: root.appendingPathComponent("other.md"), atomically: true, encoding: .utf8)
        _ = try git(["add", "other.md"], in: root)
        _ = try git(["commit", "-q", "-m", "Other file"], in: root)
        let unrelated = try git(["rev-parse", "HEAD"], in: root)
        XCTAssertThrowsError(try GitFileDiffModel.sides(note, text: "", scope: .lastCommit, pick: unrelated, provider: provider))
        _ = try git(["checkout", "-q", "-b", "other-branch", first], in: root)
        try "branch version\n".write(to: note, atomically: true, encoding: .utf8)
        _ = try git(["commit", "-q", "-am", "Branch version"], in: root)
        let branchPick = try git(["rev-parse", "HEAD"], in: root)
        _ = try git(["checkout", "-q", "main"], in: root)
        XCTAssertEqual(try GitFileDiffModel.sides(note, text: "", scope: .lastCommit, pick: branchPick, provider: provider).new, "branch version\n")
        _ = try git(["mv", "note.md", "renamed.md"], in: root)
        _ = try git(["commit", "-q", "-m", "Rename"], in: root)
        let renamed = root.appendingPathComponent("renamed.md")
        XCTAssertEqual(try GitFileDiffModel.sides(renamed, text: "", scope: .lastCommit, pick: first, provider: provider).new, "version 0\n")
    }

    func testAbsentIndexAndDeletedWorkingFileStayDistinctFromEmptyText() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("diff-deletion-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let note = root.appendingPathComponent("note.md")
        _ = try git(["init", "-q", "-b", "main"], in: root)
        try "saved\n".write(to: note, atomically: true, encoding: .utf8)
        _ = try git(["add", "."], in: root)
        _ = try git(["commit", "-q", "-m", "Saved"], in: root)
        _ = try git(["rm", "--cached", "note.md"], in: root)
        let provider = GenesisKitGTCLIProvider()
        let unstaged = try GitFileDiffModel.sides(note, text: "saved\n", scope: .unstaged, pick: nil, provider: provider)
        XCTAssertNil(unstaged.old)
        XCTAssertEqual(unstaged.new, "saved\n")
        XCTAssertEqual(GitFileDiffModel.diffFile(path: unstaged.path, old: unstaged.old, new: unstaged.new).status, .added)
        try FileManager.default.removeItem(at: note)
        let deleted = try GitFileDiffModel.sides(note, text: nil, scope: .uncommitted, pick: nil, provider: provider)
        XCTAssertEqual(deleted.old, "saved\n")
        XCTAssertNil(deleted.new)
        XCTAssertEqual(GitFileDiffModel.diffFile(path: deleted.path, old: deleted.old, new: deleted.new).status, .deleted)
        let empty = try GitFileDiffModel.sides(note, text: "", scope: .uncommitted, pick: nil, provider: provider)
        XCTAssertEqual(GitFileDiffModel.diffFile(path: empty.path, old: empty.old, new: empty.new).status, .modified)

        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "deleted-\(UUID())")!)
        model.openChanges(GitStatusEntry(path: "note.md", staged: .deleted), staged: true, root: root)
        let doc = try XCTUnwrap(model.selected)
        XCTAssertTrue(doc.missing)
        XCTAssertFalse(model.showsMissingFile(doc), "Changes must be visible for a missing file")
        XCTAssertNil(model.workingText(for: doc))
        model.setMode(.preview)
        XCTAssertTrue(model.showsMissingFile(doc))
        let commit = try XCTUnwrap(provider.history(of: note, limit: 1).first)
        model.revisionView = MarkdownRevision(docID: doc.id, commit: commit, text: "saved\n")
        XCTAssertFalse(model.showsMissingFile(doc), "a past revision must be visible too")
        doc.edit("recovered draft")
        XCTAssertEqual(model.workingText(for: doc), "recovered draft")
    }

    func testNormalAndHistoricalDiffCountsRunOffMain() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("diff-worker-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let note = root.appendingPathComponent("note.md")
        _ = try git(["init", "-q", "-b", "main"], in: root)
        try "saved\n".write(to: note, atomically: true, encoding: .utf8)
        _ = try git(["add", "."], in: root)
        _ = try git(["commit", "-q", "-m", "Saved"], in: root)
        let commit = try XCTUnwrap(GenesisKitGTCLIProvider().history(of: note, limit: 1).first)
        for compare in [false, true] {
            let model = GitFileDiffModel()
            let computed = expectation(description: "background counts")
            model.makeDiff = { path, old, new in
                XCTAssertFalse(Thread.isMainThread)
                let file = GitFileDiffModel.diffFile(path: path, old: old, new: new)
                computed.fulfill()
                return file
            }
            if compare { model.loadCompare(note, text: "draft\n", old: commit, new: nil) }
            else { model.load(note, text: "draft\n", scope: .uncommitted) }
            await fulfillment(of: [computed], timeout: 5)
            let end = Date().addingTimeInterval(3)
            while model.phase != .ready, Date() < end { try await Task.sleep(for: .milliseconds(100)) }
            XCTAssertEqual(model.phase, .ready)
            XCTAssertEqual(model.file?.additions, 1)
            XCTAssertEqual(model.file?.deletions, 1)
        }
    }

    func testTrailingNewlineChangesDoNotDuplicateRenderedContent() async throws {
        final class Loaded: NSObject, WKNavigationDelegate {
            var done: XCTestExpectation?
            func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { done?.fulfill() }
        }
        let loaded = Loaded()
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(MarkdownWebView.AssetSchemeHandler(), forURLScheme: MarkdownWebView.assetScheme)
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 900, height: 700), configuration: config)
        web.navigationDelegate = loaded
        let window = NSWindow(contentRect: web.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = web
        defer { window.contentView = nil }
        let done = expectation(description: "page loaded")
        loaded.done = done
        web.loadHTMLString(MarkdownWebView.template, baseURL: URL(string: "\(MarkdownWebView.assetScheme)://asset/"))
        await fulfillment(of: [done], timeout: 10)

        let cases: [(old: String, new: String, paragraphs: [String], replacements: [String])] = [
            ("Hello", "Hello\n", ["Hello"], []),
            ("Hello\n", "Hello", ["Hello"], []),
            ("Old\n\nHello", "New\n\nHello\n", ["Old", "New", "Hello"], ["Old"]),
            ("Hello", "Goodbye\n", ["Hello", "Goodbye"], ["Hello"]),
        ]
        for (index, sample) in cases.enumerated() {
            let marks = MarkdownWebView.DiffMark.between(old: sample.old, new: sample.new)
            XCTAssertEqual(marks.map(\.old), sample.replacements)
            let hunks = GitHunks.between(old: sample.old, new: sample.new)
            XCTAssertFalse(hunks.isEmpty, "EOF changes remain available for reverting")
            XCTAssertEqual(hunks.reversed().reduce(sample.new) { GitHunks.revert($1, in: $0) }, sample.old)
            _ = try await web.evaluateJavaScript(
                "window.gnRender(\(MarkdownWebView.jsString(sample.new)),[],false,null,{},false,\(index + 1))"
            )
            _ = try await web.evaluateJavaScript("window.gnDiff([\(marks.map(\.json).joined(separator: ","))])")
            let paragraphs = try await web.evaluateJavaScript(
                "Array.from(document.querySelectorAll('#gn-article p')).map(function(p){return p.textContent;})"
            ) as? [String]
            XCTAssertEqual(paragraphs, sample.paragraphs, "case \(index): unchanged content renders only once")
            let replacements = try await web.evaluateJavaScript(
                "Array.from(document.querySelectorAll('.gn-diff-old')).map(function(p){return p.textContent.trim();})"
            ) as? [String]
            XCTAssertEqual(replacements, sample.replacements, "case \(index): only changed content is replaced")
            if sample.replacements.isEmpty {
                let bars = try await web.evaluateJavaScript("document.querySelectorAll('.gn-git-bar').length") as? Int
                XCTAssertEqual(bars, 0, "newline-only edits have no content change/removal bars")
            }
        }
    }

    func testTheRenderedDiffMarksAddedChangedAndRemovedBlocks() async throws {
        final class Loaded: NSObject, WKNavigationDelegate {
            var done: XCTestExpectation?
            func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { done?.fulfill() }
        }
        let loaded = Loaded()
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(MarkdownWebView.AssetSchemeHandler(), forURLScheme: MarkdownWebView.assetScheme)
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 900, height: 700), configuration: config)
        web.navigationDelegate = loaded
        let window = NSWindow(contentRect: web.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = web
        defer { window.contentView = nil }
        let done = expectation(description: "page loaded")
        loaded.done = done
        web.loadHTMLString(MarkdownWebView.template, baseURL: URL(string: "\(MarkdownWebView.assetScheme)://asset/"))
        await fulfillment(of: [done], timeout: 10)

        let old = "---\ntags: [a]\n---\n# Title\n\nThe quick brown fox.\n\nGone paragraph.\n\nKept.\n"
        let new = "---\ntags: [a, b]\n---\n# Title\n\nThe quick red fox jumps.\n\nKept.\n\nBrand new.\n"
        let marks = MarkdownWebView.DiffMark.between(old: old, new: new)
        XCTAssertEqual(marks.map(\.kind), [.modified, .deleted, .added], "the frontmatter is not part of the diff")
        let body = MarkdownFrontmatter.split(new).1
        _ = try await web.evaluateJavaScript("window.gnRender(\(MarkdownWebView.jsString(body)),[],false,null,{},false,1)")
        _ = try await web.evaluateJavaScript("window.gnDiff([\(marks.map(\.json).joined(separator: ","))])")
        func strings(_ js: String) async throws -> [String] {
            try await web.evaluateJavaScript(js) as? [String] ?? []
        }
        let changed = try await strings("Array.from(document.querySelectorAll('.gn-diff-mod,.gn-diff-add')).map(function(e){return e.className.replace(/.*gn-diff-/,'')+':'+e.textContent})")
        XCTAssertEqual(changed, ["mod:The quick red fox jumps.", "add:Brand new."])
        let olds = try await strings("Array.from(document.querySelectorAll('.gn-diff-old')).map(function(e){return (e.classList.contains('gn-diff-pair')?'pair:':'gone:')+e.textContent.trim()})")
        XCTAssertEqual(olds, ["pair:The quick brown fox.", "gone:Gone paragraph."])
        let words = try await strings("Array.from(document.querySelectorAll('mark.gn-ins,mark.gn-del')).map(function(e){return e.className+':'+e.textContent})")
        XCTAssertEqual(words, ["gn-del:brown", "gn-del:fox.", "gn-ins:red", "gn-ins:fox", "gn-ins:jumps."])
        // Strips in the bar column, one per change; a changed block itself carries no background.
        let strips = try await strings("Array.from(document.querySelectorAll('.gn-git-bar')).map(function(e){return e.getAttribute('data-k')})")
        XCTAssertEqual(strips.sorted(), ["added", "modified", "removed", "removed"])
        let interactiveStrips = try await web.evaluateJavaScript("document.querySelectorAll('button.gn-git-bar').length") as? Int
        XCTAssertEqual(interactiveStrips, 0, "rendered-diff-only strips are not keyboard actions")
        let background = try await web.evaluateJavaScript("getComputedStyle(document.querySelector('.gn-diff-mod')).backgroundColor") as? String
        XCTAssertEqual(background, "rgba(0, 0, 0, 0)")
        // A second diff replaces the first instead of stacking on it.
        _ = try await web.evaluateJavaScript("window.gnDiff([])")
        let left = try await web.evaluateJavaScript("document.querySelectorAll('.gn-diff-old,.gn-diff-mod,.gn-diff-add,mark.gn-ins,.gn-git-bar').length") as? Int
        XCTAssertEqual(left, 0)
    }
}
