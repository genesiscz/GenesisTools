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

    enum WordTimings: MeetingsServiceMethod {
        static let name = "meeting.wordTimings.generate"
        struct Params: Codable, Equatable {
            let ref: String
            let fromSec: Double
            let toSec: Double
            let model: String
            var language: String?
        }
        struct Result: Decodable, Equatable {
            struct Coverage: Decodable, Equatable {
                let eligibleWords: Int
                let matchedWords: Int
            }
            let meeting: String
            let cacheRevision: String
            let reused: Bool
            let coverage: Coverage
        }
    }

    struct WordTimingsChanged: Decodable, Equatable {
        static let name = "meeting.wordTimings.changed"
        let meeting: String
        let revision: String
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
    /// A decision through the service sends `decision.applied` instead; a write outside it (the recorder, an import, a
    /// hand edit) sends this one, at most once per meeting per 300 ms.
    struct MeetingChanged: Codable, Equatable {
        static let name = "meeting.changed"
        let meeting: String
        let parts: [String]
    }

    /// `meetings.overview`: the meetings of the last days with what each waits for, as `overview --json` prints it.
    enum Overview: MeetingsServiceMethod {
        static let name = "meetings.overview"

        struct Params: Codable, Equatable { var days: Int? }

        typealias Result = MeetingsOverview
    }

    /// `config.read`: the meetings config file's path and the value at a dotted path (the whole config without one).
    enum ConfigRead: MeetingsServiceMethod {
        static let name = "config.read"

        struct Params: Codable, Equatable { var path: String? }

        struct Result: Decodable, Equatable {
            let path: String
            let value: JSONValue
        }
    }

    /// `config.read` without a path, as the window's settings read it: the whole config, the `config show --json` shape.
    enum ConfigShowRead: MeetingsServiceMethod {
        static let name = "config.read"
        typealias Params = ConfigRead.Params
        typealias Result = ConfigShow
    }

    /// `meeting.speakers` as the Speakers tab reads it: the `speakers stats --json` shape (the spans are TL's).
    enum SpeakerStatsRead: MeetingsServiceMethod {
        static let name = "meeting.speakers"
        typealias Params = MeetingSpeakers.Params
        typealias Result = SpeakerStats
    }

    /// What `config.set` and `config.unset` answer: the path as segments and the value now.
    struct ConfigChange: Decodable, Equatable {
        let path: [String]
        let value: JSONValue
    }

    /// `config.set`: one meetings config value; `expect` refuses it with `config-stale` when another editor changed it.
    enum ConfigSet: MeetingsServiceMethod {
        static let name = "config.set"

        struct Params: Codable, Equatable {
            var path: String
            var value: JSONValue
            var expect: JSONValue?
        }

        typealias Result = ConfigChange
    }

    /// `config.unset`: one meetings config value back to its default.
    enum ConfigUnset: MeetingsServiceMethod {
        static let name = "config.unset"

        struct Params: Codable, Equatable {
            var path: String
            var expect: JSONValue?
        }

        typealias Result = ConfigChange
    }

    /// Every event the window hears, decoded by name. A name this table does not know is dropped.
    static let eventDecoders: [String: (Any?) throws -> MeetingsEvent] = [
        MeetingChanged.name: { .meetingChanged(try MeetingsService.decode(MeetingChanged.self, $0)) },
        DecisionApplied.name: { .decisionApplied(try MeetingsService.decode(DecisionApplied.self, $0)) },
        DecisionReverted.name: { .decisionReverted(try MeetingsService.decode(DecisionReverted.self, $0)) },
        CommentSent.name: { .commentSent(try MeetingsService.decode(CommentSent.self, $0)) },
        CommentChanged.name: { .commentChanged(try MeetingsService.decode(CommentChanged.self, $0)) },
        PeopleChanged.name: { .peopleChanged(try MeetingsService.decode(PeopleChanged.self, $0)) },
        WordTimingsChanged.name: { .wordTimingsChanged(try MeetingsService.decode(WordTimingsChanged.self, $0)) },
    ]

    /// The events the window subscribes to.
    struct PeopleChanged: Decodable, Equatable {
        static let name = "people.changed"
    }

    static let windowEvents = [MeetingChanged.name, DecisionApplied.name, DecisionReverted.name, CommentSent.name, CommentChanged.name, PeopleChanged.name, WordTimingsChanged.name]
}

/// One event of the Meetings service, as the window hears it.
enum MeetingsEvent: Equatable {
    case meetingChanged(MeetingsAPI.MeetingChanged)
    case decisionApplied(MeetingsAPI.DecisionApplied)
    case decisionReverted(MeetingsAPI.DecisionReverted)
    case commentSent(MeetingsAPI.CommentSent)
    case commentChanged(MeetingsAPI.CommentChanged)
    case peopleChanged(MeetingsAPI.PeopleChanged)
    case wordTimingsChanged(MeetingsAPI.WordTimingsChanged)

    /// The meeting the event is about.
    var meeting: String? {
        switch self {
        case .meetingChanged(let event): return event.meeting
        case .wordTimingsChanged(let event): return event.meeting
        case .decisionApplied(let event): return event.meeting
        case .decisionReverted(let event): return event.meeting
        case .commentSent(let event): return event.meeting
        case .commentChanged(let event): return event.meeting
        case .peopleChanged: return nil
        }
    }

    /// The journal entry of a decision event.
    var entry: JournalEntry? {
        switch self {
        case .decisionApplied(let event): return event.entry
        case .decisionReverted(let event): return event.entry
        case .meetingChanged, .commentSent, .commentChanged, .peopleChanged, .wordTimingsChanged: return nil
        }
    }
}

/// What a listener of the service hears: an event, the kept subscription sent again on a new connection (events between
/// the connections were not heard: read again), or the connection of a kept subscription lost (no event arrives until
/// it resumes).
enum MeetingsServiceSignal: Equatable {
    case event(MeetingsEvent)
    case resumed
    case lost
}

extension JSONValue: Encodable {
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let text): try container.encode(text)
        case .number(let number): try container.encode(number)
        case .bool(let flag): try container.encode(flag)
        case .array(let values): try container.encode(values)
        case .object(let fields): try container.encode(fields)
        case .null: try container.encodeNil()
        }
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
/// again after `refusedBackoff`, or sooner when that instance exits or its discovery entry changes. The connection
/// closes after `idleClose` with no call and no subscription, so the
/// service can exit when it is idle. A kept subscription keeps a connection: when it closes, this side connects again
/// by itself (`resumeSubscription`).
@MainActor
final class MeetingsService {
    /// The window's service: nil in the preview build and under XCTest, and when it is turned off with
    /// `GENESIS_MEETINGS_SERVICE=0` or `defaults write com.genesiscz.genesistools meetings.service -bool NO`. Every
    /// read then runs as a command, as before. The service folder is under `genesisHome()`, so a sandbox home
    /// (`GENESIS_TOOLS_HOME`) has its own service; a service answers only when its `sourceRoot` is the checkout of the
    /// `tools` the window runs (`GENESIS_TOOLS_BIN` for a worktree's), so a worktree's window never reads through the
    /// main checkout's service, and a service that names no checkout (an older one) is used only with neither variable
    /// set.
    static let shared: MeetingsService? = {
        let environment = ProcessInfo.processInfo.environment
        guard !NativePreview.enabled, NSClassFromString("XCTestCase") == nil,
              environment["GENESIS_MEETINGS_SERVICE"] != "0",
              UserDefaults.standard.object(forKey: "meetings.service") as? Bool ?? true else { return nil }
        let overridden = environment["GENESIS_TOOLS_HOME"] != nil || environment["GENESIS_TOOLS_BIN"] != nil
        return MeetingsService(folder: GenesisToolsHome.url("meetings-service"),
                               checkout: .init(root: { ToolsBridge.workingDirectory(forBinary: ToolsBridge.defaultBinaryPath()).path },
                                               acceptsUnnamed: !overridden))
    }()

    /// Which service this window may use: the one whose `sourceRoot` (service.json, the checkout its code runs from) is
    /// `root()`, the checkout of the `tools` the window runs. A service of another checkout answers with other code
    /// (finding 5 of the Wave A review); the window reads through its own command then.
    struct Checkout {
        /// The checkout of the window's `tools`, symlinks resolved; asked at each connect, so a moved binary applies.
        var root: () -> String
        /// A service.json without `sourceRoot` (a service older than the rule) is used: true for the app on the real
        /// home with the default `tools`, false under `GENESIS_TOOLS_HOME` or `GENESIS_TOOLS_BIN`.
        var acceptsUnnamed: Bool

        /// Whether a service that names `sourceRoot` (nil: names none) is this window's.
        func accepts(_ sourceRoot: String?) -> Bool {
            guard let sourceRoot, !sourceRoot.isEmpty else { return acceptsUnnamed }
            return Self.same(sourceRoot, root())
        }

        /// Two checkout paths name one folder: symlinks resolved, a trailing `/` ignored.
        static func same(_ left: String, _ right: String) -> Bool {
            func normal(_ path: String) -> String {
                URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
            }
            return normal(left) == normal(right)
        }
    }

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
        /// False once a request may have changed data, even if its reply could not be read.
        var safeToRetry = true
        var description: String { reason }
    }

    /// Starts the service; returns once it listens (`tools meetings serve --detach` prints its service.json then).
    typealias ServiceStarter = @MainActor () async throws -> Void

    let folder: URL
    private let timing: Timing
    private let pid: Int32
    private let startService: ServiceStarter
    /// nil: any live service in `folder` is used (the tests).
    private let checkout: Checkout?
    /// Every answer and notification is decoded here, off the main thread: a transcript can be long.
    private let callbackQueue = DispatchQueue(label: "genesis.meetings.service")

    private(set) var state: State = .idle
    private var client: JSONRPCSocketClient?
    private var connecting: Task<JSONRPCSocketClient?, Never>?
    private var refusedUntil: Date?
    /// Discovery is written once per service lifetime. A refusal belongs to that instance, not its replacement.
    private var refusedDiscovery: Data?
    private var clientDiscovery: Data?
    private var lastStart: Date?
    private var failedStarts = 0
    private var starting: Task<Void, Never>?
    private var subscription: MeetingsAPI.Subscribe.Params?
    /// Connects again while a subscription is kept and no connection is open (`resumeSubscription`).
    private var resuming: Task<Void, Never>?
    private var callsInFlight = 0
    private var idleGeneration = 0

    /// Who hears the subscription's events and its state, on the main actor (`listen`).
    private var listeners: [UUID: @MainActor (MeetingsServiceSignal) -> Void] = [:]
    /// A kept subscription has a connection that heard its subscribe: events arrive.
    private(set) var isSubscribed = false

    init(folder: URL, timing: Timing = Timing(), pid: Int32 = ProcessInfo.processInfo.processIdentifier,
         checkout: Checkout? = nil,
         startService: @escaping ServiceStarter = { _ = try await MeetingsCLI.run(["serve", "--detach"], timeoutSeconds: 60) }) {
        self.folder = folder
        self.timing = timing
        self.pid = pid
        self.checkout = checkout
        self.startService = startService
    }

    /// Hears every event of the subscription and its state changes until the returned `Listening` is cancelled or
    /// released. Several models listen to one subscription (the window's list, the open meeting).
    func listen(_ handler: @escaping @MainActor (MeetingsServiceSignal) -> Void) -> Listening {
        let id = UUID()
        listeners[id] = handler
        return Listening { [weak self] in self?.listeners[id] = nil }
    }

    /// A listener's hold: `cancel()` or its release stops the events.
    final class Listening {
        private var stop: (@MainActor () -> Void)?

        init(_ stop: @escaping @MainActor () -> Void) { self.stop = stop }

        @MainActor func cancel() {
            stop?()
            stop = nil
        }

        deinit {
            guard let stop else { return }
            Task { @MainActor in stop() }
        }
    }

    private func signal(_ signal: MeetingsServiceSignal) {
        for handler in listeners.values { handler(signal) }
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
            throw failure(of: M.name, error, on: client, params: { Self.commandLine(M.name, params) })
        }
    }

    /// A mutation may use the command only when the service could not have applied it.
    static func write<M: MeetingsServiceMethod>(_ method: M.Type, _ params: M.Params,
                                               service: MeetingsService?, orRun args: [String],
                                               command: (([String], Int) async throws -> M.Result)? = nil) async throws -> M.Result {
        if let service {
            do {
                return try await service.call(method, params)
            } catch let failure as Unavailable where failure.safeToRetry {
                try Task.checkCancellation()
            }
        }
        if let command { return try await command(args, 60) }
        let data = try await MeetingsCLI.run(args)
        do {
            return try JSONDecoder().decode(M.Result.self, from: data)
        } catch {
            throw MeetingsCLI.Failure(sentence: "The command completed, but its reply could not be read. Reload before retrying.",
                                      detail: "\(args.joined(separator: " ")): \(error)")
        }
    }

    /// From now on the connection hears these events (each listener hears them, `listen`). The subscription is kept:
    /// while no connection is open (the service hung up, exited on a code change, was not running yet), this side
    /// connects again by itself and sends it, then signals `.resumed`. Throws `Unavailable` while no service answers.
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
        let heard = try await call(MeetingsAPI.Subscribe.self, params, timeout: timing.helloTimeout).events
        isSubscribed = true
        return heard
    }

    /// Forgets the subscription and closes the connection, so the service can go idle.
    func unsubscribe() {
        subscription = nil
        isSubscribed = false
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
    /// "meetings service moment.clip {"meeting":"…","target":…}": the call as a failure report names it, its params cut
    /// at 600 characters.
    static func commandLine<P: Encodable>(_ method: String, _ params: P) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let json = (try? encoder.encode(params)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
        return "meetings service \(method) " + (json.count > 600 ? String(json.prefix(600)) + "…" : json)
    }

    private func failure(of method: String, _ error: Error, on client: JSONRPCSocketClient,
                         params: () -> String) -> Error {
        if Task.isCancelled || error is CancellationError { return CancellationError() }
        switch error {
        case let remote as JSONRPCSocketClient.RemoteError:
            if remote.code == JSONRPCSocketClient.Code.cancelled { return CancellationError() }
            guard remote.code == MeetingsAPI.refusedCode, let code = remote.decodeData(MeetingsAPI.ErrorData.self)?.code else {
                // Not a refusal (an older service without the method, params it does not take): the command answers.
                HubPerf.log("meetings.service: \(method) answered \(remote.code) \(remote.message); the command answers it")
                return Unavailable(reason: "\(method) answered \(remote.code): \(remote.message)", safeToRetry: [-32601, -32602].contains(remote.code))
            }
            if MeetingsAPI.connectionRefusals.contains(code) {
                HubPerf.log("meetings.service: \(method) refused the connection [\(code)] \(remote.message)")
                drop(client, backoff: code == "no-hello" ? nil : timing.refusedBackoff)
                return Unavailable(reason: "[\(code)] \(remote.message)")
            }
            return MeetingsCLI.Failure(sentence: MeetingsCLI.sentence(fromStderr: remote.message) ?? "The Meetings service refused it.",
                                       detail: "The Meetings service refused \(method) [\(code)]:\n\(remote.message)", code: code,
                                       data: remote.data, command: params(), stack: remote.stack, issue: remote.issue)
        case let failure as JSONRPCSocketClient.Failure:
            // A service that does not answer in time may hang: the next call opens a new connection.
            if case .timeout = failure { drop(client) }
            return Unavailable(reason: "\(method): \(failure.localizedDescription)", safeToRetry: false)
        case let decoding as DecodeFailure:
            // A service this app cannot read (another checkout or version: the window's hello names no code) is not the
            // answer. The command answers, as with no service, and shows its own format error when it cannot be read
            // either; this service is not asked again before the backoff.
            HubPerf.log("meetings.service: \(method) answered a shape the window cannot read (\(decoding.error)); "
                + "the command answers it: \(decoding.preview.prefix(300))")
            drop(client, backoff: timing.refusedBackoff)
            return Unavailable(reason: "\(method): the answer does not decode", safeToRetry: false)
        default:
            return Unavailable(reason: "\(method): \(error)", safeToRetry: false)
        }
    }

    /// An answer that does not decode as the method's result.
    struct DecodeFailure: Error {
        let error: Error
        let preview: String
    }

    // MARK: Connecting

    private var discovery: URL { folder.appendingPathComponent("service.json") }

    /// What `service.json` says now.
    enum Discovery: Equatable {
        /// No live service: none wrote the file, or its process is gone.
        case none
        /// A live service of another checkout (`sourceRoot`): the window does not use it, and does not start another.
        case otherCheckout(String?)
        case socket(String)
    }

    /// The socket `service.json` names, when its process still lives and its checkout is this window's.
    func discover() -> Discovery {
        guard let data = try? Data(contentsOf: discovery),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let socket = object["socket"] as? String, !socket.isEmpty else { return .none }
        if let pid = (object["pid"] as? NSNumber)?.int32Value, pid > 0, kill(pid, 0) != 0, errno == ESRCH { return .none }
        let sourceRoot = object["sourceRoot"] as? String
        if let checkout, !checkout.accepts(sourceRoot) { return .otherCheckout(sourceRoot) }
        return .socket(socket)
    }

    /// The socket of a live service this window may use; nil otherwise.
    func discoveredSocket() -> String? {
        if case .socket(let socket) = discover() { return socket }
        return nil
    }

    /// The connection, after its hello; nil when no service answers now. Calls that arrive while it opens wait for it.
    private func connection() async -> JSONRPCSocketClient? {
        if let client, case .connected = state { return client }
        if backoffRemaining > 0 { return nil }
        if let connecting { return await connecting.value }
        let task = Task { await self.connect() }
        connecting = task
        let connected = await task.value
        connecting = nil
        return connected
    }

    private func backOff(for duration: TimeInterval, discovery: Data?) {
        refusedUntil = Date().addingTimeInterval(duration)
        refusedDiscovery = discovery
    }

    /// Keep a refused instance quiet, but let an exited or replaced service recover immediately.
    private var backoffRemaining: TimeInterval {
        guard let until = refusedUntil else { return 0 }
        let remaining = until.timeIntervalSinceNow
        guard remaining > 0 else { return 0 }
        if discover() == .none || (try? Data(contentsOf: discovery)) != refusedDiscovery {
            refusedUntil = nil
            refusedDiscovery = nil
            HubPerf.log("meetings.service: refused instance exited or changed; looking for its replacement")
            return 0
        }
        return remaining
    }

    private func connect() async -> JSONRPCSocketClient? {
        state = .connecting
        let entry = try? Data(contentsOf: discovery)
        let socket: String
        switch discover() {
        case .none:
            state = .idle
            startInBackground(because: "no live service in \(discovery.path)")
            return nil
        case .otherCheckout(let root):
            // Its code is another checkout's: the command of this window's `tools` answers. Starting one here would
            // only find it running; look again after the backoff (it may exit idle, and then this window starts its own).
            HubPerf.log("meetings.service: the live service runs \(root ?? "a checkout it does not name"), not "
                + "\(checkout?.root() ?? "?"); the command answers")
            backOff(for: timing.refusedBackoff, discovery: entry)
            state = .idle
            return nil
        case .socket(let found):
            socket = found
        }
        let candidate = JSONRPCSocketClient(path: socket, callbackQueue: callbackQueue)
        // The handlers are set before the connection opens, so no notification or close reaches a client whose
        // handlers are being set on another thread (Wave A review, Unproven list).
        install(on: candidate)
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
                backOff(for: timing.refusedBackoff, discovery: entry)
                state = .idle
                return nil
            }
            attach(candidate, hello: answer, discovery: entry)
            return candidate
        } catch {
            candidate.close()
            state = .idle
            let refusal = (error as? JSONRPCSocketClient.RemoteError)?.decodeData(MeetingsAPI.ErrorData.self)?.code
            HubPerf.log("meetings.service: hello failed (\(refusal ?? "no answer")): \(error.localizedDescription)")
            if let refusal, MeetingsAPI.connectionRefusals.contains(refusal) {
                backOff(for: timing.refusedBackoff, discovery: entry)
            }
            return nil
        }
    }

    /// A connection's close and notifications reach this side; both act only once the connection is the attached one.
    private func install(on connection: JSONRPCSocketClient) {
        connection.onClose = { [weak self, weak connection] in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self, let connection, self.client === connection else { return }
                    HubPerf.log("meetings.service: the service closed the connection")
                    self.client = nil
                    self.state = .idle
                    self.subscriptionLost()
                    self.resumeSubscription()
                }
            }
        }
        connection.onNotification = { [weak self, weak connection] method, params in
            // On the callback queue: decode here, deliver on the main actor.
            guard let decoder = MeetingsAPI.eventDecoders[method] else { return }
            let event: MeetingsEvent
            do {
                event = try decoder(params)
            } catch {
                HubPerf.log("meetings.service: the event \(method) does not decode: \(error)")
                return
            }
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self, let connection, self.client === connection else { return }
                    self.signal(.event(event))
                }
            }
        }
    }

    /// The connection answered its hello: a kept subscription is sent again.
    private func attach(_ connected: JSONRPCSocketClient, hello: MeetingsAPI.Hello.Result, discovery: Data?) {
        client = connected
        clientDiscovery = discovery
        refusedUntil = nil
        refusedDiscovery = nil
        state = .connected(methods: hello.methods, events: hello.events)
        HubPerf.log("meetings.service: connected (service \(hello.version), \(hello.methods.count) methods)")
        if let subscription {
            Task {
                do {
                    _ = try await Self.send(MeetingsAPI.Subscribe.self, subscription, on: connected, timeout: timing.helloTimeout)
                    guard self.subscription != nil, self.client === connected else { return }
                    isSubscribed = true
                    signal(.resumed)
                } catch {
                    HubPerf.log("meetings.service: subscribe again failed: \(error.localizedDescription)")
                }
            }
        }
        scheduleIdleClose()
    }

    /// A kept subscription has no connection now: its listeners hear `.lost` once, until it resumes.
    private func subscriptionLost() {
        guard subscription != nil, isSubscribed else { return }
        isSubscribed = false
        signal(.lost)
    }

    private func drop(_ dropped: JSONRPCSocketClient, backoff: TimeInterval? = nil) {
        dropped.onClose = nil
        dropped.onNotification = nil
        dropped.close()
        if let backoff { backOff(for: backoff, discovery: clientDiscovery) }
        if client === dropped {
            client = nil
            clientDiscovery = nil
            state = .idle
            subscriptionLost()
        }
        resumeSubscription()
    }

    /// While a subscription is kept and no connection is open, connects again by itself: after `reconnectDelay`, then
    /// twice as long each time up to `refusedBackoff`. During a refusal, inspect discovery every reconnectDelay so a
    /// replacement can connect promptly without knocking again on the refused instance. `connection()` starts the
    /// service when none runs, and `attach` sends the kept subscription. Nothing else would connect: the window reads
    /// on events, not on a timer.
    private func resumeSubscription() {
        guard subscription != nil, client == nil, resuming == nil else { return }
        let first = timing.reconnectDelay
        resuming = Task { [weak self] in
            var delay = first
            while true {
                let refused = self?.backoffRemaining ?? 0
                try? await Task.sleep(for: .seconds(refused > 0 ? min(first, refused) : delay))
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
                delay = self.backoffRemaining > 0 ? first : min(delay * 2, self.timing.refusedBackoff)
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
            } catch let failure as MeetingsCLI.Failure where Self.runsCommand(after: failure) {
                // A generic `failed` refusal names no state the pane can show (the service threw); the command may read
                // it, and shows its own error when it cannot. A write never comes here: it shows the refusal.
                HubPerf.log("meetings.service: \(method ?? "read") refused [failed]; the command answers it")
                try Task.checkCancellation()
            }
        }
        if let command { return try await command(args, timeoutSeconds) }
        return try await viaCommand()
    }

    /// A read the service refused runs as the command only for the generic `failed` code; a named refusal
    /// (`meeting-not-found`, `no-transcript-source`) is the answer, the same the command would give.
    static func runsCommand(after failure: MeetingsCLI.Failure) -> Bool {
        failure.code == "failed"
    }
}
