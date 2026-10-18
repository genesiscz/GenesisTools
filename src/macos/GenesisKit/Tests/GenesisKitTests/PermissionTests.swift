import AppKit
import SwiftUI
import XCTest

@testable import GenesisKitBase
@testable import GenesisKit

/// No test here reaches TCC: every grant comes from `FakePermissionSystem`, every dialog goes to
/// `RecordingPermissionPresenter`, and nothing activates the test process.
@MainActor
final class PermissionTests: XCTestCase {
    final class FakePermissionSystem: PermissionSystem, @unchecked Sendable {
        var statuses: [PermissionKind: PermissionStatus] = [:]
        var grantOnRequest: Set<PermissionKind> = []
        /// What a probe kind's request answers while `status` reads `.unknown`, as the real probes do.
        var probeAnswers: [PermissionKind: PermissionStatus] = [:]
        /// How long a request waits for "macOS" before it answers, so a test can act while it is open.
        var requestDelay: Duration?
        private(set) var requests: [PermissionKind] = []
        /// Requests that answered, in the order they did: `requests` records only that one started.
        private(set) var answered: [PermissionKind] = []
        private(set) var opened: [PermissionKind] = []

        func status(_ kind: PermissionKind) -> PermissionStatus { statuses[kind] ?? .denied }

        func request(_ kind: PermissionKind) async -> PermissionStatus {
            requests.append(kind)
            if let requestDelay { try? await Task.sleep(for: requestDelay) }
            defer { answered.append(kind) }
            if let answer = probeAnswers[kind] { return answer }
            if grantOnRequest.contains(kind) { statuses[kind] = .granted }
            return status(kind)
        }

        func openSettings(_ kind: PermissionKind) -> Bool {
            opened.append(kind)
            return true
        }
    }

    private func center(
        _ system: FakePermissionSystem, simulation: String? = nil,
        fresh: @escaping (PermissionKind) async -> PermissionStatus? = { _ in nil },
        relaunch: @escaping @MainActor () -> Bool = { false }, closeDelay: Duration = .zero
    ) -> (PermissionCenter, RecordingPermissionPresenter) {
        let presenter = RecordingPermissionPresenter()
        let parsed = PermissionSimulation.parse(simulation)
        let center = PermissionCenter(
            access: PermissionAccess(system: system, simulation: { parsed }), presenter: presenter,
            freshProbe: fresh, relaunch: relaunch, pollInterval: .seconds(3600), closeDelay: closeDelay,
            activateForPrompt: {})
        return (center, presenter)
    }

    private func waitUntil(_ condition: @MainActor () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0 ..< 200 where !condition() {
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertTrue(condition(), "condition never became true", file: file, line: line)
    }

    // MARK: - Kinds

    func testEveryKindRoundTripsItsIdAndAcceptsTheShortNames() {
        for kind in PermissionKind.allCases {
            XCTAssertEqual(PermissionKind(id: kind.rawValue), kind)
            XCTAssertEqual(PermissionKind(id: " \(kind.rawValue.uppercased()) "), kind)
        }
        let aliases: [String: PermissionKind] = [
            "input": .inputMonitoring, "keyboard": .inputMonitoring, "ax": .accessibility, "mic": .microphone,
            "dictation": .speechRecognition, "screen": .screenRecording, "capture": .screenRecording,
            "calendars": .calendars, "fda": .fullDiskAccess, "lan": .localNetwork,
        ]
        for (alias, kind) in aliases {
            XCTAssertEqual(PermissionKind(id: alias), kind, alias)
        }
        XCTAssertNil(PermissionKind(id: "camera"))
        XCTAssertNil(PermissionKind(id: ""))
    }

    func testEveryKindOpensItsExactPrivacyPane() {
        let anchors: [PermissionKind: String] = [
            .inputMonitoring: "Privacy_ListenEvent", .accessibility: "Privacy_Accessibility",
            .microphone: "Privacy_Microphone", .speechRecognition: "Privacy_SpeechRecognition",
            .screenRecording: "Privacy_ScreenCapture", .calendars: "Privacy_Calendars",
            .reminders: "Privacy_Reminders", .contacts: "Privacy_Contacts", .fullDiskAccess: "Privacy_AllFiles",
            .automation: "Privacy_Automation", .desktopFolder: "Privacy_FilesAndFolders",
            .documentsFolder: "Privacy_FilesAndFolders", .downloadsFolder: "Privacy_FilesAndFolders",
            .localNetwork: "Privacy_LocalNetwork",
        ]
        XCTAssertEqual(Set(anchors.keys), Set(PermissionKind.allCases), "every kind has an expected pane")
        for kind in PermissionKind.allCases {
            XCTAssertEqual(kind.settingsAnchor, anchors[kind])
            XCTAssertEqual(
                kind.settingsURL.absoluteString,
                "x-apple.systempreferences:com.apple.preference.security?\(anchors[kind] ?? "")")
            XCTAssertFalse(kind.title.isEmpty)
            XCTAssertTrue(kind.reason.hasSuffix("."), "\(kind) reason is one full sentence")
            XCTAssertNotNil(NSImage(systemSymbolName: kind.symbol, accessibilityDescription: nil), "\(kind) symbol")
        }
    }

    func testRequestStylesMatchWhatMacOSAllows() {
        XCTAssertEqual(PermissionKind.microphone.requestStyle, .systemPrompt)
        XCTAssertEqual(PermissionKind.speechRecognition.requestStyle, .systemPrompt)
        XCTAssertEqual(PermissionKind.calendars.requestStyle, .systemPrompt)
        XCTAssertEqual(PermissionKind.localNetwork.requestStyle, .systemPrompt)
        XCTAssertEqual(PermissionKind.accessibility.requestStyle, .promptThenSettings)
        XCTAssertEqual(PermissionKind.screenRecording.requestStyle, .promptThenSettings)
        XCTAssertEqual(PermissionKind.inputMonitoring.requestStyle, .promptThenSettings)
        XCTAssertEqual(PermissionKind.fullDiskAccess.requestStyle, .settingsOnly)
        XCTAssertEqual(PermissionKind.automation.requestStyle, .probe)
        XCTAssertEqual(PermissionKind.downloadsFolder.requestStyle, .probe)
        XCTAssertEqual(PermissionKind.allCases.filter(\.cachedPerProcess), [.inputMonitoring, .screenRecording])
    }

    func testStatusWireValuesRoundTripForTheFreshProcessProbe() {
        let statuses: [PermissionStatus] = [
            .granted, .denied, .notDetermined, .restricted, .partial("Add Only"), .unknown("asks on first use"),
            .needsRelaunch,
        ]
        for status in statuses {
            XCTAssertEqual(PermissionStatus(wireValue: status.wireValue + "\n"), status)
        }
        XCTAssertNil(PermissionStatus(wireValue: ""))
        XCTAssertNil(PermissionStatus(wireValue: "yes"))
    }

    // MARK: - Simulation

    func testSimulationParsesKindsModesAliasesAndReportsWhatItIgnored() {
        let simulation = PermissionSimulation.parse("input-monitoring, mic:ask,screen:stale bogus,speech:weird")
        XCTAssertEqual(simulation.modes, [.inputMonitoring: .denied, .microphone: .ask, .screenRecording: .stale])
        XCTAssertEqual(simulation.ignored, ["bogus", "speech:weird"])
        XCTAssertEqual(simulation.status(for: .inputMonitoring), .denied)
        XCTAssertEqual(simulation.status(for: .microphone), .notDetermined)
        XCTAssertEqual(simulation.status(for: .screenRecording), .denied)
        XCTAssertNil(simulation.status(for: .accessibility))
        XCTAssertEqual(simulation.freshStatus(for: .screenRecording), .granted, "stale: only a new process sees it")
        XCTAssertEqual(simulation.freshStatus(for: .inputMonitoring), .denied)
        XCTAssertEqual(simulation.serialized, "input-monitoring,microphone:ask,screen-recording:stale")
        XCTAssertEqual(PermissionSimulation.parse(simulation.serialized).modes, simulation.modes)
    }

    func testSimulationAllAndEmptyValues() {
        XCTAssertTrue(PermissionSimulation.parse(nil).isEmpty)
        XCTAssertTrue(PermissionSimulation.parse(" , ").isEmpty)
        let all = PermissionSimulation.parse("all:ask")
        XCTAssertEqual(Set(all.modes.keys), Set(PermissionKind.allCases))
        XCTAssertTrue(all.modes.values.allSatisfy { $0 == .ask })
        XCTAssertEqual(PermissionSimulation.parse("all,accessibility:stale").mode(for: .accessibility), .stale)
    }

    func testSimulationReportsSeparatorOnlyAndHalfWrittenEntriesInsteadOfCrashing() {
        for entry in [":", "::", ":ask", ":microphone", "microphone:", "all:"] {
            let simulation = PermissionSimulation.parse(entry)
            XCTAssertTrue(simulation.isEmpty, "\(entry) must simulate nothing")
            XCTAssertEqual(simulation.ignored, [entry], "\(entry) must be reported as ignored")
        }

        let mixed = PermissionSimulation.parse("microphone, :, screen:ask")
        XCTAssertEqual(mixed.modes, [.microphone: .denied, .screenRecording: .ask])
        XCTAssertEqual(mixed.ignored, [":"])
    }

    func testSimulationIsReadFromTheDefaultsKey() throws {
        let suite = "dev.genesis.permissions.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertTrue(PermissionSimulation.current(defaults: defaults).isEmpty)
        defaults.set("accessibility,microphone:ask", forKey: PermissionSimulation.defaultsKey)
        XCTAssertEqual(PermissionSimulation.current(defaults: defaults).modes, [.accessibility: .denied, .microphone: .ask])
    }

    /// The defaults value a running face re-reads on every check; `staging.ts allow|deny|ask` rewrites it.
    private final class SimulationBox: @unchecked Sendable {
        private let lock = NSLock()
        private var text: String?
        func set(_ value: String?) { lock.withLock { text = value } }
        func read() -> PermissionSimulation { PermissionSimulation.parse(lock.withLock { text }) }
    }

    func testAnAnsweredSimulatedPromptHoldsOnlyUntilTheSimulationChanges() async {
        let system = FakePermissionSystem()
        system.statuses = [.microphone: .granted]
        let defaults = SimulationBox()
        defaults.set("microphone:ask")
        let access = PermissionAccess(system: system, simulation: { defaults.read() })
        XCTAssertEqual(access.status(.microphone), .notDetermined)
        let answered = await access.request(.microphone)
        XCTAssertEqual(answered, .granted)
        XCTAssertEqual(access.status(.microphone), .granted, "the answered prompt lifts the simulation")

        defaults.set(nil)
        XCTAssertEqual(access.status(.microphone), .granted, "allow: the real grant")
        defaults.set("microphone")
        XCTAssertEqual(access.status(.microphone), .denied, "deny takes effect without a relaunch")
        XCTAssertEqual(access.simulatedMode(.microphone), .denied)
        defaults.set("microphone:ask")
        XCTAssertEqual(access.status(.microphone), .notDetermined, "ask again shows the prompt again")
        XCTAssertTrue(system.requests.isEmpty, "no simulated request reached the system")
    }

    func testAccessAppliesTheSimulationAndNeverRequestsASimulatedKind() async {
        let system = FakePermissionSystem()
        system.statuses = [.microphone: .granted, .accessibility: .granted, .speechRecognition: .notDetermined]
        let simulation = PermissionSimulation.parse("accessibility,microphone:ask")
        let access = PermissionAccess(system: system, simulation: { simulation })
        XCTAssertEqual(access.status(.accessibility), .denied)
        XCTAssertEqual(access.status(.microphone), .notDetermined)
        XCTAssertEqual(access.status(.speechRecognition), .notDetermined, "an unsimulated kind reads the system")
        let denied = await access.request(.accessibility)
        XCTAssertEqual(denied, .denied)
        let answered = await access.request(.microphone)
        XCTAssertEqual(answered, .granted, "Continue on an :ask kind lifts the simulation for this process")
        XCTAssertEqual(access.status(.microphone), .granted)
        XCTAssertTrue(system.requests.isEmpty, "no simulated request reached the system")
        _ = await access.request(.speechRecognition)
        XCTAssertEqual(system.requests, [.speechRecognition])
    }

    // MARK: - One dialog per kind

    func testAGrantedKindShowsNothing() {
        let system = FakePermissionSystem()
        system.statuses[.microphone] = .granted
        let (center, presenter) = center(system)
        XCTAssertTrue(center.require(PermissionNeed(.microphone)))
        XCTAssertTrue(presenter.presented.isEmpty)
    }

    func testAUsersNeedJoiningAnAutomaticDialogGivesItKeyboardFocus() {
        let system = FakePermissionSystem()
        let (center, presenter) = center(system)
        XCTAssertFalse(center.require(PermissionNeed(.accessibility, trigger: .automatic)))
        XCTAssertFalse(center.require(PermissionNeed(.accessibility, trigger: .automatic)))
        XCTAssertTrue(presenter.fronted.isEmpty, "an automatic need asking again leaves the open dialog where it is")
        XCTAssertTrue(presenter.focused.isEmpty, "automatic needs never take the keyboard")
        XCTAssertFalse(center.require(PermissionNeed(.accessibility, reason: "Grant pressed.")))
        XCTAssertEqual(presenter.fronted, [.accessibility])
        XCTAssertEqual(presenter.focused, [.accessibility], "the user's own request made the open dialog key")
    }

    func testAFeatureAskingAgainRunsItsRetryOnceWhileAnotherFeaturesNeedIsKept() async {
        let system = FakePermissionSystem()
        system.statuses[.microphone] = .notDetermined
        system.grantOnRequest = [.microphone]
        let (center, presenter) = center(system)
        var first = 0
        var second = 0
        for _ in 0 ..< 3 {
            center.require(PermissionNeed(.microphone, reason: "First asks.", trigger: .automatic, onGranted: { first += 1 }))
        }
        center.require(PermissionNeed(.microphone, reason: "Second asks.", trigger: .automatic, onGranted: { second += 1 }))
        center.dialogs[.microphone]?.primary()
        await waitUntil { presenter.closed == [.microphone] }
        XCTAssertEqual(first, 1, "the same feature asking three times runs its retry once")
        XCTAssertEqual(second, 1, "another feature's automatic need is still kept")
    }

    func testOneDialogPerKindAndASecondNeedJoinsIt() {
        let system = FakePermissionSystem()
        let (center, presenter) = center(system)
        XCTAssertFalse(center.require(PermissionNeed(.microphone, reason: "First reason.")))
        XCTAssertFalse(center.require(PermissionNeed(.microphone, reason: "Second reason.")))
        XCTAssertFalse(center.require(PermissionNeed(.speechRecognition)))
        XCTAssertEqual(presenter.presented, [.microphone, .speechRecognition])
        XCTAssertEqual(presenter.fronted, [.microphone], "the open microphone dialog came forward instead")
        XCTAssertEqual(center.dialogs[.microphone]?.reason, "Second reason.", "a user's newer reason wins")
        center.dialogs[.microphone]?.dismiss()
        XCTAssertFalse(center.require(PermissionNeed(.microphone)))
        XCTAssertEqual(presenter.presented, [.microphone, .speechRecognition, .microphone], "closed, so it shows again")
    }

    func testANeedWhoseDialogAnotherProcessShowsRunsItsRetryWhenTheGrantArrives() async {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("permission-lock-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let namespace = "test.permission-lock.\(UUID().uuidString)"
        let system = FakePermissionSystem()
        func center(_ presenter: RecordingPermissionPresenter, poll: Duration) -> PermissionCenter {
            PermissionCenter(
                access: PermissionAccess(system: system, simulation: { PermissionSimulation.parse(nil) }),
                presenter: presenter, lock: PermissionDialogLock(directory: directory, namespace: namespace),
                pollInterval: poll, activateForPrompt: {})
        }
        // Another face of the app holds the Accessibility dialog (a second lock on the same file stands in for it).
        let other = center(RecordingPermissionPresenter(), poll: .seconds(3600))
        XCTAssertFalse(other.require(PermissionNeed(.accessibility)))
        let presenter = RecordingPermissionPresenter()
        let here = center(presenter, poll: .milliseconds(10))
        var retries = 0
        XCTAssertFalse(here.require(PermissionNeed(.accessibility, onGranted: { retries += 1 })))
        XCTAssertNil(here.dialogs[.accessibility], "the other process shows the dialog")
        XCTAssertTrue(presenter.presented.isEmpty)

        system.statuses[.accessibility] = .granted
        await waitUntil { retries == 1 }
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(retries, 1, "the retry ran once")
        other.dialogs[.accessibility]?.dismiss()
    }

    func testAFeatureAskingAgainWhileAnotherProcessShowsTheDialogRunsItsRetryOnce() async {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("permission-lock-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let namespace = "test.permission-lock.\(UUID().uuidString)"
        let system = FakePermissionSystem()
        func center(_ presenter: RecordingPermissionPresenter, poll: Duration) -> PermissionCenter {
            PermissionCenter(
                access: PermissionAccess(system: system, simulation: { PermissionSimulation.parse(nil) }),
                presenter: presenter, lock: PermissionDialogLock(directory: directory, namespace: namespace),
                pollInterval: poll, activateForPrompt: {})
        }
        let other = center(RecordingPermissionPresenter(), poll: .seconds(3600))
        XCTAssertFalse(other.require(PermissionNeed(.accessibility)))
        let here = center(RecordingPermissionPresenter(), poll: .milliseconds(10))
        var first = 0
        var second = 0
        var user = 0
        // Capture starts and resumes: the same automatic need, three times.
        for _ in 0 ..< 3 {
            here.require(PermissionNeed(.accessibility, reason: "First asks.", trigger: .automatic, onGranted: { first += 1 }))
        }
        here.require(PermissionNeed(.accessibility, reason: "Second asks.", trigger: .automatic, onGranted: { second += 1 }))
        here.require(PermissionNeed(.accessibility, reason: "First asks.", onGranted: { user += 1 }))

        system.statuses[.accessibility] = .granted
        await waitUntil { first >= 1 && second >= 1 && user >= 1 }
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(first, 1, "the same feature asking three times runs its retry once")
        XCTAssertEqual(second, 1, "another feature's automatic need is still kept")
        XCTAssertEqual(user, 1, "and so is a user's request")
        other.dialogs[.accessibility]?.dismiss()
    }

    func testOnlyAUsersNeedLiftsTheDialogAnotherProcessShows() async {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("permission-lock-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let namespace = "test.permission-lock.\(UUID().uuidString)"
        let system = FakePermissionSystem()
        func center(_ presenter: RecordingPermissionPresenter) -> PermissionCenter {
            PermissionCenter(
                access: PermissionAccess(system: system, simulation: { PermissionSimulation.parse(nil) }),
                presenter: presenter, lock: PermissionDialogLock(directory: directory, namespace: namespace),
                pollInterval: .seconds(3600), activateForPrompt: {})
        }
        let otherPresenter = RecordingPermissionPresenter()
        let other = center(otherPresenter)
        XCTAssertFalse(other.require(PermissionNeed(.accessibility)))
        let here = center(RecordingPermissionPresenter())
        here.require(PermissionNeed(.accessibility, reason: "Focus counts input.", trigger: .automatic, onGranted: {}))
        // Front requests arrive in the order they were sent, so when the user's one lands the automatic one would have.
        here.require(PermissionNeed(.accessibility, onGranted: {}))
        await waitUntil { !otherPresenter.fronted.isEmpty }
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(otherPresenter.fronted, [.accessibility], "only the user's need lifted the other dialog")
        other.dialogs[.accessibility]?.dismiss()
    }

    /// Automation and the folders have no silent read: `status` stays `.unknown` after the grant, only a probe sees it.
    func testAWaitOnAnotherProcessesDialogSeesAProbeGrantThatStatusNeverShows() async {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("permission-lock-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let namespace = "test.permission-lock.\(UUID().uuidString)"
        let system = FakePermissionSystem()
        system.statuses[.desktopFolder] = .unknown("asks on first use")
        system.probeAnswers[.desktopFolder] = .denied
        func center(closeDelay: Duration = .zero) -> PermissionCenter {
            PermissionCenter(
                access: PermissionAccess(system: system, simulation: { PermissionSimulation.parse(nil) }),
                presenter: RecordingPermissionPresenter(),
                lock: PermissionDialogLock(directory: directory, namespace: namespace),
                pollInterval: .seconds(3600), closeDelay: closeDelay, activateForPrompt: {})
        }
        let other = center()
        XCTAssertFalse(other.require(PermissionNeed(.desktopFolder)))
        let here = center()
        var retries = 0
        XCTAssertFalse(here.require(PermissionNeed(.desktopFolder, onGranted: { retries += 1 })))
        XCTAssertNil(here.dialogs[.desktopFolder], "the other process shows the dialog")

        // Refused there: nothing to see here, and a waiting process never probes on its own.
        other.dialogs[.desktopFolder]?.allow()
        await waitUntil { system.answered.count == 1 }
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(system.requests, [.desktopFolder], "only the other dialog asked macOS")
        XCTAssertEqual(retries, 0)

        system.probeAnswers[.desktopFolder] = .granted
        other.dialogs[.desktopFolder]?.allow()
        await waitUntil { retries == 1 }
        XCTAssertEqual(system.requests, [.desktopFolder, .desktopFolder, .desktopFolder],
                       "the other dialog's two probes, then one check here once it saw the grant")
        XCTAssertEqual(system.statuses[.desktopFolder], .unknown("asks on first use"), "status never showed it")

        // A need that starts waiting while the other dialog still shows "is on" missed the announcement: the lock
        // file tells it.
        let showing = center(closeDelay: .seconds(60))
        let late = center()
        system.probeAnswers[.automation] = .granted
        system.statuses[.automation] = .unknown("asks on first use")
        XCTAssertFalse(showing.require(PermissionNeed(.automation)))
        showing.dialogs[.automation]?.allow()
        await waitUntil { showing.dialogs[.automation]?.phase == .granted }
        var lateRetries = 0
        XCTAssertFalse(late.require(PermissionNeed(.automation, onGranted: { lateRetries += 1 })))
        await waitUntil { lateRetries == 1 }
        showing.dialogs[.automation]?.dismiss()
    }

    /// The confirming probe does not depend on this process having no answer of its own: a refusal it remembers from
    /// an earlier probe is what the other dialog's grant replaces.
    func testAWaitingProcessRefusedEarlierStillConfirmsAGrantMadeInTheOtherDialog() async {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("permission-lock-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let namespace = "test.permission-lock.\(UUID().uuidString)"
        let system = FakePermissionSystem()
        system.statuses[.desktopFolder] = .unknown("asks on first use")
        system.probeAnswers[.desktopFolder] = .denied
        func center() -> PermissionCenter {
            PermissionCenter(
                access: PermissionAccess(system: system, simulation: { PermissionSimulation.parse(nil) }),
                presenter: RecordingPermissionPresenter(),
                lock: PermissionDialogLock(directory: directory, namespace: namespace),
                pollInterval: .seconds(3600), closeDelay: .zero, activateForPrompt: {})
        }
        let other = center()
        let here = center()
        _ = await here.access.request(.desktopFolder)
        XCTAssertEqual(here.status(.desktopFolder), .denied)
        XCTAssertFalse(other.require(PermissionNeed(.desktopFolder)))
        var retries = 0
        XCTAssertFalse(here.require(PermissionNeed(.desktopFolder, onGranted: { retries += 1 })))
        XCTAssertNil(here.dialogs[.desktopFolder], "the other process shows the dialog")

        system.probeAnswers[.desktopFolder] = .granted
        other.dialogs[.desktopFolder]?.allow()
        await waitUntil { retries == 1 }
    }

    func testAutomaticNeedsStopAfterNotNowWhileAUsersActionStillShows() {
        let system = FakePermissionSystem()
        let (center, presenter) = center(system)
        center.require(PermissionNeed(.accessibility, trigger: .automatic))
        center.dialogs[.accessibility]?.dismiss()
        XCTAssertEqual(presenter.closed, [.accessibility])
        center.require(PermissionNeed(.accessibility, trigger: .automatic))
        XCTAssertEqual(presenter.presented, [.accessibility], "Not now silences automatic needs in this process")
        center.require(PermissionNeed(.accessibility, trigger: .userAction))
        XCTAssertEqual(presenter.presented, [.accessibility, .accessibility])
    }

    // MARK: - Dialog actions

    func testPrimaryActionFollowsWhatMacOSAllows() {
        let system = FakePermissionSystem()
        system.statuses = [.microphone: .notDetermined, .speechRecognition: .denied, .accessibility: .notDetermined,
                           .contacts: .restricted]
        let (center, _) = center(system)
        center.require(PermissionNeed(.microphone))
        center.require(PermissionNeed(.speechRecognition))
        center.require(PermissionNeed(.accessibility))
        center.require(PermissionNeed(.contacts))
        XCTAssertEqual(center.dialogs[.microphone]?.primaryAction, .allow)
        XCTAssertEqual(center.dialogs[.microphone]?.primaryTitle, "Continue")
        XCTAssertEqual(center.dialogs[.microphone]?.offersCheckAgain, false)
        XCTAssertEqual(center.dialogs[.speechRecognition]?.primaryAction, .openSettings, "a refusal is changed in Settings")
        XCTAssertEqual(center.dialogs[.speechRecognition]?.primaryTitle, "Open System Settings")
        XCTAssertEqual(center.dialogs[.speechRecognition]?.offersCheckAgain, true)
        XCTAssertEqual(center.dialogs[.accessibility]?.primaryAction, .openSettings)
        XCTAssertEqual(center.dialogs[.accessibility]?.title, "Allow Accessibility")
        XCTAssertTrue(center.dialogs[.contacts]?.instructions.contains("administrator") == true)
    }

    /// Calendars "Add Only" can still be upgraded by macOS's own prompt, as an undetermined grant can be granted.
    func testAnAddOnlyCalendarGrantIsAskedForFullAccessLikeAnUndeterminedOne() async throws {
        // The rule `SystemPermissions.request` and the dialog both follow.
        XCTAssertTrue(PermissionKind.calendars.systemPromptAsks(from: .addOnly))
        XCTAssertTrue(PermissionKind.reminders.systemPromptAsks(from: .addOnly))
        XCTAssertTrue(PermissionKind.calendars.systemPromptAsks(from: .notDetermined))
        XCTAssertFalse(PermissionKind.calendars.systemPromptAsks(from: .denied))
        XCTAssertFalse(PermissionKind.contacts.systemPromptAsks(from: .partial("limited")))
        XCTAssertFalse(PermissionKind.accessibility.systemPromptAsks(from: .notDetermined))

        for start in [PermissionStatus.addOnly, .notDetermined] {
            let system = FakePermissionSystem()
            system.statuses[.calendars] = start
            system.grantOnRequest = [.calendars]
            let (center, presenter) = center(system)
            var retried = 0
            center.require(PermissionNeed(.calendars, onGranted: { retried += 1 }))
            let dialog = try XCTUnwrap(center.dialogs[.calendars])
            XCTAssertEqual(dialog.primaryAction, .allow, "\(start.label): Continue asks macOS")
            dialog.primary()
            await waitUntil { presenter.closed == [.calendars] }
            XCTAssertEqual(system.requests, [.calendars])
            XCTAssertEqual(retried, 1)
        }

        // Kept at Add Only in the prompt: only System Settings changes it now, and it says to choose Full Access
        // there instead of to turn on an app that is already on.
        let system = FakePermissionSystem()
        system.statuses[.calendars] = .addOnly
        let (center, _) = center(system)
        center.require(PermissionNeed(.calendars))
        let dialog = try XCTUnwrap(center.dialogs[.calendars])
        XCTAssertTrue(dialog.instructions.contains("Choose Allow"), "the prompt comes first: \(dialog.instructions)")
        dialog.primary()
        await waitUntil { system.requests == [.calendars] && dialog.phase == .asking }
        XCTAssertEqual(dialog.primaryAction, .openSettings)
        XCTAssertEqual(dialog.offersCheckAgain, true)
        let instructions = dialog.instructions
        XCTAssertTrue(instructions.contains("Full Access"), "turning on an app that is already on changes nothing: \(instructions)")
        XCTAssertFalse(instructions.contains("turn on"), instructions)
        XCTAssertEqual(system.requests, [.calendars], "the prompt is asked once")
    }

    func testWaitingForAGrantStopsAtItsDeadlineAndCheckAgainWaitsAgain() async throws {
        let system = FakePermissionSystem()
        system.statuses[.fullDiskAccess] = .denied
        let center = PermissionCenter(
            access: PermissionAccess(system: system, simulation: { PermissionSimulation.parse(nil) }),
            presenter: RecordingPermissionPresenter(), pollInterval: .milliseconds(10), pollDeadline: .milliseconds(300),
            activateForPrompt: {})
        center.require(PermissionNeed(.fullDiskAccess))
        let dialog = try XCTUnwrap(center.dialogs[.fullDiskAccess])
        dialog.openSettings()
        await waitUntil { dialog.phase == .waiting }
        await waitUntil { dialog.phase == .expired }
        XCTAssertNotNil(dialog.note, "it says it stopped instead of spinning on")
        XCTAssertTrue(dialog.offersCheckAgain)

        // Check again reads once and waits again: a grant that arrives after it is seen without another press.
        dialog.checkAgain()
        XCTAssertEqual(dialog.phase, .waiting)
        await waitUntil { dialog.note?.hasPrefix("Still off") == true }
        system.statuses[.fullDiskAccess] = .granted
        await waitUntil { dialog.phase == .granted }
    }

    func testContinueAsksInPlaceThenClosesAndRetriesTheFeature() async {
        let system = FakePermissionSystem()
        system.statuses[.microphone] = .notDetermined
        system.grantOnRequest = [.microphone]
        let (center, presenter) = center(system)
        var retries = 0
        center.require(PermissionNeed(.microphone, onGranted: { retries += 1 }))
        let dialog = center.dialogs[.microphone]
        dialog?.primary()
        await waitUntil { presenter.closed == [.microphone] }
        XCTAssertEqual(system.requests, [.microphone])
        XCTAssertEqual(dialog?.phase, .granted)
        XCTAssertEqual(retries, 1)
        XCTAssertNil(center.dialogs[.microphone])
        XCTAssertFalse(center.dismissed.contains(.microphone), "a grant is not a Not now")
    }

    func testARefusedProbeIsProbedAgainSoAGrantInSystemSettingsClosesTheDialog() async {
        let system = FakePermissionSystem()
        system.statuses[.automation] = .unknown("asks on first use")
        system.probeAnswers[.automation] = .denied
        let (center, presenter) = center(system)
        var retries = 0
        center.require(PermissionNeed(.automation, onGranted: { retries += 1 }))
        let dialog = center.dialogs[.automation]
        dialog?.primary()
        await waitUntil { dialog?.status == .denied && dialog?.phase == .asking }
        XCTAssertEqual(dialog?.primaryAction, .openSettings)
        dialog?.primary()
        await waitUntil { dialog?.phase == .waiting }

        await dialog?.refresh(explicit: false)
        XCTAssertEqual(dialog?.status, .denied, "the poll keeps the refusal instead of reading it as never asked")
        XCTAssertEqual(dialog?.primaryAction, .openSettings)
        XCTAssertEqual(center.status(.automation), .denied, "status keeps the last probe's answer too")
        XCTAssertEqual(system.requests, [.automation], "the plain poll never runs the probe")

        await dialog?.refresh(explicit: true)
        XCTAssertEqual(system.requests, [.automation, .automation], "Check again probes the refused grant")
        XCTAssertNotNil(dialog?.note, "still refused, and it says so")

        system.probeAnswers[.automation] = .granted
        await dialog?.refresh(explicit: true)
        await waitUntil { presenter.closed == [.automation] }
        XCTAssertEqual(dialog?.phase, .granted)
        XCTAssertEqual(center.status(.automation), .granted)
        XCTAssertEqual(retries, 1)
    }

    /// Automation and the folders have no silent read: what `status` shows for them is what their last probe answered.
    func testAProbeKindStatusFollowsItsLastAnsweredProbe() async {
        for kind in [PermissionKind.automation, .desktopFolder, .documentsFolder, .downloadsFolder] {
            let system = FakePermissionSystem()
            system.statuses[kind] = .unknown("asks on first use")
            let (center, presenter) = center(system)
            XCTAssertEqual(center.status(kind), .unknown("asks on first use"), "\(kind): never probed")

            system.probeAnswers[kind] = .notDetermined
            _ = await center.access.request(kind)
            XCTAssertEqual(center.status(kind), .unknown("asks on first use"), "\(kind): no answer is not an answer")

            system.probeAnswers[kind] = .denied
            _ = await center.access.request(kind)
            XCTAssertEqual(center.status(kind), .denied, "\(kind)")
            XCTAssertFalse(center.isGranted(kind))

            system.probeAnswers[kind] = .notDetermined
            _ = await center.access.request(kind)
            XCTAssertEqual(center.status(kind), .denied, "\(kind): a probe macOS leaves open keeps the refusal")

            system.probeAnswers[kind] = .granted
            _ = await center.access.request(kind)
            XCTAssertEqual(center.status(kind), .granted, "\(kind)")
            XCTAssertTrue(center.require(PermissionNeed(kind)), "\(kind): a granted probe needs no dialog")
            XCTAssertTrue(presenter.presented.isEmpty)
        }
    }

    /// A probe grant revoked in System Settings: probing the remembered grants again (on app activation) finds it.
    func testARevokedProbeGrantIsFoundWhenTheGrantsAreProbedAgain() async {
        for kind in [PermissionKind.automation, .desktopFolder, .documentsFolder, .downloadsFolder] {
            let system = FakePermissionSystem()
            system.statuses[kind] = .unknown("asks on first use")
            let (center, presenter) = center(system)
            system.probeAnswers[kind] = .granted
            _ = await center.access.request(kind)
            XCTAssertTrue(center.require(PermissionNeed(kind)), "\(kind)")

            system.probeAnswers[kind] = .denied
            XCTAssertTrue(center.isGranted(kind), "\(kind): nothing has looked again yet")
            await center.recheckGrantedProbes()
            XCTAssertEqual(center.status(kind), .denied, "\(kind)")
            XCTAssertFalse(center.require(PermissionNeed(kind)), "\(kind): the feature asks again")
            XCTAssertEqual(presenter.presented.count, 1, "\(kind)")
        }
    }

    func testAnObservationEndsWhenItsTokenIsReleased() {
        let center = NotificationCenter()
        let name = Notification.Name("permission-tests.observation")
        var heard = 0
        var token: ObservationToken? = ObservationToken(
            center.addObserver(forName: name, object: nil, queue: nil) { _ in heard += 1 }, center: center)
        center.post(name: name, object: nil)
        XCTAssertEqual(heard, 1)
        XCTAssertNotNil(token)
        token = nil
        center.post(name: name, object: nil)
        XCTAssertEqual(heard, 1, "a released token leaves no observer behind")
    }

    func testProbingTheGrantsAgainStartsNoProbeForARefusalOrAKindNeverProbed() async {
        let system = FakePermissionSystem()
        for kind in [PermissionKind.automation, .desktopFolder, .documentsFolder, .downloadsFolder] {
            system.statuses[kind] = .unknown("asks on first use")
        }
        system.probeAnswers[.automation] = .denied
        let (center, _) = center(system)
        _ = await center.access.request(.automation)
        let before = system.requests.count
        await center.recheckGrantedProbes()
        XCTAssertEqual(system.requests.count, before, "a remembered refusal and an unprobed folder start no probe")
    }

    func testAFeatureAskingAfterARefusedProbeFindsTheGrantMadeInSystemSettingsMeanwhile() async throws {
        let system = FakePermissionSystem()
        system.statuses[.documentsFolder] = .unknown("asks on first use")
        system.probeAnswers[.documentsFolder] = .denied
        let (center, presenter) = center(system)
        center.require(PermissionNeed(.documentsFolder))
        let first = try XCTUnwrap(center.dialogs[.documentsFolder])
        first.primary()
        await waitUntil { first.status == .denied && first.phase == .asking }
        first.dismiss()
        XCTAssertNil(center.dialogs[.documentsFolder])

        // Asked again, the dialog starts where the refusal left it and looks once without a click: still refused.
        var retries = 0
        center.require(PermissionNeed(.documentsFolder, onGranted: { retries += 1 }))
        let dialog = try XCTUnwrap(center.dialogs[.documentsFolder])
        XCTAssertEqual(dialog.status, .denied)
        XCTAssertEqual(dialog.primaryAction, .openSettings, "a refusal is changed in Settings: no Continue again")
        XCTAssertTrue(dialog.offersCheckAgain)
        await waitUntil { system.answered.count == 2 }
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(dialog.status, .denied)
        XCTAssertEqual(retries, 0)

        system.probeAnswers[.documentsFolder] = .granted
        dialog.checkAgain()
        await waitUntil { dialog.phase == .granted }
        XCTAssertEqual(retries, 1)
        XCTAssertEqual(system.requests.count, 3, "Continue, the look when the dialog opened, Check again")
        XCTAssertEqual(center.status(.documentsFolder), .granted)
        await waitUntil { presenter.closed == [.documentsFolder, .documentsFolder] }
    }

    func testACheckAgainMacOSLeavesUnansweredKeepsTheRefusal() async throws {
        let system = FakePermissionSystem()
        system.statuses[.desktopFolder] = .unknown("asks on first use")
        system.probeAnswers[.desktopFolder] = .denied
        let (center, _) = center(system)
        center.require(PermissionNeed(.desktopFolder))
        let dialog = try XCTUnwrap(center.dialogs[.desktopFolder])
        dialog.primary()
        await waitUntil { dialog.status == .denied && dialog.phase == .asking }

        // The probe sits behind a macOS prompt nobody answers, until its deadline.
        system.probeAnswers[.desktopFolder] = .notDetermined
        await dialog.refresh(explicit: true)
        XCTAssertEqual(system.requests, [.desktopFolder, .desktopFolder], "Check again did look")
        XCTAssertEqual(dialog.status, .denied, "no answer is not a reason to forget the refusal")
        XCTAssertEqual(dialog.primaryAction, .openSettings)
        XCTAssertEqual(center.status(.desktopFolder), .denied)
    }

    /// The control for the two above: a kind macOS has not answered is never touched again, which could be a second
    /// prompt, and it stays as the unanswered probe left it.
    func testAProbeMacOSNeverAnsweredStaysUnansweredAndIsNotProbedAgain() async throws {
        let system = FakePermissionSystem()
        system.statuses[.automation] = .unknown("asks on first use")
        system.probeAnswers[.automation] = .notDetermined
        let (center, _) = center(system)
        center.require(PermissionNeed(.automation))
        let dialog = try XCTUnwrap(center.dialogs[.automation])
        dialog.primary()
        await waitUntil { dialog.status == .notDetermined && dialog.phase == .asking }
        XCTAssertEqual(dialog.primaryAction, .allow, "nothing was decided, so Continue stays")

        await dialog.refresh(explicit: false)
        await dialog.refresh(explicit: false, fresh: true)
        await dialog.refresh(explicit: true)
        XCTAssertEqual(system.requests, [.automation], "no second probe for a kind macOS never answered")
        XCTAssertEqual(dialog.status, .notDetermined)
        XCTAssertEqual(dialog.primaryAction, .allow)
    }

    func testAProbeMacOSHoldsAnswersByItsDeadline() async {
        let flights = ProbeFlights()
        let started = ContinuousClock.now
        let held = await SystemPermissions.probe("fixture-held", within: 0.05, flights: flights) {
            Thread.sleep(forTimeInterval: 0.6)
            return .granted
        }
        XCTAssertEqual(held, .notDetermined, "an unanswered probe reads as not asked, so Continue and Check again work")
        XCTAssertLessThan(ContinuousClock.now - started, .milliseconds(450))
        let answered = await SystemPermissions.probe("fixture-answered", within: 5, flights: flights) { .denied }
        XCTAssertEqual(answered, .denied)
    }

    /// Counts probe runs from the queue they block on.
    private final class ProbeRuns: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        var value: Int {
            lock.lock()
            defer { lock.unlock() }
            return count
        }
        func record() {
            lock.lock()
            count += 1
            lock.unlock()
        }
    }

    func testCheckingAgainWhileAProbeIsStuckStartsNoMoreBlockingProbes() async {
        let flights = ProbeFlights()
        let runs = ProbeRuns()
        // An Automation prompt nobody answers: the probe blocks until the gate opens.
        let gate = DispatchSemaphore(value: 0)
        var opened = false
        defer { if !opened { gate.signal() } }
        for _ in 0 ..< 3 {
            let answer = await SystemPermissions.probe("fixture", within: 0.05, flights: flights) {
                runs.record()
                // The test opens the gate within a second; the deadline keeps a broken test from hanging the suite.
                if gate.wait(timeout: .now() + 10) == .timedOut { XCTFail("the stuck probe's gate never opened") }
                return .granted
            }
            XCTAssertEqual(answer, .notDetermined)
        }
        XCTAssertEqual(runs.value, 1, "one blocking probe, however often Check again is pressed")
        XCTAssertEqual(flights.running, 1)

        // A request still waiting when the stuck probe answers gets that answer, and starts nothing.
        async let joined = SystemPermissions.probe("fixture", within: 5, flights: flights) {
            runs.record()
            return .denied
        }
        try? await Task.sleep(for: .milliseconds(50))
        opened = true
        gate.signal()
        let answer = await joined
        XCTAssertEqual(answer, .granted)
        XCTAssertEqual(runs.value, 1)
        XCTAssertEqual(flights.running, 0)

        // Once it answered, the next request probes again.
        let fresh = await SystemPermissions.probe("fixture", within: 5, flights: flights) {
            runs.record()
            return .denied
        }
        XCTAssertEqual(fresh, .denied)
        XCTAssertEqual(runs.value, 2)
    }

    func testNotNowWhileMacOSIsAskingNeverRunsTheFeatureOrOpensSettings() async throws {
        let system = FakePermissionSystem()
        system.statuses[.accessibility] = .notDetermined
        system.grantOnRequest = [.accessibility, .microphone]
        system.requestDelay = .milliseconds(80)
        system.statuses[.microphone] = .notDetermined
        let (center, presenter) = center(system)
        var retries = 0
        // Settings-style kind: the request that lists the app is still open when the user presses "Not now".
        center.require(PermissionNeed(.accessibility, onGranted: { retries += 1 }))
        let settingsDialog = try XCTUnwrap(center.dialogs[.accessibility])
        settingsDialog.primary()
        await waitUntil { settingsDialog.phase == .working }
        settingsDialog.dismiss()
        // In-place prompt kind: the same, through Continue.
        center.require(PermissionNeed(.microphone, onGranted: { retries += 1 }))
        let promptDialog = try XCTUnwrap(center.dialogs[.microphone])
        promptDialog.primary()
        promptDialog.dismiss()

        // Both grants arrive after Not now; then the dialogs' own continuations get their turn on the main actor.
        await waitUntil { system.answered.count == 2 }
        for _ in 0 ..< 20 { await Task.yield() }
        XCTAssertEqual(system.requests, [.accessibility, .microphone], "both requests reached macOS and answered granted")
        XCTAssertEqual(Set(system.answered), [.accessibility, .microphone])
        XCTAssertEqual(retries, 0, "a grant that arrives after Not now runs no feature")
        XCTAssertTrue(system.opened.isEmpty, "System Settings does not open after Not now")
        XCTAssertNotEqual(settingsDialog.phase, .granted)
        XCTAssertNotEqual(promptDialog.phase, .granted)
        XCTAssertEqual(presenter.closed, [.accessibility, .microphone])
        XCTAssertEqual(center.dismissed, [.accessibility, .microphone])
    }

    func testOpenSettingsListsTheAppFirstThenWaitsAndCheckAgainCloses() async {
        let system = FakePermissionSystem()
        system.statuses[.accessibility] = .notDetermined
        let (center, presenter) = center(system)
        center.require(PermissionNeed(.accessibility))
        let dialog = center.dialogs[.accessibility]
        dialog?.primary()
        await waitUntil { dialog?.phase == .waiting }
        XCTAssertEqual(system.requests, [.accessibility], "the request puts the app in the System Settings list")
        XCTAssertEqual(system.opened, [.accessibility])
        await dialog?.refresh(explicit: true)
        XCTAssertNotNil(dialog?.note, "Check again without a grant says so")
        system.statuses[.accessibility] = .granted
        await dialog?.refresh(explicit: true)
        await waitUntil { presenter.closed == [.accessibility] }
        XCTAssertEqual(dialog?.phase, .granted)
    }

    func testAGrantOnlyANewProcessSeesOffersRelaunchForAnInProcessFeature() async {
        let system = FakePermissionSystem()
        system.statuses[.inputMonitoring] = .denied
        var probes = 0
        var relaunches = 0
        let (center, presenter) = center(system, fresh: { _ in probes += 1; return .granted }, relaunch: {
            relaunches += 1
            return true
        })
        center.require(PermissionNeed(.inputMonitoring))
        let dialog = center.dialogs[.inputMonitoring]
        await dialog?.refresh(explicit: true)
        XCTAssertEqual(probes, 1)
        XCTAssertEqual(dialog?.phase, .relaunch)
        XCTAssertEqual(dialog?.primaryAction, .relaunch)
        XCTAssertEqual(dialog?.primaryTitle.hasPrefix("Relaunch"), true)
        dialog?.primary()
        XCTAssertEqual(relaunches, 1)
        XCTAssertTrue(presenter.closed.isEmpty)
    }

    func testIOHIDGrantStatusOpensStraightInTheRelaunchPhase() {
        let system = FakePermissionSystem()
        system.statuses[.inputMonitoring] = .needsRelaunch
        let (center, _) = center(system)
        XCTAssertFalse(center.require(PermissionNeed(.inputMonitoring)))
        XCTAssertEqual(center.dialogs[.inputMonitoring]?.phase, .relaunch)
    }

    func testAFeatureRunInANewProcessGoesAheadOnAFreshGrantAndShowsTheDialogOtherwise() async {
        let system = FakePermissionSystem()
        system.statuses[.screenRecording] = .notDetermined
        var fresh: PermissionStatus = .granted
        let (center, presenter) = center(system, fresh: { _ in fresh })
        let need = PermissionNeed(.screenRecording, grantWorksInNewProcess: true)
        let allowed = await center.ensure(need)
        XCTAssertTrue(allowed)
        XCTAssertTrue(presenter.presented.isEmpty)
        fresh = .notDetermined
        let refused = await center.ensure(need)
        XCTAssertFalse(refused)
        XCTAssertEqual(presenter.presented, [.screenRecording])
        let inProcess = await center.ensure(PermissionNeed(.inputMonitoring))
        XCTAssertFalse(inProcess, "an in-process feature never counts a grant only a new process sees")
    }

    func testANeedDuringTheGrantedConfirmationRunsItsRetryOrGetsADialogOfItsOwn() async {
        let system = FakePermissionSystem()
        system.statuses[.screenRecording] = .denied
        var fresh: PermissionStatus = .denied
        let (center, presenter) = center(system, fresh: { _ in fresh }, closeDelay: .seconds(3600))
        var retries = 0
        // A retry that asks again at once, as a capture refused by this process's old answer does.
        func ask() {
            center.require(PermissionNeed(.screenRecording, grantWorksInNewProcess: true, onGranted: {
                retries += 1
                ask()
            }))
        }
        ask()
        let dialog = center.dialogs[.screenRecording]
        fresh = .granted
        await dialog?.refresh(explicit: true)
        XCTAssertEqual(dialog?.phase, .granted)
        XCTAssertEqual(retries, 1, "the retry's own ask does not run it again")

        ask()
        XCTAssertEqual(retries, 2, "a need that arrives while the confirmation shows still runs its retry")
        XCTAssertTrue(center.dialogs[.screenRecording] === dialog)
        XCTAssertEqual(presenter.presented, [.screenRecording])

        XCTAssertFalse(center.require(PermissionNeed(.screenRecording)))
        let replacement = center.dialogs[.screenRecording]
        XCTAssertFalse(replacement === dialog, "an in-process feature cannot use the grant this process has not read")
        XCTAssertEqual(presenter.presented, [.screenRecording, .screenRecording])
        XCTAssertEqual(presenter.closed, [.screenRecording])
        await waitUntil { replacement?.phase == .relaunch }
    }

    func testStaleSimulationOffersRelaunchWithoutAskingTheProbe() async {
        let system = FakePermissionSystem()
        system.statuses[.inputMonitoring] = .granted
        var probes = 0
        let (center, _) = center(system, simulation: "input-monitoring:stale", fresh: { _ in probes += 1; return nil })
        XCTAssertFalse(center.require(PermissionNeed(.inputMonitoring)))
        await center.dialogs[.inputMonitoring]?.refresh(explicit: true)
        XCTAssertEqual(center.dialogs[.inputMonitoring]?.phase, .relaunch)
        XCTAssertEqual(probes, 0, "the simulation answers for a new process itself")
        XCTAssertTrue(system.requests.isEmpty)
    }

    // MARK: - Sites

    func testShelfCaptureWithoutScreenRecordingShowsTheDialogAndNeverStartsTheScreenshot() async {
        var needs: [PermissionKind] = []
        let store = WidgetShelfStore(request: { args, _ in
            if args.first == "capture" { XCTFail("no screenshot without Screen Recording") }
            return Data(#"{"revision":0,"items":[]}"#.utf8)
        }, screenCaptureAccess: { false }, permissionGate: { need in
            needs.append(need.kind)
            XCTAssertTrue(need.grantWorksInNewProcess, "screencapture runs in a new process")
            return false
        })
        defer { store.stop() }
        store.capture()
        await waitUntil { store.notice != nil }
        XCTAssertEqual(needs, [.screenRecording])
        XCTAssertFalse(store.isCapturing)
        XCTAssertTrue(store.notice?.contains("Screen Recording") == true)
    }

    func testAScreenshotQueuedBeforeTeardownNeverAsksForTheGrantOrCaptures() async throws {
        let domain = "permission-capture." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        let model = WidgetModel(binaryPath: "/fixture/tools", stateRoot: FileManager.default.temporaryDirectory.path,
                                defaults: defaults, appearance: NativeSettingsAppearance(
                                    defaults: defaults, notificationNamespace: domain, observeExternalChanges: false))
        var gates = 0
        var actions: [WidgetJSON] = []
        model.screenCaptureGate = { _ in
            gates += 1
            return true
        }
        model.actionRunner = { value in
            actions.append(value)
            return ["ok": true]
        }

        // Stopped while the capture waited on the queue: no gate, no screenshot.
        model.capture()
        model.stop()
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(gates, 0, "a capture queued before teardown asked for the grant afterwards")
        XCTAssertTrue(actions.isEmpty)
    }

    func testAScreenshotWhoseGateEndsAfterTeardownTakesNoScreenshot() async throws {
        let domain = "permission-capture." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        let model = WidgetModel(binaryPath: "/fixture/tools", stateRoot: FileManager.default.temporaryDirectory.path,
                                defaults: defaults, appearance: NativeSettingsAppearance(
                                    defaults: defaults, notificationNamespace: domain, observeExternalChanges: false))
        var gates = 0
        var actions: [WidgetJSON] = []
        // The face is torn down while the gate waits on the fresh-process probe.
        model.screenCaptureGate = { _ in
            gates += 1
            model.stop()
            return true
        }
        model.actionRunner = { value in
            actions.append(value)
            return ["ok": true]
        }

        model.capture()
        await waitUntil { gates == 1 }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertTrue(actions.isEmpty, "the screenshot started after teardown")
    }

    func testAPasteRefusedForAccessibilityOpensTheDialogAsAnAutomaticNeed() async {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("flow-paste-permission-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let previousURL = FlowEvents.logURL
        FlowEvents.logURL = root.appendingPathComponent("events.jsonl")
        defer { FlowEvents.logURL = previousURL }
        let session = FlowSession(store: FlowStore(directory: root))
        var needs: [PermissionNeed] = []
        session.permissionPresenter = { needs.append($0) }
        session.accessibilityTrustEffect = { false }
        session.injectEffect = { _ in .notPermitted }
        await session.completeTurn(raw: "fixture dictation")
        XCTAssertEqual(needs.map(\.kind), [.accessibility])
        XCTAssertEqual(needs.first?.trigger, .automatic, "a side effect of a turn stays quiet after Not now")
        XCTAssertTrue(session.lastError?.contains("Accessibility") == true, "the inline message stays as well")
    }

    /// `PERMISSION_DIALOG_SCREENSHOT_DIR=<dir>` renders every dialog state, dark and light, without a window.
    func testRenderEveryDialogState() async throws {
        guard let directory = ProcessInfo.processInfo.environment["PERMISSION_DIALOG_SCREENSHOT_DIR"] else {
            throw XCTSkip("Set PERMISSION_DIALOG_SCREENSHOT_DIR for isolated rendering")
        }
        let prefix = ProcessInfo.processInfo.environment["PERMISSION_DIALOG_SCREENSHOT_PREFIX"] ?? "permission-dialog"
        let system = FakePermissionSystem()
        system.statuses = [.inputMonitoring: .denied, .microphone: .notDetermined, .accessibility: .notDetermined,
                           .screenRecording: .needsRelaunch, .speechRecognition: .notDetermined]
        system.grantOnRequest = [.speechRecognition]
        let (center, _) = center(system, relaunch: { true })
        center.require(PermissionNeed(
            .inputMonitoring,
            reason: "Clicky plays a sound for each key you press. It uses key positions only and never reads what you type."))
        center.require(PermissionNeed(.microphone, reason: "Voice Notes records a short clip from your microphone. It stays on this Mac until you choose Transcribe."))
        center.require(PermissionNeed(.accessibility, reason: "Flow pastes your dictation into the app you were using. Without Accessibility it can only copy the text."))
        center.require(PermissionNeed(.screenRecording))
        center.require(PermissionNeed(.speechRecognition))
        let waiting = try XCTUnwrap(center.dialogs[.accessibility])
        waiting.primary()
        await waitUntil { waiting.phase == .waiting }
        await waiting.refresh(explicit: true)
        let granted = try XCTUnwrap(center.dialogs[.speechRecognition])
        granted.primary()
        await waitUntil { granted.phase == .granted }
        let states: [(String, PermissionDialogModel)] = [
            ("input-monitoring-settings", try XCTUnwrap(center.dialogs[.inputMonitoring])),
            ("microphone-continue", try XCTUnwrap(center.dialogs[.microphone])),
            ("accessibility-still-off", waiting),
            ("screen-recording-relaunch", try XCTUnwrap(center.dialogs[.screenRecording])),
            ("speech-granted", granted),
        ]
        for (name, model) in states {
            for scheme in [ColorScheme.dark, .light] {
                let host = NSHostingView(rootView: PermissionDialogView(model: model)
                    .background(Color(nsColor: .windowBackgroundColor)).environment(\.colorScheme, scheme))
                host.frame = NSRect(origin: .zero, size: host.fittingSize)
                host.layoutSubtreeIfNeeded()
                let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: bitmap)
                let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                try png.write(to: URL(fileURLWithPath: directory)
                    .appendingPathComponent("\(prefix)-\(name)-\(scheme == .dark ? "dark" : "light").png"))
                XCTAssertEqual(host.fittingSize.width, 420, "\(name) keeps the dialog width")
            }
        }
    }

    func testTheSharedCenterOfATestProcessNeverReachesTheSystem() async {
        XCTAssertTrue(PermissionCenter.isTestProcess)
        XCTAssertTrue(PermissionCenter.shared.presenter is RecordingPermissionPresenter)
        XCTAssertEqual(PermissionCenter.shared.status(.microphone), .denied)
        let answer = await PermissionCenter.shared.access.request(.microphone)
        XCTAssertEqual(answer, .denied)
    }
}
