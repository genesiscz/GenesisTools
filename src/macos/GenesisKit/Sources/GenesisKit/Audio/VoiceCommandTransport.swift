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

    public init(binaryPath: String, stateRoot: String? = nil) {
        bridge = ToolsBridge(binaryPath: binaryPath)
        prefix = ["widget"] + (stateRoot.map { ["--state-root", $0] } ?? []) + ["voice-notes"]
    }

    public func run(args: [String], lease: (any VoiceRecordingLease)? = nil,
                    onEvent: @escaping (VoiceCommandEvent) -> Void = { _ in }) async throws -> Data {
        guard continuation == nil else { throw ToolsBridgeError.refused("A voice operation is already active") }
        self.lease = lease
        finalData = nil
        failure = nil
        cancelled = false
        receivedReady = false
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
                                        } catch {
                                            failure = error
                                            stream?.stop()
                                        }
                                    }
                                }
                                if event.kind == "recorded" || event.kind == "transcribed" { finalData = data }
                                onEvent(event)
                            }
                        }, onExit: { [self] report in
                            Task { [self] in
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
                                    completion?.resume(throwing: ToolsBridgeError.refused(String(report.stderr.suffix(1200))))
                                } else if let finalData { completion?.resume(returning: finalData) }
                                else { completion?.resume(throwing: ToolsBridgeError.refused("Voice operation ended without a saved note")) }
                            }
                        })
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

    public func finishRecording() { stream?.finishInput() }
    public func cancel() {
        cancelled = true
        stream?.stop()
    }
}
