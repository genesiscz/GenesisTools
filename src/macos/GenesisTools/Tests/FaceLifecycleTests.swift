import XCTest
@testable import GenesisToolsHost

/// The lifecycle log of the long-lived faces (Sources/Host/App/FaceLifecycle.swift) and the widget start at a window
/// face's launch (Sources/Host/WidgetLaunch.swift).
@MainActor
final class FaceLifecycleTests: XCTestCase {
    private var scratch: URL!

    override func setUp() async throws {
        scratch = FileManager.default.temporaryDirectory.appendingPathComponent("face-lifecycle-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: scratch)
    }

    func testWritersReopenTheCurrentLogAcrossRepeatedRotations() throws {
        let log = scratch.appendingPathComponent("lifecycle.jsonl")
        let first = { FaceLifecycle.appendLine("widget\n", to: log) }
        let second = { FaceLifecycle.appendLine("hub\n", to: log) }
        first()
        FaceLifecycle.rotateIfLarge(at: log, threshold: 1)
        second()
        FaceLifecycle.rotateIfLarge(at: log, threshold: 1)
        first()
        second()
        XCTAssertEqual(try String(contentsOf: log, encoding: .utf8), "widget\nhub\n")
        // By name: the listing gives /private/var/… URLs for the /var/… scratch folder, so the URLs never compare equal.
        let archives = try FileManager.default.contentsOfDirectory(at: scratch, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent != log.lastPathComponent }
        XCTAssertEqual(archives.count, 2)
        let previous = try archives.map { try String(contentsOf: $0, encoding: .utf8) }.joined()
        XCTAssertTrue(previous.contains("widget\n"))
        XCTAssertTrue(previous.contains("hub\n"))
    }

    func testALineIsOneSortedJSONObjectWithTheTimeLast() throws {
        let text = FaceLifecycle.line(time: 1_793_800_000, pid: 42, face: "--widget", event: "signal", detail: "signal 15: Terminated")

        XCTAssertEqual(text, "{\"detail\":\"signal 15: Terminated\",\"event\":\"signal\",\"face\":\"--widget\",\"pid\":42,\"t\":1793800000}\n")
        // The signal handler writes the line up to `"t":` ahead of time and only the digits when the signal arrives.
        XCTAssertTrue(FaceLifecycle.line(time: 0, pid: 42, face: "--hub", event: "crash").hasSuffix("\"t\":0}\n"))
    }

    func testOnlyTheLongLivedFacesGetALifecycle() {
        XCTAssertTrue(FaceLifecycle.isLogged(["--hub", "--resume"]))
        XCTAssertTrue(FaceLifecycle.isLogged(["--widget", "--ensure-running"]))
        XCTAssertTrue(FaceLifecycle.isLogged(["--window", "--no-activate"]))
        XCTAssertTrue(FaceLifecycle.isLogged([]))
        XCTAssertTrue(FaceLifecycle.isLogged(["--link-relay"]))
        XCTAssertFalse(FaceLifecycle.isLogged(["--rpc", "{}"]))
        XCTAssertFalse(FaceLifecycle.isLogged(["--mic"]))
        XCTAssertFalse(FaceLifecycle.isLogged(["--hub", "--snapshot", "/tmp/x.png"]))
    }

    func testABareLaunchIsNamedAsTheWindowFace() {
        XCTAssertEqual(FaceLifecycle.faceName([]), "--window")
        XCTAssertEqual(FaceLifecycle.faceName(["-psn_0_12345"]), "--window")
        XCTAssertEqual(FaceLifecycle.faceName(["--hub", "--resume"]), "--hub")
    }

    func testAFaceThatDiedWithoutAnExitLineIsClaimedOnceAndALiveOneIsKept() throws {
        let marker = try JSONEncoder().encode(FaceLifecycle.AliveMarker(face: "--widget", t: 1_793_000_000))
        try marker.write(to: scratch.appendingPathComponent("111"))
        try marker.write(to: scratch.appendingPathComponent("222"))
        try marker.write(to: scratch.appendingPathComponent("333"))

        let claimed = FaceLifecycle.claimVanished(in: scratch, ownPid: 333, alive: { $0 == 222 })

        XCTAssertEqual(claimed.map(\.pid), [111])
        XCTAssertEqual(claimed.first?.marker, FaceLifecycle.AliveMarker(face: "--widget", t: 1_793_000_000))
        XCTAssertFalse(FileManager.default.fileExists(atPath: scratch.appendingPathComponent("111").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: scratch.appendingPathComponent("222").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: scratch.appendingPathComponent("333").path))
        // A second face starting at the same time finds nothing left to report (333, the first face, still runs).
        XCTAssertTrue(FaceLifecycle.claimVanished(in: scratch, ownPid: 444, alive: { $0 == 222 || $0 == 333 }).isEmpty)
    }

    func testTheWidgetStartsOnlyWhileShowTheWidgetIsOn() throws {
        let file = scratch.appendingPathComponent("state.json")

        try Data(#"{"preferences":{"showWidget":true}}"#.utf8).write(to: file)
        XCTAssertTrue(WidgetLaunch.showWidget(stateFile: file.path))

        try Data(#"{"preferences":{"showWidget":false}}"#.utf8).write(to: file)
        XCTAssertFalse(WidgetLaunch.showWidget(stateFile: file.path))

        try Data(#"{"preferences":{}}"#.utf8).write(to: file)
        XCTAssertFalse(WidgetLaunch.showWidget(stateFile: file.path))

        try Data("not json".utf8).write(to: file)
        XCTAssertFalse(WidgetLaunch.showWidget(stateFile: file.path))

        XCTAssertFalse(WidgetLaunch.showWidget(stateFile: scratch.appendingPathComponent("missing.json").path))
    }

    func testTheWidgetCountsAsRunningOnlyWhileSomethingHoldsItsInstanceLock() throws {
        XCTAssertFalse(WidgetLaunch.isRunning(in: scratch))

        let holder = openWidgetInstanceLock(in: scratch)
        XCTAssertGreaterThanOrEqual(holder, 0)
        XCTAssertEqual(flock(holder, LOCK_EX | LOCK_NB), 0)
        XCTAssertTrue(WidgetLaunch.isRunning(in: scratch))

        close(holder)
        XCTAssertFalse(WidgetLaunch.isRunning(in: scratch))
    }

    func testTheWidgetStateFileFollowsGenesisToolsHome() {
        XCTAssertEqual(
            WidgetLaunch.stateFile(environment: ["GENESIS_TOOLS_HOME": "/tmp/sandbox-home"]),
            "/tmp/sandbox-home/.genesis-tools/hub/widget/state.json")
    }
}
