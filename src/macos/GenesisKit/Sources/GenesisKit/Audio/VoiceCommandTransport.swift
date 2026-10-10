import Foundation

@MainActor
public protocol VoiceRecordingLease: AnyObject {
    func attachRecorder(pid: Int32) async throws
    func release() async throws
}

extension FlowFocusAudioLease: VoiceRecordingLease {}

public struct VoiceCommandEvent: Decodable, Sendable {
    public let kind: String
    public let pid: Int32?
    public let rms: Double?
    public let durationMs: Double?
    public let text: String?
    public let code: String?
}

/// Uses the shared CLI pipe lifecycle. A recording can start only after its actual PID is admitted.
@MainActor
public final class VoiceCommandTransport {
    private let bridge: ToolsBridge
    private let prefix: [String]
    private var stream: ToolsLineStream?
    private var continuation: CheckedContinuation<Data, Error>?
    private var gate: Task<Void, Never>?
    private var lease: (any VoiceRecordingLease)?
    private var finalData: Data?
    private var failure: Error?
    private var cancelled = false
    private var receivedReady = false
    /// "Stop and save" can arrive before the `start` gate is written; it is applied right after it.
    private var startSent = false
    private var finishRequested = false
    private var runID = 0
    private var deadlineTask: Task<Void, Never>?
    private let deadline: Duration
    private let killGrace: Duration

    /// `deadline` bounds the whole command, setup included. On expiry the child gets SIGTERM, then
    /// SIGKILL after `killGrace`, and the caller is answered after a second `killGrace` even when
    /// the child's exit never arrives.
    public init(binaryPath: String, stateRoot: String? = nil,
                deadline: Duration = .seconds(90), killGrace: Duration = .seconds(3)) {
        bridge = ToolsBridge(binaryPath: binaryPath)
        prefix = ["widget"] + (stateRoot.map { ["--state-root", $0] } ?? []) + ["voice-notes"]
        self.deadline = deadline
        self.killGrace = killGrace
    }

    public func run(args: [String], lease: (any VoiceRecordingLease)? = nil,
                    onEvent: @escaping (VoiceCommandEvent) -> Void = { _ in }) async throws -> Data {
        guard continuation == nil else { throw ToolsBridgeError.refused("A voice operation is already active") }
        self.lease = lease
        finalData = nil
        failure = nil
        cancelled = false
        receivedReady = false
        startSent = lease == nil
        finishRequested = false
        runID += 1
        let id = runID
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                do {
                    try Task.checkCancellation()
                    stream = try ToolsLineStream(bridge: bridge, subcommand: "hub",
                        args: prefix + args,
                        onLines: { [self] lines in
                            for line in lines {
                                let data = Data(line.utf8)
                                guard let event = try? JSONDecoder().decode(VoiceCommandEvent.self, from: data) else { continue }
                                if event.kind == "ready", let pid = event.pid, let lease = self.lease {
                                    guard !receivedReady else { continue }
                                    receivedReady = true
                                    gate = Task { [self] in
                                        do {
                                            try await lease.attachRecorder(pid: pid)
                                            guard !cancelled else { return }
                                            try stream?.sendInput("start\n")
                                            startSent = true
                                            if finishRequested { stream?.finishInput() }
                                        } catch {
                                            failure = error
                                            stream?.stop()
                                        }
                                    }
                                }
                                if event.kind == "error" {
                                    failure = event.code.flatMap(VoiceCommandFailure.init(rawValue:)) ?? VoiceCommandFailure.operationFailed
                                }
                                if event.kind == "recorded" || event.kind == "transcribed" { finalData = data }
                                onEvent(event)
                            }
                        }, onExit: { [self] report in
                            Task { [self] in
                                guard id == runID else {
                                    // `terminate` already answered this run and released its lease.
                                    PerfLog.mark("voice.command late exit=\(report.status) after termination")
                                    return
                                }
                                deadlineTask?.cancel()
                                deadlineTask = nil
                                await gate?.value
                                gate = nil
                                do { try await self.lease?.release() }
                                catch { failure = failure ?? error }
                                self.lease = nil
                                stream = nil
                                let completion = self.continuation
                                self.continuation = nil
                                if cancelled { completion?.resume(throwing: CancellationError()) }
                                else if let failure { completion?.resume(throwing: failure) }
                                else if report.status != 0 {
                                    PerfLog.mark("voice.command exit=\(report.status) \(report.stderr.suffix(1200))")
                                    completion?.resume(throwing: report.status == 143
                                        ? VoiceCommandFailure.interrupted : VoiceCommandFailure.operationFailed)
                                } else if let finalData { completion?.resume(returning: finalData) }
                                else { completion?.resume(throwing: VoiceCommandFailure.operationFailed) }
                            }
                        })
                    armDeadline(id)
                } catch {
                    Task { [self] in
                        do { try await self.lease?.release() }
                        catch { PerfLog.mark("voice.lease release \(error.localizedDescription)") }
                        self.lease = nil
                        self.continuation = nil
                        continuation.resume(throwing: error)
                    }
                }
            }
        } onCancel: { Task { @MainActor [weak self] in self?.cancel() } }
    }

    public func finishRecording() {
        finishRequested = true
        guard startSent else { return }
        stream?.finishInput()
    }

    private func armDeadline(_ id: Int) {
        deadlineTask = Task { [weak self, deadline] in
            do { try await Task.sleep(for: deadline) } catch { return }
            guard let self, self.runID == id, self.continuation != nil else { return }
            PerfLog.mark("voice.command deadline \(deadline) reached, terminating")
            self.failure = self.failure ?? VoiceCommandFailure.timedOut
            await self.terminate(id, outcome: VoiceCommandFailure.timedOut)
        }
    }

    /// SIGTERM, then SIGKILL after `killGrace`, then answers the caller once if the exit never arrives.
    private func terminate(_ id: Int, outcome: Error) async {
        stream?.stop()
        do { try await Task.sleep(for: killGrace) } catch { return }
        guard runID == id, continuation != nil else { return }
        PerfLog.mark("voice.command ignored SIGTERM, killing")
        stream?.kill()
        do { try await Task.sleep(for: killGrace) } catch { return }
        guard runID == id, let completion = continuation else { return }
        PerfLog.mark("voice.command exit never arrived, answering the caller")
        continuation = nil
        runID += 1
        stream = nil
        gate = nil
        deadlineTask = nil
        let held = lease
        lease = nil
        do { try await held?.release() }
        catch { PerfLog.mark("voice.lease release \(error.localizedDescription)") }
        completion.resume(throwing: outcome)
    }

    public func cancel() {
        cancelled = true
        guard continuation != nil else { return }
        let id = runID
        deadlineTask?.cancel()
        deadlineTask = Task { [weak self] in await self?.terminate(id, outcome: CancellationError()) }
    }
}
