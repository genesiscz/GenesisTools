import Combine
import Foundation

public enum RecordingBarPhase: Equatable, Sendable {
    case setup, countdown(Int), starting(take: String), recording(take: String), paused(take: String, byUser: Bool)
    case finishing, done(URL?), failed(String)

    fileprivate var acceptsLiveChanges: Bool {
        switch self {
        case .recording, .paused: return true
        default: return false
        }
    }
}

public struct RecordingBarNotice: Equatable, Sendable {
    public enum Action: Equatable, Sendable { case retryStop, showControls }
    public let take: String?
    public let controlID: String
    public let message: String
    public let actions: [Action]
}

@MainActor
public final class RecordingBarModel: ObservableObject {
    @Published public var setup: RecordingSetup {
        didSet { if oldValue.target != setup.target { refreshCapabilities() } }
    }
    @Published public private(set) var phase: RecordingBarPhase = .setup
    @Published public private(set) var capabilities: RecordingCapabilities
    @Published public var expanded: Bool
    @Published public private(set) var notice: RecordingBarNotice?
    @Published public private(set) var elapsedMs: Double = 0
    @Published public private(set) var audioLevels: (microphone: Double, systemAudio: Double)?
    /// The display a "Follow display" take records now, as its engine reports it; nil before the first report.
    @Published public private(set) var liveDisplay: RecordingDisplay?
    @Published public private(set) var audioInputs: [RecordingAudioDevice] = []
    @Published public private(set) var audioOutputs: [RecordingAudioDevice] = []
    @Published public private(set) var isRestartPending = false

    /// The host updates these when a bar, outline, picker or pulse panel gets its window number.
    public var excludeWindowIDs: [Int] = []

    private let engine: RecordingEngineAdapter
    private let defaults: UserDefaults
    private let countdownTick: () async -> Void
    private var openingSetup: RecordingSetup
    private var activeTake: String?

    private var pauseRequestedByUser: Bool?
    private var finishRequestedFor: String?
    private var phaseBeforeFinish: RecordingBarPhase?
    private var eventTask: Task<Void, Never>?
    private var noticeTimer: Task<Void, Never>?
    private var deviceTask: Task<Void, Never>?
    private(set) var pendingCommand: Task<Void, Never>?

    public convenience init(engine: RecordingEngineAdapter, setup: RecordingSetup) {
        self.init(engine: engine, setup: setup, countdownTick: { try? await Task.sleep(for: .seconds(1)) })
    }

    init(engine: RecordingEngineAdapter, setup: RecordingSetup, defaults: UserDefaults = .standard,
         countdownTick: @escaping () async -> Void) {
        self.engine = engine
        self.setup = setup
        openingSetup = setup
        self.defaults = defaults
        self.countdownTick = countdownTick
        capabilities = engine.capabilities
        expanded = defaults.bool(forKey: "recorder.bar.expandedByDefault")
        let events = engine.events
        eventTask = Task { [weak self] in
            for await event in events {
                guard let self, !Task.isCancelled else { return }
                self.receive(event)
            }
        }
    }

    deinit {
        eventTask?.cancel()
        noticeTimer?.cancel()
        deviceTask?.cancel()
    }

    /// Reopen setup on the same engine and stream consumer.
    public func resetSetup(_ draft: RecordingSetup) {
        switch phase {
        case .setup, .done, .failed:
            setup = draft
            openingSetup = draft
            end(.setup)
        default: break
        }
    }

    public func cancelSetup() {
        if case .countdown = phase { discard() }
        guard phase == .setup else { return }
        setup = openingSetup
        clearNotice()
    }

    public func saveAsDefaults() {
        guard phase == .setup else { return }
        setup.save(defaults)
        openingSetup = setup
    }

    public func newRecording() {
        switch phase {
        case .done, .failed:
            openingSetup = setup
            end(.setup)
        default: break
        }
    }

    public func record() {
        guard phase == .setup else { return }
        if let target = setup.target, !capabilities.targets.contains(target.kind) {
            report(capabilities.reasonUnavailable[target.kind.rawValue] ?? "This target is unavailable.", control: "target")
            return
        }
        let draft = setup
        let take = engine.nextTakeID
        clearNotice()
        elapsedMs = 0
        audioLevels = nil
        liveDisplay = nil
        let seconds = max(0, draft.countdownSeconds ?? 0)
        activeTake = seconds > 0 ? nil : take
        phase = seconds > 0 ? .countdown(seconds) : .starting(take: take)
        enqueue {
            for remaining in (0..<seconds).reversed() {
                await self.countdownTick()
                guard !Task.isCancelled, case .countdown = self.phase else { return }
                if remaining == 0 { self.activeTake = take }
                self.phase = remaining > 0 ? .countdown(remaining) : .starting(take: take)
            }
            do {
                try await self.engine.start(draft, excludeWindowIDs: self.excludeWindowIDs)
                if self.activeTake == take { self.refreshCapabilities() }
            } catch {
                if self.activeTake == take { self.end(.failed(error.localizedDescription)) }
            }
        }
    }

    public func apply(_ change: RecordingSetupChange) {
        if phase == .setup {
            var draft = setup
            change.edit(&draft)
            if draft.target?.kind != setup.target?.kind {
                if draft.target?.kind == .displays {
                    draft.quality = RecordingSetup.framesQuality(defaults)
                    if draft.stillFrameRate == 0 || draft.stillFrameRate == Double(draft.frameRate) {
                        draft.stillFrameRate = RecordingSetup.framesDefaultStillRate
                    }
                } else {
                    draft.quality = .standard
                }
            }
            setup = draft
        } else if phase.acceptsLiveChanges && !isRestartPending {
            forTake { take in _ = await self.applyLive(change, take: take) }
        }
    }

    public func changeFrameRate(active: Int? = nil, still: Double? = nil) {
        if phase == .setup {
            apply(.frameRate(active ?? setup.frameRate, still: still ?? setup.stillFrameRate))
        } else if phase.acceptsLiveChanges && !isRestartPending {
            forTake { take in
                _ = await self.applyLive(.frameRate(active ?? self.setup.frameRate, still: still ?? self.setup.stillFrameRate),
                                         take: take)
            }
        }
    }

    @discardableResult
    private func applyLive(_ change: RecordingSetupChange, take: String) async -> Bool {
        guard phase.acceptsLiveChanges else { return false }
        var requested = setup
        change.edit(&requested)
        if requested == setup { return true }
        if let reason = capabilities.unavailableReason(for: change, in: setup) {
            report(reason, control: change.controlID)
            return false
        }
        do {
            try await engine.apply(change)
            guard activeTake == take else { return false }
            change.edit(&setup)
            if notice?.controlID == change.controlID { clearNotice() }
            return true
        } catch {
            if activeTake == take {
                if case let RecordingEngineError.partialTargetSwitch(target, _) = error {
                    setup.target = target
                    phase = .recording(take: take)
                }
                report(error.localizedDescription, control: change.controlID)
            }
            return false
        }
    }

    public func pause() { forTake { await self.pause(take: $0, byUser: true) } }
    public func resume() { forTake { await self.resume(take: $0) } }

    public func beginTargetSelection(onReady: @escaping @MainActor () -> Void = {}) {
        if phase == .setup { onReady(); return }
        // Read the phase inside the command queue: a Resume or Pause queued just before must land first.
        forTake { take in
            guard !self.isRestartPending else { return }
            if case .paused = self.phase { onReady(); return }
            guard case .recording = self.phase else { return }
            await self.pause(take: take, byUser: false)
            if self.activeTake == take, case .paused = self.phase, !self.isRestartPending { onReady() }
        }
    }

    /// Both Choose and Cancel come through here. A picker opened while manually paused leaves that pause in place.
    public func endTargetSelection(_ target: RecordingTarget?) {
        if phase == .setup {
            if let target { apply(.target(target)) }
            return
        }
        forTake { take in
            guard case let .paused(_, byUser) = self.phase else {
                if target != nil {
                    self.report("Pause the recording before changing its target.", control: "target")
                }
                return
            }
            if let target { _ = await self.applyLive(.target(target), take: take) }
            if !byUser, self.activeTake == take, case .paused = self.phase {
                await self.resume(take: take)
                if self.phase == .paused(take: take, byUser: false) { self.phase = .paused(take: take, byUser: true) }
            }
        }
    }

    private func pause(take: String, byUser: Bool) async {
        if byUser, phase == .paused(take: take, byUser: false) {
            phase = .paused(take: take, byUser: true)
            return
        }
        guard case .recording = phase else { return }
        pauseRequestedByUser = byUser
        defer { pauseRequestedByUser = nil }
        do {
            try await engine.pause()
            if activeTake == take, case .recording = phase { phase = .paused(take: take, byUser: byUser) }
        } catch {
            if activeTake == take { report(error.localizedDescription, control: "pause") }
        }
    }

    private func resume(take: String) async {
        guard case .paused = phase else { return }
        do {
            try await engine.resume()
            if activeTake == take, case .paused = phase { phase = .recording(take: take) }
        } catch {
            if activeTake == take { report(error.localizedDescription, control: "resume") }
        }
    }

    public func stop() {
        guard phase.acceptsLiveChanges, !isRestartPending else { return }
        finish(keeping: true)
    }

    public func retryStop(take: String) {
        guard activeTake == take, notice?.take == take, notice?.actions.contains(.retryStop) == true else { return }
        stop()
    }

    public func discard() {
        guard !isRestartPending else { return }
        switch phase {
        case .countdown:
            pendingCommand?.cancel()
            end(.setup)
        case .starting, .recording, .paused: finish(keeping: false)
        default: break
        }
    }

    private func finish(keeping: Bool) {
        guard let take = activeTake, finishRequestedFor != take else { return }
        finishRequestedFor = take
        enqueue {
            defer { if self.finishRequestedFor == take { self.finishRequestedFor = nil } }
            guard self.activeTake == take else { return }
            self.phaseBeforeFinish = self.phase
            self.phase = .finishing
            do {
                let result: RecordingBarPhase
                if keeping { result = .done(try await self.engine.stop()) }
                else {
                    try await self.engine.discard()
                    result = .setup
                }
                if self.activeTake == take { self.end(result) }
            } catch {
                guard self.activeTake == take else { return }
                if let previous = self.phaseBeforeFinish { self.phase = previous }
                self.phaseBeforeFinish = nil
                self.report(error.localizedDescription, control: keeping ? "stop" : "discard",
                            actions: keeping ? [.retryStop, .showControls] : [])
            }
        }
    }

    public func restart() {
        guard phase.acceptsLiveChanges, !isRestartPending, finishRequestedFor == nil else { return }
        guard capabilities.liveRestart else {
            report(capabilities.reasonUnavailable["restart"] ?? "This recorder does not offer Restart.", control: "restart")
            return
        }
        isRestartPending = true
        forTake { oldTake in
            defer { self.isRestartPending = false }
            let previous = self.phase
            let oldElapsed = self.elapsedMs
            let take = self.engine.nextTakeID
            self.activeTake = take
            self.phase = .starting(take: take)
            self.elapsedMs = 0
            self.audioLevels = nil
            self.clearNotice()
            do { try await self.engine.restart() }
            catch {
                guard self.activeTake == take else { return }
                if case let .restartEnded(event) = error as? RecordingEngineError {
                    self.receive(.init(take: take, value: event))
                    return
                }
                self.activeTake = oldTake
                self.phase = previous
                self.elapsedMs = oldElapsed
                self.report(error.localizedDescription, control: "restart")
            }
        }
    }

    public func refreshAudioDevices() {
        deviceTask?.cancel()
        let engine = engine
        deviceTask = Task { [weak self] in
            do {
                let devices = try await engine.audioDevices()
                guard !Task.isCancelled else { return }
                self?.audioInputs = devices.inputs
                self?.audioOutputs = devices.outputs
            } catch {
                if !Task.isCancelled { self?.report(error.localizedDescription, control: "microphoneDevice") }
            }
        }
    }

    private func receive(_ event: RecordingEngineEvent) {
        let take = event.take
        guard take == activeTake else { return }
        switch event.value {
        case .firstFrame:
            if (phaseBeforeFinish ?? phase) == .starting(take: take) { enginePhase(.recording(take: take)) }
        case .paused:
            if (phaseBeforeFinish ?? phase) == .recording(take: take) {
                enginePhase(.paused(take: take, byUser: pauseRequestedByUser ?? true))
            }
        case .resumed:
            if case .paused = phaseBeforeFinish ?? phase { enginePhase(.recording(take: take)) }
        case let .stopped(url): end(.done(url))
        case .discarded: end(.setup)
        case let .failed(message): end(.failed(message))
        case let .elapsed(milliseconds): elapsedMs = milliseconds
        case let .warning(message): report(message, control: "recording")
        case let .audioLevels(microphone, systemAudio): audioLevels = (microphone, systemAudio)
        case let .liveDisplay(display): if liveDisplay != display { liveDisplay = display }
        }
    }

    private func enginePhase(_ next: RecordingBarPhase) {
        if phase == .finishing { phaseBeforeFinish = next }
        else { phase = next }
    }

    private func refreshCapabilities() {
        let current = engine.capabilities
        if current != capabilities { capabilities = current }
    }

    private func end(_ result: RecordingBarPhase) {
        activeTake = nil
        isRestartPending = false
        pauseRequestedByUser = nil
        phaseBeforeFinish = nil
        clearNotice()
        audioLevels = nil
        liveDisplay = nil
        if result == .setup { elapsedMs = 0 }
        phase = result
    }

    private func report(_ message: String, control: String, actions: [RecordingBarNotice.Action] = []) {
        // Keep a failed Stop reachable until this take ends or the user retries.
        if notice?.actions.contains(.retryStop) == true && actions.isEmpty { return }
        noticeTimer?.cancel()
        notice = RecordingBarNotice(take: activeTake, controlID: control, message: message, actions: actions)
        guard actions.isEmpty else { return }
        let seconds = defaults.object(forKey: "recorder.bar.noticeSeconds") as? Double ?? 4
        noticeTimer = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(max(0, seconds))) } catch { return }
            self?.notice = nil
        }
    }

    private func clearNotice() {
        noticeTimer?.cancel()
        notice = nil
    }

    /// An acknowledgement from a slower command cannot overwrite a newer edit or act on a replacement take.
    private func forTake(_ operation: @escaping @MainActor (String) async -> Void) {
        guard let take = activeTake else { return }
        enqueue {
            guard self.activeTake == take else { return }
            await operation(take)
        }
    }

    private func enqueue(_ operation: @escaping @MainActor () async -> Void) {
        let previous = pendingCommand
        pendingCommand = Task {
            await previous?.value
            guard !Task.isCancelled else { return }
            await operation()
        }
    }
}
