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
    public let flow: FlowSession
    public let focus: FocusController
    public let configuration: FlowFocusConfiguration
    public let dataRoot: URL
    public let directory: URL
    public let hostID: String
    public let liveServices: Bool
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
        let usesSharedModels = sharedModels && root.standardizedFileURL == Self.defaultDataRoot.standardizedFileURL
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
        switch role {
        case .starting, .owner, .client: return
        case .stopped, .unavailable: break
        }
        role = .starting
        lastError = nil
        do {
            try registerParticipant()
            installDiscovery()
            try rejectLegacyOwner()
            for _ in 0 ..< 20 {
                guard !Task.isCancelled, role == .starting else { return }
                if let acquired = try FlowFocusLease.acquire(directory: directory, hostID: hostID) {
                    lease = acquired
                    try becomeOwner(acquired)
                    return
                }
                if let owner = try? FlowFocusLease.readOwner(directory: directory) {
                    try becomeClient(owner)
                    return
                }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            throw FlowFocusMailbox.Failure.unavailable("The Flow and Focus owner is still starting. Try again shortly.")
        } catch {
            let message = error.localizedDescription
            await stop()
            role = .unavailable(message)
            reportFailure(message)
            installDiscovery()
        }
    }

    /// Hosts must await this from their terminate-later delegate path. The descriptor stays held
    /// until recording has stopped and every already-queued settings write has reached disk.
    public func stop() async {
        role = .stopped
        publication?.cancel()
        publication = nil
        ownerExit?.cancel()
        ownerExit = nil
        stateWatcher?.stop()
        stateWatcher = nil
        discoveryWatcher?.stop()
        discoveryWatcher = nil
        mailbox?.stop()
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
        await configuration.flush()
        if Self.activeOwners[directory] === self { Self.activeOwners.removeValue(forKey: directory) }
        lease?.release()
        lease = nil
        if let applicationObserver { NSWorkspace.shared.notificationCenter.removeObserver(applicationObserver) }
        applicationObserver = nil
        unregisterParticipant()
    }

    public func send(action: String, payload: Data = Data()) async throws -> Data {
        guard let mailbox else { throw FlowFocusMailbox.Failure.unavailable(lastError ?? "Flow and Focus are not ready.") }
        return try await mailbox.request(action: action, payload: payload)
    }

    public func acquireExternalAudio() async throws -> FlowFocusAudioLease {
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
        FlowEvents.logURL = dataRoot.appendingPathComponent("flow/events.jsonl")
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
        FlowFocusHost.shared.soundsEnabled = liveServices
        FlowFocusHost.shared.notificationsEnabled = liveServices
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
            return try self.handle(command)
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
        configuration.forwardPatch = { [weak self] patch in
            do { self?.perform("configuration.patch", try JSONSerialization.data(withJSONObject: patch)) }
            catch { self?.reportFailure(error.localizedDescription) }
        }
        flowStore.forwardWrite = { [weak self] name, data in
            do { self?.perform("flow.file", try JSONEncoder().encode(FlowStoreWrite(name: name, data: data))) }
            catch { self?.reportFailure(error.localizedDescription) }
        }
        do {
            try focus.attachClient(databasePath: dataRoot.appendingPathComponent("activity.db").path, command: forward)
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
        Task { @MainActor [weak self] in
            do {
                _ = try await channel.request(action: action, payload: payload)
                guard let self, self.mailbox === channel else { return }
                self.receiveSnapshot()
            } catch {
                guard let self, self.mailbox === channel else { return }
                self.flow.reloadStoredState()
                self.configuration.reload()
                self.reportFailure(error.localizedDescription)
            }
        }
    }

    private func handle(_ command: FlowFocusMailbox.Command) throws -> Data {
        do {
            return try flowStore.verifyingWrites { try handleMutation(command) }
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
        case "flow.lab": flow.setLabEnabled(try decode(Bool.self))
        case "flow.config":
            let patch = try JSONSerialization.jsonObject(with: command.payload) as? [String: Any] ?? [:]
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
            let allowed: Set<String> = ["focus", "labs", "focusWhileListening", "focusShortcutName"]
            guard Set(patch.keys).isSubset(of: allowed) else { throw invalidCommand() }
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

    private var participantURL: URL { directory.appendingPathComponent("participant-\(participant.pid).json") }

    private func registerParticipant() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try FlowFocusLease.writePrivate(try JSONEncoder().encode(participant), to: participantURL)
    }

    private func unregisterParticipant() {
        guard let data = try? Data(contentsOf: participantURL),
              let current = try? JSONDecoder().decode(Participant.self, from: data), current.nonce == participant.nonce else { return }
        do { try FileManager.default.removeItem(at: participantURL) }
        catch { FlowFocusLog.focus.warning("participant cleanup failed: \(error.localizedDescription)") }
    }

    private func rejectLegacyOwner() throws {
        guard dataRoot.standardizedFileURL == Self.defaultDataRoot.standardizedFileURL else { return }
        for app in NSRunningApplication.runningApplications(withBundleIdentifier: "dev.foltyn.genesis")
            where app.processIdentifier != participant.pid {
            let record = directory.appendingPathComponent("participant-\(app.processIdentifier).json")
            if let data = try? Data(contentsOf: record),
               let peer = try? JSONDecoder().decode(Participant.self, from: data),
               peer.version == 1, peer.launchDate != nil, peer.launchDate == app.launchDate { continue }
            throw FlowFocusMailbox.Failure.unavailable(
                "An older Genesis is running its own Flow and Focus services. Update or quit that copy before enabling this host.")
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
