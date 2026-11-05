import Darwin
import Foundation

/// The recorder host: this app's connection to the recorder service (`tools recorder serve`, one TypeScript process
/// that owns the edit sessions). The host connects as a client, says `hello { role: "host" }` and then answers the
/// requests the service forwards to it (`RecorderHostMethods`): opening and listing windows, renders, the camera.
///
/// The service names its socket in `<recordings>/service.json` (`{ version, protocol, pid, socket, startedAt,
/// codeStamp }`). When no live service answers there, the host starts one and waits for its socket with a bounded,
/// slow retry. A dropped connection is tried again after a few seconds, longer after each failure in a row; a start
/// that keeps failing (an older `tools` without `serve`) is not repeated for the rest of the face's life.
@MainActor
final class RecorderServiceHost {
    /// The host the recorder face runs, for the code that tells the service about a change (`window.changed`).
    private(set) static var shared: RecorderServiceHost?

    static let protocolVersion = 1

    /// The recorder service's own error codes this side meets.
    enum Code {
        static let protocolMismatch = 1011
        static let hostTaken = 1012
        static let cameraDenied = 1014
        static let cameraBusy = 1015
    }

    struct Timing {
        /// After a dropped connection; doubled for each failure in a row, up to `maxRetry`.
        var retry: TimeInterval = 3
        var maxRetry: TimeInterval = 60
        /// How long a started service gets to open its socket, and the gaps between the looks.
        var socketWait: TimeInterval = 20
        var socketSteps: [TimeInterval] = [0.25, 0.5, 1]
        /// The least time between two starts of the service, and how many failed starts end the starting.
        var startThrottle: TimeInterval = 30
        var maxFailedStarts = 3
        var helloTimeout: TimeInterval = 5
    }

    enum State: Equatable {
        case idle
        case connecting
        case waitingForService
        /// `hello` was answered: the methods the service lists.
        case connected(methods: [String])
        case retrying(after: TimeInterval)
        case stopped
    }

    /// Starts `tools recorder serve`; calls `failed(status, logTail)` on the main thread when it exits early with an error.
    typealias ServiceStarter = (_ failed: @escaping (Int32, String) -> Void) throws -> Void

    let folder: URL
    private let methods: [String: LiveRecordingRPCClient.Handler]
    private let startService: ServiceStarter
    private let timing: Timing
    private let pid: Int32
    /// Runs after each successful `hello`, so the service hears the current state at once (`window.changed`).
    var onConnected: ((RecorderServiceHost) -> Void)?
    private(set) var state: State = .idle {
        didSet { if state != oldValue { onStateChange?(state) } }
    }
    var onStateChange: ((State) -> Void)?

    private var client: LiveRecordingRPCClient?
    /// Counts the attempts, so a timer of an earlier one does nothing.
    private var generation = 0
    private var failures = 0
    private var lastStart: Date?
    private var failedStarts = 0

    init(folder: URL, methods: [String: LiveRecordingRPCClient.Handler], timing: Timing = Timing(),
         pid: Int32 = ProcessInfo.processInfo.processIdentifier, startService: @escaping ServiceStarter) {
        self.folder = folder
        self.methods = methods
        self.timing = timing
        self.pid = pid
        self.startService = startService
    }

    /// The recorder face's host: `<genesis-tools root>/recordings`, the face's methods, `tools recorder serve`.
    /// Off with `defaults write com.genesiscz.genesistools recorder.serviceHost -bool NO` (or the launch argument
    /// `-recorder.serviceHost NO`); the face then keeps only editor-open.json and `camera.requested`.
    static func startForFace() {
        guard shared == nil, UserDefaults.standard.object(forKey: "recorder.serviceHost") as? Bool ?? true else { return }
        let host = RecorderServiceHost(folder: RecorderMenu.libraryFolder.deletingLastPathComponent(),
                                       methods: RecorderHostMethods.table(face: LiveRecorderFace())) { failed in
            try ToolsRunner.detached(["recorder", "serve"], onEarlyFailure: failed)
        }
        host.onConnected = { $0.notify("window.changed", params: EditorWindows.shared.openState()) }
        shared = host
        host.start()
    }

    func start() {
        guard state == .idle || state == .stopped else { return }
        attempt()
    }

    func stop() {
        generation += 1
        client?.onClose = nil
        client?.close()
        client = nil
        state = .stopped
    }

    /// Sends a notification to the service; dropped while not connected (the file fallbacks still hold the state).
    func notify(_ method: String, params: [String: Any]) {
        guard case .connected = state else { return }
        client?.notify(method, params: params)
    }

    // MARK: Connecting

    private var discovery: URL { folder.appendingPathComponent("service.json") }

    /// The socket `service.json` names, when its process still lives; nil when there is no live service.
    func discoveredSocket() -> String? {
        guard let data = try? Data(contentsOf: discovery),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        if let pid = (object["pid"] as? NSNumber)?.int32Value, pid > 0, kill(pid, 0) != 0, errno == ESRCH {
            HubPerf.log("recorder.host: service.json names pid \(pid), which is gone")
            return nil
        }
        guard let socket = object["socket"] as? String, !socket.isEmpty else { return nil }
        return socket
    }

    private func attempt() {
        generation += 1
        state = .connecting
        if let socket = discoveredSocket(), let connected = connect(socket) {
            handshake(connected)
            return
        }
        guard failedStarts < timing.maxFailedStarts else {
            retryLater()
            return
        }
        if let lastStart, Date().timeIntervalSince(lastStart) < timing.startThrottle {
            retryLater()
            return
        }
        lastStart = Date()
        let attempt = generation
        do {
            try startService { [weak self] status, tail in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.failedStarts += 1
                    HubPerf.log("recorder.host: tools recorder serve exited \(status) (start \(self.failedStarts) of \(self.timing.maxFailedStarts)): \(tail.suffix(300))")
                    if self.generation == attempt, self.state == .waitingForService { self.retryLater() }
                }
            }
        } catch {
            failedStarts += 1
            HubPerf.log("recorder.host: could not start tools recorder serve: \(error.localizedDescription)")
            retryLater()
            return
        }
        HubPerf.log("recorder.host: started tools recorder serve; waiting for its socket")
        state = .waitingForService
        waitForSocket(attempt: attempt, step: 0, deadline: Date().addingTimeInterval(timing.socketWait))
    }

    /// A slow look at `service.json` and the socket: the steps, then once per its last gap, until the deadline.
    private func waitForSocket(attempt: Int, step: Int, deadline: Date) {
        let delay = timing.socketSteps[min(step, timing.socketSteps.count - 1)]
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.generation == attempt, self.state == .waitingForService else { return }
                if let socket = self.discoveredSocket(), let connected = self.connect(socket) {
                    self.handshake(connected)
                } else if Date() < deadline {
                    self.waitForSocket(attempt: attempt, step: step + 1, deadline: deadline)
                } else {
                    HubPerf.log("recorder.host: the service opened no socket in \(Int(self.timing.socketWait)) s")
                    self.retryLater()
                }
            }
        }
    }

    private func connect(_ socket: String) -> LiveRecordingRPCClient? {
        let client = LiveRecordingRPCClient(path: socket)
        for (method, handler) in methods {
            client.answer(method, with: handler)
        }
        do {
            try client.connect()
            return client
        } catch {
            HubPerf.log("recorder.host: \(socket) refused: \(error.localizedDescription)")
            return nil
        }
    }

    private func handshake(_ connected: LiveRecordingRPCClient) {
        let attempt = generation
        client = connected
        connected.onClose = { [weak self, weak connected] in
            MainActor.assumeIsolated {
                guard let self, let connected, self.client === connected else { return }
                self.client = nil
                HubPerf.log("recorder.host: the service closed the connection")
                self.retryLater()
            }
        }
        let hello: [String: Any] = ["role": "host", "protocol": Self.protocolVersion, "pid": Int(pid), "answers": connected.answers]
        connected.call("hello", params: hello, timeout: timing.helloTimeout) { [weak self] result in
            MainActor.assumeIsolated {
                guard let self, self.generation == attempt, self.client === connected else { return }
                switch result {
                case let .success(answer):
                    let reply = answer as? [String: Any]
                    let theirs = (reply?["protocol"] as? NSNumber)?.intValue
                    guard theirs == Self.protocolVersion else {
                        HubPerf.log("recorder.host: the service speaks protocol \(theirs.map(String.init) ?? "?"), this host \(Self.protocolVersion)")
                        self.drop(connected, retryAfter: self.timing.maxRetry)
                        return
                    }
                    self.failures = 0
                    self.failedStarts = 0
                    let methods = reply?["methods"] as? [String] ?? []
                    self.state = .connected(methods: methods)
                    HubPerf.log("recorder.host: connected (service \(reply?["version"] ?? "?"), \(methods.count) methods; answering \(connected.answers.count))")
                    self.onConnected?(self)
                case let .failure(error):
                    let code: Int? = if case let LiveRecordingRPCClient.Failure.remote(code, _) = error { code } else { nil }
                    HubPerf.log("recorder.host: hello refused: \(error.localizedDescription)")
                    // Another host holds the service, or it speaks another protocol: look again much later.
                    let later = code == Code.hostTaken || code == Code.protocolMismatch
                    self.drop(connected, retryAfter: later ? self.timing.maxRetry : nil)
                }
            }
        }
    }

    private func drop(_ connected: LiveRecordingRPCClient, retryAfter delay: TimeInterval?) {
        connected.onClose = nil
        connected.close()
        if client === connected { client = nil }
        retryLater(after: delay)
    }

    private func retryLater(after fixed: TimeInterval? = nil) {
        failures += 1
        let delay = fixed ?? min(timing.maxRetry, timing.retry * pow(2, Double(failures - 1)))
        generation += 1
        let attempt = generation
        state = .retrying(after: delay)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.generation == attempt else { return }
                self.attempt()
            }
        }
    }
}
