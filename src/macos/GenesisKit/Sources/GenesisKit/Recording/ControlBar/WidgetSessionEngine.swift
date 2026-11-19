import Foundation

/// The short movie made by tools control capture session. Each launch owns its pipe until the movie is saved or discarded.
@MainActor
public final class WidgetSessionEngine: RecordingEngineAdapter {
    /// A change to active FPS, idle FPS or the motion threshold starts a new segment, or waits for Resume when paused.
    public let capabilities = RecordingCapabilities(
        targets: [.window, .app, .display, .area], liveTargetSwitch: true, liveFrameRate: true,
        maxDurationMs: RecordingSessionController.maximumDurationMs, reasonUnavailable: [
            "displays": "Record several displays with the full recorder (⌘7).",
            "microphone": "Widget recordings have no microphone track to mute.",
            "microphoneDevice": "Widget recordings have no microphone input. Choose one in the full recorder (⌘7).",
            "systemAudio": "Widget recordings have no system audio track to mute.",
            "camera": "Add a camera with the full recorder (⌘7).",
            "quality": "The widget records at the target’s native size.",
            "drawsCursor": "The widget uses the capture session’s cursor setting.",
        ])
    public private(set) var nextTakeID = UUID().uuidString
    public let events: AsyncStream<RecordingEngineEvent>
    private let output: AsyncStream<RecordingEngineEvent>.Continuation
    private let makeController: @MainActor () -> RecordingSessionController
    private let showsBorder: @MainActor () -> Bool
    private let finishTimeout: Duration
    private var controller: RecordingSessionController?
    private var take: String?
    private var hasFrame = false
    private var isPaused = false
    // The CLI's switch command starts capturing. Hold a paused choice until Resume to keep the pause silent.
    private var targetOnResume: RecordingTarget?

    private typealias Command = RecordingSessionController.Command
    private var waiting: Command?
    private var restartingAs: String?
    private var reply: CheckedContinuation<URL?, Error>?
    private var deadline: Task<Void, Never>?

    public convenience init(bridge: ToolsBridge, settings: RecordingSettings? = nil) {
        self.init(makeController: { RecordingSessionController(bridge: bridge) },
                  showsBorder: { (settings ?? RecordingSettings.shared).showsBorder })
    }

    init(makeController: @escaping @MainActor () -> RecordingSessionController, showsBorder: @escaping @MainActor () -> Bool,
         finishTimeout: Duration = .seconds(240)) {
        self.makeController = makeController
        self.showsBorder = showsBorder
        self.finishTimeout = finishTimeout
        (events, output) = AsyncStream.makeStream(of: RecordingEngineEvent.self)
    }

    deinit { output.finish() }

    public func start(_ setup: RecordingSetup, excludeWindowIDs: [Int]) async throws {
        guard controller == nil else { throw Failure("A widget recording is already open.") }
        let id = reserveTake()
        guard let target = setup.target else { throw RecordingEngineError.unsupported("Choose what to record first.") }
        try requireTarget(target)
        let session = makeController()
        controller = session
        take = id
        hasFrame = false
        isPaused = false
        session.onEvent = { [weak self, weak session] event in
            guard let self, self.controller === session else { return }
            self.receive(event)
        }
        session.onRates = { [weak self, weak session] active, idle in
            guard let self, self.controller === session, case let .rates(fps, still) = self.waiting else { return }
            if active == Double(fps), idle == (still == 0 ? active : still) { self.complete(.success(nil)) }
            else { self.complete(.failure(Failure("The recorder applied \(active) fps and \(idle) fps while still."))) }
        }
        session.onDone = { [weak self, weak session] url, _ in
            guard let self, self.controller === session else { return }
            self.ended(.stopped(url))
        }
        session.onDiscarded = { [weak self, weak session] in
            guard let self, self.controller === session else { return }
            self.ended(.discarded)
        }
        session.onFailed = { [weak self, weak session] message, _ in
            guard let self, self.controller === session else { return }
            self.ended(.failed(message))
        }
        do {
            try session.start(target: target, excludeWindowIDs: excludeWindowIDs, frameRate: setup.frameRate,
                              showsBorder: showsBorder(), stillFrameRate: setup.stillFrameRate)
        } catch {
            controller = nil
            take = nil
            throw error
        }
    }

    public func pause() async throws { _ = try await command(.pause) }
    public func resume() async throws {
        if let targetOnResume {
            _ = try await command(.switchTo(targetOnResume))
            self.targetOnResume = nil
        } else {
            _ = try await command(.resume)
        }
    }

    public func stop() async throws -> URL? { try await command(.stop) }
    public func discard() async throws { _ = try await command(.discard) }

    public func restart() async throws {
        let id = reserveTake()
        let command: Command = targetOnResume.map(Command.restartOn) ?? .restart
        _ = try await self.command(command, restartingAs: id)
        targetOnResume = nil
    }

    public func apply(_ change: RecordingSetupChange) async throws {
        switch change {
        case let .target(target):
            try requireTarget(target)
            guard let controller else { throw Failure("There is no open widget recording.") }
            if controller.phase == .paused {
                targetOnResume = target
            } else {
                _ = try await command(.switchTo(target))
            }
        case let .frameRate(active, still):
            guard (1...120).contains(active), still == 0 || still == Double(active)
                    || ((0.1...5).contains(still) && still <= Double(active)) else {
                throw Failure("Choose a supported active and still frame rate.")
            }
            _ = try await command(.rates(active, still == Double(active) ? 0 : still))
        case .microphone, .systemAudio, .camera, .quality, .drawsCursor:
            throw RecordingEngineError.unsupported(capabilities.reasonUnavailable[change.controlID]
                ?? "The widget cannot apply this change.")
        }
    }

    public func audioDevices() async throws -> (inputs: [RecordingAudioDevice], outputs: [RecordingAudioDevice]) {
        ([], [])
    }

    private func reserveTake() -> String {
        let id = nextTakeID
        nextTakeID = UUID().uuidString
        return id
    }

    private func requireTarget(_ target: RecordingTarget) throws {
        if !capabilities.targets.contains(target.kind) {
            throw RecordingEngineError.unsupported(capabilities.reasonUnavailable[target.kind.rawValue]
                ?? "Choose a single widget recording target.")
        }
    }

    private struct Failure: LocalizedError {
        let text: String
        init(_ text: String) { self.text = text }
        var errorDescription: String? { text }
    }

    /// The bar serializes its commands. A pipe write alone acknowledges neither a state change nor a saved file.
    private func command(_ command: Command, restartingAs: String? = nil) async throws -> URL? {
        guard let controller else { throw Failure("There is no open widget recording.") }
        guard waiting == nil else { throw Failure("The recording is still applying the previous command.") }
        return try await withCheckedThrowingContinuation { continuation in
            waiting = command
            self.restartingAs = restartingAs
            reply = continuation
            // Joining the finished movie can take minutes. Boundary-changing commands get a longer deadline.
            let timeout = command == .stop || command == .discard || restartingAs != nil ? finishTimeout : .seconds(15)
            deadline = Task { [weak self] in
                do { try await Task.sleep(for: timeout) } catch { return }
                guard let self else { return }
                let message = "The recorder did not confirm the command."
                if self.restartingAs != nil {
                    self.ended(.failed(message))
                    controller.terminate()
                } else {
                    self.complete(.failure(Failure(message)))
                }
            }
            do { try controller.write(command) }
            catch { complete(.failure(error)) }
        }
    }

    private func receive(_ event: RecordingSessionLine) {
        switch event.event {
        case "state":
            switch event.state {
            case "starting":
                // stdout is ordered. The old segment can still deliver lines after the Restart write.
                // Only the new, empty session boundary consumes the reserved ID.
                if let next = restartingAs, event.reason == "user", event.segments == 0, event.elapsedMs == 0 {
                    take = next
                    hasFrame = false
                    isPaused = false
                    complete(.success(nil))
                } else if waiting == .resume || isSwitching(to: event.target) {
                    complete(.success(nil))
                }
            case "recording":
                if !hasFrame { emit(.firstFrame) }
                else if isPaused { emit(.resumed) }
                hasFrame = true
                isPaused = false
            case "paused":
                isPaused = true
                emit(.paused)
                if waiting == .pause { complete(.success(nil)) }
            default: break
            }
            if let ms = event.elapsedMs { emit(.elapsed(milliseconds: ms)) }
        case "elapsed":
            if let ms = event.elapsedMs { emit(.elapsed(milliseconds: ms)) }
        case "preparing":
            if let message = event.message { emit(.warning(message)) }
        case "error" where event.fatal != true:
            let message = event.message ?? "The recorder could not apply the command."
            emit(.warning(message))
            // A segment may report a recoverable warning while it winds down. The join can still succeed.
            if event.code == "command-refused" || message.hasPrefix("Unknown command:")
                || (restartingAs == nil && controller?.phase == .paused) {
                complete(.failure(Failure(message)))
            }
        default: break
        }
    }

    private func isSwitching(to target: RecordingTarget?) -> Bool {
        guard case let .switchTo(requested) = waiting, let target else { return false }
        // The pipe drops long display names and window titles to fit its atomic write.
        switch (requested, target) {
        case let (.window(ids, _, _, _), .window(echo, _, _, _)): return ids == echo
        case let (.display(index, _), .display(echo, _)): return index == echo
        case let (.app(app, _), .app(echo, _)): return app == echo
        case let (.area(rect, index, id), .area(echo, echoIndex, echoID)):
            return rect == echo && (id.map { $0 == echoID } ?? (index == echoIndex))
        default: return requested == target
        }
    }

    private func emit(_ value: RecordingEngineEvent.Value) {
        if let take { output.yield(.init(take: take, value: value)) }
    }

    private func ended(_ event: RecordingEngineEvent.Value) {
        if let restartingAs {
            output.yield(.init(take: restartingAs, value: event))
            complete(.failure(RecordingEngineError.restartEnded(event)))
        } else {
            emit(event)
            switch (waiting, event) {
            case let (.stop, .stopped(url)): complete(.success(url))
            case (.discard, .discarded): complete(.success(nil))
            case let (_, .failed(message)): complete(.failure(Failure(message)))
            default: complete(.failure(Failure("The recording ended before it confirmed the command.")))
            }
        }
        take = nil
        controller = nil
        targetOnResume = nil
    }

    private func complete(_ result: Result<URL?, Error>) {
        deadline?.cancel()
        deadline = nil
        waiting = nil
        restartingAs = nil
        let continuation = reply
        reply = nil
        continuation?.resume(with: result)
    }
}
