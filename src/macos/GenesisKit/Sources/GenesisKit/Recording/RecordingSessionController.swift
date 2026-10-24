import Foundation

/// The command side of a running `tools control capture session`: one JSON line per command, EOF to stop.
@MainActor
public protocol RecordingCommandChannel: AnyObject {
    func send(_ line: String) throws
    func finishInput()
    /// SIGTERM: the session stops and keeps what it recorded.
    func stop()
}

extension ToolsLineStream: RecordingCommandChannel {
    public func send(_ line: String) throws { try sendInput(line) }
}

/// Drives one recording session through `tools control capture session --json --stop-on-stdin` and publishes what it
/// reports. It knows nothing about who records or what happens to the movie: the host gets `onDone` with the movie,
/// `onDiscarded`, or `onFailed`.
@MainActor
public final class RecordingSessionController: ObservableObject {
    @Published public private(set) var phase: RecordingPhase = .idle
    /// Recorded time: what is in the movie so far, without arming or paused time.
    @Published public private(set) var elapsedMs: Double = 0
    @Published public private(set) var limitMs: Double = 600_000
    @Published public private(set) var target: RecordingTarget?
    /// Why the session paused: `user`, `limit` (the length limit) or `recorder` (it stopped by itself).
    @Published public private(set) var pauseReason: String?
    @Published public private(set) var segments = 0
    /// The last problem the session reported that did not end it; cleared by the next state change.
    @Published public var notice: String?
    /// Why `starting` takes long (the recorder compiles after an update, or no first frame came yet); cleared once
    /// the session leaves `starting`.
    @Published public private(set) var preparing: String?

    public var onDone: ((URL, Double) -> Void)?
    public var onDiscarded: (() -> Void)?
    /// The message and its code (`screen-recording-denied`), when the session could not record at all.
    public var onFailed: ((String, String?) -> Void)?

    private let bridge: ToolsBridge?
    private let openChannel: (([String], @escaping @MainActor ([String]) -> Void,
                               @escaping @MainActor (Int32, String) -> Void) throws -> RecordingCommandChannel)?
    private var channel: RecordingCommandChannel?
    private var ended = false

    public init(bridge: ToolsBridge) {
        self.bridge = bridge
        openChannel = nil
    }

    /// Tests: `open` gets the CLI arguments and the line and exit callbacks, and returns the command channel.
    init(open: @escaping ([String], @escaping @MainActor ([String]) -> Void,
                          @escaping @MainActor (Int32, String) -> Void) throws -> RecordingCommandChannel) {
        bridge = nil
        openChannel = open
    }

    /// The arguments after `tools control`.
    static func arguments(target: RecordingTarget, excludeWindowIDs: [Int], frameRate: Int, showsBorder: Bool) -> [String] {
        var args = ["capture", "session", "--json", "--stop-on-stdin", "--target", target.json, "--fps", String(frameRate)]
        if !excludeWindowIDs.isEmpty {
            args += ["--exclude-window-ids", excludeWindowIDs.map(String.init).joined(separator: ",")]
        }
        if !showsBorder { args.append("--no-indicator") }
        return args
    }

    /// Starts recording `target`. `excludeWindowIDs` are windows the movie never shows (the controls panel).
    public func start(target: RecordingTarget, excludeWindowIDs: [Int], frameRate: Int, showsBorder: Bool) throws {
        guard channel == nil, !ended else { return }
        let args = Self.arguments(target: target, excludeWindowIDs: excludeWindowIDs, frameRate: frameRate,
                                  showsBorder: showsBorder)
        self.target = target
        phase = .starting
        let lines: @MainActor ([String]) -> Void = { [weak self] in self?.receive($0) }
        let exit: @MainActor (Int32, String) -> Void = { [weak self] status, stderr in self?.exited(status: status, stderr: stderr) }
        do {
            if let openChannel {
                channel = try openChannel(args, lines, exit)
            } else if let bridge {
                channel = try ToolsLineStream(
                    bridge: bridge, subcommand: "control", args: args,
                    onLines: lines, onExit: { exit($0.status, $0.stderr) })
            }
            PerfLog.mark("recording.session started target=\(target.json)")
        } catch {
            phase = .failed
            ended = true
            throw error
        }
    }

    public func pause() { send(["cmd": "pause"]) }
    public func resume() { send(["cmd": "resume"]) }
    public func restart() { send(["cmd": "restart"]) }
    /// Stops and keeps the movie: `onDone` follows once it is joined.
    public func stop() { send(["cmd": "stop"]) }
    public func discard() { send(["cmd": "discard"]) }

    public func switchTo(_ target: RecordingTarget) {
        var wire = target.wire
        // The channel takes one line of at most 512 bytes. A window's title and a display's name are labels only, so
        // a long one is left out rather than the switch refused.
        let line = try? JSONSerialization.data(withJSONObject: ["cmd": "switch", "target": wire], options: [.sortedKeys])
        if (line?.count ?? 0) >= Self.commandLimit {
            wire["title"] = nil
            wire["name"] = nil
        }
        send(["cmd": "switch", "target": wire])
    }

    /// `ToolsLineStream.sendInput`'s limit; the newline takes one byte of it.
    static let commandLimit = 512

    /// Ends the child at once (an app that quits): it stops and keeps what it recorded on SIGTERM.
    public func terminate() {
        channel?.stop()
    }

    private func send(_ command: [String: Any]) {
        guard let channel, !ended else { return }
        do {
            let data = try JSONSerialization.data(withJSONObject: command, options: [.sortedKeys])
            try channel.send(String(decoding: data, as: UTF8.self) + "\n")
        } catch {
            notice = "The recorder did not take the command: \(error.localizedDescription)"
            PerfLog.mark("recording.session send failed \(error.localizedDescription)")
        }
    }

    func receive(_ lines: [String]) {
        for line in lines {
            guard let event = try? JSONDecoder().decode(RecordingSessionLine.self, from: Data(line.utf8)) else {
                PerfLog.mark("recording.session unreadable line \(line.prefix(200))")
                continue
            }
            apply(event)
        }
    }

    private func apply(_ event: RecordingSessionLine) {
        switch event.event {
        case "state":
            if let state = event.state, let next = RecordingPhase(rawValue: state) { phase = next }
            if let target = event.target { self.target = target }
            if let elapsed = event.elapsedMs { elapsedMs = elapsed }
            if let limit = event.limitMs { limitMs = limit }
            if let segments = event.segments { self.segments = segments }
            pauseReason = phase == .paused ? event.reason : nil
            if phase != .paused { notice = nil }
            if phase != .starting { preparing = nil }
        case "preparing":
            preparing = event.message
        case "elapsed":
            if let elapsed = event.elapsedMs { elapsedMs = elapsed }
        case "segment":
            segments += 1
        case "done":
            guard let path = event.path else { return }
            phase = .done
            ended = true
            onDone?(URL(fileURLWithPath: path), event.durationMs ?? elapsedMs)
        case "discarded":
            phase = .discarded
            ended = true
            onDiscarded?()
        case "error":
            let message = event.message ?? "The recorder failed."
            if event.fatal == true {
                phase = .failed
                ended = true
                onFailed?(message, event.code)
            } else {
                notice = message
            }
        default:
            break
        }
    }

    private func exited(status: Int32, stderr: String) {
        channel = nil
        PerfLog.mark("recording.session exited status=\(status) phase=\(phase.rawValue)")
        guard !ended else { return }
        ended = true
        phase = .failed
        // One sentence on screen; the recorder's own words go to the log.
        let tail = stderr.trimmingCharacters(in: .whitespacesAndNewlines).suffix(600)
        KitHost.log("recording.session stderr (exit \(status)) \(tail.isEmpty ? "(empty)" : String(tail))")
        onFailed?("The recorder stopped unexpectedly. The details are in the log.", nil)
    }
}
