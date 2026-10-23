import GenesisKitFixtures
import XCTest
@testable import GenesisKit
@testable import GenesisKitDisk

/// The typed `tools macos clones` commands that change state (reclaim apply, rollback, presets, daemon, config) and
/// the doctor act expectations. A fake `tools` script records its argv and prints a canned payload; the shapes come
/// from the CLI source (`src/macos/commands/clones/{reclaim,optimize,daemon,config}.ts`) and the frozen contracts.
final class ToolsDiskClonesCommandTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("clones-cmd-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    /// A provider whose `tools` prints `payload` and exits with `code`, recording its argv one per line.
    private func provider(printing payload: Data, exitCode: Int32 = 0) throws -> ToolsDiskProvider {
        let output = directory.appendingPathComponent("out.json")
        try payload.write(to: output)
        let script = directory.appendingPathComponent("tools")
        let body = "#!/bin/sh\nprintf '%s\\n' \"$@\" > '\(directory.appendingPathComponent("argv").path)'\n"
            + "cat '\(output.path)'\nexit \(exitCode)\n"
        try body.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        return ToolsDiskProvider(bridge: ToolsBridge(binaryPath: script.path), timeoutSeconds: 30)
    }

    private func provider(printing json: String, exitCode: Int32 = 0) throws -> ToolsDiskProvider {
        try provider(printing: Data(json.utf8), exitCode: exitCode)
    }

    private func argv() throws -> [String] {
        try String(contentsOf: directory.appendingPathComponent("argv"), encoding: .utf8)
            .split(separator: "\n", omittingEmptySubsequences: false).dropLast().map(String.init)
    }

    private func fixture(_ name: String) throws -> Data {
        try KitFixture.data("\(name).json")
    }

    private let options = ClonesReclaimPlanOptions(dirs: ["/Users/alice/Projects"], targets: ["node_modules"])

    func testReclaimApplyPinsItsArgvAndDecodesTheRunOrThePlan() async throws {
        let applying = try provider(printing: fixture("contract-clones-apply-result"))
        guard case .applied(let run) = try await applying.clonesReclaimApply(options, usesCachedPlan: false) else {
            return XCTFail("applied")
        }
        XCTAssertEqual(run.state, "applied")
        XCTAssertEqual(try argv(), ["macos", "clones", "reclaim", "apply", "--format", "json", "--silent", "--yes",
                                    "--dir", "/Users/alice/Projects", "--targets", "node_modules", "--no-daemon",
                                    "--no-cache"])

        let empty = try provider(printing: fixture("clones-reclaim-plan"))
        guard case .nothingToApply(let plan) = try await empty.clonesReclaimApply(options) else {
            return XCTFail("a plan without ops")
        }
        XCTAssertFalse(plan.runId.isEmpty)
    }

    func testRollbackPinsItsArgvAndThrowsTheEnvelope() async throws {
        let refusing = try provider(printing: fixture("contract-clones-error-envelope"), exitCode: 1)
        do {
            _ = try await refusing.clonesRollback(processId: "2026-10-08T20-41-40-760Z.51673.1")
            XCTFail("expected the envelope")
        } catch let error as ClonesCommandError {
            XCTAssertEqual(error.kind, "rollback-space")
            XCTAssertEqual(error.required, 5_368_709_120)
        }
        XCTAssertEqual(try argv(), ["macos", "clones", "optimize", "--rollback", "--process",
                                    "2026-10-08T20-41-40-760Z.51673.1", "--yes", "--format", "json", "--silent"])
    }

    func testPresetsSaveAndRemove() async throws {
        let saving = try provider(printing: """
            {"preset": {"id": "home", "dirs": ["/Users/alice/Projects"], "targets": ["node_modules"], "exclude": [],
             "minReal": 10485760, "keepPartners": ["bun"], "createdAt": "2026-10-13T20:00:00.000Z",
             "auto": {"enabled": true, "maxBytes": 5000000000, "maxFiles": 2000}}}
            """)
        let preset = try await saving.clonesPresetSave(id: "home", options: options)
        XCTAssertEqual(preset.keepPartners, [ClonesKeepPartnerID(rawValue: "bun")])
        XCTAssertEqual(preset.auto?.maxFiles, 2000)
        XCTAssertEqual(try argv(), ["macos", "clones", "reclaim", "presets", "save", "home", "--json",
                                    "--dir", "/Users/alice/Projects", "--targets", "node_modules"],
                       "presets save takes the selector without --no-daemon")

        let unlimited = try provider(printing: """
            {"preset": {"id": "home", "dirs": ["/Users/alice/Projects"], "targets": ["all"], "exclude": [],
             "minReal": 102400, "keepPartners": [], "createdAt": "2026-10-19T15:00:00.000Z", "auto": {"enabled": true}}}
            """)
        var withFloor = options
        withFloor.minReal = 102_400
        let armed = try await unlimited.clonesPresetSave(id: "home", options: withFloor)
        XCTAssertEqual(armed.auto, ClonesPreset.Auto(enabled: true), "an armed preset without limits decodes as nil limits")
        XCTAssertTrue(try argv().contains("102400B"), "the floor goes out with a unit; the CLI refuses a bare number")

        let unknown = try provider(printing: """
            {"error": {"kind": "unknown-preset", "message": "Unknown preset \\"x\\".", "command": "reclaim presets rm",
             "presetId": "x", "known": ["home"]}}
            """, exitCode: 1)
        do {
            try await unknown.clonesPresetRemove(id: "x")
            XCTFail("expected the envelope")
        } catch let error as ClonesCommandError {
            XCTAssertEqual(error.known, ["home"])
            XCTAssertEqual(error.presetId, "x")
        }
        XCTAssertEqual(try argv(), ["macos", "clones", "reclaim", "presets", "rm", "x", "--json"])
        let removing = try provider(printing: #"{"removed": "home"}"#)
        let removed = try await removing.clonesPresetRemove(id: "home")
        XCTAssertEqual(removed, "home")
    }

    func testDaemonEnableDisableAndStatus() async throws {
        let enabling = try provider(printing: """
            {"enabled": true, "newlyRegistered": {"scan": true, "prune": false}, "registered": {"scan": true, "prune": true}}
            """)
        let enabled = try await enabling.clonesDaemonEnable()
        XCTAssertEqual(enabled.newlyRegistered, ClonesDaemonTaskFlags(scan: true, prune: false))
        XCTAssertEqual(enabled.registered, ClonesDaemonTaskFlags(scan: true, prune: true))
        XCTAssertEqual(try argv(), ["macos", "clones", "daemon", "enable", "--json"])

        let disabling = try provider(printing: """
            {"enabled": false, "removed": {"scan": true, "prune": true}, "registered": {"scan": false, "prune": false}}
            """)
        let disabled = try await disabling.clonesDaemonDisable()
        XCTAssertEqual(disabled.removed, ClonesDaemonTaskFlags(scan: true, prune: true))
        XCTAssertFalse(disabled.enabled)
        XCTAssertEqual(try argv(), ["macos", "clones", "daemon", "disable", "--json"])

        let status = try provider(printing: """
            {"enabled": true, "daemon": {"installed": true, "running": true, "pid": 812, "needsMigration": false},
             "tasks": [{"name": "clones-scan", "command": "tools macos clones reclaim scan-task", "every": "every 1d",
                        "retries": 0, "enabled": true, "timeoutMs": 600000, "notify": "failure",
                        "priority": "background", "missedRun": {"mode": "on-wake"}, "schedule": "every day"}],
             "registered": {"scan": true, "prune": false}}
            """)
        let read = try await status.clonesDaemonStatus()
        XCTAssertEqual(read.daemon.pid, 812)
        XCTAssertEqual(read.tasks.first?.notify, .string("failure"))
        XCTAssertEqual(read.tasks.first?.missedRun?.mode, "on-wake")
        XCTAssertEqual(try argv(), ["macos", "clones", "daemon", "status", "--json"])
    }

    func testConfigReadsAndChangesTheWatchedFolders() async throws {
        let config = try provider(printing: #"{"watchedDirs": ["/Users/alice/Projects"], "minReal": 10485760}"#)
        let updated = try await config.clonesConfigUpdate(addDirs: ["/Users/alice/Projects"], removeDirs: ["/old"])
        XCTAssertEqual(updated.watchedDirs, ["/Users/alice/Projects"])
        XCTAssertEqual(try argv(), ["macos", "clones", "config", "--list", "--add-dir", "/Users/alice/Projects",
                                    "--remove-dir", "/old"])
        _ = try await config.clonesConfig()
        XCTAssertEqual(try argv(), ["macos", "clones", "config", "--list"])
        XCTAssertThrowsError(try ToolsDiskProvider.clonesConfigArguments(addDirs: ["/a,b"]), "the CLI splits commas")
    }

    func testDoctorFindingsCarryThePathsHashAndTheTypedPhrase() throws {
        let report = try ToolsDiskProvider.decode(DoctorReport.self, from: fixture("contract-doctor-findings"),
                                                  command: "doctor")
        XCTAssertTrue(report.findings.first?.pathsHash?.hasPrefix("sha256:") ?? false)
        let vm = try XCTUnwrap(report.findings.first { $0.id == "app-bloat:claude-vm-bundles" })
        XCTAssertEqual(vm.actions?.first?.confirm, "typed")
        XCTAssertEqual(vm.actions?.first?.confirmPhrase, "DELETE")
    }

    func testActExpectationsPinTheirArgv() {
        let argv = ToolsDiskProvider.doctorActArguments(
            actionId: "delete-app-cache", analyzerId: "app-bloat", findingIDs: ["app-bloat:claude-vm-bundles"],
            method: .trash, confirmPhrases: ["DELETE"],
            expect: ["app-bloat:claude-vm-bundles": 4_294_967_296],
            expectPaths: ["app-bloat:claude-vm-bundles": "sha256:e425403513e5", "a:first": "sha256:00"])
        XCTAssertEqual(argv, ["act", "delete-app-cache", "--analyzer", "app-bloat", "--id", "app-bloat:claude-vm-bundles",
                              "--method", "trash", "--confirm", "DELETE",
                              "--expect", "app-bloat:claude-vm-bundles=4294967296",
                              "--expect-paths", "a:first=sha256:00",
                              "--expect-paths", "app-bloat:claude-vm-bundles=sha256:e425403513e5", "--json"])
    }
}
