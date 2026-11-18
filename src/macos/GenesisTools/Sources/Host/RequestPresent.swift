import AppKit
import Foundation
import Darwin
import UserNotifications

@MainActor
enum RequestWindowContent {
    static func build(_ params: RequestPresentParams) -> ApprovalDialogModel {
        ApprovalDialogModel(
            title: params.title, purpose: params.reason, symbol: "info.circle",
            facts: [ApprovalFact("Request", params.id, monospaced: true)], details: [],
            warning: nil, footnote: "This notice asks for an acknowledgement. It runs no command.",
            rememberChoices: [], rememberNote: nil, allowTitle: "Acknowledge",
            deadline: Date().addingTimeInterval(params.deadlineSeconds ?? 120), identifier: "request-present", deadlineLabel: "Stops waiting in ")
    }
}

@MainActor
final class RequestPresenter {
    static let shared = RequestPresenter()
    private let panel = ApprovalPanelPresenter()
    private var active: String?
    private var pending: [(RequestPresentParams, (RequestPresentResult) -> Void)] = []
    private var timeout: DispatchWorkItem?
    var onIdle: (() -> Void)?
    var onBusy: (() -> Void)?

    func show(_ params: RequestPresentParams) async -> RequestPresentResult {
        await withCheckedContinuation { continuation in
            enqueue(params) { continuation.resume(returning: $0) }
        }
    }

    func enqueue(_ params: RequestPresentParams, completion: @escaping (RequestPresentResult) -> Void) {
        onBusy?()
        pending.append((params, completion))
        showNext()
    }

    private func showNext() {
        guard active == nil, !pending.isEmpty else { return }
        let (params, completion) = pending.removeFirst()
        active = params.id
        let model = RequestWindowContent.build(params)
        var answered = false
        let finish: (RequestPresentResultStatus, String?) -> Void = { [weak self] status, reason in
            guard !answered, let self else { return }
            answered = true
            timeout?.cancel()
            timeout = nil
            panel.close()
            active = nil
            completion(RequestPresentResult(id: params.id, status: status, reason: reason))
            showNext()
            if pending.isEmpty, active == nil { onIdle?() }
        }
        model.onAllow = { _ in finish(.value0, nil) }
        model.onDeny = { [weak model] in
            let note = model?.denyNote ?? ""
            finish(.value2, note.isEmpty ? nil : note)
        }
        let deadline = DispatchWorkItem { MainActor.assumeIsolated { finish(.value4, "The window wait ended; the request stays open.") } }
        timeout = deadline
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0.001, params.deadlineSeconds ?? 120), execute: deadline)
        // The person area owns notice sound/repetition; generic approval reminders would post a second notice.
        panel.present(model, reminders: false)
        if params.takesFocus ?? true { NSApp.activate(ignoringOtherApps: true) }
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
    UNUserNotificationCenter.current().delegate = sharedNotificationDelegate
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
