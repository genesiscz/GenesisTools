import Foundation
import GenesisKitFixtures
import SQLite3
import XCTest
@testable import GenesisKit

/// The contract fixtures (`contract-*` in GenesisKitFixtures) were frozen by the CLI side in GenesisTools commit
/// 91a1fa1e6; the GenesisTools bun tests check each one against the real output. The schema is
/// `contract-du-index-schema.sql`.
final class DuIndexContractTests: XCTestCase {
    private func fixture(_ name: String, _ ext: String = "json") throws -> Data {
        try KitFixture.data("\(name).\(ext)")
    }

    private func decodeIndex<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try ToolsDiskProvider.decode(T.self, from: fixture(name), command: name, snakeCaseKeys: true)
    }

    func testAQueryWithChildrenDecodesSizesSharesFlagsAndTopFiles() throws {
        let result = try decodeIndex(DuIndexQueryResult.self, "contract-du-index-query-children")
        XCTAssertTrue(result.found)
        XCTAssertEqual(result.asOf?.scanId, 43)
        XCTAssertEqual(result.node?.storedChildren, 8)
        XCTAssertEqual(result.node?.allocBytes, 64_424_509_440)
        XCTAssertEqual(result.local?.allocBytes, 5_368_709_120)
        XCTAssertEqual(result.children?.count, 8)
        XCTAssertEqual(result.children?.first?.share ?? 0, 0.3333, accuracy: 0.0001)
        XCTAssertEqual(result.children?.first { $0.name == "Mail" }?.flags, .denied)
        XCTAssertEqual(result.children?.first { $0.name == "CloudStorage" }?.flags, .cloudSkipped)
        XCTAssertEqual(result.topFiles?.count, 3)
        XCTAssertTrue(result.topFiles?.last?.path.hasSuffix("blob \"quoted\" name.bin") ?? false)
        XCTAssertEqual(result.topFiles?.first?.allocBytes, 3_221_225_472, "Docker.raw: sparse, far below its length")
        XCTAssertEqual(result.truncated, false)
    }

    func testAFoldedPathNamesItsStoredAncestorAndTheMeasureHint() throws {
        let result = try decodeIndex(DuIndexQueryResult.self, "contract-du-index-query-folded")
        XCTAssertFalse(result.found)
        XCTAssertEqual(result.reason, "folded")
        XCTAssertEqual(result.foldedIn, "/Users/example/Projects/app")
        XCTAssertTrue(result.hint?.hasPrefix("tools du clonesize") ?? false)
        XCTAssertNil(result.node)
    }

    func testLargestInfoDiffAndSchedule() throws {
        let largest = try decodeIndex(DuIndexLargestResult.self, "contract-du-index-query-largest")
        XCTAssertEqual(largest.largest, "dirs")
        XCTAssertEqual(largest.dirs.map(\.name), ["Containers", "Caches"])
        XCTAssertEqual(largest.dirs.first?.localAllocBytes, 9_663_676_416)
        XCTAssertTrue(largest.files.isEmpty)
        XCTAssertTrue(largest.truncated)

        let info = try decodeIndex(DuIndexInfo.self, "contract-du-index-query-info")
        XCTAssertEqual(info.meta.schemaVersion, "1")
        XCTAssertEqual(info.meta.private, "1")
        XCTAssertEqual(info.meta.volumeFsid, "0100000e0000001a")
        XCTAssertEqual(info.counts.tombstones, 12)
        XCTAssertEqual(info.scans.map(\.kind), ["update", "build"])
        XCTAssertEqual(info.dbBytes, 1_835_008)

        let diff = try decodeIndex(DuIndexDiff.self, "contract-du-index-diff")
        XCTAssertEqual(diff.rows.map(\.status), ["grown", "new", "grown", "gone", "shrunk"])
        XCTAssertNil(diff.rows[2].before, "an approximate old side")
        XCTAssertEqual(diff.rows[2].approx, true)
        XCTAssertEqual(diff.to.live, true)
        XCTAssertNil(diff.to.snapshotId)
        XCTAssertEqual(diff.totalDelta.allocBytes, 9_663_676_416)

        let schedule = try decodeIndex(DuIndexSchedule.self, "contract-du-index-schedule-status")
        XCTAssertTrue(schedule.registered)
        XCTAssertEqual(schedule.every, "every day at 02:15")
    }

    func testBuildAndUpdateResultsAndTheErrorDocument() throws {
        let build = try decodeIndex(DuIndexBuildResult.self, "contract-du-index-build-result")
        XCTAssertEqual(build.scanId, 42)
        XCTAssertEqual(build.private, true)
        XCTAssertEqual(build.skippedCloud, ["/Users/example/Library/CloudStorage"])
        XCTAssertNil(build.reset, "a JSON null is no reset")

        let update = try decodeIndex(DuIndexUpdateResult.self, "contract-du-index-update-result")
        XCTAssertFalse(update.deferred)
        XCTAssertEqual(update.regions.map(\.ownerId), [17, 311])
        XCTAssertEqual(update.regions.last?.delta.allocBytes, -4_096_000)

        let queued = try decodeIndex(DuIndexUpdateResult.self, "contract-du-index-update-queued")
        XCTAssertTrue(queued.deferred)
        XCTAssertNil(queued.scanId)
        XCTAssertEqual(queued.queued, 2)
        XCTAssertEqual(queued.ignored, ["/Volumes/External/photos"])

        let error = try decodeIndex(DuIndexError.self, "contract-du-index-error")
        XCTAssertEqual(error.code, "locked")
        XCTAssertEqual(error.exitCode, 3)
    }

    func testTheBuildStreamParsesLineByLine() throws {
        let lines = String(decoding: try fixture("contract-du-index-build", "ndjson"), as: UTF8.self)
            .split(separator: "\n").map(String.init)
        let events = lines.compactMap(DuIndexEvent.parse(line:))
        XCTAssertEqual(events.count, lines.count)
        guard case .start(let start) = events[0] else { return XCTFail("start first") }
        XCTAssertEqual(start.scanId, 42)
        guard case .progress(let progress) = events[1] else { return XCTFail("progress") }
        XCTAssertEqual(progress.filesPerS, 274_666)
        XCTAssertEqual(progress.dir, "/Users/example/Projects/app/node_modules/react")
        guard case .blocked(let blocked) = events[2] else { return XCTFail("blocked") }
        XCTAssertEqual(blocked.path, "/Users/example/Library/Containers/com.example.other-app/Data")
        XCTAssertEqual(blocked.waitedMs, 10_012)
        guard case .phase(let checkpoint) = events[6] else { return XCTFail("phase") }
        XCTAssertEqual(checkpoint.phase, "checkpoint")
        XCTAssertNil(checkpoint.rows)
        guard case .built(let result) = events.last else { return XCTFail("result last") }
        XCTAssertEqual(result.files, 1_301_243)
        XCTAssertEqual(result.blockedDirs, 1)
        XCTAssertEqual(result.blockedPaths, ["/Users/example/Library/Containers/com.example.other-app/Data"])
        XCTAssertNil(DuIndexEvent.parse(line: "not json"))
        XCTAssertEqual(DuIndexEvent.parse(line: #"{"type":"future-kind"}"#), .other("future-kind"))
        let failed = DuIndexEvent.parse(line: #"{"type":"error","code":"disk_low","message":"Below 8 GB free."}"#)
        XCTAssertEqual(failed, .failed(DuIndexError(command: nil, code: "disk_low", message: "Below 8 GB free.", exitCode: nil)))
    }

    func testDoctorFindingsCarryTheirActionsAndTheScanGate() throws {
        let report = try ToolsDiskProvider.decode(DoctorReport.self, from: fixture("contract-doctor-findings"), command: "doctor")
        XCTAssertEqual(report.schemaVersion, 1)
        XCTAssertEqual(report.analyzers, ["temp-leaks", "app-bloat"])
        XCTAssertEqual(report.scanGate?.gated, false)
        XCTAssertEqual(report.scanGate?.fseventsdLimitBytes, 1_073_741_824)
        let clone = try XCTUnwrap(report.findings.first)
        XCTAssertEqual(clone.actions?.first?.id, "delete-clone")
        XCTAssertEqual(clone.actions?.first?.confirm, "yesno")
        XCTAssertEqual(clone.fromCache, false)
        XCTAssertEqual(clone.metadata?["bundleId"], .string("com.google.Chrome"))
    }

    func testDoctorActResultsDecodeEveryStatus() throws {
        let dry = try ToolsDiskProvider.decode(DoctorActResult.self, from: fixture("contract-doctor-act-dryrun"), command: "act")
        XCTAssertTrue(dry.dryRun)
        XCTAssertNil(dry.manifestPath)
        XCTAssertEqual(dry.totals.skipped, 2)
        XCTAssertNil(dry.volume.deltaBytes)

        let ok = try ToolsDiskProvider.decode(DoctorActResult.self, from: fixture("contract-doctor-act-result-ok"), command: "act")
        XCTAssertEqual(ok.method, .delete)
        XCTAssertEqual(ok.volume.deltaBytes, 943_718_400)
        XCTAssertEqual(ok.items.map(\.status), ["ok", "ok"])
        XCTAssertEqual(ok.items.first?.freesNow, "yes")

        let refused = try ToolsDiskProvider.decode(DoctorActResult.self, from: fixture("contract-doctor-act-result-refused"),
                                                   command: "act")
        XCTAssertEqual(refused.items.map(\.reason), ["blocked", "confirm-required", "outside-allowlist"])
        XCTAssertEqual(refused.items[0].severity, .blocked)
        XCTAssertNotNil(refused.items[0].blacklistReason)
        XCTAssertEqual(refused.items[1].requiredConfirm, "typed")
        XCTAssertEqual(refused.items[1].expectedPhrase, "DELETE")
        XCTAssertNotNil(refused.items[2].error)
        XCTAssertNil(refused.volume.path)
    }

    func testTheActStreamParsesAndTheArgumentsMatchTheContractsArgv() throws {
        let lines = String(decoding: try fixture("contract-doctor-act", "ndjson"), as: UTF8.self)
            .split(separator: "\n").map(String.init)
        let events = lines.compactMap(DoctorActEvent.parse(line:))
        XCTAssertEqual(events.count, 5)
        guard case .plan(let plan) = events[0] else { return XCTFail("plan first") }
        XCTAssertEqual(plan.items.first?.paths.first?.allocatedBytes, 891_289_600)
        XCTAssertEqual(plan.method, .trash)
        XCTAssertEqual(events[1], .itemStarted(findingId: "app-bloat:playwright-cache:/Users/alice/Library/Caches/ms-playwright"))
        guard case .itemDone(let done) = events[2] else { return XCTFail("item done") }
        XCTAssertEqual(done.status, "staged")
        XCTAssertEqual(done.trashPaths, ["/Users/alice/.Trash/ms-playwright"])
        XCTAssertEqual(events[3], .volumeAfter(availableAfter: 9_663_676_416))
        guard case .result(let result) = events[4] else { return XCTFail("result last") }
        XCTAssertEqual(result.totals.staged, 1)
        XCTAssertEqual(result.items.first?.restore, "Finder: Put Back from the Trash")

        let argv = ToolsDiskProvider.doctorActArguments(
            actionId: "delete-app-cache", analyzerId: "app-bloat",
            findingIDs: ["app-bloat:playwright-cache:/Users/alice/Library/Caches/ms-playwright"],
            method: .trash, yes: true, ndjson: true)
        XCTAssertEqual(["doctor"] + argv, plan.argv, "the kit builds the argv the CLI recorded")
        let typed = ToolsDiskProvider.doctorActArguments(actionId: "delete-scratch", analyzerId: "temp-leaks",
                                                         findingIDs: ["a", "b"], method: .delete,
                                                         confirmPhrases: ["DELETE"], dryRun: true)
        XCTAssertEqual(typed, ["act", "delete-scratch", "--analyzer", "temp-leaks", "--id", "a", "--id", "b",
                               "--method", "delete", "--confirm", "DELETE", "--dry-run", "--json"])
    }

    func testClonesApplyAndItsErrorEnvelope() throws {
        let applied = try ToolsDiskProvider.decodeClonesApply(fixture("contract-clones-apply-result"))
        XCTAssertEqual(applied.state, "applied")
        XCTAssertEqual(applied.ops.map(\.status), ["ok", "already-cloned"])
        XCTAssertEqual(applied.totals.bytesReclaimed, 52_428_800)
        XCTAssertEqual(applied.freeBytes?.after, 9_716_105_216)
        XCTAssertEqual(applied.plan?.sets, 2)
        XCTAssertEqual(applied.planCache?.hit, true)
        XCTAssertThrowsError(try ToolsDiskProvider.decodeClonesApply(fixture("contract-clones-error-envelope"))) { error in
            let envelope = error as? ClonesCommandError
            XCTAssertEqual(envelope?.kind, "rollback-space")
            XCTAssertEqual(envelope?.required, 5_368_709_120)
            XCTAssertEqual(envelope?.available, 2_147_483_648)
        }
    }

    func testAnIndexCommandsErrorDocumentIsThrownAsItself() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("du-index-fake-\(UUID())")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let errorJSON = String(decoding: try fixture("contract-du-index-error"), as: UTF8.self)
            .replacingOccurrences(of: "\n", with: " ")
        let script = folder.appendingPathComponent("tools")
        try Data("#!/bin/sh\nprintf '%s\\n' '\(errorJSON)'\nexit 3\n".utf8).write(to: script)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        let provider = ToolsDiskProvider(bridge: ToolsBridge(binaryPath: script.path), timeoutSeconds: 20)
        do {
            _ = try await provider.duIndexInfo(db: "/tmp/fixture-index.db")
            XCTFail("expected the CLI's error")
        } catch let error as DuIndexError {
            XCTAssertEqual(error.code, "locked")
        }
    }
}

final class DuIndexReaderTests: XCTestCase {
    private var directory: URL!
    private var dbPath: String { directory.appendingPathComponent("index.db").path }
    private var writer: OpaquePointer?

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("du-index-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let schemaURL = try KitFixture.url("contract-du-index-schema.sql")
        XCTAssertEqual(sqlite3_open(dbPath, &writer), SQLITE_OK)
        try exec("PRAGMA journal_mode = WAL;")
        try exec(String(contentsOf: schemaURL, encoding: .utf8))
        try exec("""
            INSERT INTO meta VALUES ('schema_version', '1'), ('root', '/Users/example'), ('private', '1');
            INSERT INTO scans (id, kind, root, started_at_ms, finished_at_ms, status, files, dirs, alloc_bytes, walk_ms, threads, options_json)
              VALUES (42, 'build', '/Users/example', 1760313593470, 1760313600000, 'done', 1301243, 159603, 36291559424, 5412, 8, '{}'),
                     (43, 'update', '/Users/example', 1760381999882, 1760382000000, 'done', 6222, 195, 36339892224, 64, 4, '{}');
            INSERT INTO dirs (id, parent_id, name, fileid, alloc_bytes, logical_bytes, private_bytes, files, dirs, max_file_bytes,
                              newest_mtime_s, dir_mtime_ms, flags, scan_id, first_scan_id) VALUES
              (1, 0, '/Users/example', 1, 100000000000, 90000000000, 70000000000, 2000000, 200000, 68719476736, 1760381940, 0, 0, 43, 42),
              (3, 1, 'Library', 3, 64424509440, 60559038874, 45741401702, 1200000, 150000, 3221225472, 1760381880, 1760054400000, 0, 43, 42),
              (17, 3, 'Containers', 17, 21474836480, 20186346291, 15247133901, 400000, 50000, 2386092942, 1760371200, 1759622400000, 0, 42, 42),
              (18, 3, 'Caches', 18, 12884901888, 12111807775, 9148280340, 300000, 40000, 1431655765, 1760370600, 1759536000000, 0, 43, 42),
              (19, 3, 'Application Support', 19, 10737418240, 10093173146, 7623566950, 200000, 30000, 1193046471, 1760370000, 1759449600000, 0, 42, 42),
              (20, 3, 'Developer', 20, 8589934592, 8074538516, 6098853560, 150000, 15000, 954437177, 1760369400, 1759363200000, 0, 42, 42),
              (21, 3, 'Group Containers', 21, 4294967296, 4037269258, 3049426780, 50000, 4000, 477218588, 1760368800, 1759276800000, 0, 42, 42),
              (22, 3, 'Logs', 22, 1073741824, 1009317315, 762356695, 20000, 900, 119304647, 1760368200, 1759190400000, 0, 42, 42),
              (23, 3, 'Mail', 23, 0, 0, 0, 0, 0, 0, 0, 1759104000000, 1, 42, 42),
              (24, 3, 'CloudStorage', 24, 0, 0, 0, 0, 0, 0, 0, 1759017600000, 4, 42, 42),
              (25, 3, 'Gone', 25, 999, 999, 999, 9, 9, 0, 0, 0, 16, 42, 42);
            INSERT INTO big_files VALUES
              ('/Users/example/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw', 17, 68719476736, 3221225472, 1, 1760381940000, 1, 43),
              ('/Users/example/Library/Caches/com.example.app/blob "quoted" name.bin', 18, 536870912, 536870912, 2, 1760374800000, 2, 43),
              ('/Users/example/Library0/outside.bin', 1, 9999999999, 9999999999, 3, 1760374800000, 1, 43),
              ('/Users/example/LibraryX/outside.bin', 1, 8888888888, 8888888888, 4, 1760374800000, 1, 43);
            """)
    }

    override func tearDownWithError() throws {
        sqlite3_close(writer)
        try? FileManager.default.removeItem(at: directory)
    }

    private func exec(_ sql: String) throws {
        var message: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(writer, sql, nil, nil, &message) == SQLITE_OK else {
            let text = message.map { String(cString: $0) } ?? "?"
            sqlite3_free(message)
            throw NSError(domain: "fixture-sql", code: 1, userInfo: [NSLocalizedDescriptionKey: text])
        }
    }

    func testLookupFindsStoredFoldersFoldedPathsAndOutsiders() throws {
        let reader = try DuIndexReader(path: dbPath)
        XCTAssertEqual(try reader.roots().map(\.path), ["/Users/example"])
        guard case .found(let library) = try reader.lookup("/Users/example/Library/") else { return XCTFail("found") }
        XCTAssertEqual(library.path, "/Users/example/Library")
        XCTAssertEqual(library.storedChildren, 8, "the tombstone is not counted")
        guard case .folded(let path, let into) = try reader.lookup("/Users/example/Library/Containers/com.docker.docker")
        else { return XCTFail("folded") }
        XCTAssertEqual(path, "/Users/example/Library/Containers/com.docker.docker")
        XCTAssertEqual(into.path, "/Users/example/Library/Containers")
        guard case .folded(_, let parent) = try reader.lookup("/Users/example/Library/Gone") else { return XCTFail("gone") }
        XCTAssertEqual(parent.name, "Library")
        XCTAssertEqual(try reader.lookup("/etc"), .notIndexed)
        XCTAssertEqual(try reader.path(of: 17), "/Users/example/Library/Containers")
        XCTAssertEqual(try reader.node(id: 22)?.path, "/Users/example/Library/Logs")
    }

    func testChildrenLocalTopFilesAndScansMatchTheContract() throws {
        let reader = try DuIndexReader(path: dbPath)
        guard case .found(let library) = try reader.lookup("/Users/example/Library") else { return XCTFail("found") }
        let children = try reader.children(of: library)
        XCTAssertEqual(children.map(\.name), ["Containers", "Caches", "Application Support", "Developer",
                                              "Group Containers", "Logs", "CloudStorage", "Mail"])
        XCTAssertEqual(children.first?.share ?? 0, 0.3333, accuracy: 0.0001)
        XCTAssertEqual(children.first?.path, "/Users/example/Library/Containers")
        XCTAssertEqual(try reader.children(of: library, minBytes: 10_000_000_000).count, 5, "3, then the 2 flagged ones")
        XCTAssertEqual(try reader.children(of: library, sort: .name, limit: 2).map(\.name),
                       ["Application Support", "Caches", "CloudStorage", "Mail"])
        XCTAssertEqual(children.first { $0.name == "Mail" }?.flags, .denied)

        let local = try reader.local(of: library)
        XCTAssertEqual(local, DuIndexLocal(allocBytes: 5_368_709_120, logicalBytes: 5_046_586_573,
                                           privateBytes: 3_811_783_476, files: 80_000, dirs: 10_092),
                       "the same numbers the CLI prints as local")

        let top = try reader.topFiles(under: "/Users/example/Library")
        XCTAssertEqual(top.count, 2, "Library0 and LibraryX are outside the range")
        XCTAssertEqual(top.first?.allocBytes, 3_221_225_472)
        XCTAssertEqual(try reader.largestFiles(limit: 1).first?.path, "/Users/example/Library0/outside.bin")
        XCTAssertEqual(try reader.scans().map(\.id), [43, 42])
        XCTAssertEqual(try reader.meta()["root"], "/Users/example")
    }

    func testAnOpenWriteTransactionNeverBlocksTheReaderAndItsCommitIsSeen() throws {
        let reader = try DuIndexReader(path: dbPath, busyTimeout: 200)
        try exec("BEGIN IMMEDIATE; INSERT INTO dirs (id, parent_id, name, fileid, alloc_bytes, logical_bytes, files, dirs, max_file_bytes, newest_mtime_s, dir_mtime_ms, flags, scan_id, first_scan_id) VALUES (900, 0, '/Volumes/Other', 9, 1, 1, 1, 0, 1, 0, 0, 0, 44, 44);")
        let started = Date()
        XCTAssertEqual(try reader.roots().count, 1, "the last committed snapshot")
        // A wait for the writer would end in SQLITE_BUSY after the 200 ms busy timeout, which throws; the bound
        // only catches a hang, so a loaded machine does not fail it.
        XCTAssertLessThan(Date().timeIntervalSince(started), 1.0, "no wait for the writer")
        try exec("COMMIT;")
        XCTAssertEqual(try reader.roots().count, 2)
    }

    func testAnIndexClosedCleanlyByItsWriterIsStillReadable() throws {
        // The writer's clean close deletes the WAL files; a SQLITE_OPEN_READONLY connection cannot create them, and
        // its first read failed with SQLITE_CANTOPEN ("no index" in the app after every finished build).
        sqlite3_close(writer)
        writer = nil
        // Apple's SQLite keeps the WAL file on close; the CLI's (Bun's) deletes both, which is the state to read.
        try? FileManager.default.removeItem(atPath: dbPath + "-wal")
        try? FileManager.default.removeItem(atPath: dbPath + "-shm")
        XCTAssertFalse(FileManager.default.fileExists(atPath: dbPath + "-wal"))
        let reader = try DuIndexReader(path: dbPath)
        XCTAssertEqual(try reader.roots().map(\.path), ["/Users/example"])
        XCTAssertEqual(try reader.scans(limit: 5).count, 2)
    }

    func testAMissingFileAndANewerSchemaAreRefused() throws {
        XCTAssertThrowsError(try DuIndexReader(path: directory.appendingPathComponent("none.db").path)) { error in
            guard case .missing = error as? DuIndexReader.ReaderError else { return XCTFail("\(error)") }
        }
        try exec("UPDATE meta SET value = '2' WHERE key = 'schema_version';")
        XCTAssertThrowsError(try DuIndexReader(path: dbPath)) { error in
            XCTAssertEqual(error as? DuIndexReader.ReaderError, .schemaNewer(found: 2, supported: 1))
        }
    }
}

// MARK: - Review fixes and the blocked contract (2026-10-13)

extension DuIndexContractTests {
    func testTheBlockedCountsDecode() throws {
        let query = try decodeIndex(DuIndexQueryResult.self, "contract-du-index-query-children")
        XCTAssertEqual(query.blockedBelow, 3)
        let info = try decodeIndex(DuIndexInfo.self, "contract-du-index-query-info")
        XCTAssertEqual(info.meta.blockedDirs, "3")
        XCTAssertEqual(info.counts.blocked, 3)
        let error = try DuIndexJSON.decoder().decode(DuIndexError.self, from: Data(
            #"{"command":"query","code":"inconsistent","message":"rebuild the index","exit_code":1}"#.utf8))
        XCTAssertEqual(error.code, "inconsistent")
        XCTAssertEqual(error.exitCode, 1)
    }

    /// M11: a known line that does not decode is not an unknown line.
    func testAKnownLineThatDoesNotDecodeIsUndecodable() {
        guard case .undecodable(let type, let detail)? = DuIndexEvent.parse(line: #"{"type":"result","command":"build","scan_id":"x"}"#)
        else { return XCTFail("undecodable") }
        XCTAssertEqual(type, "result")
        XCTAssertFalse(detail.isEmpty)
        XCTAssertEqual(DuIndexEvent.parse(line: #"{"type":"future"}"#), .other("future"))
        guard case .undecodable("result", _)? = DoctorActEvent.parse(line: #"{"type":"result","result":{"runId":1}}"#)
        else { return XCTFail("undecodable act result") }
        XCTAssertEqual(DuIndexEvent.parse(line: #"{"type":"blocked","path":"/x","waited_ms":5}"#),
                       .blocked(DuIndexEvent.Blocked(path: "/x", waitedMs: 5)), "the event structs have public inits")
    }

    /// Low 23: a method this build does not know does not fail the whole act result.
    func testAnUnknownActMethodReadsAsNil() throws {
        let text = try KitFixture.string("contract-doctor-act-result-ok.json")
        XCTAssertTrue(text.contains(#""method": "delete""#) || text.contains(#""method":"delete""#))
        let changed = text.replacingOccurrences(of: #""method": "delete""#, with: #""method": "shred""#)
            .replacingOccurrences(of: #""method":"delete""#, with: #""method":"shred""#)
        let result = try JSONDecoder().decode(DoctorActResult.self, from: Data(changed.utf8))
        XCTAssertNil(result.method)
    }

    /// Low 20: a relative path that starts with a dash never parses as a flag.
    func testADashPathIsPassedAsAnOperand() {
        XCTAssertEqual(ToolsDiskProvider.operand("-rf"), "./-rf")
        XCTAssertEqual(ToolsDiskProvider.operand("/Users/example"), "/Users/example")
    }
}

extension DuIndexReaderTests {
    func testBlockedFoldersAreAlwaysListedAndCounted() throws {
        try exec("""
            INSERT INTO dirs (id, parent_id, name, fileid, alloc_bytes, logical_bytes, files, dirs, max_file_bytes,
                              newest_mtime_s, dir_mtime_ms, flags, scan_id, first_scan_id) VALUES
              (26, 3, 'Photos Library', 26, 0, 0, 0, 0, 0, 0, 0, 32, 43, 43);
            INSERT INTO meta VALUES ('blocked_dirs', '1');
            """)
        let reader = try DuIndexReader(path: dbPath)
        guard case .found(let library) = try reader.lookup("/Users/example/Library") else { return XCTFail("found") }
        XCTAssertEqual(try reader.children(of: library, minBytes: 10_000_000_000).map(\.name),
                       ["Containers", "Caches", "Application Support", "CloudStorage", "Mail", "Photos Library"],
                       "flagged children follow the others whatever the size filter")
        XCTAssertEqual(try reader.children(of: library, sort: .name, limit: 2).map(\.name),
                       ["Application Support", "Caches", "CloudStorage", "Mail", "Photos Library"])
        XCTAssertEqual(try reader.blockedDirCount(), 1)
        XCTAssertEqual(try reader.blockedBelow(library), 1)
        let root = try XCTUnwrap(try reader.roots().first)
        XCTAssertEqual(try reader.blockedBelow(root), 1)
        XCTAssertEqual(try reader.blockedBelow(try XCTUnwrap(try reader.node(id: 17))), 0)
        try exec("UPDATE meta SET value = '0' WHERE key = 'blocked_dirs';")
        XCTAssertEqual(try reader.blockedBelow(library), 0, "nothing blocked in the last walk: no lookup")
    }

    /// Low 17: a node read before an update still gives sizes from one read.
    func testAStaleNodeGivesSharesAndLocalSizesFromTheCurrentRead() throws {
        let reader = try DuIndexReader(path: dbPath)
        guard case .found(var library) = try reader.lookup("/Users/example/Library") else { return XCTFail("found") }
        let fresh = try reader.local(of: library)
        library.allocBytes = 1
        XCTAssertEqual(try reader.local(of: library), fresh)
        XCTAssertEqual(try reader.children(of: library).first?.share ?? 0, 0.3333, accuracy: 0.0001)
    }

    /// Low 19: a parent cycle has no path, and a database without a schema version is refused.
    func testAParentCycleHasNoPathAndAMissingSchemaVersionIsRefused() throws {
        try exec("UPDATE dirs SET parent_id = 22 WHERE id = 3;")
        let reader = try DuIndexReader(path: dbPath)
        XCTAssertNil(try reader.node(id: 22)?.path)
        try exec("DELETE FROM meta WHERE key = 'schema_version';")
        XCTAssertThrowsError(try DuIndexReader(path: dbPath)) { error in
            guard case .open = error as? DuIndexReader.ReaderError else { return XCTFail("\(error)") }
        }
    }
}
