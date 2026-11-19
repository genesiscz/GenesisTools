import AppKit
import Combine

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
    nonisolated static let maximumDurationMs: Double = 600_000
    @Published public private(set) var phase: RecordingPhase = .idle
    /// Recorded time: what is in the movie so far, without arming or paused time.
    @Published public private(set) var elapsedMs: Double = 0
    @Published public private(set) var limitMs: Double = RecordingSessionController.maximumDurationMs
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
    var onEvent: ((RecordingSessionLine) -> Void)?
    var onRates: ((Double, Double) -> Void)?

    private let bridge: ToolsBridge?
    private let screenFrames: @MainActor () -> [CGRect]
    private let displayIDs: @MainActor () -> [UInt32?]
    private let openChannel: (([String], @escaping @MainActor ([String]) -> Void,
                               @escaping @MainActor (Int32, String) -> Void) throws -> RecordingCommandChannel)?
    private var channel: RecordingCommandChannel?
    private var ended = false

    public init(bridge: ToolsBridge) {
        self.bridge = bridge
        screenFrames = { NSScreen.screens.map(\.frame) }
        displayIDs = { RecordingTarget.connectedDisplayIDs }
        openChannel = nil
    }

    /// Tests: `open` gets the CLI arguments and the line and exit callbacks, and returns the command channel.
    init(screenFrames: @escaping @MainActor () -> [CGRect] = { NSScreen.screens.map(\.frame) },
         displayIDs: @escaping @MainActor () -> [UInt32?] = { RecordingTarget.connectedDisplayIDs },
         open: @escaping ([String], @escaping @MainActor ([String]) -> Void,
                          @escaping @MainActor (Int32, String) -> Void) throws -> RecordingCommandChannel) {
        bridge = nil
        self.screenFrames = screenFrames
        self.displayIDs = displayIDs
        openChannel = open
    }

    /// The arguments after `tools control`.
    private func arguments(target: RecordingTarget, excludeWindowIDs: [Int], frameRate: Int,
                           stillFrameRate: Double, showsBorder: Bool) throws -> [String] {
        let data = try JSONSerialization.data(withJSONObject: sessionTarget(target), options: [.sortedKeys])
        let json = String(decoding: data, as: UTF8.self)
        var args = ["capture", "session", "--json", "--stop-on-stdin", "--target", json, "--fps", String(frameRate)]
        if stillFrameRate != 0 && stillFrameRate != Double(frameRate) {
            args += ["--idle-fps", String(stillFrameRate)]
        }
        if !excludeWindowIDs.isEmpty {
            args += ["--exclude-window-ids", excludeWindowIDs.map(String.init).joined(separator: ",")]
        }
        if !showsBorder { args.append("--no-indicator") }
        return args
    }

    /// Starts recording `target`. `excludeWindowIDs` are windows the movie never shows (the controls panel).
    public func start(target: RecordingTarget, excludeWindowIDs: [Int], frameRate: Int, showsBorder: Bool,
                      stillFrameRate: Double = 0) throws {
        guard channel == nil, !ended else { return }
        let args = try arguments(target: target, excludeWindowIDs: excludeWindowIDs, frameRate: frameRate,
                                 stillFrameRate: stillFrameRate, showsBorder: showsBorder)
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

    enum Command: Equatable {
        case pause, resume, restart, restartOn(RecordingTarget), stop, discard, switchTo(RecordingTarget), rates(Int, Double)
    }

    public func pause() { send(.pause) }
    public func resume() { send(.resume) }
    public func restart() { send(.restart) }
    /// Stops and keeps the movie: `onDone` follows once it is joined.
    public func stop() { send(.stop) }
    public func discard() { send(.discard) }

    public func switchTo(_ target: RecordingTarget) {
        send(.switchTo(target))
    }

    private func targetCommand(_ command: String, _ target: RecordingTarget) throws -> [String: Any] {
        var wire = try sessionTarget(target)
        // The channel takes one line of at most 512 bytes. A window's title and a display's name are labels only, so
        // a long one is left out rather than the switch refused.
        let line = try? JSONSerialization.data(withJSONObject: ["cmd": command, "target": wire], options: [.sortedKeys])
        if (line?.count ?? 0) >= Self.commandLimit {
            wire["title"] = nil
            wire["name"] = nil
        }
        return ["cmd": command, "target": wire]
    }

    private func sessionTarget(_ target: RecordingTarget) throws -> [String: Any] {
        guard target.kind == .area else { return target.wire }
        let screens = screenFrames()
        guard let primary = screens.first, let cocoa = target.areaBounds(screens: screens, displayIDs: displayIDs()) else {
            throw RecordingEngineError.unsupported("Choose the area again on a connected display.")
        }
        let region = RecordingPanelLayout.cocoa(cocoa, primaryHeight: primary.maxY)
        return ["kind": "region", "x": region.minX, "y": region.minY, "width": region.width, "height": region.height]
    }

    /// `ToolsLineStream.sendInput`'s limit; the newline takes one byte of it.
    static let commandLimit = 512

    /// Ends the child at once (an app that quits): it stops and keeps what it recorded on SIGTERM.
    public func terminate() {
        channel?.stop()
    }

    private func send(_ command: Command) {
        guard !ended, channel != nil else { return }
        do { try write(command) }
        catch {
            notice = "The recorder did not take the command: \(error.localizedDescription)"
            PerfLog.mark("recording.session send failed \(error.localizedDescription)")
        }
    }

    func write(_ command: Command) throws {
        guard let channel, !ended else { throw POSIXError(.EPIPE) }
        let wire: [String: Any]
        switch command {
        case .pause: wire = ["cmd": "pause"]
        case .resume: wire = ["cmd": "resume"]
        case .restart: wire = ["cmd": "restart"]
        case let .restartOn(target): wire = try targetCommand("restart", target)
        case .stop: wire = ["cmd": "stop"]
        case .discard: wire = ["cmd": "discard"]
        case let .switchTo(target): wire = try targetCommand("switch", target)
        case let .rates(active, idle): wire = ["cmd": "rates", "activeFps": active, "idleFps": idle]
        }
        let data = try JSONSerialization.data(withJSONObject: wire, options: [.sortedKeys])
        try channel.send(String(decoding: data, as: UTF8.self) + "\n")
    }

    func receive(_ lines: [String]) {
        for line in lines {
            guard !ended else { return }
            let data = Data(line.utf8)
            guard let event = decode(data) else {
                PerfLog.mark("recording.session unreadable line \(line.prefix(200))")
                continue
            }
            apply(event)
            if event.event == "rates", let rates = try? JSONDecoder().decode(Rates.self, from: data) {
                onRates?(rates.activeFps, rates.idleFps)
            }
            onEvent?(event)
        }
    }

    private struct Rates: Decodable {
        let activeFps: Double
        let idleFps: Double
    }

    /// Only the capture session uses global, top-left "region" on the wire. Saved bar targets stay display-local.
    private func decode(_ data: Data) -> RecordingSessionLine? {
        let decoder = JSONDecoder()
        if let event = try? decoder.decode(RecordingSessionLine.self, from: data) { return event }
        guard var object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let region = object["target"] as? [String: Any], region["kind"] as? String == "region",
              let x = region["x"] as? Double, let y = region["y"] as? Double,
              let w = region["width"] as? Double, let h = region["height"] as? Double else { return nil }
        let screens = screenFrames()
        object["target"] = nil
        if let primary = screens.first {
            let rect = RecordingPanelLayout.cocoa(CGRect(x: x, y: y, width: w, height: h), primaryHeight: primary.maxY)
            if let index = screens.firstIndex(where: { $0.contains(rect) }) {
                let ids = displayIDs()
                let id = ids.indices.contains(index) ? ids[index] : nil
                object["target"] = RecordingTarget.area(
                    rect: rect.offsetBy(dx: -screens[index].minX, dy: -screens[index].minY),
                    display: index, displayID: id).wire
            }
        }
        guard let normalized = try? JSONSerialization.data(withJSONObject: object) else { return nil }
        return try? decoder.decode(RecordingSessionLine.self, from: normalized)
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
