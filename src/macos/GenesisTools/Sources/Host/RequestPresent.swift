import AppKit
import Foundation
import Darwin

@MainActor
enum RequestWindowContent {
    /// The footnote of a request that declares neither buttons nor actions: it is a plain notice.
    static let plainNoticeFootnote = "This notice asks for an acknowledgement. It runs no command."

    /// `deadline` is when the caller stops waiting; nil counts the request's own seconds from now. The caller declares
    /// what the window shows: its `fields` as rows, its `actions` as buttons that answer nothing, its `buttons` as the
    /// words on the answers. The request id is for a reader of the journal, so it sits folded under Details.
    static func build(_ params: RequestPresentParams, deadline: Date? = nil, actions: [RequestActionButton] = []) -> ApprovalDialogModel {
        let allow = params.buttons?.confirm ?? "Acknowledge"
        let deny = params.buttons?.decline ?? "Not now"
        return ApprovalDialogModel(
            title: params.title, purpose: params.reason, symbol: "info.circle",
            facts: (params.fields ?? []).map { ApprovalFact($0.label, $0.value, help: $0.help) },
            details: [ApprovalFact("Request", params.id, monospaced: true)],
            warning: nil, footnote: footnote(allow: allow, deny: deny, declared: params.buttons != nil, actions: actions),
            rememberChoices: [], rememberNote: nil, allowTitle: allow,
            deadline: deadline ?? Date().addingTimeInterval(params.deadlineSeconds ?? 120), identifier: "request-present",
            links: actions.map(\.link), deadlineLabel: "Stops waiting in ", denyTitle: deny)
    }

    /// What the window can do, all of it true: each extra button's sentence, then that the answers change nothing here
    /// (the asking tool acts on the answer).
    static func footnote(allow: String, deny: String, declared: Bool, actions: [RequestActionButton]) -> String {
        guard declared || !actions.isEmpty else { return plainNoticeFootnote }
        let answers = "\(allow) and \(deny) answer the request; the window itself saves and runs nothing else."
        return (actions.map(\.footnote) + [answers]).joined(separator: " ")
    }
}

/// The panel a request shows in; tests pass a fake, so no window opens.
@MainActor
protocol RequestPanel: AnyObject {
    func present(_ model: ApprovalDialogModel, reminders: Bool)
    func close()
}

extension ApprovalPanelPresenter: RequestPanel {}

/// The time a presenter reads and its timers; tests pass a clock they move by hand.
struct RequestClock {
    var now: () -> Date
    /// Runs `work` on the main actor after `seconds`; the returned closure cancels it.
    var after: (_ seconds: TimeInterval, _ work: @escaping @MainActor () -> Void) -> () -> Void

    static let live = RequestClock(now: Date.init, after: { seconds, work in
        let item = DispatchWorkItem { MainActor.assumeIsolated { work() } }
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: item)
        return { item.cancel() }
    })
}

@MainActor
final class RequestPresenter {
    static let shared = RequestPresenter()
    /// More notices than this waiting behind the open one are answered `unreachable` at once.
    static let defaultCapacity = 32

    private struct Entry {
        let params: RequestPresentParams
        /// When the caller stops waiting, fixed when the request arrives: time spent in the queue counts.
        let deadline: Date
        let completion: (RequestPresentResult) -> Void
    }

    private let panel: RequestPanel
    private let clock: RequestClock
    private let actionContext: RequestActionContext
    private let capacity: Int
    private let activate: () -> Void
    private var active: String?
    /// A FIFO read from `head`, so taking the next one never shifts the rest.
    private var pending: [Entry] = []
    private var head = 0
    private var cancelTimeout: (() -> Void)?
    var onIdle: (() -> Void)?
    var onBusy: (() -> Void)?

    init(panel: RequestPanel? = nil, clock: RequestClock = .live, capacity: Int? = nil, activate: (() -> Void)? = nil,
         actionContext: RequestActionContext = .live) {
        self.panel = panel ?? ApprovalPanelPresenter()
        self.clock = clock
        self.actionContext = actionContext
        self.capacity = capacity ?? Self.defaultCapacity
        self.activate = activate ?? { NSApp.activate(ignoringOtherApps: true) }
    }

    var waiting: Int { pending.count - head }

    func show(_ params: RequestPresentParams) async -> RequestPresentResult {
        await withCheckedContinuation { continuation in
            enqueue(params) { continuation.resume(returning: $0) }
        }
    }

    func enqueue(_ params: RequestPresentParams, completion: @escaping (RequestPresentResult) -> Void) {
        guard waiting < capacity else {
            completion(RequestPresentResult(id: params.id, status: .value5, reason: "Too many notices are waiting to show; this one was not shown."))
            return
        }
        onBusy?()
        let seconds = max(0.001, params.deadlineSeconds ?? 120)
        pending.append(Entry(params: params, deadline: clock.now().addingTimeInterval(seconds), completion: completion))
        showNext()
    }

    private func dequeue() -> Entry? {
        guard head < pending.count else { return nil }
        let entry = pending[head]
        head += 1
        if head == pending.count {
            pending.removeAll(keepingCapacity: true)
            head = 0
        } else if head >= capacity {
            pending.removeFirst(head)
            head = 0
        }
        return entry
    }

    private func showNext() {
        guard active == nil else { return }
        while let entry = dequeue() {
            let remaining = entry.deadline.timeIntervalSince(clock.now())
            if remaining > 0 {
                present(entry, for: remaining)
                return
            }
            // The caller stopped waiting while this one queued: a panel now would ask nobody.
            entry.completion(RequestPresentResult(id: entry.params.id, status: .value4, reason: "The window wait ended before the notice could show; the request stays open."))
        }
        onIdle?()
    }

    private func present(_ entry: Entry, for remaining: TimeInterval) {
        let params = entry.params
        active = params.id
        let actions = RequestActions.buttons(for: params, context: actionContext)
        let model = RequestWindowContent.build(params, deadline: entry.deadline, actions: actions)
        let requestRow = model.details
        for action in actions {
            // A button that cannot run says why in one sentence under the rows; the CLI's own words fold under Details.
            action.changed = { [weak model] in
                model?.refresh(links: actions.map(\.link))
                model?.refresh(items: [], summary: actions.compactMap(\.problem?.sentence).first)
                model?.refresh(details: requestRow + actions.compactMap { action in
                    action.problem.map { ApprovalFact(action.link.title, $0.detail, monospaced: true) }
                })
            }
            action.prepare()
        }
        var answered = false
        let finish: (RequestPresentResultStatus, String?) -> Void = { [weak self] status, reason in
            guard !answered, let self else { return }
            answered = true
            // A clip still playing stops with the window.
            actions.forEach { $0.close() }
            cancelTimeout?()
            cancelTimeout = nil
            panel.close()
            active = nil
            entry.completion(RequestPresentResult(id: params.id, status: status, reason: reason))
            showNext()
        }
        model.onAllow = { _ in finish(.value0, nil) }
        model.onDeny = { [weak model] in
            let note = model?.denyNote ?? ""
            finish(.value2, note.isEmpty ? nil : note)
        }
        cancelTimeout = clock.after(remaining) { finish(.value4, "The window wait ended; the request stays open.") }
        // The person area owns notice sound/repetition; generic approval reminders would post a second notice.
        panel.present(model, reminders: false)
        if params.takesFocus ?? true { activate() }
    }
}

func presentRequest(_ params: RequestPresentParams) {
    MainActor.assumeIsolated {
        RequestPresenter.shared.enqueue(params) { result in
            do {
                let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(result)) as? [String: Any] ?? [:]
                emitResult(object)
            } catch {
                emitError(code: "internal", message: "The request reply could not be encoded.", exitCode: 70)
            }
        }
    }
}

private var residentRequests: GenesisToolsRPC?

/// A resident renderer only. Request state and decisions stay in the TypeScript service.
@MainActor
func runRequestFace(_ arguments: [String]) -> Never {
    // A resident face: a banner click must not quit it (the default) and drop its open and queued requests.
    installNotificationClicksForWindowFace()
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let socket = arguments.firstIndex(of: "--socket").flatMap { index in arguments.indices.contains(index + 1) ? arguments[index + 1] : nil }
        ?? GenesisToolsHome.path("genesis-tools/service.sock")
    let lockPath = socket + ".face.lock"
    do {
        try FileManager.default.createDirectory(at: URL(fileURLWithPath: socket).deletingLastPathComponent(), withIntermediateDirectories: true)
    } catch {
        HubPerf.log("request.face error creating its folder: \(error)")
        exit(73)
    }
    let descriptor = open(lockPath, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
    guard descriptor >= 0 else { HubPerf.log("request.face error opening its lock: \(errno)"); exit(73) }
    var locked = flock(descriptor, LOCK_EX | LOCK_NB)
    while locked != 0, errno == EINTR { locked = flock(descriptor, LOCK_EX | LOCK_NB) }
    if locked != 0 {
        let code = errno
        close(descriptor)
        // Only contention means another face renders the requests; any other error leaves none.
        guard code == EWOULDBLOCK else { HubPerf.log("request.face error taking its lock: \(code)"); exit(73) }
        exit(0)
    }
    let rpc = GenesisToolsRPC(path: socket)
    residentRequests = rpc
    rpc.serve.requestPresent { params in await RequestPresenter.shared.show(params) }
    // A face whose service went away renders nothing yet holds the lock: exit, so the next request starts a new face.
    rpc.onDisconnect = {
        HubPerf.log("request.face lost its service connection; exiting so a new face can take the lock")
        app.terminate(nil)
    }
    Task {
        do { try await rpc.connect() }
        catch { HubPerf.log("request.face connect failed: \(error)"); app.terminate(nil) }
    }
    var idle: DispatchWorkItem?
    let armIdle = {
        idle?.cancel()
        let work = DispatchWorkItem { MainActor.assumeIsolated { rpc.close(); app.terminate(nil) } }
        idle = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 600, execute: work)
    }
    RequestPresenter.shared.onIdle = armIdle
    RequestPresenter.shared.onBusy = { idle?.cancel(); idle = nil }
    armIdle()
    app.run()
    rpc.close()
    close(descriptor)
    exit(0)
}
