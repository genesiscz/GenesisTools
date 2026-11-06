import Foundation

/// One editor window's edit session on the recorder service (`tools recorder serve`), over the recorder host's own
/// connection (`RecorderServiceHost`): the service holds the edit, applies every op, keeps the undo stack and saves;
/// the window sends ops and draws the project the service answers. It opens again after each new connection (a
/// restarted service lost the last one's sessions) and tells the window when another writer changed the edit.
///
/// While no service answers (`isOnline` false) the window falls back to `tools recorder apply` and the file watcher.
@MainActor
final class EditorSession {
    /// The edit file the session holds (`edit.json`, or `<name>.edit.json` beside a plain movie).
    let path: String
    private let host: @MainActor () -> RecorderServiceLink?
    /// This window's hold on the service: every editor window shares the app's one connection, and the service counts
    /// each holder apart, so one window's close leaves another window's session of the same edit open.
    let holder = UUID().uuidString
    /// The revision of the project the window last took from the service.
    private(set) var revision: Int?
    /// The undo steps the service keeps for the edit, from the last `session.open`.
    private(set) var undoDepth: Int?
    private(set) var isOpen = false
    /// The service answered `session.open`: the project it holds, which replaces the window's.
    var onOpened: ((EditProject) -> Void)?
    /// Another writer (an agent, the CLI) changed the edit; the window fetches it with `refetch`.
    var onOutsideChange: ((RecorderProtocol.ProjectChanged) -> Void)?
    /// The connection went away or came back.
    var onOnlineChange: ((Bool) -> Void)?
    private var opening = false

    init(path: String, host: @escaping @MainActor () -> RecorderServiceLink? = { RecorderServiceHost.shared }) {
        self.path = URL(fileURLWithPath: path).standardizedFileURL.path
        self.host = host
    }

    var isOnline: Bool { isOpen && host()?.isConnected == true }

    /// Whether the service lists `method` (an older service may not have a newer op's method).
    func offers(_ method: String) -> Bool { host()?.serviceMethods.contains(method) ?? false }

    func start() {
        host()?.listen(self, notification: { [weak self] method, params in
            self?.notified(method, params)
        }, connected: { [weak self] in
            self?.isOpen = false
            self?.open()
        })
        open()
    }

    func stop() {
        host()?.unlisten(self)
        guard isOpen else { return }
        isOpen = false
        host()?.call("session.close", params: ["path": path, "holder": holder], timeout: 10, onProgress: nil) { result in
            if case let .failure(error) = result { HubPerf.log("recorder.editor: session.close failed: \(error.localizedDescription)") }
        }
    }

    private func open() {
        guard let host = host(), host.isConnected, !opening else { return }
        opening = true
        host.call("session.open", params: ["path": path, "holder": holder], timeout: 30, onProgress: nil) { [weak self] result in
            guard let self else { return }
            self.opening = false
            switch result {
            case let .success(value):
                do {
                    let opened = try RecorderProtocol.decode(RecorderProtocol.OpenedSession.self, from: value)
                    self.revision = opened.revision
                    self.undoDepth = opened.undoDepth
                    let wasOpen = self.isOpen
                    self.isOpen = true
                    HubPerf.log("recorder.editor: session open on the recorder service (\(self.path), revision \(opened.revision))")
                    self.onOpened?(opened.project)
                    if !wasOpen { self.onOnlineChange?(true) }
                } catch {
                    HubPerf.log("recorder.editor: session.open answer did not decode: \(error)")
                }
            case let .failure(error):
                HubPerf.log("recorder.editor: session.open failed, editing through tools: \(error.localizedDescription)")
            }
        }
    }

    /// The edit as the service holds it now (after another writer's change).
    func refetch(_ done: @escaping (EditProject) -> Void) {
        call("session.open", ["path": path, "holder": holder]) { [weak self] result in
            guard let self, case let .success(value) = result,
                  let opened = try? RecorderProtocol.decode(RecorderProtocol.OpenedSession.self, from: value) else { return }
            self.revision = opened.revision
            done(opened.project)
        }
    }

    /// A call on the service; a failure carries the service's own message (`LiveRecordingRPCClient.Failure.remote`).
    @discardableResult
    func call(_ method: String, _ params: [String: Any], timeout: TimeInterval = 30,
              onProgress: ((LiveRecordingRPCClient.CallProgress) -> Void)? = nil,
              done: @escaping (Result<Any?, Error>) -> Void) -> Int? {
        guard let host = host() else {
            done(.failure(LiveRecordingRPCClient.Failure.notConnected))
            return nil
        }
        return host.call(method, params: params, timeout: timeout, onProgress: onProgress) { result in
            MainActor.assumeIsolated { done(result) }
        }
    }

    /// The service's answer to an edit (`edit.apply`, `edit.undo`, `edit.redo`, `gesture.commit`).
    func edit(_ method: String, _ params: [String: Any], timeout: TimeInterval = 30,
              done: @escaping (Result<RecorderProtocol.EditAnswer, Error>) -> Void) {
        call(method, params.merging(["path": path]) { $1 }, timeout: timeout) { [weak self] result in
            done(result.flatMap { value in
                Result { try RecorderProtocol.decode(RecorderProtocol.EditAnswer.self, from: value) }
            }.map { answer in
                self?.revision = answer.revision
                return answer
            })
        }
    }

    /// The service's answer to a drag's step (`gesture.begin`, `gesture.preview`, `gesture.cancel`).
    func gesture(_ method: String, _ params: [String: Any], done: @escaping (Result<RecorderProtocol.GestureAnswer, Error>) -> Void) {
        call(method, params.merging(["path": path]) { $1 }, timeout: 10) { result in
            done(result.flatMap { value in Result { try RecorderProtocol.decode(RecorderProtocol.GestureAnswer.self, from: value) } })
        }
    }

    private func notified(_ method: String, _ params: Any?) {
        guard method == "project.changed",
              let changed = try? RecorderProtocol.decode(RecorderProtocol.ProjectChanged.self, from: params),
              URL(fileURLWithPath: changed.path).standardizedFileURL.path == path else { return }
        // The window's own change: its answer carries the project (the notification comes just before it).
        guard changed.by != "editor" else { return }
        guard changed.revision != revision else { return }
        onOutsideChange?(changed)
    }

    /// The message of a refused call, for the window's notice.
    static func reason(_ error: Error) -> String {
        if case let LiveRecordingRPCClient.Failure.remote(_, message) = error { return message }
        return error.localizedDescription
    }
}
