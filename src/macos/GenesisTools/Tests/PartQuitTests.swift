import AppKit
import Darwin
import XCTest
@testable import GenesisToolsHost

/// ⌘Q in the widget and the feature settings face (Clicky): which parts the question names, when it is skipped, and
/// what an answer does (Sources/Host/PartQuit). Fakes stand in for the process scan, the alert and the quit signal.
@MainActor
final class PartQuitTests: XCTestCase {
    private let own: Int32 = 100
    private let allLinked: Set<String> = ["features", "hub", "widget", "clicky", "markdown"]

    private func snapshot(_ faces: [(Int32, String)], clickyUp: Bool = true, linked: Set<String>? = nil)
        -> RunningPartsSnapshot
    {
        RunningPartsSnapshot(
            ownPid: own, faces: faces.map { RunningFace(pid: $0.0, face: $0.1) }, linkedParts: linked ?? allLinked,
            liveHostedParts: clickyUp ? ["clicky"] : [])
    }

    // MARK: Which processes are faces

    func testOnlyWindowFacesAreNamedNeverTheLauncherRelayOrScriptedRuns() {
        XCTAssertEqual(PartQuit.face(ofArguments: ["--widget", "--ensure-running"], preview: false), "--widget")
        XCTAssertEqual(PartQuit.face(ofArguments: ["--features", "--no-activate"], preview: false), "--features")
        XCTAssertEqual(PartQuit.face(ofArguments: ["--clicky"], preview: false), "--features", "the old name")
        XCTAssertEqual(PartQuit.face(ofArguments: ["--hub", "--mode", "prs"], preview: false), "--hub")
        XCTAssertEqual(PartQuit.face(ofArguments: ["genesis-tools://hub?mode=prs"], preview: false), "--hub")
        XCTAssertEqual(PartQuit.face(ofArguments: ["--review", "--repo", "/tmp/r"], preview: false), "--review")
        XCTAssertEqual(PartQuit.face(ofArguments: [], preview: false), "--window")
        XCTAssertEqual(PartQuit.face(ofArguments: ["--window", "--no-activate"], preview: false), "--window")
        XCTAssertEqual(PartQuit.face(ofArguments: [], preview: true), "--widget", "a Preview bundle's bare launch")

        for unnamed in [
            ["/Users/example/.bun/bin/bun", "run", "/tmp/x.ts"], ["--link-relay"], ["--rpc", "{}"], ["--mic"],
            ["--capsule"], ["https://example.org/"], ["--hub", "--snapshot", "/tmp/x.png"],
            ["--features", "--page", "general", "--headless"], ["--hub", "--bench", "/tmp/b.json"],
        ] {
            XCTAssertNil(PartQuit.face(ofArguments: unnamed, preview: false), "\(unnamed)")
        }
    }

    // MARK: When the question is skipped

    func testThisPartAloneQuitsWithoutAQuestionWhateverTheSetting() {
        let alone = snapshot([(own, "--widget")])
        for behavior in QuitBehavior.allCases {
            XCTAssertEqual(PartQuit.plan(face: "--widget", snapshot: alone, behavior: behavior), .quitThis)
        }
    }

    func testTheSettingAnswersWithoutAQuestion() {
        let running = snapshot([(own, "--widget"), (300, "--hub"), (200, "--features")])

        XCTAssertEqual(PartQuit.plan(face: "--widget", snapshot: running, behavior: .thisPart), .quitThis)
        XCTAssertEqual(
            PartQuit.plan(face: "--widget", snapshot: running, behavior: .allParts), .quitAll(otherPids: [200, 300]))
    }

    // MARK: Which parts the question names

    func testTheQuestionNamesEveryOtherRunningPartInOrder() {
        let running = snapshot([(400, "--window"), (300, "--hub"), (own, "--widget"), (200, "--features")])

        guard case .ask(let question) = PartQuit.plan(face: "--widget", snapshot: running, behavior: .ask) else {
            return XCTFail("expected a question")
        }
        XCTAssertEqual(question.otherNames, ["Clicky", "Hub", "Permissions"])
        XCTAssertEqual(question.title, "Quit only Widget, or all GenesisTools parts?")
        XCTAssertEqual(question.quitThisTitle, "Quit Widget")
        XCTAssertEqual(question.message, "Clicky, Hub and Permissions are also running. Quit All stops them too.")
    }

    func testOneOtherPartReadsInTheSingular() {
        guard case .ask(let question) = PartQuit.plan(
            face: "--widget", snapshot: snapshot([(own, "--widget"), (300, "--hub")]), behavior: .ask)
        else { return XCTFail("expected a question") }

        XCTAssertEqual(question.message, "Hub is also running. Quit All stops it too.")
    }

    /// Clicky lives in the feature settings face; without its status item (or in a build without the part) that
    /// face is only the settings window.
    func testClickyIsNamedOnlyWhileItsStatusItemIsUpInABuildThatLinksIt() {
        let faces: [(Int32, String)] = [(own, "--widget"), (200, "--features")]

        for (clickyUp, linked, expected) in [
            (true, allLinked, "Clicky"), (false, allLinked, "Settings"),
            (true, allLinked.subtracting(["clicky"]), "Settings"),
        ] {
            let plan = PartQuit.plan(
                face: "--widget", snapshot: snapshot(faces, clickyUp: clickyUp, linked: linked), behavior: .ask)
            XCTAssertEqual(plan, .ask(QuitQuestion(thisName: "Widget", otherNames: [expected])))
        }
    }

    func testTheFeatureSettingsFaceCallsItselfClickyWhileClickyIsUp() {
        let running = snapshot([(own, "--features"), (300, "--widget")])

        XCTAssertEqual(
            PartQuit.plan(face: "--features", snapshot: running, behavior: .ask),
            .ask(QuitQuestion(thisName: "Clicky", otherNames: ["Widget"])))
        XCTAssertEqual(
            PartQuit.plan(face: "--features", snapshot: snapshot([(own, "--features"), (300, "--widget")], clickyUp: false), behavior: .ask),
            .ask(QuitQuestion(thisName: "Settings", otherNames: ["Widget"])))
    }

    func testTwoProcessesOfOneFaceAreNamedOnceAndBothQuit() {
        let running = snapshot([(own, "--widget"), (310, "--review"), (300, "--review")])

        XCTAssertEqual(
            PartQuit.plan(face: "--widget", snapshot: running, behavior: .ask),
            .ask(QuitQuestion(thisName: "Widget", otherNames: ["Review"])))
        XCTAssertEqual(
            PartQuit.plan(face: "--widget", snapshot: running, behavior: .allParts), .quitAll(otherPids: [300, 310]))
    }

    func testNameLists() {
        XCTAssertEqual(PartQuit.list(["Hub"]), "Hub")
        XCTAssertEqual(PartQuit.list(["Widget", "Hub"]), "Widget and Hub")
        XCTAssertEqual(PartQuit.list(["Widget", "Clicky", "Hub"]), "Widget, Clicky and Hub")
    }

    // MARK: What an answer does

    func testQuitAllAsksTheFacesRunningAtTheAnswerThenQuitsThisOne() {
        let probe = FakeProbe([
            snapshot([(own, "--widget"), (300, "--hub")]),
            // The review started while the question was open.
            snapshot([(own, "--widget"), (300, "--hub"), (310, "--review")]),
        ])
        let flow = Flow(probe: probe, reply: QuitReply(answer: .quitAll, dontAskAgain: false))

        XCTAssertEqual(flow.run(), .quitAll)

        XCTAssertEqual(flow.presenter.questions, [QuitQuestion(thisName: "Widget", otherNames: ["Hub"])])
        XCTAssertEqual(flow.terminator.quits, [[300, 310]])
        XCTAssertEqual(flow.quits, 1)
        XCTAssertEqual(flow.store.remembered, [], "the setting stays Ask without the checkbox")
    }

    func testDontAskAgainStoresTheAnswer() {
        for (answer, stored) in [(QuitAnswer.quitThis, QuitBehavior.thisPart), (.quitAll, .allParts)] {
            let flow = Flow(
                probe: FakeProbe([snapshot([(own, "--widget"), (300, "--hub")])]),
                reply: QuitReply(answer: answer, dontAskAgain: true))

            flow.run()

            XCTAssertEqual(flow.store.remembered, [stored])
            XCTAssertEqual(flow.quits, 1)
        }
    }

    func testCancelQuitsNothingAndStoresNothing() {
        let flow = Flow(
            probe: FakeProbe([snapshot([(own, "--widget"), (300, "--hub")])]),
            reply: QuitReply(answer: .cancel, dontAskAgain: true))

        XCTAssertEqual(flow.run(), .cancel)

        XCTAssertEqual(flow.terminator.quits, [])
        XCTAssertEqual(flow.quits, 0)
        XCTAssertEqual(flow.store.remembered, [])
    }

    func testNoQuestionWhenNothingElseRuns() {
        let flow = Flow(probe: FakeProbe([snapshot([(own, "--widget")])]), reply: QuitReply(answer: .cancel, dontAskAgain: false))

        XCTAssertEqual(flow.run(), .quitThis)

        XCTAssertEqual(flow.presenter.questions, [])
        XCTAssertEqual(flow.quits, 1)
    }

    func testAStoredQuitAllQuitsEveryPartWithNoQuestion() {
        let flow = Flow(
            probe: FakeProbe([snapshot([(own, "--widget"), (300, "--hub")])]),
            reply: QuitReply(answer: .cancel, dontAskAgain: false), behavior: .allParts)

        XCTAssertEqual(flow.run(), .quitAll)

        XCTAssertEqual(flow.presenter.questions, [])
        XCTAssertEqual(flow.terminator.quits, [[300]])
        XCTAssertEqual(flow.quits, 1)
    }

    // MARK: The pieces the live flow uses

    func testTheQuitSignalReachesOnlyTheNamedProcesses() {
        let userInfo: [AnyHashable: Any] = [FaceQuitSignal.pidsKey: [NSNumber(value: 300), NSNumber(value: 310)]]

        XCTAssertTrue(FaceQuitSignal.targets(userInfo, pid: 310))
        XCTAssertFalse(FaceQuitSignal.targets(userInfo, pid: 311))
        XCTAssertFalse(FaceQuitSignal.targets(nil, pid: 310))
        XCTAssertFalse(FaceQuitSignal.targets([FaceQuitSignal.pidsKey: "310"], pid: 310))
    }

    func testTheStoredSettingDefaultsToAsk() throws {
        let suite = "PartQuitTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        XCTAssertEqual(QuitBehavior.stored(in: defaults), .ask)
        defaults.set("never", forKey: QuitBehavior.defaultsKey)
        XCTAssertEqual(QuitBehavior.stored(in: defaults), .ask, "an unknown value reads as the default")
        // `store` would also tell the live settings window; the key is what the faces read.
        defaults.set(QuitBehavior.allParts.rawValue, forKey: QuitBehavior.defaultsKey)
        XCTAssertEqual(QuitBehavior.stored(in: defaults), .allParts)
    }

    /// Return quits only this part, ⌘A every part, Escape cancels, and the checkbox says "Don't ask again". Built,
    /// never shown. (`cacheDisplay` of an NSAlert on macOS 26 draws only its icon, so this test reads no picture.)
    func testTheAlertIsKeyboardDriven() {
        let question = QuitQuestion(thisName: "Widget", otherNames: ["Clicky", "Hub"])
        let alert = AlertQuitDialog.alert(for: question)
        alert.layout()

        XCTAssertEqual(alert.messageText, "Quit only Widget, or all GenesisTools parts?")
        XCTAssertEqual(alert.informativeText, "Clicky and Hub are also running. Quit All stops them too.")
        XCTAssertEqual(alert.buttons.map(\.title), ["Quit Widget", "Quit All", "Cancel"])
        XCTAssertEqual(alert.buttons[0].keyEquivalent, "\r")
        XCTAssertEqual(alert.buttons[1].keyEquivalent, "a")
        XCTAssertEqual(alert.buttons[1].keyEquivalentModifierMask, .command)
        XCTAssertEqual(alert.buttons[2].keyEquivalent, "\u{1b}")
        XCTAssertEqual(alert.suppressionButton?.title, "Don't ask again")
        XCTAssertEqual(alert.suppressionButton?.state, .off)
        XCTAssertFalse(alert.window.preventsApplicationTerminationWhenModal)
    }

    /// The lock another process holds: a second open of the file stands in for it (flock locks belong to the open).
    func testPresenceFollowsTheLockAnotherProcessHolds() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("PartQuitTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        XCTAssertFalse(PartPresence.isUp("fixture", in: directory), "no lock file yet")
        let holder = open(PartPresence.lockFile("fixture", in: directory).path, O_CREAT | O_RDWR, 0o600)
        XCTAssertGreaterThanOrEqual(holder, 0)
        XCTAssertEqual(flock(holder, LOCK_EX | LOCK_NB), 0)
        XCTAssertTrue(PartPresence.isUp("fixture", in: directory))
        flock(holder, LOCK_UN)
        close(holder)
        XCTAssertFalse(PartPresence.isUp("fixture", in: directory), "the holder is gone")
    }
}

// MARK: Fakes

@MainActor
private final class FakeProbe: RunningPartsProbing {
    private var snapshots: [RunningPartsSnapshot]
    init(_ snapshots: [RunningPartsSnapshot]) { self.snapshots = snapshots }
    /// Each read takes the next snapshot; the last one repeats.
    func snapshot() -> RunningPartsSnapshot {
        snapshots.count > 1 ? snapshots.removeFirst() : snapshots[0]
    }
}

@MainActor
private final class FakePresenter: QuitDialogPresenting {
    let reply: QuitReply
    var questions: [QuitQuestion] = []
    init(_ reply: QuitReply) { self.reply = reply }
    func ask(_ question: QuitQuestion) -> QuitReply {
        questions.append(question)
        return reply
    }
}

@MainActor
private final class FakeTerminator: FaceTerminating {
    var quits: [[Int32]] = []
    func quit(pids: [Int32]) { quits.append(pids) }
}

@MainActor
private final class FakeStore: QuitBehaviorStoring {
    var behavior: QuitBehavior
    var remembered: [QuitBehavior] = []
    init(_ behavior: QuitBehavior) { self.behavior = behavior }
    func remember(_ behavior: QuitBehavior) { remembered.append(behavior) }
}

/// One widget face's ⌘Q with every collaborator faked.
@MainActor
private final class Flow {
    let probe: FakeProbe
    let presenter: FakePresenter
    let terminator = FakeTerminator()
    let store: FakeStore
    var quits = 0

    init(probe: FakeProbe, reply: QuitReply, behavior: QuitBehavior = .ask) {
        self.probe = probe
        presenter = FakePresenter(reply)
        store = FakeStore(behavior)
    }

    @discardableResult
    func run() -> QuitAnswer {
        QuitFlow(
            face: "--widget", probe: probe, presenter: presenter, terminator: terminator, store: store,
            quitThis: { [weak self] in self?.quits += 1 }
        ).run()
    }
}
