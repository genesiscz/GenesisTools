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
    /// `rowButtons` are the rows' own buttons by row id (`RequestActions.rowButtons`): each row of `rows` becomes a check,
    /// ticked at first, with its button.
    static func build(_ params: RequestPresentParams, deadline: Date? = nil, actions: [RequestActionButton] = [],
                      rowButtons: [String: RequestActionButton] = [:]) -> ApprovalDialogModel {
        let allow = params.buttons?.confirm ?? "Acknowledge"
        let deny = params.buttons?.decline ?? "Not now"
        let checks = Self.checks(params, rowButtons: rowButtons)
        return ApprovalDialogModel(
            title: params.title, purpose: params.reason, symbol: "info.circle",
            facts: (params.fields ?? []).map { ApprovalFact($0.label, $0.value, help: $0.help) },
            details: [ApprovalFact("Request", params.id, monospaced: true)],
            warning: nil,
            footnote: footnote(allow: allow, deny: deny, declared: params.buttons != nil,
                               actions: actions + rowButtons.values.prefix(1), rows: !checks.isEmpty),
            rememberChoices: [], rememberNote: nil, allowTitle: allow,
            deadline: deadline ?? Date().addingTimeInterval(params.deadlineSeconds ?? 120), identifier: "request-present",
            links: actions.map(\.link), selectable: !checks.isEmpty, deadlineLabel: "Stops waiting in ", denyTitle: deny,
            checks: checks)
    }

    /// The request's rows as checks, each with its button's current words.
    static func checks(_ params: RequestPresentParams, rowButtons: [String: RequestActionButton]) -> [ApprovalCheck] {
        (params.rows ?? []).map { row in
            ApprovalCheck(id: row.id, title: row.title, quote: row.quote, detail: row.detail, link: rowButtons[row.id]?.link)
        }
    }

    /// What the window can do, all of it true: each extra button's sentence, then that the answers change nothing here
    /// (the asking tool acts on the answer).
    static func footnote(allow: String, deny: String, declared: Bool, actions: [RequestActionButton], rows: Bool = false) -> String {
        guard declared || !actions.isEmpty || rows else { return plainNoticeFootnote }
        let answers = rows
            ? "\(allow) answers for the ticked rows and \(deny) for none; the window itself saves and runs nothing else."
            : "\(allow) and \(deny) answer the request; the window itself saves and runs nothing else."
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
    /// Answers the open request and closes its window, once: what Allow, Deny and its deadline call.
    private var finishActive: ((RequestPresentResultStatus, String?, [String]?) -> Void)?
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

    /// Why a window of `change.id` closes: nil while the request still waits for an answer. A request withdrawn by its
    /// caller, answered in another surface or ended any other way is no longer asked here.
    static func endedElsewhere(_ change: RequestChangedEvent) -> String? {
        guard change.outcome.status != .value4 else { return nil }
        let why = change.outcome.reason.map { " \($0)" } ?? ""
        return "This window closed without an answer, because the request ended elsewhere (\(change.state.rawValue)).\(why)"
    }

    /// Closes the window of request `id`, or takes it out of the queue, and answers `obsolete` with `reason`: the
    /// request ended elsewhere, so an answer here would count for nothing. Another id changes nothing.
    func end(_ id: String, reason: String) {
        if active == id {
            finishActive?(.value3, reason, nil)
            return
        }
        guard let index = pending[head...].firstIndex(where: { $0.params.id == id }) else { return }
        let entry = pending.remove(at: index)
        if head == pending.count {
            pending.removeAll(keepingCapacity: true)
            head = 0
        }
        entry.completion(RequestPresentResult(id: id, status: .value3, reason: reason))
    }

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
        let rowButtons = RequestActions.rowButtons(for: params, context: actionContext)
        let model = RequestWindowContent.build(params, deadline: entry.deadline, actions: actions, rowButtons: rowButtons)
        let requestRow = model.details
        let every = actions + (params.rows ?? []).compactMap { rowButtons[$0.id] }
        for action in every {
            // A button that cannot run says why in one sentence under the rows; the CLI's own words fold under Details.
            action.changed = { [weak model] in
                model?.refresh(links: actions.map(\.link))
                if !rowButtons.isEmpty {
                    model?.refresh(checks: RequestWindowContent.checks(params, rowButtons: rowButtons))
                }
                model?.refresh(items: [], summary: every.compactMap(\.problem?.sentence).first)
                model?.refresh(details: requestRow + every.compactMap { action in
                    action.problem.map { ApprovalFact(action.link.title, $0.detail, monospaced: true) }
                })
            }
            // One clip at a time: a button's Play stops the clip another button plays (a row's or the request's own).
            action.willPlay = { [weak action] in
                for other in every where other !== action {
                    other.stopPlaying()
                }
            }
            action.prepare()
        }
        var answered = false
        let finish: (RequestPresentResultStatus, String?, [String]?) -> Void = { [weak self] status, reason, picked in
            guard !answered, let self else { return }
            answered = true
            // A clip still playing stops with the window.
            every.forEach { $0.close() }
            cancelTimeout?()
            cancelTimeout = nil
            panel.close()
            active = nil
            finishActive = nil
            entry.completion(RequestPresentResult(id: params.id, status: status, reason: reason, picked: picked))
            showNext()
        }
        // A request with rows answers done with the rows still ticked, in their order; none ticked cannot confirm.
        model.onAllow = { [weak model] _ in
            guard let rows = params.rows else { return finish(.value0, nil, nil) }
            let picked = rows.map(\.id).filter { model?.selected.contains($0) ?? false }
            guard !picked.isEmpty else { return }
            finish(.value0, nil, picked)
        }
        model.onDeny = { [weak model] in
            let note = model?.denyNote ?? ""
            finish(.value2, note.isEmpty ? nil : note, nil)
        }
        finishActive = finish
        cancelTimeout = clock.after(remaining) { finish(.value4, "The window wait ended; the request stays open.", nil) }
        // The person area owns notice sound/repetition; generic approval reminders would post a second notice.
        panel.present(model, reminders: false)
        if params.takesFocus ?? true { activate() }
    }
}

/// Closes the window of each request that ends elsewhere while it shows or waits here: withdrawn by its caller (a rerun
/// that asks again), answered in a terminal or another window. The service sends every change of its request journal
/// to a subscribed connection as `request.changed`, also a change another process wrote; the stream ends with the
/// connection.
@MainActor
func followEndedRequests(_ rpc: GenesisToolsRPC) {
    Task { @MainActor in
        do {
            for try await change in rpc.events.requestChanged {
                if let reason = RequestPresenter.endedElsewhere(change) { RequestPresenter.shared.end(change.id, reason: reason) }
            }
        } catch {
            HubPerf.log("request window: no request.changed events, so a request that ends elsewhere keeps its window: \(error)")
        }
    }
}

/// A one-shot window never starts the service: without one, nothing else can end its request.
private struct NoServiceForRequestEvents: Error {}

func presentRequest(_ params: RequestPresentParams) {
    MainActor.assumeIsolated {
        // The one-shot window (no resident face was connected) listens on its own connection.
        let events = GenesisToolsRPC(startService: { throw NoServiceForRequestEvents() })
        followEndedRequests(events)
        RequestPresenter.shared.enqueue(params) { result in
            events.close()
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
    followEndedRequests(rpc)
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
