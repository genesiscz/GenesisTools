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

/// One extra button a request declared: a click keeps the window open and answers nothing.
@MainActor
protocol RequestActionButton: AnyObject {
    /// The button as the window shows it now (Play clip, then Stop while the clip plays).
    var link: ApprovalLink { get }
    /// The footnote's sentence about this button, so the footnote says everything the window can do.
    var footnote: String { get }
    /// Why the last click did nothing ("The clip could not play: …"), shown under the rows; nil once it worked.
    var note: String? { get }
    /// Called when `link` or `note` changed, so the window shows the new ones.
    var changed: (() -> Void)? { get set }
    /// The window closed: stop what this button started.
    func close()
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
        (params.actions ?? []).compactMap { action in
            for make in makers {
                if let button = make(action, context) { return button }
            }
            return nil
        }
    }
}

/// `play-meeting`: plays the range with `tools meetings play <meeting> --at --to`, the cut the CLI plays; a second
/// click stops the player, and the button turns back to Play when the clip ends.
@MainActor
final class PlayMeetingButton: RequestActionButton {
    private let action: RequestPresentParamsActionsItemOption0
    private let context: RequestActionContext
    private var pid: Int32?
    private var starting = false
    private(set) var note: String?
    var changed: (() -> Void)?

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
         "--to", String(Int(action.toSec.rounded(.up))), "--json"]
    }

    var link: ApprovalLink {
        pid == nil
            ? ApprovalLink(title: starting ? "Starting…" : action.label, symbol: "play.fill") { [weak self] in self?.play() }
            : ApprovalLink(title: "Stop", symbol: "stop.fill") { [weak self] in self?.stopPlaying() }
    }

    var footnote: String { "\(action.label) only plays the clip." }

    func play() {
        guard pid == nil, !starting else { return }
        starting = true
        note = nil
        changed?()
        context.tools(argv) { [weak self] status, stdout, stderr in
            guard let self else { return }
            starting = false
            guard status == 0, let pid = Self.pid(in: stdout) else {
                let reason = stderr.split(separator: "\n").last.map(String.init) ?? "exit \(status)"
                HubPerf.log("request.action play-meeting failed: exit \(status) \(reason)")
                note = "The clip could not play: \(reason)"
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

    func stopPlaying() {
        guard let pid else { return }
        context.stop(pid)
        self.pid = nil
        changed?()
    }

    func close() {
        changed = nil
        stopPlaying()
    }

    /// The player's pid from `play --json`; nil when the plan started no player.
    static func pid(in stdout: String) -> Int32? {
        guard let object = try? JSONSerialization.jsonObject(with: Data(stdout.utf8)) as? [String: Any],
              let pid = object["pid"] as? Int else { return nil }
        return Int32(pid)
    }
}

/// `open-link`: opens an http(s) page; a genesis.tools router link opens its app.
@MainActor
final class OpenLinkButton: RequestActionButton {
    private let action: RequestPresentParamsActionsItemOption1
    private let context: RequestActionContext
    let note: String? = nil
    var changed: (() -> Void)?

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

    func close() {
        changed = nil
    }
}
