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

    func testOnlyTheSoftFileLimitOffersShowAnyway() {
        for size in [GitWorkingTreeSource.maxBytes + 1, GitWorkingTreeSource.maxShownBytes,
                     GitWorkingTreeSource.maxShownBytes + 1] {
            let note = GitWorkingTreeSource.largeNote(size)
            XCTAssertEqual(GitWorkingTreeSource.isLarge(note), size <= GitWorkingTreeSource.maxShownBytes,
                           "only an overridable size skip offers the display action")
        }
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

    /// A last-turn review shows a changed image too: its before side is the change log's blob, read from the log's
    /// own object store, and its after side is the working-tree file.
    func testALastTurnImageShowsBothSides() throws {
        let repo = FileManager.default.temporaryDirectory.appendingPathComponent("gk-diff-turns-\(UUID().uuidString)")
        let store = FileManager.default.temporaryDirectory.appendingPathComponent("gk-diff-turns-store-\(UUID().uuidString)")
        let loose = FileManager.default.temporaryDirectory.appendingPathComponent("gk-diff-turns-\(UUID().uuidString).png")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        defer {
            for url in [repo, store, loose] { try? FileManager.default.removeItem(at: url) }
        }
        let before = Data([0x89, 0x50, 0x4E, 0x47, 0, 1, 2])
        let after = Data([0x89, 0x50, 0x4E, 0x47, 0, 3, 4, 5])
        _ = try git(["init", "-q"], in: repo)
        _ = try git(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "start"],
                    in: repo)
        _ = try git(["init", "-q", "--bare", store.path], in: repo)
        try before.write(to: loose)
        let oid = try git(["--git-dir", store.path, "hash-object", "-w", loose.path], in: repo)
        try after.write(to: repo.appendingPathComponent("logo.png"))

        final class TurnsProvider: GenesisKitGTCLIProvider {
            var changes = GitWorkingTreeSource.TurnChanges(files: [], objects: "")
            override func agentTurnChanges(session: String, lastTurns: Int) throws -> GitWorkingTreeSource.TurnChanges {
                changes
            }
        }
        let provider = TurnsProvider()
        provider.changes = GitWorkingTreeSource.TurnChanges(
            files: [.init(path: repo.appendingPathComponent("logo.png").path, beforeOid: oid, skipped: nil)],
            objects: store.path)
        let previous = GenesisKitGT.provider
        GenesisKitGT.provider = provider
        defer { GenesisKitGT.provider = previous }

        let files = try GitWorkingTreeSource(repo: repo).load(scope: .lastTurns(1), session: "s1").files
        let image = try XCTUnwrap(files.first { $0.path == "logo.png" }?.image, "a last-turn image has a picture")
        let load = { (source: DiffImage.Source?) in try XCTUnwrap(source.flatMap { DiffImageRegistry.load($0) }) }
        XCTAssertEqual(try load(image.old).data, before, "the before side comes from the change log's store")
        XCTAssertEqual(try load(image.old).path, "logo.png")
        XCTAssertEqual(try load(image.new).data, after)
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

    func testPanelRetargetsANewRootAndRejectsOldDates() async throws {
        let first = URL(fileURLWithPath: "/fixture/first"), second = URL(fileURLWithPath: "/fixture/second")
        let a = GitRepoStatus(root: first, branch: "main", entries: [GitStatusEntry(path: "a.md", unstaged: .modified)])
        let b = GitRepoStatus(root: second, branch: "main", entries: [GitStatusEntry(path: "b.md", unstaged: .modified)])
        let lists = GitRepoPanelLists()
        let started = expectation(description: "old dates started"), finished = expectation(description: "old dates finished")
        let gate = DispatchSemaphore(value: 0)
        lists.readDates = { root, paths in
            if root == first {
                started.fulfill()
                _ = gate.wait(timeout: .now() + 5)
                finished.fulfill()
            }
            return [paths[0]: .distantPast]
        }
        lists.update(.init(root: first, order: .name, filter: "", untracked: true), status: a, reads: 1)
        await fulfillment(of: [started], timeout: 3)
        lists.update(.init(root: second, order: .name, filter: "", untracked: true), status: b, reads: 1)
        XCTAssertTrue(lists.lists(for: first).changed.isEmpty, "a new root never offers old paths")
        let deadline = Date().addingTimeInterval(3)
        while lists.lists(for: second).changed.isEmpty, Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(lists.lists(for: second).changed.map(\.path), ["b.md"])
        gate.signal()
        await fulfillment(of: [finished], timeout: 3)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(Set(lists.lists.dates.keys), ["b.md"], "the old root's late dates are dropped")
    }

    func testReturningToAnAppliedRootStillReadsDatesAfterClearingItsLists() async throws {
        let first = URL(fileURLWithPath: "/fixture/return-first"), second = URL(fileURLWithPath: "/fixture/return-second")
        let entry = GitStatusEntry(path: "note.md", unstaged: .modified)
        let firstStatus = GitRepoStatus(root: first, branch: "main", entries: [entry])
        let secondStatus = GitRepoStatus(root: second, branch: "main", entries: [entry])
        let inputs = GitRepoPanelLists.Inputs(root: first, order: .lastUpdate, filter: "", untracked: true)
        let date = Date(timeIntervalSince1970: 1_000)
        let lists = GitRepoPanelLists()
        lists.readDates = { _, _ in [entry.path: date] }
        lists.update(inputs, status: firstStatus, reads: 1)
        let initialDeadline = Date().addingTimeInterval(3)
        while lists.settled != inputs, Date() < initialDeadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(lists.lists.dates[entry.path], date)
        let started = expectation(description: "other root started")
        let gate = DispatchSemaphore(value: 0)
        defer { gate.signal() }
        lists.readDates = { root, _ in
            if root == second {
                started.fulfill()
                _ = gate.wait(timeout: .now() + 5)
            }
            return [entry.path: date]
        }
        var other = inputs
        other.root = second
        lists.update(other, status: secondStatus, reads: 1)
        await fulfillment(of: [started], timeout: 3)
        lists.update(inputs, status: firstStatus, reads: 1)
        let deadline = Date().addingTimeInterval(3)
        while lists.settled != inputs, Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(lists.settled, inputs)
        XCTAssertEqual(lists.lists.dates[entry.path], date, "the root switch cleared the lists, including their dates")
    }

    func testPendingDatesSurviveAnInputChange() async throws {
        let root = URL(fileURLWithPath: "/fixture/pending-dates")
        let old = GitStatusEntry(path: "old.md", unstaged: .modified)
        let added = GitStatusEntry(path: "new.md", unstaged: .untracked)
        let oldDate = Date(timeIntervalSince1970: 1_000), newDate = Date(timeIntervalSince1970: 2_000)
        let lists = GitRepoPanelLists()
        lists.readDates = { _, _ in [old.path: oldDate] }
        let initial = GitRepoPanelLists.Inputs(root: root, order: .lastUpdate, filter: "", untracked: true)
        lists.update(initial, status: GitRepoStatus(root: root, branch: "main", entries: [old]), reads: 1)
        let initialDeadline = Date().addingTimeInterval(3)
        while lists.settled != initial, Date() < initialDeadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(lists.settled, initial)

        let started = expectation(description: "fresh dates started")
        let finished = expectation(description: "superseded dates finished")
        final class Gate: @unchecked Sendable {
            let lock = NSLock()
            let semaphore = DispatchSemaphore(value: 0)
            var calls = 0
            func first() -> Bool { lock.withLock { calls += 1; return calls == 1 } }
        }
        let gate = Gate()
        defer { gate.semaphore.signal() }
        lists.readDates = { _, _ in
            if gate.first() {
                started.fulfill()
                _ = gate.semaphore.wait(timeout: .now() + 5)
                finished.fulfill()
            }
            return [old.path: oldDate, added.path: newDate]
        }
        let status = GitRepoStatus(root: root, branch: "main", entries: [old, added])
        lists.update(initial, status: status, reads: 2)
        await fulfillment(of: [started], timeout: 3)
        var filtered = initial
        filtered.filter = ".md"
        lists.update(filtered, status: status, reads: 2)
        let deadline = Date().addingTimeInterval(3)
        while lists.settled != filtered, Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(lists.settled, filtered)
        XCTAssertEqual(lists.lists.dates[added.path], newDate, "a new input must not reuse the old date snapshot")
        XCTAssertEqual(lists.lists.recent.first, .file(added), "the newest file sorts first")
        gate.semaphore.signal()
        await fulfillment(of: [finished], timeout: 3)
    }

    /// A status read that finds the same status and the same dates changes nothing: no new lists, no publish. Before,
    /// every read re-read the dates, derived the lists twice and re-ran the panel six times (2026-10-25).
    func testAnEqualReadChangesNothing() async throws {
        let root = URL(fileURLWithPath: "/fixture/equal")
        let status = GitRepoStatus(root: root, branch: "main", entries: [GitStatusEntry(path: "a.md", unstaged: .modified)])
        let lists = GitRepoPanelLists()
        final class Clock: @unchecked Sendable { var date = Date(timeIntervalSince1970: 1_000) }
        let clock = Clock()
        lists.readDates = { _, paths in [paths[0]: clock.date] }
        let inputs = GitRepoPanelLists.Inputs(root: root, order: .lastUpdate, filter: "", untracked: true)
        lists.update(inputs, status: status, reads: 1)
        let deadline = Date().addingTimeInterval(3)
        while lists.settled != inputs, Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        let version = lists.version
        var published = 0
        let watch = lists.objectWillChange.sink { published += 1 }
        lists.update(inputs, status: status, reads: 2)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(lists.version, version)
        XCTAssertEqual(published, 0)
        clock.date = Date(timeIntervalSince1970: 2_000)
        lists.update(inputs, status: status, reads: 3)
        let moved = Date().addingTimeInterval(3)
        while lists.version == version, Date() < moved { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(lists.lists.dates["a.md"], clock.date, "a newer date on the same status is a change")
        watch.cancel()
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

    /// Martin, 2026-10-25: "No unstaged changes in this file." flashed every few seconds. Each status refresh reloaded the
    /// diff, and a reload with no diff on screen went through `.loading`, which drew nothing for a moment.
    func testReloadingTheSameEmptyDiffKeepsItsMessage() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("diff-flash-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let note = root.appendingPathComponent("note.md")
        _ = try git(["init", "-q", "-b", "main"], in: root)
        try "saved\n".write(to: note, atomically: true, encoding: .utf8)
        _ = try git(["add", "."], in: root)
        _ = try git(["commit", "-q", "-m", "Saved"], in: root)
        let model = GitFileDiffModel()
        model.load(note, text: "saved\n", scope: .unstaged)
        let deadline = Date().addingTimeInterval(5)
        while model.phase == .loading || model.phase == .idle, Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(model.phase, .empty("No unstaged changes in this file."))
        var phases: [GitFileDiffModel.Phase] = []
        let watch = model.$phase.dropFirst().sink { phases.append($0) }
        for _ in 0..<3 {
            model.load(note, text: "saved\n", scope: .unstaged)
            try await Task.sleep(for: .milliseconds(300))
        }
        watch.cancel()
        XCTAssertFalse(phases.contains(.loading), "a reload of the same question keeps the message: \(phases)")
        model.load(note, text: "saved\n", scope: .staged)
        XCTAssertEqual(model.phase, .loading, "another question still shows that it is loading")
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
