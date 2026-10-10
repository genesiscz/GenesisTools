import AppKit
import AVFoundation

public enum VoiceMicrophonePermission: Equatable, Sendable {
    case notDetermined, authorized, denied, restricted, unknown

    /// Through GenesisKit's permission module, so the denial simulation applies to Voice Notes too.
    public static var current: Self {
        switch PermissionAccess.live.status(.microphone) {
        case .notDetermined: return .notDetermined
        case .granted: return .authorized
        case .denied: return .denied
        case .restricted: return .restricted
        case .partial, .unknown: return .unknown
        }
    }

    public var guidance: String? {
        switch self {
        case .authorized: return nil
        case .notDetermined: return "Microphone access is needed. Press Record to review the macOS permission prompt."
        case .denied: return "Microphone access is off. Enable this app in System Settings → Privacy & Security → Microphone."
        case .restricted: return "Microphone access is restricted by this Mac's settings or administrator."
        case .unknown: return "Microphone permission could not be checked. Review Microphone settings before recording."
        }
    }

    @MainActor
    static func request() async throws -> Self {
        guard current == .notDetermined else { return current }
        let request = VoiceMicrophoneRequest()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                request.continuation = continuation
                request.timeout = Task { @MainActor in
                    try? await Task.sleep(for: .seconds(30))
                    guard !Task.isCancelled else { return }
                    request.finish(.success(.current))
                }
                Task { @MainActor in
                    _ = await PermissionAccess.live.request(.microphone)
                    request.finish(.success(.current))
                }
            }
        } onCancel: {
            Task { @MainActor in request.finish(.failure(CancellationError())) }
        }
    }
}

@MainActor
private final class VoiceMicrophoneRequest {
    var continuation: CheckedContinuation<VoiceMicrophonePermission, Error>?
    var timeout: Task<Void, Never>?
    func finish(_ result: Result<VoiceMicrophonePermission, Error>) {
        let completion = continuation
        continuation = nil
        timeout?.cancel()
        timeout = nil
        completion?.resume(with: result)
    }
}

public enum VoiceCommandFailure: String, Error, LocalizedError, Sendable {
    case microphonePermission = "microphone_permission"
    case noAudio = "no_audio"
    case interrupted = "capture_interrupted"
    case captureFailed = "capture_failed"
    case cancelled
    case operationFailed = "operation_failed"
    case timedOut = "timed_out"

    public var errorDescription: String? {
        switch self {
        case .microphonePermission: return "Microphone access is not available. Review Microphone settings, then try Record again."
        case .noAudio: return "No audio was recorded. Check your input device and try again."
        case .interrupted: return "Recording was interrupted before it could be saved. Try Record again."
        case .captureFailed: return "Audio capture failed. Check your input device and try again."
        case .cancelled: return "Recording cancelled. Existing notes are kept locally."
        case .operationFailed: return "The voice operation failed. Try again. Details are in the diagnostic log."
        case .timedOut: return "The voice operation took too long and was stopped. Try again."
        }
    }
}
