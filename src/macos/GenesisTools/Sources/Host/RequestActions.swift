import AppKit
import Darwin
import Foundation

/// What a request's extra buttons need from the app: a `tools` command, a process to stop or watch, a page to open.
/// Tests pass fakes, so no player starts and no page opens.
struct RequestActionContext {
    /// Runs `tools <argv>` off the main thread; `done` gets its exit code, stdout and stderr on the main thread.
    var tools: (_ argv: [String], _ done: @escaping @MainActor (Int32, String, String) -> Void) -> Void
    /// Calls `done` on the main thread once `pid` has exited (at once when it is gone already).
    var whenExits: (_ pid: Int32, _ done: @escaping @MainActor () -> Void) -> Void
    var stop: (_ pid: Int32) -> Void
    var open: (_ url: URL) -> Void

    static let live = RequestActionContext(
        tools: { argv, done in
            DispatchQueue.global(qos: .userInitiated).async {
                let result = RequestActionContext.runTools(argv)
                DispatchQueue.main.async { MainActor.assumeIsolated { done(result.status, result.stdout, result.stderr) } }
            }
        },
        whenExits: { pid, done in
            let source = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
            // The handler holds the source until it fires, then lets it go.
            source.setEventHandler {
                source.cancel()
                MainActor.assumeIsolated { done() }
            }
            source.resume()
            if kill(pid, 0) != 0 {
                source.cancel()
                DispatchQueue.main.async { MainActor.assumeIsolated { done() } }
            }
        },
        stop: { pid in _ = kill(pid, SIGTERM) },
        open: { url in NSWorkspace.shared.open(url) }
    )

    /// One `tools` process with the app's scrubbed environment; it ends on its own (`meetings play` returns once its
    /// player started), so the caller's queue waits for it.
    private static func runTools(_ argv: [String]) -> (status: Int32, stdout: String, stderr: String) {
        let plan = ToolsBridge.launchPlan(binaryPath: ToolsBridge.defaultBinaryPath(), argv: argv)
        let process = Process()
        process.executableURL = plan.executable
        process.arguments = plan.arguments
        process.currentDirectoryURL = plan.workingDirectory
        process.environment = ToolsBridge.scrubbedEnvironment()
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        process.standardInput = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return (-1, "", "\(error)")
        }
        let out = stdout.fileHandleForReading.readDataToEndOfFile()
        let err = stderr.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, String(decoding: out, as: UTF8.self), String(decoding: err, as: UTF8.self))
    }
}

/// Why a declared button cannot do its work: one plain sentence for the window, and the technical text (the CLI's
/// words, any command it names) for Details.
struct RequestActionProblem: Equatable {
    let sentence: String
    let detail: String
}

/// One extra button a request declared: a click keeps the window open and answers nothing.
@MainActor
protocol RequestActionButton: AnyObject {
    /// The button as the window shows it now (Play clip, then Stop while the clip plays; dimmed with its reason when it
    /// cannot run).
    var link: ApprovalLink { get }
    /// The footnote's sentence about this button, so the footnote says everything the window can do.
    var footnote: String { get }
    /// Why the button cannot run here, learnt before a click (`prepare`) or from one; nil while it can.
    var problem: RequestActionProblem? { get }
    /// Called when `link` or `problem` changed, so the window shows the new ones.
    var changed: (() -> Void)? { get set }
    /// Called just before the button starts a clip, so the window stops the clip another button plays: a window plays
    /// one clip at a time.
    var willPlay: (() -> Void)? { get set }
    /// The window is on screen: check, without side effects, whether a click could work.
    func prepare()
    /// Stop the clip this button plays, or the one it is starting; the button stays usable.
    func stopPlaying()
    /// The window closed: stop what this button started.
    func close()
}

extension RequestActionButton {
    /// A button that plays nothing has nothing to stop.
    func stopPlaying() {}
}

/// Every kind of request action the window runs. A new kind is one maker here and its schema in
/// src/utils/genesis-tools/areas/person/request-actions.ts; each maker takes only its own kind.
@MainActor
enum RequestActions {
    static let makers: [(RequestPresentParamsActionsItem, RequestActionContext) -> RequestActionButton?] = [
        PlayMeetingButton.make,
        OpenLinkButton.make,
    ]

    static func buttons(for params: RequestPresentParams, context: RequestActionContext) -> [RequestActionButton] {
        (params.actions ?? []).compactMap { button(for: $0, context: context) }
    }

    /// Each row's own button by row id. A row's action has the same kinds and fields as the request's actions, so it
    /// is read as one of them and made by the same makers.
    static func rowButtons(for params: RequestPresentParams, context: RequestActionContext) -> [String: RequestActionButton] {
        var buttons: [String: RequestActionButton] = [:]
        for row in params.rows ?? [] {
            guard let action = row.action else { continue }
            do {
                let item = try JSONDecoder().decode(RequestPresentParamsActionsItem.self, from: JSONEncoder().encode(action))
                buttons[row.id] = button(for: item, context: context)
            } catch {
                HubPerf.log("request.action row \(row.id) has an action this app cannot read: \(error)")
            }
        }
        return buttons
    }

    static func button(for action: RequestPresentParamsActionsItem, context: RequestActionContext) -> RequestActionButton? {
        for make in makers {
            if let button = make(action, context) { return button }
        }
        return nil
    }
}

/// `play-meeting`: plays the range with `tools meetings play <meeting> --at --to` (the cut the CLI plays, `--track` when
/// the request names one); a second click stops the player, and the button turns back to Play when the clip ends. Its
/// Play stops the clip another button of the window plays first (`willPlay`).
/// When the window opens it plans the same play with `--no-start`, so a range with no sound shows a dimmed button and
/// its reason instead of failing on the click.
@MainActor
final class PlayMeetingButton: RequestActionButton {
    private let action: RequestPresentParamsActionsItemOption0
    private let context: RequestActionContext
    private var pid: Int32?
    private var starting = false
    /// Another Play of the window came while this player started: its player stops the moment it starts.
    private var stopWhenStarted = false
    private(set) var problem: RequestActionProblem?
    var changed: (() -> Void)?
    var willPlay: (() -> Void)?

    init(_ action: RequestPresentParamsActionsItemOption0, context: RequestActionContext) {
        self.action = action
        self.context = context
    }

    static func make(_ item: RequestPresentParamsActionsItem, _ context: RequestActionContext) -> RequestActionButton? {
        guard case let .option0(play) = item else { return nil }
        return PlayMeetingButton(play, context: context)
    }

    /// Whole seconds, as `play --at` reads them: the start rounded down and the end up, so the cut holds the range.
    var argv: [String] {
        ["meetings", "play", action.meeting, "--at", String(Int(action.fromSec.rounded(.down))),
         "--to", String(Int(action.toSec.rounded(.up)))] + (action.track.map { ["--track", $0] } ?? []) + ["--json"]
    }

    var link: ApprovalLink {
        if let pid {
            return ApprovalLink(title: "Stop", symbol: "stop.fill") { [weak self] in self?.stop(pid) }
        }
        return ApprovalLink(title: starting ? "Starting…" : action.label, symbol: "play.fill",
                            enabled: problem == nil, help: problem?.sentence) { [weak self] in self?.play() }
    }

    var footnote: String { "\(action.label) only plays the clip." }

    func prepare() {
        context.tools(argv + ["--no-start"]) { [weak self] status, _, stderr in
            guard let self, status != 0, pid == nil else { return }
            problem = Self.problem(status: status, stderr: stderr)
            changed?()
        }
    }

    func play() {
        guard pid == nil, !starting, problem == nil else { return }
        willPlay?()
        starting = true
        stopWhenStarted = false
        changed?()
        // The reply holds the button until the player started, so a start that a close or another Play overtook still
        // stops its player.
        context.tools(argv) { [self] status, stdout, stderr in
            starting = false
            guard status == 0, let pid = Self.pid(in: stdout) else {
                problem = Self.problem(status: status, stderr: stderr)
                HubPerf.log("request.action play-meeting failed: \(problem?.detail ?? "exit \(status)")")
                changed?()
                return
            }
            if stopWhenStarted {
                stopWhenStarted = false
                context.stop(pid)
                changed?()
                return
            }
            self.pid = pid
            changed?()
            context.whenExits(pid) { [weak self] in
                guard let self, self.pid == pid else { return }
                self.pid = nil
                changed?()
            }
        }
    }

    private func stop(_ playing: Int32) {
        guard pid == playing else { return }
        context.stop(playing)
        pid = nil
        changed?()
    }

    func stopPlaying() {
        if let pid {
            stop(pid)
        } else if starting {
            stopWhenStarted = true
        }
    }

    func close() {
        changed = nil
        willPlay = nil
        stopPlaying()
    }

    /// The player's pid from `play --json`; nil when the plan started no player.
    static func pid(in stdout: String) -> Int32? {
        guard let object = try? JSONSerialization.jsonObject(with: Data(stdout.utf8)) as? [String: Any],
              let pid = object["pid"] as? Int else { return nil }
        return Int32(pid)
    }

    /// The CLI's refusal as a sentence a person reads and the CLI's own text for Details. The meetings CLI writes its
    /// error as one JSON line on stderr (`{"error":{"data":{"code":…},"message":…}}`); its code picks the sentence.
    static func problem(status: Int32, stderr: String) -> RequestActionProblem {
        let lines = stderr.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let error = lines.lazy.compactMap { line -> [String: Any]? in
            guard line.hasPrefix("{"),
                  let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { return nil }
            return object["error"] as? [String: Any]
        }.first
        let message = (error?["message"] as? String)
            ?? lines.last.map { $0.replacingOccurrences(of: #"^[✗×]\s*"#, with: "", options: .regularExpression) }
            ?? "exit \(status)"
        // A refusal the CLI wraps names its code only as the message's lead (`[no-transcript-source] …`).
        let lead = message.range(of: #"^\[[a-z0-9-]+\]"#, options: .regularExpression)
            .map { String(message[$0].dropFirst().dropLast()) }
        let code = (error?["data"] as? [String: Any])?["code"] as? String ?? lead ?? error?["code"] as? String
        return RequestActionProblem(sentence: sentence(code: code), detail: message)
    }

    /// The plain sentence for a refusal code of `meetings play`.
    static func sentence(code: String?) -> String {
        switch code {
        case "no-transcript-source", "no-audio", "no-sound", "no-source-audio", "unplayable":
            "This meeting has no sound to play yet."
        case "no-ffmpeg":
            "ffmpeg is not installed, so the clip cannot be cut."
        case "recording":
            "The meeting is still being recorded."
        default:
            "The clip could not play."
        }
    }
}

/// `open-link`: opens an http(s) page; a genesis.tools router link opens its app.
@MainActor
final class OpenLinkButton: RequestActionButton {
    private let action: RequestPresentParamsActionsItemOption1
    private let context: RequestActionContext
    let problem: RequestActionProblem? = nil
    var changed: (() -> Void)?
    /// Opening a page plays nothing, so this is never called.
    var willPlay: (() -> Void)?

    init(_ action: RequestPresentParamsActionsItemOption1, context: RequestActionContext) {
        self.action = action
        self.context = context
    }

    static func make(_ item: RequestPresentParamsActionsItem, _ context: RequestActionContext) -> RequestActionButton? {
        guard case let .option1(link) = item,
              let url = URL(string: link.url), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return nil }
        return OpenLinkButton(link, context: context)
    }

    /// Holds no reference to the button: the link opens its page even when only the window keeps it.
    var link: ApprovalLink {
        let open = context.open
        let url = URL(string: action.url)
        return ApprovalLink(title: action.label, symbol: "arrow.up.forward.square") {
            if let url { open(url) }
        }
    }

    var footnote: String { "\(action.label) only opens the page." }

    func prepare() {}

    func close() {
        changed = nil
        willPlay = nil
    }
}
