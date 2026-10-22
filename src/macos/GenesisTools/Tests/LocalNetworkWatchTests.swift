@testable import GenesisToolsHost
import XCTest

final class LocalNetworkWatchTests: XCTestCase {
    func testPromptPidReadsNehelpersLine() {
        let line = "2026-10-22 16:33:02.480 I  nehelper[402:377e9a1] [com.apple.networkextension:] Found new path "
            + "/Users/me/.genesis-tools/app/retired.noindex/1792679551787/GenesisTools.app/Contents/MacOS/GenesisTools "
            + "for PID 49784, allowing a new prompt"
        XCTAssertEqual(LocalNetworkWatch.promptPid(inLogLine: line), 49784)
        XCTAssertNil(LocalNetworkWatch.promptPid(inLogLine: "Filtering the log data using \"process == nehelper\""))
    }

    func testShortCommandNamesTheTool() {
        XCTAssertEqual(LocalNetworkPromptRow.short("gt-cc /Users/me/GenesisTools/src/cc/index.ts run work --resume x"), "cc run work --resume x")
        XCTAssertEqual(LocalNetworkPromptRow.short("/usr/bin/python3 server.py"), "/usr/bin/python3 server.py")
    }
}
