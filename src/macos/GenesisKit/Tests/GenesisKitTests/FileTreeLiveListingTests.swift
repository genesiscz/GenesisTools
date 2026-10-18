import os
import XCTest
@testable import GenesisKitBase
@testable import GenesisKit

/// The tree lists what is on disk now, not what was there when a folder was first read. Another app (an agent
/// session saving notes) writes into folders the tree already read; on 2026-10-15 "Show in Sidebar" on such a note
/// did nothing, because its folder's listing predated the note.
@MainActor
final class FileTreeLiveListingTests: XCTestCase {
    private var root: URL!

    /// Creates a scratch folder and initial note for live-listing tests.
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("filetree-live-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("Návrhy"), withIntermediateDirectories: true)
        try Data("x".utf8).write(to: root.appendingPathComponent("Návrhy/old.md"))
    }

    /// Removes the scratch filesystem fixture after each test.
    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func settle(until done: @escaping () -> Bool, seconds: Double = 2) async {
        let deadline = Date().addingTimeInterval(seconds)
        while !done(), Date() < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    /// A tree whose "Návrhy" folder is open and read.
    private func openTree() async -> FileTreeModel {
        let model = FileTreeModel(root: root)
        model.setRoot(root)
        model.reveal(root.appendingPathComponent("Návrhy/old.md"))
        await settle { model.rows.contains { $0.name == "old.md" } }
        XCTAssertTrue(model.rows.contains { $0.name == "old.md" })
        return model
    }

    /// A reveal refreshes an already cached folder when its target note arrived later.
    func testShowInSidebarFindsANoteWrittenAfterItsFolderWasRead() async throws {
        let model = await openTree()
        let note = root.appendingPathComponent("Návrhy/2026-10-15-Proposals.sol3.md")
        try Data("# sol3".utf8).write(to: note)

        model.reveal(note)
        await settle { model.rows.contains { $0.name == note.lastPathComponent } }
        XCTAssertTrue(model.rows.contains { $0.name == note.lastPathComponent }, "the reveal reads the folder again")
        XCTAssertFalse(model.rows.contains { $0.loading }, "a quiet read shows no spinner")
    }

    /// Filesystem events add and remove notes from an already open folder.
    func testAFolderAnotherAppWritesIntoListsTheNewNoteByItself() async throws {
        let model = await openTree()
        // FSEvents reports from the moment the stream starts; give it that moment.
        try? await Task.sleep(for: .milliseconds(300))
        try Data("# new".utf8).write(to: root.appendingPathComponent("Návrhy/new.md"))
        await settle(until: { model.rows.contains { $0.name == "new.md" } }, seconds: 5)
        XCTAssertTrue(model.rows.contains { $0.name == "new.md" })

        try FileManager.default.removeItem(at: root.appendingPathComponent("Návrhy/old.md"))
        await settle(until: { !model.rows.contains { $0.name == "old.md" } }, seconds: 5)
        XCTAssertFalse(model.rows.contains { $0.name == "old.md" }, "a deleted note leaves the tree too")
    }

    /// The first read's snapshot is already taken when the folder changes. The event has to mark that read stale,
    /// or the tree publishes the snapshot and never lists the new file.
    func testADiskEventDuringTheFirstReadIsKept() async {
        let model = FileTreeModel(root: root)
        let calls = OSAllocatedUnfairLock(initialState: 0)
        let started = OSAllocatedUnfairLock(initialState: false)
        let gate = DispatchSemaphore(value: 0)
        defer { gate.signal() }
        let folder = root.standardizedFileURL
        let old = FileTreeEntry(path: folder.appendingPathComponent("old.md").path, name: "old.md", isFolder: false)
        let arrived = FileTreeEntry(path: folder.appendingPathComponent("arrived.md").path, name: "arrived.md", isFolder: false)
        model.watchesDisk = false
        model.listing = { _ in
            let call = calls.withLock { state -> Int in
                state += 1
                return state
            }
            if call == 1 {
                started.withLock { $0 = true }
                // The test signals as soon as it sees `started`. A missed signal must not hold the worker.
                if gate.wait(timeout: .now() + 5) == .timedOut {
                    return [old]
                }
                return [old]
            }
            return [old, arrived]
        }
        model.setRoot(root)
        let deadline = Date().addingTimeInterval(2)
        while !started.withLock({ $0 }), Date() < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(started.withLock { $0 }, "the first read started")
        model.diskChanged([model.root.path.nativeUTF8 + "/"])
        gate.signal()
        await settle { model.rows.contains { $0.name == "arrived.md" } }
        XCTAssertTrue(model.rows.contains { $0.name == "arrived.md" }, "a disk event during the first read is read again")
        XCTAssertGreaterThanOrEqual(calls.withLock { $0 }, 2, "the load retries instead of publishing the stale snapshot")
    }

    /// A quiet read is in flight when the folder is refreshed. That read's snapshot is older, so it must not
    /// replace the listing the refresh reads.
    func testARefreshWinsOverAQuietReadStillRunning() async {
        let model = FileTreeModel(root: root)
        let calls = OSAllocatedUnfairLock(initialState: 0)
        let quietStarted = OSAllocatedUnfairLock(initialState: false)
        let gate = DispatchSemaphore(value: 0)
        defer { gate.signal() }
        let folder = root.standardizedFileURL
        let old = FileTreeEntry(path: folder.appendingPathComponent("old.md").path, name: "old.md", isFolder: false)
        let fresh = FileTreeEntry(path: folder.appendingPathComponent("fresh.md").path, name: "fresh.md", isFolder: false)
        model.watchesDisk = false
        model.listing = { _ in
            let call = calls.withLock { state -> Int in
                state += 1
                return state
            }
            if call == 1 {
                return [old]
            }
            if call == 2 {
                quietStarted.withLock { $0 = true }
                if gate.wait(timeout: .now() + 5) == .timedOut {
                    return [old]
                }
                return [old]
            }
            return [old, fresh]
        }
        model.setRoot(root)
        await settle { model.rows.contains { $0.name == "old.md" } }
        XCTAssertTrue(model.rows.contains { $0.name == "old.md" })
        model.diskChanged([model.root.path.nativeUTF8 + "/"])
        let deadline = Date().addingTimeInterval(2)
        while !quietStarted.withLock({ $0 }), Date() < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(quietStarted.withLock { $0 }, "the quiet read started")
        model.refresh(model.root.path)
        await settle { model.rows.contains { $0.name == "fresh.md" } }
        XCTAssertTrue(model.rows.contains { $0.name == "fresh.md" }, "the refresh published its listing")
        gate.signal()
        try? await Task.sleep(for: .milliseconds(200))
        XCTAssertTrue(model.rows.contains { $0.name == "fresh.md" }, "the quiet snapshot does not replace the refresh")
        XCTAssertGreaterThanOrEqual(calls.withLock { $0 }, 3, "the refresh reads the folder itself")
    }

    /// An obsolete quiet snapshot must still drain a disk event queued after navigation back to the folder.
    func testARootChangeKeepsANewerQueuedQuietRead() async {
        let model = FileTreeModel(root: root)
        model.watchesDisk = false
        let folder = root.appendingPathComponent("Návrhy").standardizedFileURL.path
        let rootPath = root.standardizedFileURL.path
        let calls = OSAllocatedUnfairLock(initialState: 0)
        let gate = DispatchSemaphore(value: 0)
        defer { gate.signal() }
        let child = FileTreeEntry(path: folder, name: "Návrhy", isFolder: true)
        let old = FileTreeEntry(path: folder + "/old.md", name: "old.md", isFolder: false)
        let fresh = FileTreeEntry(path: folder + "/fresh.md", name: "fresh.md", isFolder: false)
        model.listing = { path in
            if path == rootPath { return [child] }
            guard path == folder else { return [] }
            let call = calls.withLock { state -> Int in
                state += 1
                return state
            }
            if call == 2 {
                _ = gate.wait(timeout: .now() + 5)
                return [old]
            }
            return call >= 3 ? [old, fresh] : [old]
        }
        model.setRoot(root)
        model.toggle(folder)
        await settle { model.rows.contains { $0.name == "old.md" } }
        XCTAssertTrue(model.rows.contains { $0.name == "old.md" })
        model.diskChanged([folder])
        await settle { calls.withLock { $0 } == 2 }
        XCTAssertEqual(calls.withLock { $0 }, 2, "the quiet read has its old snapshot")
        model.setRoot(root.appendingPathComponent("elsewhere"))
        model.setRoot(root)
        model.diskChanged([folder])
        gate.signal()
        await settle { model.rows.contains { $0.name == "fresh.md" } }
        XCTAssertTrue(model.rows.contains { $0.name == "fresh.md" }, "the event after the root change starts a current read")
        XCTAssertEqual(calls.withLock { $0 }, 3)
    }

    /// Returning to a watched root refreshes listings changed while its watcher covered another root.
    func testReturningToARootRefreshesCachedDescendantsChangedWhileAway() async throws {
        let folder = root.appendingPathComponent("Návrhy").standardizedFileURL
        let nested = folder.appendingPathComponent("nested")
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
        let removed = folder.appendingPathComponent("old.md")
        let renamed = nested.appendingPathComponent("before.md")
        try Data("before".utf8).write(to: renamed)
        let model = FileTreeModel(root: root)
        model.watchesDisk = false
        model.setRoot(root)
        model.restoreExpanded([folder.path.nativeUTF8, nested.path.nativeUTF8])
        await settle { model.rows.contains { $0.name == "before.md" } }
        XCTAssertTrue(model.rows.contains { $0.name == "old.md" })
        XCTAssertTrue(model.rows.contains { $0.name == "before.md" })

        // Cache the nested folder, then close it before leaving. Reopening it after Back must use a fresh listing too.
        model.toggle(nested.path.nativeUTF8)
        let saved = model.expandedFolders
        let elsewhere = root.appendingPathComponent("elsewhere")
        try FileManager.default.createDirectory(at: elsewhere, withIntermediateDirectories: true)
        model.setRoot(elsewhere)
        try FileManager.default.removeItem(at: removed)
        try FileManager.default.moveItem(at: renamed, to: nested.appendingPathComponent("after.md"))
        try Data("added".utf8).write(to: folder.appendingPathComponent("added.md"))

        // No diskChanged call: the old watcher was stopped, so no event can repair these cached snapshots.
        model.setRoot(root)
        model.restoreExpanded(saved)
        await settle { model.rows.contains { $0.name == "added.md" } && !model.rows.contains { $0.name == "old.md" } }
        XCTAssertTrue(model.rows.contains { $0.name == "added.md" }, "returning refreshes a cached open folder")
        XCTAssertFalse(model.rows.contains { $0.name == "old.md" }, "deletions while away cannot remain as obsolete rows")
        model.toggle(nested.path.nativeUTF8)
        await settle { model.rows.contains { $0.name == "after.md" } }
        XCTAssertTrue(model.rows.contains { $0.name == "after.md" }, "a cached closed descendant refreshes too")
        XCTAssertFalse(model.rows.contains { $0.name == "before.md" }, "a rename while away replaces the old row")
    }

    /// Editing a note without changing its directory entries publishes no new tree rows.
    func testANoteSavedInPlaceChangesNoRows() async throws {
        let model = await openTree()
        try? await Task.sleep(for: .milliseconds(300))
        var changes = 0
        let watch = model.$rows.dropFirst().sink { _ in changes += 1 }
        defer { watch.cancel() }
        try Data("edited".utf8).write(to: root.appendingPathComponent("Návrhy/old.md"))
        try? await Task.sleep(for: .milliseconds(1500))
        XCTAssertEqual(changes, 0, "an edit inside a note is not a listing change")
    }
}
