import AppKit
import Combine
import Foundation
import SwiftUI

/// One elected runtime owns hotkeys, audio capture, activity recording, the Pomodoro clock,
/// DND and feature writes. Other app processes retain the same views over passive models.
@MainActor
public final class FlowFocusRuntime: ObservableObject {
    public enum Role: Equatable {
        case stopped, starting
        case owner(String), client(String), unavailable(String)
        public var isOwner: Bool { if case .owner = self { return true }; return false }
    }

    public static let shared = FlowFocusRuntime(sharedModels: true)
    private static var activeOwners: [URL: FlowFocusRuntime] = [:]
    nonisolated public static var defaultDataRoot: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".genesis", isDirectory: true)
    }

    @Published public private(set) var role: Role = .stopped
    @Published public private(set) var lastError: String?
    /// The older Genesis copies this host steps back for. They run their own dictation shortcut, capture, Focus timer
    /// and Do Not Disturb, so this host owns none of those while they run. An explicit recording still works
    /// (`acquireExternalAudio`), and the host takes its part back when they quit.
    @Published public private(set) var legacyHosts: [FlowFocusPeerApp] = []
    /// Why the last `acquireExternalAudio` was refused, with what was found and the fixes. The Voice Notes module
    /// shows it for the error text it matches (its store keeps only the text).
    public private(set) static var lastAudioRefusal: FlowFocusNotice?
    /// The running Genesis.app copies to check before this host owns anything. Only the shared data root is the one
    /// an older Genesis also uses, so a runtime on an explicit root sees none. Tests replace it.
    var peerApps: @MainActor () -> [FlowFocusPeerApp]
    /// Asks a peer app to quit (the legacy notice's fix). Tests replace it.
    var terminatePeer: @MainActor (Int32) -> Bool = { pid in
        NSRunningApplication(processIdentifier: pid)?.terminate() ?? false
    }
    private var legacyExits: [DispatchSourceProcess] = []
    public let flow: FlowSession
    public let focus: FocusController
    public let configuration: FlowFocusConfiguration
    public let dataRoot: URL
    public let directory: URL
    public let hostID: String
    public let liveServices: Bool
    /// Set before `start()` by a face that only edits settings (Clicky's `--headless` Settings): it never takes the
    /// owner's place, so it starts no capture, hotkeys or DND, and plays no sounds or notifications. It joins the
    /// running owner as a client, so its switches and Flow files are written by the owner as the normal Settings'.
    public var settingsOnly = false
    private let presentsWindows: Bool
    private let dnd: FocusOrchestrator
    private let flowStore: FlowStore
    private let participant: Participant
    private var lease: FlowFocusLease?
    private var mailbox: FlowFocusMailbox?
    private var stateWatcher: DirectoryWatcher?
    private var discoveryWatcher: DirectoryWatcher?
    private var ownerExit: DispatchSourceProcess?
    private var applicationObserver: NSObjectProtocol?
    private var subscriptions = Set<AnyCancellable>()
    private var publication: Task<Void, Never>?
    private var suppressPublication = false
    private(set) var publicationAttempts = 0
    private var flowRevision: UInt64 = 0
    private var receivedFlowRevision: UInt64?
    private var receivedConfigurationRevision: UInt64?
    private var lastSnapshot: FlowFocusLiveSnapshot?
    private var reconnecting = false
    private var lastExternalTarget: FlowFocusTarget?
    private var dictationWindow: NSWindowController?
    private lazy var externalAudio = FlowFocusAudioCoordinator(directory: directory, flow: flow)

    private struct Participant: Codable {
        let version: Int
        let pid: Int32
        let hostID: String
        let nonce: UUID
        let launchDate: Date?
    }

    public init(dataRoot: URL? = nil, hostID: String? = nil, liveServices: Bool = true,
                presentsWindows: Bool = true, sharedModels: Bool = false) {
        let root = dataRoot ?? Self.defaultDataRoot
        let sharedRoot = root.standardizedFileURL == Self.defaultDataRoot.standardizedFileURL
        let usesSharedModels = sharedModels && sharedRoot
        peerApps = sharedRoot ? { FlowFocusPeerApp.running() } : { [] }
        self.dataRoot = root
        directory = root.appendingPathComponent("feature-runtime", isDirectory: true)
        self.hostID = hostID ?? Bundle.main.bundleIdentifier ?? "dev.genesis.feature-host"
        self.liveServices = liveServices
        self.presentsWindows = presentsWindows
        configuration = FlowFocusConfiguration(directory: root)
        flowStore = FlowStore(directory: root.appendingPathComponent("flow", isDirectory: true), writesEnabled: false)
        flow = usesSharedModels ? FlowSession.shared : FlowSession(store: flowStore)
        focus = usesSharedModels ? FocusController.shared : FocusController()
        dnd = usesSharedModels ? FocusOrchestrator.shared : FocusOrchestrator(
            stateURL: root.appendingPathComponent("focus-snapshot.json"))
        participant = Participant(version: 1, pid: ProcessInfo.processInfo.processIdentifier,
                                  hostID: self.hostID, nonce: UUID(), launchDate: NSRunningApplication.current.launchDate)
    }

    public func start() async {
        // A start during an asynchronous stop waits for it: the stop's tail releases the lease and unregisters the
        // participant, which must never belong to the runtime a restart just set up.
        while let shutdown { await shutdown.value }
        // A start cancelled while it waited never begins: it would register a participant and stay `.starting`.
        guard !Task.isCancelled else { return }
        switch role {
        case .starting, .owner, .client: return
        case .stopped, .unavailable: break
        }
        startGeneration &+= 1
        let generation = startGeneration
        role = .starting
        lastError = nil
        // A stop, or a later start that ran while this one slept, makes this start stale. A stale start neither
        // acts on the newer start's role nor tears it down.
        func isCurrentStart() -> Bool { generation == startGeneration && role == .starting }
        do {
            try registerParticipant()
            installDiscovery()
            let legacy = legacyPeers()
            for _ in 0 ..< 20 {
                guard isCurrentStart() else { return }
                if Task.isCancelled {
                    // Undo the registration, so a later start is not refused by a role stuck at `.starting`.
                    await stop()
                    return
                }
                if !settingsOnly, let acquired = try FlowFocusLease.acquire(directory: directory, hostID: hostID) {
                    guard legacy.isEmpty else {
                        // The lock was free, so no current host owns Flow and Focus, and an older Genesis runs them
                        // itself. Owning them here would run its shortcut, capture, timer and DND twice: this host
                        // steps back from them, and from nothing else.
                        acquired.release()
                        stepBack(for: legacy)
                        return
                    }
                    clearLegacy()
                    lease = acquired
                    try becomeOwner(acquired)
                    return
                }
                // A live owner already runs every service, so joining it as a client duplicates nothing, whatever
                // else runs.
                if let owner = try? FlowFocusLease.readOwner(directory: directory) {
                    clearLegacy()
                    try becomeClient(owner)
                    return
                }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            guard isCurrentStart() else { return }
            guard legacy.isEmpty else {
                stepBack(for: legacy)
                return
            }
            throw FlowFocusMailbox.Failure.unavailable("The Flow and Focus owner is still starting. Try again shortly.")
        } catch is CancellationError {
            // The host withdrew the start while it waited for another owner to finish starting. That is not a
            // failure: undo the registration quietly, and leave a newer start alone.
            if generation == startGeneration { await stop() }
        } catch {
            let message = error.localizedDescription
            await stop()
            // A restart may have run while this failed start was being stopped; its role is not this start's to
            // overwrite (an owner marked unavailable would refuse every command).
            guard generation == startGeneration else { return }
            role = .unavailable(message)
            reportFailure(message)
            installDiscovery()
        }
    }

    /// Hosts must await this from their terminate-later delegate path. The descriptor stays held until recording has
    /// stopped, the command the owner took and any ledger deletion have finished, and every already-queued settings
    /// write has reached disk. A terminating host bounds the wait (5 s); the process exit then frees the lease.
    public func stop() async {
        if let shutdown {
            await shutdown.value
            return
        }
        // The task clears itself as its last step: a start resuming between the shutdown's end and this caller's
        // resumption must never leave a finished task behind for a later stop() to mistake for one in progress.
        let task = Task { @MainActor [self] in
            await self.shutDown()
            self.shutdown = nil
        }
        shutdown = task
        await task.value
    }

    private var shutdown: Task<Void, Never>?
    /// Moves on with every start that begins, so a failed start records its failure only if no later start ran.
    private var startGeneration = 0
    /// Awaited inside a shutdown right before the settings flush; tests hold a shutdown open with it.
    var beforeShutdownFlush: (() async -> Void)?

    private func shutDown() async {
        role = .stopped
        publication?.cancel()
        publication = nil
        ownerExit?.cancel()
        ownerExit = nil
        stateWatcher?.stop()
        stateWatcher = nil
        discoveryWatcher?.stop()
        discoveryWatcher = nil
        // A command the owner already took finishes first, while the models it uses still run (a client's "delete
        // activity" waits for its deletion); commands still waiting are refused.
        await mailbox?.stopAfterCurrentCommand()
        mailbox = nil
        subscriptions.removeAll()
        configuration.allowsWrites = false
        configuration.forwardPatch = nil
        flowStore.writesEnabled = false
        externalAudio.stopObserving()
        flow.stop()
        focus.stop(preservingSession: true)
        dnd.uninstallTerminateHook()
        if lease != nil {
            do { _ = try dnd.endSession() }
            catch { reportFailure(error.localizedDescription) }
        }
        dnd.ownsRuntime = false
        dnd.remoteCommand = nil
        if let beforeShutdownFlush { await beforeShutdownFlush() }
        // The owner's own "delete activity" runs outside the mailbox; the ledger is not handed over mid-deletion.
        await focus.finishLedgerWrites()
        await configuration.flush()
        if Self.activeOwners[directory] === self { Self.activeOwners.removeValue(forKey: directory) }
        lease?.release()
        lease = nil
        if let applicationObserver { NSWorkspace.shared.notificationCenter.removeObserver(applicationObserver) }
        applicationObserver = nil
        clearLegacy()
        unregisterParticipant()
    }

    public func send(action: String, payload: Data = Data()) async throws -> Data {
        guard let mailbox else { throw FlowFocusMailbox.Failure.unavailable(lastError ?? "Flow and Focus are not ready.") }
        return try await mailbox.request(action: action, payload: payload)
    }

    public func acquireExternalAudio() async throws -> FlowFocusAudioLease {
        // While this host steps back for an older Genesis, no current host owns audio to admit a recorder, and the
        // older copy captures without admissions anyway: an explicit recording goes ahead on its own lease.
        if mailbox == nil, !legacyHosts.isEmpty {
            PerfLog.mark("flow-focus.audio standalone legacy=\(legacyHosts.map { String($0.pid) }.joined(separator: ","))")
            return FlowFocusAudioLease(standaloneFor: self)
        }
        guard let holder = FlowAudioProcess.read(pid: ProcessInfo.processInfo.processIdentifier) else {
            throw FlowFocusMailbox.Failure.unavailable("The recording host could not be identified.")
        }
        let token = UUID()
        let request = FlowAudioAdmission(token: token, holder: holder, recorder: nil,
                                          attachBefore: Date().addingTimeInterval(30))
        do {
            _ = try await send(action: "audio.acquire", payload: JSONEncoder().encode(request))
            return FlowFocusAudioLease(runtime: self, token: token)
        } catch {
            Self.lastAudioRefusal = audioRefusal(error)
            do { _ = try await send(action: "audio.release", payload: JSONEncoder().encode(token)) }
            catch { FlowFocusLog.flow.warning("Unacknowledged audio admission cleanup: \(error.localizedDescription)") }
            throw error
        }
    }

    public func beginDictation() {
        let target = externalTarget() ?? lastExternalTarget
        flow.beginTurn(target: target, captureCurrentTarget: false)
    }

    public func showDictation() {
        if dictationWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1060, height: 760),
                                  styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            window.title = "Dictation"
            window.minSize = NSSize(width: 760, height: 540)
            window.isReleasedWhenClosed = false
            window.contentView = NSHostingView(rootView: FlowView(session: flow).preferredColorScheme(.dark))
            window.center()
            dictationWindow = NSWindowController(window: window)
        }
        dictationWindow?.showWindow(nil)
        dictationWindow?.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    public func showStudio() { focus.openStudio() }
    public func showTimer() { focus.showHUD() }

    private func configureModels(owner: Bool) {
        FlowFocusConfiguration.shared = configuration
        FlowStore.shared = flowStore
        flowStore.writesEnabled = owner
        flowStore.forwardWrite = nil
        flowStore.didWrite = { [weak self] in
            guard let self else { return }
            self.flowRevision &+= 1
            self.schedulePublication()
        }
        flow.configuration = configuration
        focus.configuration = configuration
        focus.orchestrator = dnd
        dnd.configuration = configuration
        dnd.ownsRuntime = owner
        dnd.configure(stateURL: dataRoot.appendingPathComponent("focus-snapshot.json"))
        flow.remoteCommand = nil
        dnd.remoteCommand = nil
        configuration.forwardPatch = nil
        configuration.allowsWrites = owner
        configuration.onFailure = { [weak self] in self?.reportFailure($0) }
        configuration.reload()
        flow.configure(store: flowStore)
        FlowFocusHost.shared.soundsEnabled = liveServices && !settingsOnly
        FlowFocusHost.shared.notificationsEnabled = liveServices && !settingsOnly
        installTargetObserver()
        stateWatcher = DirectoryWatcher(paths: [dataRoot.path], latency: 0.2,
            accepts: { [dataRoot] in $0 == dataRoot.appendingPathComponent("client.json").path }) { [weak self] _ in
                MainActor.assumeIsolated { self?.configuration.reload() }
            }
        configuration.$revision.dropFirst().sink { [weak self] _ in
            guard let self, self.role.isOwner else { return }
            self.focus.apply(appConfig: self.configuration.app)
            self.flow.setLabEnabled(self.configuration.dictationEnabled)
            self.schedulePublication()
        }.store(in: &subscriptions)
    }

    private func becomeOwner(_ lease: FlowFocusLease) throws {
        configureModels(owner: true)
        try flowStore.verifyingWrites { flowStore.recoverPendingHistory() }
        flow.reloadStoredState()
        externalAudio.onFailure = { [weak self] in self?.reportFailure($0) }
        try externalAudio.start()
        _ = dnd.recoverIfNeeded()
        dnd.installTerminateHook()
        focus.ownsRuntime = true
        focus.start(appConfig: configuration.app, databasePath: dataRoot.appendingPathComponent("activity.db").path,
                    liveServices: liveServices, presentsWindows: presentsWindows)
        if liveServices { flow.start() }
        let mailbox = try FlowFocusMailbox(directory: directory, owner: lease.owner) { [weak self] command in
            guard let self, self.role.isOwner else {
                throw FlowFocusMailbox.Failure.unavailable("This process no longer owns Flow and Focus.")
            }
            return try await self.handle(command)
        }
        self.mailbox = mailbox
        role = .owner(hostID)
        Self.activeOwners[directory] = self
        try publish()
        try lease.advertise()
        observeOwnerState()
        mailbox.start()
        PerfLog.mark("flow-focus.owner host=\(hostID)")
    }

    private func becomeClient(_ owner: FlowFocusLease.Owner) throws {
        configureModels(owner: false)
        let mailbox = try FlowFocusMailbox(directory: directory, owner: owner)
        self.mailbox = mailbox
        let forward: (String, Data) -> Void = { [weak self] action, payload in self?.perform(action, payload) }
        flow.remoteCommand = forward
        dnd.remoteCommand = forward
        // The configuration reports a refusal itself (its `onFailure` reaches `reportFailure`), and a save waits for it.
        configuration.forwardPatch = { [weak self] patch in
            guard let self, let channel = self.mailbox else {
                throw FlowFocusMailbox.Failure.unavailable("Flow and Focus are not ready.")
            }
            let sent = self.forward("configuration.patch", try JSONSerialization.data(withJSONObject: patch), through: channel)
            return Task { @MainActor [weak self] in
                try await sent.value
                // The owner answers after its write, so client.json holds the patch now; a save that returns true
                // already reads it, without waiting for the owner's next snapshot.
                self?.configuration.reload()
            }
        }
        flowStore.forwardWrite = { [weak self] name, data in
            do { self?.perform("flow.file", try JSONEncoder().encode(FlowStoreWrite(name: name, data: data))) }
            catch { self?.reportFailure(error.localizedDescription) }
        }
        do {
            try focus.attachClient(databasePath: dataRoot.appendingPathComponent("activity.db").path, command: forward)
            focus.remoteRequest = { [weak self] action, payload in
                guard let self else { throw CancellationError() }
                let reply = try await self.send(action: action, payload: payload)
                self.receiveSnapshot()
                return reply
            }
        } catch { focus.reportFailure(error.localizedDescription) }
        role = .client(owner.hostID)
        receivedFlowRevision = nil
        receivedConfigurationRevision = nil
        mailbox.onStateChange = { [weak self] in self?.receiveSnapshot() }
        mailbox.onOwnerChange = { [weak self] in self?.scheduleReconnect() }
        mailbox.start()
        receiveSnapshot()
        if owner.pid != ProcessInfo.processInfo.processIdentifier {
            let source = DispatchSource.makeProcessSource(identifier: owner.pid, eventMask: .exit, queue: .main)
            source.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.scheduleReconnect() } }
            source.resume()
            ownerExit = source
        }
        PerfLog.mark("flow-focus.client owner=\(owner.hostID)")
    }

    private func observeOwnerState() {
        func observe(_ publisher: ObservableObjectPublisher) {
            publisher.sink { [weak self] _ in self?.schedulePublication() }.store(in: &subscriptions)
        }
        observe(flow.objectWillChange)
        observe(flow.recognizer.objectWillChange)
        observe(focus.objectWillChange)
        observe(dnd.objectWillChange)
        if let engine = focus.engine { observe(engine.objectWillChange) }
        if let recorder = focus.recorder { observe(recorder.objectWillChange) }
    }

    private func schedulePublication() {
        guard role.isOwner, publication == nil, !suppressPublication else { return }
        publication = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 100_000_000)
            guard !Task.isCancelled, let self else { return }
            self.publication = nil
            do {
                try self.publish()
            } catch {
                self.suppressPublication = true
                self.reportFailure(error.localizedDescription)
                self.suppressPublication = false
            }
        }
    }

    private func publish() throws {
        guard role.isOwner, let lease else { return }
        let state = FlowFocusLiveSnapshot(ownerNonce: lease.owner.nonce, flowRevision: flowRevision,
                                         configurationRevision: configuration.revision, configurationError: configuration.lastError,
                                         flow: flow.liveSnapshot, focus: focus.liveSnapshot, dnd: dnd.liveSnapshot)
        guard state != lastSnapshot else { return }
        publicationAttempts += 1
        try PerfLog.span("flow-focus.publish") {
            try FlowFocusLease.writePrivate(try JSONEncoder().encode(state),
                                           to: directory.appendingPathComponent("state.json"))
        }
        lastSnapshot = state
        mailbox?.signalStateChange()
    }

    private func receiveSnapshot() {
        guard case .client = role, let mailbox else { return }
        do {
            let data = try Data(contentsOf: directory.appendingPathComponent("state.json"))
            let snapshot = try JSONDecoder().decode(FlowFocusLiveSnapshot.self, from: data)
            guard snapshot.ownerNonce == mailbox.owner.nonce else { return }
            if receivedFlowRevision != snapshot.flowRevision {
                receivedFlowRevision = snapshot.flowRevision
                flow.reloadStoredState()
            }
            if receivedConfigurationRevision != snapshot.configurationRevision {
                receivedConfigurationRevision = snapshot.configurationRevision
                configuration.reload()
                if let error = snapshot.configurationError { configuration.reportFailure(error) }
                else { configuration.dismissError() }
            }
            flow.applyRemote(snapshot.flow)
            focus.applyRemote(snapshot.focus)
            dnd.applyRemote(snapshot.dnd)
        } catch { reportFailure(error.localizedDescription) }
    }

    private func perform(_ action: String, _ payload: Data) {
        guard let channel = mailbox else { reportFailure("Flow and Focus are not ready."); return }
        let sent = forward(action, payload, through: channel)
        Task { @MainActor [weak self] in
            do { try await sent.value }
            catch {
                guard let self, self.mailbox === channel else { return }
                self.reportFailure(error.localizedDescription)
            }
        }
    }

    /// One command to the owner. A refusal makes this client read the stored state again, so it shows nothing that
    /// was never written; the error goes to the caller.
    private func forward(_ action: String, _ payload: Data, through channel: FlowFocusMailbox) -> Task<Void, Error> {
        Task { @MainActor [weak self] in
            do {
                _ = try await channel.request(action: action, payload: payload)
                guard let self, self.mailbox === channel else { return }
                self.receiveSnapshot()
            } catch {
                if let self, self.mailbox === channel {
                    self.flow.reloadStoredState()
                    self.configuration.reload()
                }
                throw error
            }
        }
    }

    private func handle(_ command: FlowFocusMailbox.Command) async throws -> Data {
        do {
            if command.action == "focus.forget" { return try await forget(command) }
            let failures = configuration.failureCount
            let reply = try flowStore.verifyingWrites { try handleMutation(command) }
            if command.action == "configuration.patch" {
                // The answer waits for client.json, so a client's Save reports what was stored, not what was sent.
                await configuration.flush()
                if configuration.failureCount != failures {
                    throw FlowFocusMailbox.Failure.unavailable(configuration.lastError ?? "The setting was not stored.")
                }
            }
            return reply
        } catch {
            reportFailure(error.localizedDescription)
            throw error
        }
    }

    private func handleMutation(_ command: FlowFocusMailbox.Command) throws -> Data {
        func decode<T: Decodable>(_ type: T.Type) throws -> T { try JSONDecoder().decode(type, from: command.payload) }
        if command.action.hasPrefix("focus."), !command.action.hasPrefix("focus.dnd."), focus.engine == nil {
            throw FlowFocusMailbox.Failure.unavailable(focus.lastError ?? "The Focus ledger is unavailable.")
        }
        switch command.action {
        case "audio.acquire": try externalAudio.acquire(decode(FlowAudioAdmission.self))
        case "audio.attach": try externalAudio.attach(decode(FlowAudioAttachment.self))
        case "audio.release": try externalAudio.release(decode(UUID.self))
        case "flow.begin":
            let target = try decode(FlowFocusTarget?.self)
            if let target, target.processIdentifier == ProcessInfo.processInfo.processIdentifier {
                throw FlowFocusMailbox.Failure.unavailable("The dictation owner cannot be its own insertion target.")
            }
            flow.beginTurn(target: target, captureCurrentTarget: false)
        case "flow.end": flow.endTurn()
        case "flow.cancel": flow.cancelTurn()
        case "flow.permissions": flow.requestDictationPermissions()
        case "flow.accessibility": flow.requestAccessibility()
        case "flow.lab": flow.setLabEnabled(try decode(Bool.self))
        case "flow.hotkey.suspend": flow.suspendHotkey(try decode(Bool.self))
        case "flow.config":
            let patch = try JSONSerialization.jsonObject(with: command.payload) as? [String: Any] ?? [:]
            // Decoding clamps a stored value; a new one outside the range is refused, not quietly changed.
            if let grace = patch["trailingGraceMs"], !((grace as? Int).map(FlowConfig.trailingGraceRange.contains) ?? false) {
                throw FlowFocusMailbox.Failure.unavailable(
                    "Trailing grace must be 0 to \(FlowConfig.trailingGraceRange.upperBound) ms.")
            }
            let raw = try JSONSerialization.jsonObject(with: JSONEncoder().encode(flow.config)) as? [String: Any] ?? [:]
            let value = try JSONDecoder().decode(FlowConfig.self, from:
                JSONSerialization.data(withJSONObject: FlowFocusConfiguration.merge(raw, patch)))
            try flow.persistConfiguration(value)
        case "flow.rule.add":
            let values = try decode([String].self)
            guard values.count == 2 else { throw invalidCommand() }
            flow.addRule(from: values[0], to: values[1])
        case "flow.rule.remove": flow.removeRule(try decode(UUID.self))
        case "flow.suggestion.accept":
            let value = try decode(FlowSuggestionAcceptance.self)
            flow.acceptSuggestion(value.suggestion, replacement: value.replacement)
        case "flow.suggestion.dismiss": flow.dismissSuggestion(try decode(FlowSuggestion.self))
        case "flow.snippet.add":
            let values = try decode([String].self)
            guard values.count == 2 else { throw invalidCommand() }
            flow.addSnippet(trigger: values[0], body: values[1])
        case "flow.snippet.remove": flow.removeSnippet(try decode(UUID.self))
        case "flow.history.delete": flow.deleteEntry(try decode(UUID.self))
        case "flow.history.clear": flow.clearHistory()
        case "flow.file":
            let write = try decode(FlowStoreWrite.self)
            try flowStore.writeFromClient(name: write.name, data: write.data)
        case "configuration.patch":
            let patch = try JSONSerialization.jsonObject(with: command.payload) as? [String: Any] ?? [:]
            // `flowTransforms` is FlowTransformTools.save: a client host forwards it here like any setting.
            let allowed: Set<String> = ["focus", "labs", "focusWhileListening", "focusShortcutName", "flowTransforms"]
            guard Set(patch.keys).isSubset(of: allowed) else { throw invalidCommand() }
            if let transforms = patch["flowTransforms"] {
                guard let fields = transforms as? [String: Any], Set(fields.keys) == ["modelRef"],
                      let ref = fields["modelRef"] as? String, ref.hasPrefix("@account/") else { throw invalidCommand() }
            }
            configuration.applyPatch(patch)
        case "focus.start":
            let value = try decode(FocusStartCommand.self)
            if let seconds = value.seconds, seconds <= 0 { throw invalidCommand() }
            focus.engine?.start(value.phase, seconds: value.seconds, tag: value.tag)
        case "focus.pause":
            let value = try decode(FocusPauseCommand.self)
            focus.engine?.pause(reason: value.reason, since: value.since)
        case "focus.resume": focus.engine?.resume()
        case "focus.stop": focus.engine?.stop()
        case "focus.skip": focus.engine?.skip()
        case "focus.back": focus.engine?.goBack()
        case "focus.tag": focus.engine?.setTag(try decode(String?.self))
        case "focus.note": focus.engine?.setNote(try decode(String.self))
        case "focus.capture.pause": focus.recorder?.pauseCapture(until: try decode(Date.self))
        case "focus.capture.resume": focus.recorder?.resumeCapture()
        case "focus.dnd.begin": _ = try dnd.beginSession(reason: String(data: command.payload, encoding: .utf8) ?? "genesis-voice")
        case "focus.dnd.end":
            let reason = String(data: command.payload, encoding: .utf8).flatMap { $0.isEmpty ? nil : $0 }
            _ = try dnd.endSession(reason: reason)
        default: throw invalidCommand()
        }
        schedulePublication()
        return Data()
    }

    /// A client's ledger connection is read-only, so a "delete activity" request from its Settings runs here, off the
    /// main actor like the owner's own (the range can be the whole ledger).
    private func forget(_ command: FlowFocusMailbox.Command) async throws -> Data {
        let range = try JSONDecoder().decode(FocusForgetCommand.self, from: command.payload)
        guard range.from < range.to else { throw invalidCommand() }
        let result = try await focus.forgetOwned(range)
        schedulePublication()
        return try JSONEncoder().encode(result)
    }

    private func invalidCommand() -> FlowFocusMailbox.Failure { .unavailable("Unsupported Flow and Focus command.") }

    private func reportFailure(_ message: String) {
        lastError = message
        flow.reportFailure(message)
        focus.reportFailure(message)
        FlowFocusLog.focus.error("runtime: \(message)")
    }

    private func scheduleReconnect() {
        guard !role.isOwner, role != .stopped, !reconnecting else { return }
        reconnecting = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            await self.stop()
            self.lastSnapshot = nil
            self.reconnecting = false
            await self.start()
        }
    }

    private func installDiscovery() {
        discoveryWatcher = DirectoryWatcher(paths: [directory.path], latency: 0.1,
            accepts: { $0.hasSuffix("/owner.json") }) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    if case .unavailable = self.role { Task { await self.start() } }
                }
            }
    }

    private func participantURL(_ pid: Int32) -> URL { directory.appendingPathComponent("participant-\(pid).json") }

    private func registerParticipant() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try FlowFocusLease.writePrivate(try JSONEncoder().encode(participant), to: participantURL(participant.pid))
    }

    private func unregisterParticipant() {
        guard let data = try? Data(contentsOf: participantURL(participant.pid)),
              let current = try? JSONDecoder().decode(Participant.self, from: data), current.nonce == participant.nonce else { return }
        do { try FileManager.default.removeItem(at: participantURL(participant.pid)) }
        catch { FlowFocusLog.focus.warning("participant cleanup failed: \(error.localizedDescription)") }
    }

    /// The running Genesis copies that do not speak this protocol.
    private func legacyPeers() -> [FlowFocusPeerApp] {
        peerApps().filter { $0.pid != participant.pid && !isParticipant($0) }
    }

    /// A peer speaks this protocol when its participant record was written by the process running now: the launch
    /// dates match, or the record is not older than the process. A record left by an earlier process with the same
    /// pid predates it. LaunchServices gives no launch date to an app started another way, so the date alone called a
    /// current Genesis "older" and refused this host (2026-10-23).
    private func isParticipant(_ peer: FlowFocusPeerApp) -> Bool {
        let record = participantURL(peer.pid)
        guard let data = try? Data(contentsOf: record),
              let found = try? JSONDecoder().decode(Participant.self, from: data),
              found.version == 1, found.pid == peer.pid else { return false }
        if let launched = found.launchDate, launched == peer.launchDate { return true }
        guard let started = peer.startedAt,
              let written = (try? FileManager.default.attributesOfItem(atPath: record.path))?[.modificationDate] as? Date
        else { return false }
        // One second of slack for a file system that stores whole seconds.
        return written >= started.addingTimeInterval(-1)
    }

    private func stepBack(for hosts: [FlowFocusPeerApp]) {
        let message = Self.legacyMessage(hosts)
        legacyHosts = hosts
        role = .unavailable(message)
        // The runtime's own error only (a command sent meanwhile names the reason; the next start clears it). Not the
        // Flow and Focus models' errors: nothing clears those when the host takes its part back.
        lastError = message
        watchLegacyExits(hosts)
        PerfLog.mark("flow-focus.legacy pids=\(hosts.map { String($0.pid) }.joined(separator: ","))")
    }

    static func legacyMessage(_ hosts: [FlowFocusPeerApp]) -> String {
        let pids = hosts.map { String($0.pid) }.joined(separator: ", ")
        return "An older Genesis (\(hosts.count == 1 ? "pid" : "pids") \(pids)) runs its own dictation shortcut, Focus "
            + "timer and Do Not Disturb, so this host leaves them to it. Voice Notes still record."
    }

    /// When an older copy quits, this host takes its part back: it starts again, as owner or client.
    private func watchLegacyExits(_ hosts: [FlowFocusPeerApp]) {
        legacyExits.forEach { $0.cancel() }
        legacyExits = hosts.map { host in
            let source = DispatchSource.makeProcessSource(identifier: host.pid, eventMask: .exit, queue: .main)
            source.setEventHandler { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, case .unavailable = self.role, self.legacyHosts.contains(host) else { return }
                    Task { await self.start() }
                }
            }
            source.resume()
            return source
        }
    }

    private func clearLegacy() {
        legacyExits.forEach { $0.cancel() }
        legacyExits = []
        if !legacyHosts.isEmpty { legacyHosts = [] }
    }

    /// The notice the Flow module shows while this host steps back: each older copy, how it was found, and how to quit it.
    public func legacyNotice() -> FlowFocusNotice {
        let found = legacyHosts.map { host in
            [
                "Genesis, pid \(host.pid)",
                "App: \(host.bundlePath.map(PathDisplay.tilde) ?? "unknown")",
                "Version: \(host.version ?? "unknown")",
                "Started: \(FlowFocusDiagnostics.stamp(host.startedAt ?? host.launchDate))",
                "Why it counts as older: since it started, it wrote no Flow and Focus participant record "
                    + "(\(PathDisplay.tilde(participantURL(host.pid).path))).",
            ].joined(separator: "\n")
        }.joined(separator: "\n\n")
        var fixes: [NoticeFix] = []
        for host in legacyHosts {
            let confirm = NoticeFix.Confirmation(
                "Quit Genesis (pid \(host.pid))?",
                consequence: "Genesis may ask to save open work. Dictation and Focus then start in this host.",
                confirmLabel: "Quit Genesis")
            fixes.append(.button("Quit the older Genesis (pid \(host.pid))", symbol: "power", confirm: confirm) { [weak self] in
                let asked = self?.terminatePeer(host.pid) ?? false
                PerfLog.mark("flow-focus.legacy quit pid=\(host.pid) asked=\(asked)")
            })
            fixes.append(.command("Or quit it from a terminal", "kill \(host.pid)"))
        }
        return FlowFocusNotice(
            text: "An older Genesis runs dictation and Focus",
            detail: "This host leaves the dictation shortcut, the Focus timer and Do Not Disturb to that copy until it "
                + "quits or is updated. Voice Notes record as usual.",
            found: found, fixes: fixes)
    }

    /// What was found when the owner refused audio, and the fixes that apply: the owner, a dictation in progress, the
    /// process that holds the microphone.
    private func audioRefusal(_ error: Error) -> FlowFocusNotice {
        var lines = ["This host: \(hostID), pid \(participant.pid), \(Self.describe(role))"]
        var fixes: [NoticeFix] = []
        if let owner = try? FlowFocusLease.readOwner(directory: directory) {
            lines.append("Flow and Focus owner: \(owner.hostID), pid \(owner.pid), since \(FlowFocusDiagnostics.stamp(owner.startedAt))")
        } else {
            lines.append("Flow and Focus owner: none (\(PathDisplay.tilde(directory.appendingPathComponent("owner.json").path)))")
        }
        if [.listening, .transcribing, .injecting].contains(flow.phase) {
            lines.append("Dictation: \(flow.phase.rawValue)")
            fixes.append(.button("Cancel the dictation in progress", symbol: "xmark.circle",
                                 confirm: .init("Cancel the dictation in progress?",
                                                consequence: "The words heard so far are not inserted.",
                                                confirmLabel: "Cancel dictation")) { [weak self] in self?.flow.cancelTurn() })
        }
        let admissionURL = directory.appendingPathComponent("audio-admission.json")
        if let data = try? Data(contentsOf: admissionURL),
           let admission = try? JSONDecoder().decode(FlowAudioAdmission.self, from: data) {
            let process = admission.recorder ?? admission.holder
            let name = FlowFocusPeerApp.processName(process.pid) ?? "a process"
            lines.append("Microphone admitted to: \(name), pid \(process.pid), "
                + (admission.recorder == nil ? "recorder not started yet" : "recording"))
            if admission.recorder != nil, process.isAlive, process.pid != participant.pid {
                fixes.append(.button("Stop the other recording (\(name), pid \(process.pid))", symbol: "stop.circle",
                                     confirm: .init("Stop \(name) (pid \(process.pid))?",
                                                    consequence: "That recording ends now; what it captured may not be saved.",
                                                    confirmLabel: "Stop it")) {
                    // The notice can outlive the recorder; the kernel start time catches a reused pid.
                    guard process.isAlive else {
                        PerfLog.mark("flow-focus.audio stop pid=\(process.pid) skipped=exited")
                        return
                    }
                    let sent = kill(process.pid, SIGTERM) == 0
                    PerfLog.mark("flow-focus.audio stop pid=\(process.pid) sent=\(sent)")
                })
                fixes.append(.command("Or stop it from a terminal", "kill \(process.pid)"))
            }
        }
        if case .unavailable = role {
            fixes.append(.button("Connect to Flow and Focus again", symbol: "arrow.clockwise") { [weak self] in
                guard let self, case .unavailable = self.role else { return }
                Task { await self.start() }
            })
        }
        return FlowFocusNotice(text: error.localizedDescription, detail: nil, found: lines.joined(separator: "\n"), fixes: fixes)
    }

    private static func describe(_ role: Role) -> String {
        switch role {
        case .stopped: return "stopped"
        case .starting: return "starting"
        case .owner: return "owner"
        case .client(let owner): return "client of \(owner)"
        case .unavailable(let why): return "unavailable: \(why)"
        }
    }

    private func installTargetObserver() {
        lastExternalTarget = externalTarget()
        applicationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                if let target = self?.externalTarget() { self?.lastExternalTarget = target }
            }
        }
    }

    private func externalTarget() -> FlowFocusTarget? {
        guard let app = NSWorkspace.shared.frontmostApplication,
              app.processIdentifier != ProcessInfo.processInfo.processIdentifier,
              app.bundleIdentifier != "dev.foltyn.genesis",
              !(app.bundleIdentifier ?? "").hasPrefix("com.genesiscz.genesistools") else { return nil }
        return FlowFocusTarget(bundleIdentifier: app.bundleIdentifier, localizedName: app.localizedName,
                               processIdentifier: app.processIdentifier)
    }
}
