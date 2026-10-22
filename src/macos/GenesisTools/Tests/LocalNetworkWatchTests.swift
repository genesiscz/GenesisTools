@testable import GenesisToolsHost
import XCTest

final class LocalNetworkWatchTests: XCTestCase {
    func testPromptPidReadsNehelpersLine() {
        let line = "2026-10-22 16:33:02.480 I  nehelper[402:377e9a1] [com.apple.networkextension:] Found new path "
            + "/Users/me/.genesis-tools/app/retired.noindex/1792679551787/GenesisTools.app/Contents/MacOS/GenesisTools "
            + "for PID 49784, allowing a new prompt"
        XCTAssertEqual(LocalNetworkWatch.promptPid(inLogLine: line), 49784)
        XCTAssertNil(LocalNetworkWatch.promptPid(inLogLine: "Filtering the log data using \"process == nehelper\""))
        let other = "2026-10-22 16:34:10.002 I  nehelper[402:377e9a1] [com.apple.networkextension:] Found new path "
            + "/Applications/Other.app/Contents/MacOS/Other for PID 51200, allowing a new prompt"
        XCTAssertNil(LocalNetworkWatch.promptPid(inLogLine: other), "another app's prompt is not ours to describe")
    }

    /// Only a prompt that `tools` returned without a process says the process exited; a lookup that failed or did not
    /// find the pid says that instead.
    func testAFailedLookupIsNotShownAsAnExitedProcess() {
        let exited = LocalNetworkPrompt(at: "2026-10-22 16:33:02", pid: 49784, executable: "/x", retiredAt: nil, process: nil)
        let list = LocalNetworkPromptList(prompts: [exited])
        XCTAssertEqual(LocalNetworkWatch.prompt(for: 49784, in: list).headline, "pid 49784 (it has already exited)")
        XCTAssertEqual(LocalNetworkWatch.prompt(for: 51200, in: list).headline, "pid 51200 (could not look up this process)")
        XCTAssertEqual(LocalNetworkWatch.prompt(for: 49784, in: nil).headline, "pid 49784 (could not look up this process)")
    }

    /// The `log stream` child ended: the exit hook must not signal its pid, which another process may hold by then.
    func testAnEndedLogStreamLeavesNoPidForTheExitHook() {
        LocalNetworkWatch.streamPid = 12345
        LocalNetworkWatch.streamEnded()
        XCTAssertEqual(LocalNetworkWatch.streamPid, 0)
    }

    func testShortCommandNamesTheTool() {
        XCTAssertEqual(LocalNetworkPromptRow.short("gt-cc /Users/me/GenesisTools/src/cc/index.ts run work --resume x"), "cc run work --resume x")
        XCTAssertEqual(LocalNetworkPromptRow.short("/usr/bin/python3 server.py"), "/usr/bin/python3 server.py")
    }
}
