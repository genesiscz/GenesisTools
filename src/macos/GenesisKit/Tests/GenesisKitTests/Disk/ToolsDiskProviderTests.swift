import GenesisKitFixtures
import XCTest
@testable import GenesisKit

/// The captured outputs in GenesisKitFixtures (the `Disk/*.json` files without the `contract-` prefix) are real
/// output, captured on 2026-10-13 with the GenesisTools CLI at
/// `GenesisTools/.worktrees/posture-disk-kit/tools` (HEAD 041adfa93, the same commit as this kit's worktree).
/// The home folder became `/Users/alice`, the scratch folders `/Users/alice/Projects/…`, and the doctor
/// fixture keeps 10 of its 34 findings. Nothing else was edited.
///
/// - `demo/` is a scratch tree: `app/` (a copy of `src/du`), `app-clone/` (`cp -c` clones of it) and
///   `dup-lib/` (a plain copy of `app/lib`). `reclaim-demo/` holds two plain copies of `src/du/lib` under
///   `api/node_modules` and `web/node_modules`.
/// - du-clonesize: `tools du clonesize demo --depth 1 --freeable --format json`
/// - du-volume: `tools du volume demo --depth 1 --format json`. Scoped to `demo` because the whole-volume
///   run did not finish within 300 s; the `volume` figures are still the Data volume's own.
/// - du-partners: `tools du partners demo/app --against demo --format json`
/// - clones-measure: `tools macos clones measure demo --min-real 1 --format json`
/// - clones-du: `tools macos clones du demo/app --depth 2 --min-real 1 --format json`
/// - clones-duplicates: `tools macos clones duplicates demo --format json`
/// - clones-reclaim-plan: `tools macos clones reclaim plan reclaim-demo --targets node_modules --min-real 1
///   --no-daemon --format json`
/// - doctor: `tools doctor --json --dry-run --only disk-space,dev-caches,system-caches`
/// - hub-worktrees-list: `tools hub worktrees list <kit worktree> --json`
/// - hub-worktrees-size: `tools hub worktrees size demo/app demo/gone --json`
/// - macos-swap: `tools macos swap --json --limit 8`
final class ToolsDiskProviderTests: XCTestCase {
    // MARK: Fixtures

    func testDuClonesizeFixture() throws {
        let result = try decodeFixture(DuClonesizeResult.self, "du-clonesize")
        XCTAssertEqual(result.filesScanned, 57)
        XCTAssertEqual(result.uniqueBytes, 382_104)
        XCTAssertEqual(result.uniqueAllocatedBytes, 458_752)
        XCTAssertEqual(result.privateSumBytes, 155_648)
        XCTAssertEqual(result.sharedPct, 39.78, accuracy: 0.001)
        XCTAssertEqual(result.engine, .cFfi)
        XCTAssertEqual(result.elapsedMs, 8)
        XCTAssertEqual(result.groups.map(\.name), ["app-clone", "app", "dup-lib"])
        XCTAssertEqual(result.groups.filter(\.cloneFlagged).count, 2)
        XCTAssertEqual(result.depth, 1)
        let nodes = try XCTUnwrap(result.nodes)
        XCTAssertEqual(nodes.count, 4)
        XCTAssertEqual(nodes[0].parent, -1)
        XCTAssertEqual(nodes.dropFirst().map(\.parent), [0, 0, 0])
        XCTAssertEqual(URL(fileURLWithPath: nodes[3].path).lastPathComponent, "dup-lib")
    }

    func testDuVolumeFixture() throws {
        let report = try decodeFixture(DuVolumeReport.self, "du-volume")
        XCTAssertEqual(report.volume.sizeBytes, 994_662_584_320)
        XCTAssertEqual(report.volume.usedBytes, 959_420_788_736)
        XCTAssertEqual(report.scan.filesScanned, 57)
        // The scan inside `du volume` carries no engine or timing: `clonesize` adds those.
        XCTAssertNil(report.scan.engine)
        XCTAssertNil(report.scan.elapsedMs)
        XCTAssertEqual(report.scan.nodes?.count, 4)
        let scanned = try XCTUnwrap(report.scan.uniqueAllocatedBytes)
        XCTAssertEqual(report.unaccountedBytes, report.volume.usedBytes - scanned)
    }

    func testDuPartnersFixture() throws {
        let result = try decodeFixture(DuPartnersResult.self, "du-partners")
        XCTAssertEqual(result.targetSharedBytes, 259_895)
        XCTAssertEqual(result.partnerBytes, 259_895)
        XCTAssertEqual(result.partnerFilesTotal, 21)
        XCTAssertEqual(result.partnerDirs.count, 3)
        XCTAssertEqual(result.partnerDirs.first?.files, 15)
        XCTAssertEqual(result.partnerFiles.count, 21)
        let first = try XCTUnwrap(result.partnerFiles.first)
        XCTAssertEqual(URL(fileURLWithPath: first.path).lastPathComponent, "clonesize.c")
        XCTAssertEqual(first.sharedBytes, 101_785)
        XCTAssertNil(first.files, "a file entry has no file count")
    }

    func testClonesMeasureFixture() throws {
        let report = try decodeFixture(ClonesMeasureReport.self, "clones-measure")
        XCTAssertEqual(report.minReal, 1)
        XCTAssertFalse(report.nodeModulesMode)
        XCTAssertEqual(report.tree.count, 1)
        XCTAssertEqual(URL(fileURLWithPath: report.tree[0].path).lastPathComponent, "dup-lib")
        XCTAssertEqual(report.tree[0].real, 155_648)
        XCTAssertEqual(report.totals.real, 155_648)
        XCTAssertEqual(report.totals.uniqueAllocated, 458_752)
        XCTAssertEqual(try XCTUnwrap(report.totals.overcount), 4.8947, accuracy: 0.0001)
        XCTAssertEqual(report.cloneAnalysis.families, 21)
        XCTAssertEqual(report.cloneAnalysis.clonedFiles, 42)
        XCTAssertEqual(report.freeSpace.total, 994_662_584_320)
        XCTAssertTrue(report.errors.isEmpty)
    }

    func testClonesDuFixture() throws {
        let report = try decodeFixture(ClonesMeasureReport.self, "clones-du")
        XCTAssertTrue(report.tree.isEmpty, "every file under demo/app is shared, so no row clears --min-real 1")
        XCTAssertEqual(report.totals.real, 0)
        XCTAssertNil(report.totals.overcount, "null in the JSON")
        XCTAssertEqual(report.cloneAnalysis.sharedBytes, 303_104)
        XCTAssertEqual(report.cloneAnalysis.notes.count, 2)
    }

    func testClonesDuplicatesFixture() throws {
        let report = try decodeFixture(ClonesDuplicatesReport.self, "clones-duplicates")
        XCTAssertEqual(report.sets.count, 15)
        XCTAssertEqual(report.totalReclaimable, 122_209)
        XCTAssertEqual(report.sets.map(\.reclaimable).reduce(0, +), report.totalReclaimable)
        XCTAssertTrue(report.sets.allSatisfy { $0.kind == .file && $0.copies == 2 && $0.members.count == 2 })
        XCTAssertEqual(report.sets[0].what, "app-clone/lib/clone-controls.test.ts")
        XCTAssertFalse(report.grouped)
        let stats = try XCTUnwrap(report.stats)
        XCTAssertEqual(stats.walkedFiles, 57)
        XCTAssertEqual(stats.sha256Calls, 30)
        XCTAssertEqual(stats.walkMs, 16.104, accuracy: 0.001)
    }

    func testClonesReclaimPlanFixture() throws {
        let plan = try decodeFixture(ClonesReclaimPlan.self, "clones-reclaim-plan")
        XCTAssertEqual(plan.selector.targets, ["node_modules"])
        XCTAssertEqual(plan.selector.minReal, 1)
        XCTAssertTrue(plan.selector.keepPartners.isEmpty)
        XCTAssertNil(plan.selector.rewriteStores)
        XCTAssertEqual(plan.roots.map { URL(fileURLWithPath: $0).deletingLastPathComponent().lastPathComponent }, ["api", "web"])
        XCTAssertEqual(plan.rootStamps.count, 2)
        XCTAssertEqual(plan.rootStamps[0].mtimeMs, 1_791_917_911_013.3694, accuracy: 0.001)
        XCTAssertEqual(plan.sets.count, 1)
        XCTAssertEqual(plan.sets[0].kind, .dir)
        XCTAssertEqual(plan.sets[0].what, "api/node_modules/du-lib")
        XCTAssertEqual(plan.sets[0].freeable, 155_648)
        XCTAssertEqual(plan.totalReclaimable, 122_209)
        XCTAssertEqual(plan.totalFreeable, 155_648)
        XCTAssertEqual(plan.totalFreeableUpTo, 155_648)
        XCTAssertEqual(plan.dropped, ClonesDroppedSets(sets: 0, naiveBytes: 0))
        XCTAssertFalse(plan.fromSnapshot)
    }

    func testDoctorFixture() throws {
        let report = try decodeFixture(DoctorReport.self, "doctor")
        XCTAssertEqual(report.analyzers, ["disk-space", "dev-caches", "system-caches"])
        XCTAssertEqual(report.findings.count, 10)
        XCTAssertTrue(report.errors.isEmpty)
        let downloads = report.findings[0]
        XCTAssertEqual(downloads.id, "disk-downloads")
        XCTAssertEqual(downloads.severity, .cautious)
        XCTAssertEqual(downloads.reclaimableBytes, 14_419_988_480)
        XCTAssertEqual(downloads.availableActionIds, ["reveal"])
        XCTAssertEqual(downloads.metadata?["path"]?.stringValue, "/Users/alice/Downloads")
        let brew = try XCTUnwrap(report.findings.first { $0.id == "dev-brew-cache" })
        XCTAssertEqual(brew.severity, .safe)
        XCTAssertEqual(brew.metadata?["bytes"]?.numberValue, 415_367_168)
        let logs = try XCTUnwrap(report.findings.first { $0.id == "sys-var-log" })
        guard case .array(let paths)? = logs.metadata?["paths"] else {
            return XCTFail("sys-var-log metadata.paths is an array")
        }
        XCTAssertEqual(paths.count, 6)
    }

    func testHubWorktreesListFixture() throws {
        let report = try decodeFixture(HubWorktreeReport.self, "hub-worktrees-list")
        XCTAssertEqual(report.rows.count, 13)
        XCTAssertEqual(report.rows.filter(\.removable).count, 0)
        XCTAssertEqual(report.bases.first?.base, "origin/master")
        XCTAssertEqual(report.elapsedMs, 3987)
        let core = try XCTUnwrap(report.rows.first { $0.path.hasSuffix("/kit-core") })
        XCTAssertEqual(core.verdict, .unmerged)
        XCTAssertEqual(core.how, HubWorktreeHow.none)
        XCTAssertEqual(core.processes.map(\.name), ["zsh", "swift-test", "xctest"])
        XCTAssertEqual(core.blockers.map(\.kind), [.unmerged, .process])
        let activity = try XCTUnwrap(core.lastActivityAt)
        XCTAssertNotEqual(activity, activity.rounded(), "lastActivityAt comes from stat with a fraction")
        let gone = try XCTUnwrap(report.rows.last)
        XCTAssertEqual(gone.prunable, "gitdir file points to non-existent location")
        XCTAssertEqual(gone.blockers.first?.kind, .missing)
        XCTAssertEqual(report.rows.filter { $0.branch == nil }.count, 3, "detached HEADs")
        XCTAssertEqual(report.rows.filter { $0.how == .superseded }.count, 3)
    }

    func testHubWorktreeSizesFixture() throws {
        let sizes = try decodeFixture([HubWorktreeSize].self, "hub-worktrees-size")
        XCTAssertEqual(sizes.count, 2)
        XCTAssertEqual(URL(fileURLWithPath: sizes[0].path).lastPathComponent, "app")
        XCTAssertEqual(sizes[0].bytes, 303_104)
        XCTAssertEqual(sizes[0].freeableBytes, 0, "every block of demo/app is shared with its clone")
        XCTAssertEqual(sizes[0].files, 21)
        XCTAssertNil(sizes[0].error)
        XCTAssertEqual(sizes[1].error, "The folder does not exist")
        XCTAssertNil(sizes[1].freeableBytes)
    }

    func testSwapFixture() throws {
        let report = try decodeFixture(SwapReport.self, "macos-swap")
        XCTAssertEqual(report.scannedCount, 8)
        XCTAssertEqual(report.totalProcesses, 1262)
        XCTAssertEqual(report.inaccessibleCount, 1)
        XCTAssertFalse(report.wasAllMode)
        XCTAssertEqual(report.processes.count, 6)
        XCTAssertEqual(report.processes[0].pid, 9957)
        XCTAssertEqual(URL(fileURLWithPath: report.processes[0].name).lastPathComponent, "claude")
        XCTAssertEqual(report.processes[0].rssBytes, 1_482_063_872)
        XCTAssertEqual(report.processes[1].swapBytes, 206_674_329.6, accuracy: 0.01, "vmmap sizes carry a fraction")
        XCTAssertEqual(report.processes.map(\.swapBytes), report.processes.map(\.swapBytes).sorted(by: >))
    }

    // MARK: Decoding rules

    func testPreambleBeforeObjectStillDecodes() throws {
        let preamble = "[profile:du] scan.c-ffi 12.0ms\nwarning: extent cache {stale}, rebuilding\n"
        let data = Data(preamble.utf8) + (try fixture("du-clonesize"))
        let result = try ToolsDiskProvider.decode(DuClonesizeResult.self, from: data, command: "du clonesize")
        XCTAssertEqual(result.filesScanned, 57)
    }

    func testPreambleBeforeTopLevelArrayStillDecodes() throws {
        let data = Data("note: sizing 2 worktrees\n".utf8) + (try fixture("hub-worktrees-size"))
        let sizes = try ToolsDiskProvider.decode([HubWorktreeSize].self, from: data, command: "hub worktrees size")
        XCTAssertEqual(sizes.count, 2)
        XCTAssertEqual(sizes[0].bytes, 303_104)
    }

    func testUnknownEnumValuesDecode() throws {
        let finding = try decodeJSON(
            DoctorFinding.self,
            #"{"id":"x","analyzerId":"disk-space","title":"t","severity":"catastrophic","availableActionIds":[]}"#
        )
        XCTAssertEqual(finding.severity.rawValue, "catastrophic")
        XCTAssertNotEqual(finding.severity, .safe)

        let blocker = try decodeJSON(HubWorktreeBlocker.self, #"{"kind":"quarantined","text":"t"}"#)
        XCTAssertEqual(blocker.kind, HubWorktreeBlockerKind(rawValue: "quarantined"))

        let set = try decodeJSON(
            ClonesDuplicateSet.self,
            #"{"kind":"symlink","what":"a","copies":2,"eachBytes":1,"reclaimable":1,"members":["/a","/b"],"keep":"/a"}"#
        )
        XCTAssertEqual(set.kind.rawValue, "symlink")
        XCTAssertEqual(String(decoding: try JSONEncoder().encode(DoctorSeverity.safe), as: UTF8.self), #""safe""#)
    }

    func testUnknownExtraKeyIsIgnored() throws {
        let size = try decodeJSON(
            HubWorktreeSize.self,
            #"{"path":"/x","bytes":1,"freeableBytes":null,"files":1,"elapsedMs":2,"futureField":{"nested":[1,2]}}"#
        )
        XCTAssertEqual(size, HubWorktreeSize(path: "/x", bytes: 1, freeableBytes: nil, files: 1, elapsedMs: 2))
    }

    func testMissingKeyThrowsDecodeErrorNamingTheKey() {
        XCTAssertThrowsError(try decodeJSON(SwapReport.self, #"{"system":{}}"#)) { error in
            guard case ToolsDiskProviderError.decode(let command, let detail)? = error as? ToolsDiskProviderError else {
                return XCTFail("expected .decode, got \(error)")
            }
            XCTAssertEqual(command, "test")
            XCTAssertTrue(detail.contains("missing key totalBytes"), detail)
        }
    }

    func testEmptyPathListIsRefusedBeforeRunning() async throws {
        let provider = ToolsDiskProvider(bridge: ToolsBridge(binaryPath: "/nonexistent/tools"))
        do {
            _ = try await provider.clonesMeasure(paths: [])
            XCTFail("expected a throw")
        } catch ToolsDiskProviderError.invalidArgument(let reason) {
            XCTAssertTrue(reason.contains("macos clones measure"), reason)
        }
    }

    // MARK: Process errors

    func testNonZeroExitCarriesTheStderrTail() async throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("tools-disk-fake-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: dir) }
        let script = dir.appendingPathComponent("tools")
        let body = """
        #!/bin/sh
        echo "[profile:du] scan 3ms" >&2
        echo "loading volume" >&2
        echo "Could not read volume attributes for /nope (is it a mount point?)" >&2
        exit 3

        """
        try body.write(to: script, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)

        let provider = ToolsDiskProvider(bridge: ToolsBridge(binaryPath: script.path), timeoutSeconds: 30)
        do {
            _ = try await provider.duVolume(mount: "/nope")
            XCTFail("expected a throw")
        } catch ToolsDiskProviderError.exit(let code, let stderr) {
            XCTAssertEqual(code, 3)
            XCTAssertTrue(stderr.hasSuffix("Could not read volume attributes for /nope (is it a mount point?)"), stderr)
            XCTAssertFalse(stderr.contains("[profile:"), "timing lines are not the reason")
        }
    }

    // MARK: Helpers

    private func fixture(_ name: String) throws -> Data {
        try KitFixture.data("\(name).json")
    }

    private func decodeFixture<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try ToolsDiskProvider.decode(type, from: fixture(name), command: name)
    }

    private func decodeJSON<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try ToolsDiskProvider.decode(type, from: Data(json.utf8), command: "test")
    }
}
