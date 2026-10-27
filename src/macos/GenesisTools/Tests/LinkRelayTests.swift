import XCTest
@testable import GenesisToolsHost
@testable import GenesisToolsHub

/// Which faces keep the link relay in front of them (LinkRelay.swift).
final class LinkRelayTests: XCTestCase {
    func testNewerSwitchClearsAndInvalidatesAnInFlightStackRead() throws {
        var snapshot = BrowserURLForwarder.StackSnapshot()
        let first = try XCTUnwrap(snapshot.begin(shouldRead: true))
        snapshot.finish([1, 2], generation: first)
        let stale = try XCTUnwrap(snapshot.begin(shouldRead: true))
        XCTAssertNil(snapshot.begin(shouldRead: false))
        snapshot.finish([3, 4], generation: stale)
        XCTAssertEqual(snapshot.stack, [])

        let next = try XCTUnwrap(snapshot.begin(shouldRead: true))
        snapshot.finish([5, 6], generation: next)
        XCTAssertEqual(snapshot.stack, [5, 6])
    }

    /// The Grok web app's X login left it for Brave and the app stayed signed out (2026-10-16).
    func testASignInStepFromASafariWebAppGoesBackIntoItAndOtherLinksDoNot() {
        let webApp = "com.apple.Safari.WebApp.5A6B70DC-0000-4A8A-994F-97CB051AA8D8"
        for link in [
            "https://accounts.example.test/check-login?redirect=app",
            "https://auth.example.test/set-cookie?token=abc",
            "https://x.example.test/i/oauth2/authorize?client_id=1",
            "https://example.test/login",
        ] {
            XCTAssertTrue(WebAppSignIn.returnsToWebApp(link, sourceBundleID: webApp), link)
        }
        XCTAssertFalse(WebAppSignIn.returnsToWebApp("https://github.com/genesiscz/GenesisTools", sourceBundleID: webApp))
        XCTAssertFalse(WebAppSignIn.returnsToWebApp("https://accounts.example.test/check-login", sourceBundleID: "com.brave.Browser"))
        XCTAssertFalse(WebAppSignIn.returnsToWebApp("https://accounts.example.test/check-login", sourceBundleID: nil))
        XCTAssertFalse(WebAppSignIn.returnsToWebApp("mailto:someone@example.test", sourceBundleID: webApp))
    }

    func testContentPathsContainingLoginWordsKeepNormalRouting() {
        for path in ["/blog/oauth-security", "/docs/callbacks", "/login-guide", "/authorize-your-team"] {
            XCTAssertFalse(WebAppSignIn.isSignInStep(URL(string: "https://example.test" + path)!))
        }
        for path in ["/oauth/callback", "/i/oauth2/authorize", "/signin", "/sign-in", "/set-cookie"] {
            XCTAssertTrue(WebAppSignIn.isSignInStep(URL(string: "https://example.test" + path)!))
        }
    }

    func testRepeatsAreScopedToTheSourceWebApp() {
        let at = Date(timeIntervalSince1970: 100)
        let raw = "https://example.test/login"
        let last = WebAppSignIn.ReturnAttempt(raw: raw, sourceBundleID: "app-a", at: at)
        XCTAssertTrue(last.isRepeat(raw, sourceBundleID: "app-a", now: at.addingTimeInterval(5)))
        XCTAssertFalse(last.isRepeat(raw, sourceBundleID: "app-b", now: at.addingTimeInterval(5)))
        XCTAssertFalse(last.isRepeat(raw, sourceBundleID: "app-a", now: at.addingTimeInterval(11)))
        XCTAssertFalse(last.isRepeat(raw + "?next=1", sourceBundleID: "app-a", now: at.addingTimeInterval(5)))
    }

    func testAFailedWebAppOpenFallsBackWithTheOriginalLink() {
        let raw = "https://auth.example.test/set-cookie?token=fixture"
        var forwarded: [String] = []
        WebAppSignIn.completeReturn(raw, error: nil) { forwarded.append($0) }
        XCTAssertTrue(forwarded.isEmpty)
        WebAppSignIn.completeReturn(raw, error: NSError(domain: "fixture", code: 1)) { forwarded.append($0) }
        XCTAssertEqual(forwarded, [raw])
    }

    func testEveryWindowFaceEnsuresTheRelayAndScriptedRunsDoNot() {
        XCTAssertTrue(LinkRelay.shouldEnsure([]))
        XCTAssertTrue(LinkRelay.shouldEnsure(["--hub"]))
        XCTAssertTrue(LinkRelay.shouldEnsure(["--review", "--proposal", "/tmp/p.json"]))
        XCTAssertFalse(LinkRelay.shouldEnsure(["--hub", "--snapshot", "/tmp/x.png"]))
        XCTAssertFalse(LinkRelay.shouldEnsure([LinkRelay.argument]))
        XCTAssertFalse(LinkRelay.shouldEnsure(["--rpc", "{}"]))
        XCTAssertFalse(LinkRelay.shouldEnsure(["https://example.org/"]))
    }

    func testABareLaunchIsNotRunAgainBecauseItMayCarryABannerClick() {
        XCTAssertTrue(LinkRelay.mayRunAgain(["--hub", "--pr", "7"]))
        XCTAssertTrue(LinkRelay.mayRunAgain(["--review"]))
        XCTAssertTrue(LinkRelay.mayRunAgain(["--window"]))
        XCTAssertFalse(LinkRelay.mayRunAgain([]))
        XCTAssertFalse(LinkRelay.mayRunAgain(["-psn_0_12345"]))
    }

    func testTheNextRelayNamesACrashButNotACleanEndOrALiveRelay() {
        let started = Date(timeIntervalSinceNow: -600)
        let crashed = RelayJournal.State(pid: 4242, startedAt: started, heartbeatAt: Date(timeIntervalSinceNow: -120), cleanExit: false)
        let line = RelayJournal.previousEnd(crashed, isAlive: { _ in false }, crashReport: { _ in "/reports/GenesisTools-1.ips" })
        XCTAssertNotNil(line)
        XCTAssertTrue(line!.contains("pid=4242 ended without a clean exit"))
        XCTAssertTrue(line!.contains("crash report /reports/GenesisTools-1.ips"))
        XCTAssertTrue(RelayJournal.previousEnd(crashed, isAlive: { _ in false }, crashReport: { _ in nil })!.contains("no crash report"))

        var clean = crashed
        clean.cleanExit = true
        XCTAssertNil(RelayJournal.previousEnd(clean, isAlive: { _ in false }, crashReport: { _ in nil }))
        XCTAssertNil(RelayJournal.previousEnd(crashed, isAlive: { _ in true }, crashReport: { _ in nil }), "it still runs")
        XCTAssertNil(RelayJournal.previousEnd(nil, isAlive: { _ in false }, crashReport: { _ in nil }))
    }

    func testAStartingRelayRetriesATransientProbeLock() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("relay-lock-\(UUID())")
        FileManager.default.createFile(atPath: file.path, contents: nil)
        let probe = open(file.path, O_RDWR)
        let relay = open(file.path, O_RDWR)
        defer { close(probe); close(relay); try? FileManager.default.removeItem(at: file) }
        XCTAssertEqual(flock(probe, LOCK_SH | LOCK_NB), 0)
        let released = DispatchSemaphore(value: 0)
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) {
            flock(probe, LOCK_UN)
            released.signal()
        }
        XCTAssertTrue(LinkRelay.acquireLock(relay))
        XCTAssertEqual(released.wait(timeout: .now() + 1), .success)
    }

    func testAnotherRelayStillExcludesASecondClaim() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("relay-lock-\(UUID())")
        FileManager.default.createFile(atPath: file.path, contents: nil)
        let first = open(file.path, O_RDWR)
        let second = open(file.path, O_RDWR)
        defer { close(first); close(second); try? FileManager.default.removeItem(at: file) }
        XCTAssertEqual(flock(first, LOCK_EX | LOCK_NB), 0)
        XCTAssertFalse(LinkRelay.acquireLock(second))
    }

    func testAClaimCannotSucceedWithoutAnOpenedAndExclusiveDescriptor() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("relay-claim-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        XCTAssertNil(LinkRelay.claimDescriptor(directory), "a directory cannot open as a writable lock file")
        let file = directory.appendingPathComponent("relay.lock")
        let descriptor = try XCTUnwrap(LinkRelay.claimDescriptor(file))
        defer { close(descriptor) }
        XCTAssertNil(LinkRelay.claimDescriptor(file), "the normal first claim excludes a second relay")
        XCTAssertNil(LinkRelay.claimDescriptor(directory.appendingPathComponent("missing/relay.lock")))
    }

    func testTheStateFileRoundTrips() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("relay-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: file) }
        let state = RelayJournal.State(pid: 7, startedAt: Date(timeIntervalSince1970: 100), heartbeatAt: Date(timeIntervalSince1970: 160), cleanExit: true)
        RelayJournal.writeState(state, to: file)
        XCTAssertEqual(RelayJournal.readState(file), state)
    }

    func testTheJournalIsReadableOnlyByItsOwnerEvenWhenAnOlderBuildMadeItWide() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("relay-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let fresh = folder.appendingPathComponent("app/link-relay.log")
        RelayJournal.write("first line", to: fresh)
        XCTAssertEqual(try permissions(fresh), 0o600)
        XCTAssertEqual(try permissions(fresh.deletingLastPathComponent()), 0o700)

        let old = folder.appendingPathComponent("old.log")
        XCTAssertTrue(FileManager.default.createFile(atPath: old.path, contents: Data(), attributes: [.posixPermissions: 0o644]))
        RelayJournal.write("next line", to: old)
        XCTAssertEqual(try permissions(old), 0o600)
        XCTAssertTrue(try String(contentsOf: old, encoding: .utf8).contains("next line"))
    }

    private func permissions(_ url: URL) throws -> Int {
        try XCTUnwrap(FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int)
    }

    func testAJournalLineKeepsTheLinkButNotItsQuery() {
        XCTAssertEqual(RelayJournal.describe("https://example.org/md/open?path=/secret&token=x"), "https://example.org/md/open?…")
        XCTAssertEqual(RelayJournal.describe("genesis-tools://hub"), "genesis-tools://hub")
    }
}
