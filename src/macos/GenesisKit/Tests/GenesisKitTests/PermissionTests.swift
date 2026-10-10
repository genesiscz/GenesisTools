import AppKit
import SwiftUI
import XCTest

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
        private(set) var opened: [PermissionKind] = []

        func status(_ kind: PermissionKind) -> PermissionStatus { statuses[kind] ?? .denied }

        func request(_ kind: PermissionKind) async -> PermissionStatus {
            requests.append(kind)
            if let requestDelay { try? await Task.sleep(for: requestDelay) }
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
        relaunch: @escaping @MainActor () -> Bool = { false }
    ) -> (PermissionCenter, RecordingPermissionPresenter) {
        let presenter = RecordingPermissionPresenter()
        let parsed = PermissionSimulation.parse(simulation)
        let center = PermissionCenter(
            access: PermissionAccess(system: system, simulation: { parsed }), presenter: presenter,
            freshProbe: fresh, relaunch: relaunch, pollInterval: .seconds(3600), closeDelay: .zero,
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
            "calendars": .calendars, "fda": .fullDiskAccess,
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
        XCTAssertEqual(system.requests, [.automation], "the plain poll never runs the probe")

        await dialog?.refresh(explicit: true)
        XCTAssertEqual(system.requests, [.automation, .automation], "Check again probes the refused grant")
        XCTAssertNotNil(dialog?.note, "still refused, and it says so")

        system.probeAnswers[.automation] = .granted
        await dialog?.refresh(explicit: true)
        await waitUntil { presenter.closed == [.automation] }
        XCTAssertEqual(dialog?.phase, .granted)
        XCTAssertEqual(retries, 1)
    }

    func testAProbeMacOSHoldsAnswersByItsDeadline() async {
        let started = ContinuousClock.now
        let held = await SystemPermissions.probe(within: 0.05) {
            Thread.sleep(forTimeInterval: 0.6)
            return .granted
        }
        XCTAssertEqual(held, .notDetermined, "an unanswered probe reads as not asked, so Continue and Check again work")
        XCTAssertLessThan(ContinuousClock.now - started, .milliseconds(450))
        let answered = await SystemPermissions.probe(within: 5) { .denied }
        XCTAssertEqual(answered, .denied)
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

        try await Task.sleep(for: .milliseconds(250))
        XCTAssertEqual(system.requests, [.accessibility, .microphone], "both requests reached macOS and answered granted")
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
