import AppKit
import Foundation
import Darwin

@MainActor
enum RequestWindowContent {
    /// `deadline` is when the caller stops waiting; nil counts the request's own seconds from now.
    static func build(_ params: RequestPresentParams, deadline: Date? = nil) -> ApprovalDialogModel {
        ApprovalDialogModel(
            title: params.title, purpose: params.reason, symbol: "info.circle",
            facts: [ApprovalFact("Request", params.id, monospaced: true)], details: [],
            warning: nil, footnote: "This notice asks for an acknowledgement. It runs no command.",
            rememberChoices: [], rememberNote: nil, allowTitle: "Acknowledge",
            deadline: deadline ?? Date().addingTimeInterval(params.deadlineSeconds ?? 120), identifier: "request-present", deadlineLabel: "Stops waiting in ")
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
    private let capacity: Int
    private let activate: () -> Void
    private var active: String?
    /// A FIFO read from `head`, so taking the next one never shifts the rest.
    private var pending: [Entry] = []
    private var head = 0
    private var cancelTimeout: (() -> Void)?
    var onIdle: (() -> Void)?
    var onBusy: (() -> Void)?

    init(panel: RequestPanel? = nil, clock: RequestClock = .live, capacity: Int? = nil, activate: (() -> Void)? = nil) {
        self.panel = panel ?? ApprovalPanelPresenter()
        self.clock = clock
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
        let model = RequestWindowContent.build(params, deadline: entry.deadline)
        var answered = false
        let finish: (RequestPresentResultStatus, String?) -> Void = { [weak self] status, reason in
            guard !answered, let self else { return }
            answered = true
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
    guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else { close(descriptor); exit(0) }
    let rpc = GenesisToolsRPC(path: socket)
    residentRequests = rpc
    rpc.serve.requestPresent { params in await RequestPresenter.shared.show(params) }
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
