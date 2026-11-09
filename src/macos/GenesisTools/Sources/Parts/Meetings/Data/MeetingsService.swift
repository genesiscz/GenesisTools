import Darwin
import Foundation

// MARK: - The interface: a Swift mirror of `meetingsApi` (src/meetings/lib/service/api.ts)

/// One method of the Meetings service with its params and its result as Swift types. The protocol fixture
/// (src/meetings/lib/service/__fixtures__/meetings-protocol.json) holds a real request and reply of each, and
/// MeetingsServiceTests decodes them with these types, so the two sides cannot drift without a red test.
protocol MeetingsServiceMethod {
    associatedtype Params: Codable & Equatable
    associatedtype Result: Decodable
    static var name: String { get }
}

/// The Meetings service's methods, events and refusals as this side reads them. Only what the window calls is here; a
/// method the service adds reaches the window when its type is added (Wave B: the decisions, the moments).
enum MeetingsAPI {
    /// `MEETINGS_PROTOCOL`: a service that speaks another one refuses the hello with `protocol-mismatch`.
    static let protocolVersion = 1
    /// `MEETINGS_REFUSED`: the JSON-RPC error code of every refusal; its `data.code` says which one.
    static let refusedCode = 1100

    /// A refusal's `data`.
    struct ErrorData: Decodable, Equatable { let code: String }

    /// The refusals that are about the connection, not the call: the service will not answer this connection (another
    /// protocol, its code is changing and it exits soon, a call before the hello). The command answers then.
    static let connectionRefusals: Set<String> = ["no-hello", "protocol-mismatch", "code-mismatch"]

    /// A meeting by an exact id, a unique prefix, `last` or `wisprflow:<id>`.
    struct MeetingRef: Codable, Equatable { var ref: String }

    enum Hello: MeetingsServiceMethod {
        static let name = "hello"

        struct Params: Codable, Equatable {
            enum Role: String, Codable { case window, cli, listen, agent }
            var role: Role
            /// The agent harness behind the caller; the window has none.
            var harness: String?
            var session: String?
            var `protocol`: Int
            /// The caller's code stamp; the window runs no TypeScript and sends none.
            var code: String?
            var pid: Int?
        }

        struct Result: Decodable, Equatable {
            let `protocol`: Int
            let code: String
            let methods: [String]
            let events: [String]
            let version: String
        }
    }

    /// `meetings.list`: the list rows, as `list --json` prints them.
    enum List: MeetingsServiceMethod {
        static let name = "meetings.list"

        struct Params: Codable, Equatable {
            var project: String?
            var limit: Int?
        }

        typealias Result = [MeetingListRow]
    }

    /// `meetings.list` with `full: true`: the whole records, as `list --json --full` prints them.
    enum ListRecords: MeetingsServiceMethod {
        static let name = "meetings.list"

        struct Params: Codable, Equatable {
            var project: String?
            var limit: Int?
            var full = true
        }

        typealias Result = [MeetingRecordView]
    }

    /// `meeting.show`: one record, as `show <meeting> --json` prints it.
    enum Show: MeetingsServiceMethod {
        static let name = "meeting.show"
        typealias Params = MeetingRef
        typealias Result = MeetingRecordView
    }

    /// `meeting.transcript`: the corrected transcript, as `transcript <meeting> --format json` prints it.
    enum Transcript: MeetingsServiceMethod {
        static let name = "meeting.transcript"

        struct Params: Codable, Equatable {
            var ref: String
            /// Also apply the suggested items at or above the apply bar (a preview).
            var withSuggested: Bool?
            /// False leaves the dictionary out.
            var dictionary: Bool?
        }

        typealias Result = MeetingTranscript
    }

    /// `meeting.revisions`: one token per window part, as `revisions <meeting> --json` prints it.
    enum Revisions: MeetingsServiceMethod {
        static let name = "meeting.revisions"
        typealias Params = MeetingRef
        typealias Result = MeetingRevisions
    }

    /// `subscribe` (answered by the transport): the connection hears these events from now on. One subscription per
    /// connection; a second replaces the first.
    enum Subscribe: MeetingsServiceMethod {
        static let name = "subscribe"

        struct Params: Codable, Equatable {
            /// Only this meeting's events (an exact id); nil: every meeting's.
            var meeting: String?
            /// Only these events; nil or empty: all of them.
            var events: [String]?
        }

        struct Result: Decodable, Equatable { let events: [String] }
    }

    /// `meeting.changed`: a meeting's files changed; `parts` are the window parts whose revision token would differ
    /// now (`show`, `transcript`, `speakers`, `timeline`). Kept as text, so a part the service adds later still arrives.
    struct MeetingChanged: Codable, Equatable {
        static let name = "meeting.changed"
        let meeting: String
        let parts: [String]
    }
}

/// One meeting as `list --json` prints it (`meetingListRowSchema`).
struct MeetingListRow: Decodable, Equatable {
    struct Counts: Decodable, Equatable { let suggested: Int; let confirmed: Int; let rejected: Int }
    struct Recording: Decodable, Equatable { let status: String?; let frames: Double; let bytes: Double }

    let id: String
    let title: String
    let start: String
    let end: String?
    let project: String?
    let labels: [String]
    let sources: [String]
    let context: Int
    let items: Counts
    let recording: Recording?
}

// MARK: - The connection

/// The Meetings window's connection to the Meetings service (`tools meetings serve`, src/meetings/lib/service/): one
/// TypeScript process that owns the meetings store while it runs and answers typed reads over a Unix socket, with no
/// `tools` process per read. The service names its socket in `<genesis-tools>/meetings-service/service.json`.
///
/// The window says `hello { role: "window" }` once per connection. A read the service does not answer (no service
/// runs, it is starting, it refused the connection, it dropped it, or it timed out) runs as the `tools meetings`
/// command instead (`MeetingsRead`), which prints the same JSON; so the window works the same with the service up,
/// down or changing. When no service answers, this side starts one in the background through the launcher
/// (`tools meetings serve --detach`), at most once per `startThrottle`; the read that found none does not wait for it.
/// A service whose code is changing refuses the hello with `code-mismatch` and exits within a minute: the window looks
/// again only after `refusedBackoff`. The connection closes after `idleClose` with no call and no subscription, so the
/// service can exit when it is idle. A kept subscription keeps a connection: when it closes, this side connects again
/// by itself (`resumeSubscription`).
@MainActor
final class MeetingsService {
    /// The window's service: nil in the preview build and under XCTest, for a sandbox home (`GENESIS_TOOLS_HOME`) and
    /// a worktree's `tools` (`GENESIS_TOOLS_BIN`), whose reads must not reach a service of the main checkout (the same
    /// rule as the hub server's meetings door, `MeetingsCLI.server`), and when it is turned off with
    /// `GENESIS_MEETINGS_SERVICE=0` or `defaults write com.genesiscz.genesistools meetings.service -bool NO`. Every
    /// read then runs as a command, as before.
    static let shared: MeetingsService? = {
        let environment = ProcessInfo.processInfo.environment
        guard !NativePreview.enabled, NSClassFromString("XCTestCase") == nil,
              environment["GENESIS_MEETINGS_SERVICE"] != "0",
              environment["GENESIS_TOOLS_HOME"] == nil, environment["GENESIS_TOOLS_BIN"] == nil,
              UserDefaults.standard.object(forKey: "meetings.service") as? Bool ?? true else { return nil }
        return MeetingsService(folder: URL(fileURLWithPath: genesisHome()).appendingPathComponent(".genesis-tools/meetings-service"))
    }()

    struct Timing {
        var helloTimeout: TimeInterval = 3
        /// The least time between two starts of the service.
        var startThrottle: TimeInterval = 30
        /// After `maxFailedStarts` failed starts in a row (a `tools` without `serve`, a source file caught half edited),
        /// the least time between two more. Never given up: a later start may work.
        var maxFailedStarts = 3
        var failedStartRetry: TimeInterval = 300
        /// After the service refused this connection (another protocol, its code is changing): no look before this.
        var refusedBackoff: TimeInterval = 60
        /// The connection closes after this long with no call and no subscription.
        var idleClose: TimeInterval = 120
        /// A kept subscription with no connection looks again after this long, then twice as long each time, up to
        /// `refusedBackoff`.
        var reconnectDelay: TimeInterval = 1
    }

    enum State: Equatable {
        case idle
        case connecting
        /// `hello` was answered: the methods and events the service lists.
        case connected(methods: [String], events: [String])
    }

    /// The service did not answer the call; the caller runs the command instead.
    struct Unavailable: Error, Equatable, CustomStringConvertible {
        let reason: String
        var description: String { reason }
    }

    /// Starts the service; returns once it listens (`tools meetings serve --detach` prints its service.json then).
    typealias ServiceStarter = @MainActor () async throws -> Void

    let folder: URL
    private let timing: Timing
    private let pid: Int32
    private let startService: ServiceStarter
    /// Every answer and notification is decoded here, off the main thread: a transcript can be long.
    private let callbackQueue = DispatchQueue(label: "genesis.meetings.service")

    private(set) var state: State = .idle
    private var client: JSONRPCSocketClient?
    private var connecting: Task<JSONRPCSocketClient?, Never>?
    private var refusedUntil: Date?
    private var lastStart: Date?
    private var failedStarts = 0
    private var starting: Task<Void, Never>?
    private var subscription: MeetingsAPI.Subscribe.Params?
    /// Connects again while a subscription is kept and no connection is open (`resumeSubscription`).
    private var resuming: Task<Void, Never>?
    private var callsInFlight = 0
    private var idleGeneration = 0

    /// A `meeting.changed` the subscription hears, on the main actor.
    var onMeetingChanged: ((MeetingsAPI.MeetingChanged) -> Void)?
    /// The kept subscription was sent again on a new connection, on the main actor. Events between the two connections
    /// were not heard, so the subscriber reads what it shows again (its revisions).
    var onSubscriptionResumed: (() -> Void)?

    init(folder: URL, timing: Timing = Timing(), pid: Int32 = ProcessInfo.processInfo.processIdentifier,
         startService: @escaping ServiceStarter = { _ = try await MeetingsCLI.run(["serve", "--detach"], timeoutSeconds: 60) }) {
        self.folder = folder
        self.timing = timing
        self.pid = pid
        self.startService = startService
    }

    /// Calls one method. Throws `Unavailable` when the service does not answer it or answers a shape this app cannot
    /// decode (the caller runs the command), the
    /// `MeetingsCLI.Failure` the command would have thrown when the service refuses it (its `code` is the refusal's
    /// `data.code`, `no-transcript-source` and the like), and `CancellationError` when the task was cancelled (the
    /// service hears `$/cancel`).
    func call<M: MeetingsServiceMethod>(_ method: M.Type, _ params: M.Params, timeout: TimeInterval = 60) async throws -> M.Result {
        guard let client = await connection() else {
            throw Unavailable(reason: "no Meetings service answers")
        }
        callsInFlight += 1
        defer {
            callsInFlight -= 1
            scheduleIdleClose()
        }
        let span = HubPerf.begin("meetings.service", M.name)
        do {
            let result = try await Self.send(method, params, on: client, timeout: timeout)
            span.end()
            return result
        } catch {
            span.end("failed")
            throw failure(of: M.name, error, on: client)
        }
    }

    /// From now on the connection hears these events (on `onMeetingChanged`). The subscription is kept: while no
    /// connection is open (the service hung up, exited on a code change, was not running yet), this side connects
    /// again by itself and sends it, then calls `onSubscriptionResumed`. Throws `Unavailable` while no service answers.
    @discardableResult
    func subscribe(meeting: String? = nil, events: [String]? = nil) async throws -> [String] {
        let params = MeetingsAPI.Subscribe.Params(meeting: meeting, events: events)
        // The connection opens before the subscription is kept: a new connection sends a kept one by itself, and this
        // call would send it a second time.
        let connected = await connection()
        subscription = params
        guard connected != nil else {
            resumeSubscription()
            throw Unavailable(reason: "no Meetings service answers; the next connection subscribes")
        }
        return try await call(MeetingsAPI.Subscribe.self, params, timeout: timing.helloTimeout).events
    }

    /// Forgets the subscription and closes the connection: the transport has no unsubscribe.
    func unsubscribe() {
        subscription = nil
        resuming?.cancel()
        resuming = nil
        disconnect()
    }

    /// Closes the connection; the next call opens a new one, and a kept subscription opens one by itself.
    func disconnect() {
        guard let client else { return }
        drop(client)
    }

    // MARK: Errors

    /// What a failed call throws: `Unavailable` (the command answers), the command's `MeetingsCLI.Failure` for a
    /// refusal, or `CancellationError`.
    private func failure(of method: String, _ error: Error, on client: JSONRPCSocketClient) -> Error {
        if Task.isCancelled || error is CancellationError { return CancellationError() }
        switch error {
        case let remote as JSONRPCSocketClient.RemoteError:
            if remote.code == JSONRPCSocketClient.Code.cancelled { return CancellationError() }
            guard remote.code == MeetingsAPI.refusedCode, let code = remote.decodeData(MeetingsAPI.ErrorData.self)?.code else {
                // Not a refusal (an older service without the method, params it does not take): the command answers.
                HubPerf.log("meetings.service: \(method) answered \(remote.code) \(remote.message); the command answers it")
                return Unavailable(reason: "\(method) answered \(remote.code): \(remote.message)")
            }
            if MeetingsAPI.connectionRefusals.contains(code) {
                HubPerf.log("meetings.service: \(method) refused the connection [\(code)] \(remote.message)")
                drop(client, backoff: code == "no-hello" ? nil : timing.refusedBackoff)
                return Unavailable(reason: "[\(code)] \(remote.message)")
            }
            return MeetingsCLI.Failure(sentence: MeetingsCLI.sentence(fromStderr: remote.message) ?? "The Meetings service refused it.",
                                       detail: "The Meetings service refused \(method) [\(code)]:\n\(remote.message)", code: code)
        case let failure as JSONRPCSocketClient.Failure:
            // A service that does not answer in time may hang: the next call opens a new connection.
            if case .timeout = failure { drop(client) }
            return Unavailable(reason: "\(method): \(failure.localizedDescription)")
        case let decoding as DecodeFailure:
            // A service this app cannot read (another checkout or version: the window's hello names no code) is not the
            // answer. The command answers, as with no service, and shows its own format error when it cannot be read
            // either; this service is not asked again before the backoff.
            HubPerf.log("meetings.service: \(method) answered a shape the window cannot read (\(decoding.error)); "
                + "the command answers it: \(decoding.preview.prefix(300))")
            drop(client, backoff: timing.refusedBackoff)
            return Unavailable(reason: "\(method): the answer does not decode")
        default:
            return Unavailable(reason: "\(method): \(error)")
        }
    }

    /// An answer that does not decode as the method's result.
    struct DecodeFailure: Error {
        let error: Error
        let preview: String
    }

    // MARK: Connecting

    private var discovery: URL { folder.appendingPathComponent("service.json") }

    /// The socket `service.json` names, when its process still lives; nil when there is no live service.
    func discoveredSocket() -> String? {
        guard let data = try? Data(contentsOf: discovery),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let socket = object["socket"] as? String, !socket.isEmpty else { return nil }
        if let pid = (object["pid"] as? NSNumber)?.int32Value, pid > 0, kill(pid, 0) != 0, errno == ESRCH { return nil }
        return socket
    }

    /// The connection, after its hello; nil when no service answers now. Calls that arrive while it opens wait for it.
    private func connection() async -> JSONRPCSocketClient? {
        if let client, case .connected = state { return client }
        if let refusedUntil, Date() < refusedUntil { return nil }
        if let connecting { return await connecting.value }
        let task = Task { await self.connect() }
        connecting = task
        let connected = await task.value
        connecting = nil
        return connected
    }

    private func connect() async -> JSONRPCSocketClient? {
        state = .connecting
        guard let socket = discoveredSocket() else {
            state = .idle
            startInBackground(because: "no live service in \(discovery.path)")
            return nil
        }
        let candidate = JSONRPCSocketClient(path: socket, callbackQueue: callbackQueue)
        do {
            try candidate.connect()
        } catch {
            state = .idle
            startInBackground(because: "\(socket) refused: \(error.localizedDescription)")
            return nil
        }
        let hello = MeetingsAPI.Hello.Params(role: .window, protocol: MeetingsAPI.protocolVersion, pid: Int(pid))
        do {
            let answer = try await Self.send(MeetingsAPI.Hello.self, hello, on: candidate, timeout: timing.helloTimeout)
            guard answer.protocol == MeetingsAPI.protocolVersion else {
                HubPerf.log("meetings.service: the service speaks protocol \(answer.protocol), the window \(MeetingsAPI.protocolVersion)")
                candidate.close()
                refusedUntil = Date().addingTimeInterval(timing.refusedBackoff)
                state = .idle
                return nil
            }
            attach(candidate, hello: answer)
            return candidate
        } catch {
            candidate.close()
            state = .idle
            let refusal = (error as? JSONRPCSocketClient.RemoteError)?.decodeData(MeetingsAPI.ErrorData.self)?.code
            HubPerf.log("meetings.service: hello failed (\(refusal ?? "no answer")): \(error.localizedDescription)")
            if let refusal, MeetingsAPI.connectionRefusals.contains(refusal) {
                refusedUntil = Date().addingTimeInterval(timing.refusedBackoff)
            }
            return nil
        }
    }

    /// The connection answered its hello: its notifications and its close reach this side, and a kept subscription is
    /// sent again.
    private func attach(_ connected: JSONRPCSocketClient, hello: MeetingsAPI.Hello.Result) {
        client = connected
        refusedUntil = nil
        state = .connected(methods: hello.methods, events: hello.events)
        connected.onClose = { [weak self, weak connected] in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self, let connected, self.client === connected else { return }
                    HubPerf.log("meetings.service: the service closed the connection")
                    self.client = nil
                    self.state = .idle
                    self.resumeSubscription()
                }
            }
        }
        connected.onNotification = { [weak self] method, params in
            // On the callback queue: decode here, deliver on the main actor.
            guard method == MeetingsAPI.MeetingChanged.name,
                  let changed = try? Self.decode(MeetingsAPI.MeetingChanged.self, params) else { return }
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.onMeetingChanged?(changed) }
            }
        }
        HubPerf.log("meetings.service: connected (service \(hello.version), \(hello.methods.count) methods)")
        if let subscription {
            Task {
                do {
                    _ = try await Self.send(MeetingsAPI.Subscribe.self, subscription, on: connected, timeout: timing.helloTimeout)
                    onSubscriptionResumed?()
                } catch {
                    HubPerf.log("meetings.service: subscribe again failed: \(error.localizedDescription)")
                }
            }
        }
        scheduleIdleClose()
    }

    private func drop(_ dropped: JSONRPCSocketClient, backoff: TimeInterval? = nil) {
        dropped.onClose = nil
        dropped.onNotification = nil
        dropped.close()
        if client === dropped {
            client = nil
            state = .idle
        }
        if let backoff { refusedUntil = Date().addingTimeInterval(backoff) }
        resumeSubscription()
    }

    /// While a subscription is kept and no connection is open, connects again by itself: after `reconnectDelay`, then
    /// twice as long each time up to `refusedBackoff`, never before a refusal's backoff ends. `connection()` starts the
    /// service when none runs, and `attach` sends the kept subscription. Nothing else would connect: the window reads
    /// on events, not on a timer.
    private func resumeSubscription() {
        guard subscription != nil, client == nil, resuming == nil else { return }
        let first = timing.reconnectDelay
        resuming = Task { [weak self] in
            var delay = first
            while true {
                let refused = self?.refusedUntil?.timeIntervalSinceNow ?? 0
                try? await Task.sleep(for: .seconds(max(delay, refused)))
                // Cancelled: `unsubscribe` cleared `resuming` itself, and a later subscription may own it now.
                guard let self, !Task.isCancelled else { return }
                var done = self.subscription == nil || self.client != nil
                if !done { done = await self.connection() != nil }
                guard !Task.isCancelled else { return }
                if done {
                    self.resuming = nil
                    // A connection that closed again before this line got no new look from its close: give it one.
                    self.resumeSubscription()
                    return
                }
                delay = min(delay * 2, self.timing.refusedBackoff)
            }
        }
    }

    /// Starts the service in the background, at most once per `startThrottle`; the next call finds it.
    private func startInBackground(because reason: String) {
        guard starting == nil else { return }
        let throttle = failedStarts < timing.maxFailedStarts ? timing.startThrottle : timing.failedStartRetry
        if let lastStart, Date().timeIntervalSince(lastStart) < throttle { return }
        lastStart = Date()
        HubPerf.log("meetings.service: starting tools meetings serve (\(reason))")
        starting = Task { [weak self] in
            guard let start = self?.startService else { return }
            do {
                try await start()
                self?.failedStarts = 0
                HubPerf.log("meetings.service: tools meetings serve --detach returned; the next read connects")
            } catch {
                self?.failedStarts += 1
                HubPerf.log("meetings.service: tools meetings serve --detach failed (\(self?.failedStarts ?? 0) in a row): \(error)")
            }
            self?.starting = nil
        }
    }

    /// Closes an idle connection: no call in flight, no subscription and no call for `idleClose`.
    private func scheduleIdleClose() {
        idleGeneration += 1
        let generation = idleGeneration
        DispatchQueue.main.asyncAfter(deadline: .now() + timing.idleClose) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.idleGeneration == generation, self.callsInFlight == 0, self.subscription == nil,
                      let client = self.client else { return }
                HubPerf.log("meetings.service: idle for \(Int(self.timing.idleClose)) s; closing the connection")
                self.drop(client)
            }
        }
    }

    // MARK: Wire

    /// One request on `client`: the params encoded, the answer decoded off the main thread, a cancelled task's
    /// request cancelled on the wire. Errors come back as the transport made them (`RemoteError` with its data).
    private static func send<M: MeetingsServiceMethod>(_ method: M.Type, _ params: M.Params, on client: JSONRPCSocketClient,
                                                      timeout: TimeInterval) async throws -> M.Result {
        let object = try paramsObject(params)
        let pending = PendingRequest()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let id = client.request(M.name, params: object, timeout: timeout, errorData: true) { result in
                    switch result {
                    case let .success(value):
                        do {
                            continuation.resume(returning: try decode(M.Result.self, value))
                        } catch {
                            continuation.resume(throwing: DecodeFailure(error: error, preview: preview(value)))
                        }
                    case let .failure(error):
                        continuation.resume(throwing: error)
                    }
                }
                pending.started(id) { client.cancel(id) }
            }
        } onCancel: {
            pending.cancel()
        }
    }

    /// The params as the JSON object the transport sends; nil members are left out, as the strict schemas want.
    nonisolated static func paramsObject<P: Encodable>(_ params: P) throws -> [String: Any] {
        let data = try JSONEncoder().encode(params)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw EncodingError.invalidValue(params, .init(codingPath: [], debugDescription: "params must be a JSON object"))
        }
        return object
    }

    nonisolated static func decode<T: Decodable>(_ type: T.Type, _ value: Any?) throws -> T {
        let data = try JSONSerialization.data(withJSONObject: value ?? NSNull(), options: [.fragmentsAllowed])
        return try JSONDecoder().decode(T.self, from: data)
    }

    private nonisolated static func preview(_ value: Any?) -> String {
        guard let value, let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]) else { return "null" }
        return String(decoding: data.prefix(1500), as: UTF8.self)
    }
}

/// A request's id once it is on the wire, so a cancel that came first still reaches it.
private final class PendingRequest: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelWire: (() -> Void)?
    private var cancelled = false

    func started(_ id: Int, cancel: @escaping () -> Void) {
        lock.lock()
        let already = cancelled
        if !already { cancelWire = cancel }
        lock.unlock()
        if already { cancel() }
    }

    func cancel() {
        lock.lock()
        cancelled = true
        let wire = cancelWire
        cancelWire = nil
        lock.unlock()
        wire?()
    }
}

// MARK: - The window's reads

/// One read of the window: the Meetings service method that answers it when the service runs, and the `tools meetings`
/// command that prints the same JSON otherwise. A refusal of the service throws what the command would (the same
/// sentence and code), so a pane shows the same state either way.
struct MeetingsRead<Value: Decodable> {
    /// The command's argv after `tools meetings`.
    let args: [String]
    let timeoutSeconds: Int
    /// The service method; nil for a read the service does not answer yet (it runs as the command).
    let method: String?
    private let viaService: (@MainActor (MeetingsService) async throws -> Value)?
    /// The command, `MeetingsCLI.json` with `args`. Made here, outside the main actor, so the decoding runs off it.
    private let viaCommand: () async throws -> Value

    private init(args: [String], timeoutSeconds: Int, method: String?,
                 viaService: (@MainActor (MeetingsService) async throws -> Value)?) {
        self.args = args
        self.timeoutSeconds = timeoutSeconds
        self.method = method
        self.viaService = viaService
        viaCommand = { try await MeetingsCLI.json(Value.self, args, timeoutSeconds: timeoutSeconds) }
    }

    /// A read only the command answers.
    static func command(_ args: [String], timeoutSeconds: Int = 60) -> MeetingsRead {
        MeetingsRead(args: args, timeoutSeconds: timeoutSeconds, method: nil, viaService: nil)
    }

    /// A read the service answers with `method`, and the command `args` otherwise.
    static func service<M: MeetingsServiceMethod>(_ method: M.Type, _ params: M.Params, orRun args: [String],
                                                  timeoutSeconds: Int = 60) -> MeetingsRead where M.Result == Value {
        MeetingsRead(args: args, timeoutSeconds: timeoutSeconds, method: M.name) { service in
            try await service.call(method, params, timeout: TimeInterval(timeoutSeconds))
        }
    }

    /// Runs the read through the window's service (`MeetingsService.shared`) when it answers, else as the command.
    @MainActor
    func run() async throws -> Value {
        try await run(service: MeetingsService.shared)
    }

    /// Runs the read through `service` when it answers, else as the command (`command` when given: a test passes one
    /// that records its argv).
    @MainActor
    func run(service: MeetingsService?, command: (([String], Int) async throws -> Value)? = nil) async throws -> Value {
        if let service, let viaService {
            do {
                return try await viaService(service)
            } catch is MeetingsService.Unavailable {
                try Task.checkCancellation()
            }
        }
        if let command { return try await command(args, timeoutSeconds) }
        return try await viaCommand()
    }
}
