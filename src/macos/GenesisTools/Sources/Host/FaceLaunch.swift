import AppKit
import Foundation

/// Starts another face of this app (`--hub`, `--review`, `--window`, `--features`, `--widget`) as a new instance
/// through Launch Services, never as a plain child `Process`.
///
/// Launch Services makes the face an app job of the login session, and launchd stops such a job when the session
/// ends. A plain child belongs to no job once its parent exits, and nothing stops it: on 2026-11-18 WindowServer
/// crashed at 08:36:46, the five faces Launch Services had started got SIGTERM, and the hub that the link relay had
/// started as a child (pid 14278) lived on with no WindowServer. It kept the hub lock, so every later open of the app
/// was handed to it, and no window appeared until it was killed at 15:29.
package enum FaceLaunch {
    /// Starts `arguments` and returns at once. `failed` runs on the main actor when the face did not start.
    /// `activates` defaults to true unless the arguments carry `--no-activate`.
    package static func start(_ arguments: [String], activates: Bool? = nil,
                              failed: @escaping @MainActor (Error) -> Void = { _ in }) {
        let report: @Sendable (Error) -> Void = { error in
            HubPerf.log("face: \(arguments.first ?? "") did not start: \(error.localizedDescription)")
            Task { @MainActor in failed(error) }
        }
        guard inBundle else {
            do {
                try startChild(arguments)
            } catch {
                report(error)
            }
            return
        }
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL,
                                           configuration: configuration(arguments, activates: activates)) { _, error in
            if let error {
                report(error)
            }
        }
    }

    /// For a face that has no NSApplication yet and exits right after: waits up to `timeout` for Launch Services.
    /// Returns the new instance's pid (0 outside a bundle, where it runs as a child), or the error.
    package static func startAndWait(_ arguments: [String], timeout: TimeInterval) -> Result<pid_t, Error> {
        guard inBundle else {
            return Result { try startChild(arguments) }
        }
        let answer = LaunchAnswer()
        let done = DispatchSemaphore(value: 0)
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL,
                                           configuration: configuration(arguments, activates: nil)) { app, error in
            answer.set(error.map { .failure($0) } ?? .success(app?.processIdentifier ?? 0))
            done.signal()
        }
        guard done.wait(timeout: .now() + timeout) == .success, let result = answer.value else {
            return .failure(CocoaError(.executableLoad, userInfo: [
                NSLocalizedDescriptionKey: "Launch Services did not answer within \(Int(timeout)) s",
            ]))
        }
        return result
    }

    /// A build run outside its bundle (`.build/debug/GenesisTools`) cannot be started by Launch Services.
    private static var inBundle: Bool {
        Bundle.main.bundlePath.hasSuffix(".app")
    }

    private static func configuration(_ arguments: [String], activates: Bool?) -> NSWorkspace.OpenConfiguration {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.arguments = arguments
        configuration.createsNewApplicationInstance = true
        configuration.activates = activates ?? !arguments.contains("--no-activate")
        // Launch Services gives a new instance launchd's bare environment; the face and its `tools` children need
        // this one (GENESIS_TOOLS_HOME, the login shell's PATH from ChildEnvironment).
        configuration.environment = ProcessInfo.processInfo.environment
        return configuration
    }

    @discardableResult
    private static func startChild(_ arguments: [String]) throws -> pid_t {
        guard let executable = Bundle.main.executableURL else {
            throw CocoaError(.executableNotLoadable)
        }
        let child = Process()
        child.executableURL = executable
        child.arguments = arguments
        try child.run()
        return child.processIdentifier
    }
}

private final class LaunchAnswer: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<pid_t, Error>?
    var value: Result<pid_t, Error>? { lock.withLock { result } }
    func set(_ value: Result<pid_t, Error>) { lock.withLock { result = value } }
}
