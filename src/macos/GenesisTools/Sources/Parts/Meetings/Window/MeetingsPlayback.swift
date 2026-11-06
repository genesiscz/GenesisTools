import AppKit
import Foundation
import Observation

/// The meeting's audio, played from a transcript time, with its state and its controls in the window. The CLI starts
/// the player and names its process (`tools meetings play … --json`: the file, the start, the player, the pid). The
/// window then owns that process: Pause suspends it, Resume continues it, Stop ends it, and its exit ends the state.
/// Before this, a time click started VLC or ffplay with sound and the window showed nothing at all.
@Observable
@MainActor
final class MeetingsPlayback {
    /// What `tools meetings play … --json` prints once the player runs.
    struct Launch: Decodable, Equatable {
        let audioPath: String?
        let startSec: Double
        let player: String
        let pid: Int32?
    }

    struct Session: Equatable {
        let pid: pid_t
        let player: String
        let startSec: Double
        /// When the audio started or last resumed, and how long it played before that.
        var resumedAt: Date
        var playedBefore: TimeInterval

        /// The transcript time the audio is at, counted on the wall clock from its start.
        func position(at now: Date) -> Double { startSec + playedBefore + max(0, now.timeIntervalSince(resumedAt)) }
        /// Pausing works only for a player with no window of its own: VLC has its own controls.
        var canPause: Bool { player == "ffplay" }
    }

    enum State: Equatable {
        case idle
        case starting(fromSec: Double)
        case playing(Session)
        case paused(Session, at: Double)
        case failed(MeetingsCLI.Failure, fromSec: Double)
    }

    /// Starts the player for a meeting at a time.
    typealias Starter = @MainActor (_ meeting: String, _ seconds: Double, _ player: String?) async throws -> Launch
    typealias Signal = (_ pid: pid_t, _ signal: Int32) -> Void

    private(set) var state: State = .idle {
        didSet { if state == .idle { meeting = nil } }
    }
    /// The meeting that plays, so the bar can name it while the reader looks at another one.
    private(set) var meeting: String?
    @ObservationIgnored private let start: Starter
    @ObservationIgnored private let signal: Signal
    @ObservationIgnored private var exitWatch: DispatchSourceProcess?
    @ObservationIgnored private var startGeneration = 0
    @ObservationIgnored private var terminateObserver: NSObjectProtocol?
    @ObservationIgnored private var lastRequest: (meeting: String, seconds: Double, player: String?)?

    init(start: @escaping Starter = MeetingsPlayback.cliStart, signal: @escaping Signal = { kill($0, $1) }) {
        self.start = start
        self.signal = signal
        // The player outlives this process (the CLI starts it detached), so quitting the window stops it too.
        terminateObserver = NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification,
                                                                   object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.stop() }
        }
    }

    deinit {
        if let terminateObserver { NotificationCenter.default.removeObserver(terminateObserver) }
    }

    /// Plays `meeting` from `seconds`, ending whatever played before. `player` is the window's choice (Settings →
    /// Meetings → Window): "ffplay" plays with no window and is controlled here; nil takes the meetings config's player.
    func play(meeting: String, at seconds: Double, player: String?) {
        stop()
        startGeneration += 1
        let generation = startGeneration
        lastRequest = (meeting, seconds, player)
        state = .starting(fromSec: seconds)
        self.meeting = meeting
        Task {
            do {
                let launch = try await start(meeting, seconds, player)
                guard generation == startGeneration else {
                    if let pid = launch.pid { signal(pid, SIGTERM) }
                    return
                }
                guard let pid = launch.pid else {
                    // `play --json` names the process of every player it started; no pid means none runs.
                    state = .failed(MeetingsCLI.Failure(sentence: "The player did not start.",
                                                        detail: "tools meetings play printed no process id."), fromSec: seconds)
                    return
                }
                let session = Session(pid: pid, player: launch.player, startSec: launch.startSec, resumedAt: Date(), playedBefore: 0)
                state = .playing(session)
                watchExit(of: pid)
                GenAnnounce.post("Playing from \(MeetingsFormat.clock(launch.startSec))")
            } catch {
                guard generation == startGeneration else { return }
                state = .failed(asFailure(error), fromSec: seconds)
            }
        }
    }

    func pause() {
        guard case .playing(let session) = state, session.canPause else { return }
        signal(session.pid, SIGSTOP)
        var paused = session
        paused.playedBefore += max(0, Date().timeIntervalSince(session.resumedAt))
        state = .paused(paused, at: paused.startSec + paused.playedBefore)
        GenAnnounce.post("Paused")
    }

    func resume() {
        guard case .paused(var session, _) = state else { return }
        signal(session.pid, SIGCONT)
        session.resumedAt = Date()
        state = .playing(session)
        GenAnnounce.post("Playing")
    }

    /// Ends the player and the state; a starting player is ended as soon as it names itself.
    func stop() {
        startGeneration += 1
        exitWatch?.cancel()
        exitWatch = nil
        switch state {
        case .playing(let session), .paused(let session, _):
            // A suspended process ends only once it runs again.
            signal(session.pid, SIGCONT)
            signal(session.pid, SIGTERM)
            state = .idle
            GenAnnounce.post("Stopped")
        case .starting, .failed:
            state = .idle
        case .idle:
            break
        }
    }

    /// Starts the failed request again.
    func retry() {
        guard case .failed = state, let lastRequest else { return }
        play(meeting: lastRequest.meeting, at: lastRequest.seconds, player: lastRequest.player)
    }

    /// Hides a failure note.
    func dismiss() {
        if case .failed = state { state = .idle }
    }

    /// The player ended by itself (the audio's end, its own window closed): the bar goes.
    func playerExited(_ pid: pid_t) {
        switch state {
        case .playing(let session) where session.pid == pid, .paused(let session, _) where session.pid == pid:
            exitWatch?.cancel()
            exitWatch = nil
            state = .idle
        default:
            break
        }
    }

    private func watchExit(of pid: pid_t) {
        let source = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
        source.setEventHandler { [weak self] in
            MainActor.assumeIsolated { self?.playerExited(pid) }
        }
        source.resume()
        exitWatch = source
    }

    /// The live starter: `tools meetings play --json` starts the player and names its process. A `--player` that is
    /// not installed is refused, and the bar shows the refusal with Retry.
    static func cliStart(meeting: String, seconds: Double, player: String?) async throws -> Launch {
        let at = String(Int(seconds.rounded(.down)))
        return try await MeetingsCLI.json(Launch.self, ["play", meeting, "--at", at, "--json"] + (player.map { ["--player", $0] } ?? []))
    }
}
