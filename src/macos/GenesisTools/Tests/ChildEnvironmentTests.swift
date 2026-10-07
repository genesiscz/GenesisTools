import XCTest
@testable import GenesisTools

/// The PATH an app face gives its children (Sources/App/ChildEnvironment.swift).
final class ChildEnvironmentTests: XCTestCase {
    private let user = ["/Users/someone/.local/bin", "/Users/someone/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin"]

    func testCapturedEnvironmentSurvivesTheSharedRunnerPolicy() {
        for key in ChildEnvironment.capturedKeys {
            XCTAssertTrue(ToolsBridge.envAllowlist.contains(key), "captured \(key) must reach child tools")
        }
    }

    func testAddedDirectoriesComeAfterTheBase() {
        let path = ChildEnvironment.path(ChildEnvironment.launchdPath, adding: user)

        XCTAssertEqual(path, "/usr/bin:/bin:/usr/sbin:/sbin:/Users/someone/.local/bin:/Users/someone/.bun/bin:/opt/homebrew/bin:/usr/local/bin")
    }

    func testTerminalPathKeepsItsOrderAndGainsOnlyWhatIsMissing() {
        let terminal = "/Users/someone/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin"
        let parts = terminal.split(separator: ":").map(String.init)

        XCTAssertEqual(ChildEnvironment.path(parts, adding: user), terminal + ":/Users/someone/.local/bin:/usr/local/bin")
        XCTAssertEqual(ChildEnvironment.path(parts + ["/Users/someone/.local/bin", "/usr/local/bin"], adding: user),
                       terminal + ":/Users/someone/.local/bin:/usr/local/bin")
    }

    func testNoPathAtAllStillHasTheSystemDirectories() {
        let updates = ChildEnvironment.updates(current: [:], login: [:], home: "/Users/someone", exists: { $0 == "/opt/homebrew/bin" })

        XCTAssertEqual(updates["PATH"], "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin")
    }

    /// A Launch Services face runs what the login shell would run: its PATH in its order, even where it
    /// puts /usr/bin before Homebrew, and the usual directories it lacks after it.
    func testLaunchdFaceTakesTheLoginPathInItsOrderAndCABundle() {
        let login = ["PATH": "/Users/someone/.tool/bin:/usr/bin:/opt/homebrew/bin:/bin", "NODE_EXTRA_CA_CERTS": "/Users/someone/ca.pem"]
        let current = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]

        let updates = ChildEnvironment.updates(current: current, login: login, home: "/Users/someone", exists: { $0 != "/Users/someone/.local/bin" })

        XCTAssertEqual(updates["PATH"], "/Users/someone/.tool/bin:/usr/bin:/opt/homebrew/bin:/bin:/usr/sbin:/sbin:/Users/someone/.bun/bin:/opt/homebrew/sbin:/usr/local/bin")
        XCTAssertEqual(updates["NODE_EXTRA_CA_CERTS"], "/Users/someone/ca.pem")
    }

    func testLaunchdFaceWithoutALoginShellAppendsTheUsualDirectories() {
        let updates = ChildEnvironment.updates(current: ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"], login: [:], home: "/Users/someone", exists: { _ in true })

        XCTAssertEqual(updates["PATH"], "/usr/bin:/bin:/usr/sbin:/sbin:/Users/someone/.local/bin:/Users/someone/.bun/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin")
    }

    /// A face started from a terminal keeps the terminal's preferences: the login shell's directories
    /// it lacks come after them, never ahead.
    func testTerminalFaceKeepsItsPathAheadOfTheLoginShell() {
        let current = ["PATH": "/Users/someone/project/bin:/usr/bin:/bin"]
        let login = ["PATH": "/opt/homebrew/bin:/usr/bin:/bin"]

        let updates = ChildEnvironment.updates(current: current, login: login, home: "/Users/someone", exists: { $0 == "/opt/homebrew/bin" || $0 == "/usr/bin" || $0 == "/bin" })

        XCTAssertEqual(updates["PATH"], "/Users/someone/project/bin:/usr/bin:/bin:/opt/homebrew/bin")
    }

    func testAValueTheFaceAlreadyHasIsKept() {
        let current = ["PATH": "/opt/homebrew/bin:/usr/bin", "NODE_EXTRA_CA_CERTS": "/elsewhere/ca.pem"]
        let login = ["PATH": "/opt/homebrew/bin:/usr/bin", "NODE_EXTRA_CA_CERTS": "/Users/someone/ca.pem"]

        let updates = ChildEnvironment.updates(current: current, login: login, home: "/Users/someone", exists: { $0 == "/opt/homebrew/bin" })

        XCTAssertEqual(updates, [:])
    }

    func testParseReadsOnlyTheCapturedKeysAfterTheMarker() {
        let output = "PATH=/noise/from/zshrc\n__GENESIS_TOOLS_LOGIN_ENV__\nHOME=/Users/someone\nPATH=/a:/b\nNODE_EXTRA_CA_CERTS=/c=d.pem\n"

        XCTAssertEqual(ChildEnvironment.parse(output), ["PATH": "/a:/b", "NODE_EXTRA_CA_CERTS": "/c=d.pem"])
    }
}
