import Foundation

/// What a recorder's socket said, laid over its live file: the newest state, frames, warning, connected displays and
/// display mode. Pure, so the message shapes are tested without a socket.
public struct LiveRecordingOverlay: Equatable, Sendable {
    public var state: String?
    public var frames: Int?
    public var lastFrameAt: Date?
    public var warning: String?
    public var mode: String?
    public var displays: [LiveRecording.ConnectedDisplay]?
    public var lastError: String?

    public init() {}

    /// The result of `status`, or the params of a `state` notification.
    public mutating func applyStatus(_ value: Any?) {
        guard let object = value as? [String: Any] else {
            if let text = value as? String { state = text }
            return
        }

        if let text = object["state"] as? String { state = text }
        if let number = object["frames"] as? NSNumber { frames = number.intValue }
        if let at = LiveRecordingStore.date(object["lastFrameAt"]) { lastFrameAt = at }
        if let text = object["mode"] as? String { mode = text }
        if object.keys.contains("warning") { warning = (object["warning"] as? String).flatMap { $0.isEmpty ? nil : $0 } }
        if let list = object["connectedDisplays"] { applyDisplays(list) }
    }

    /// One `frame` notification: `{displayId, at, file}`.
    public mutating func applyFrame(_ value: Any?) {
        frames = (frames ?? 0) + 1
        if let at = LiveRecordingStore.date((value as? [String: Any])?["at"]) { lastFrameAt = at }
    }

    /// `displays.list`'s result or a `displays` notification: a list, or `{displays: [...], mode}`.
    public mutating func applyDisplays(_ value: Any?) {
        let object = value as? [String: Any]
        if let text = object?["mode"] as? String { mode = text }
        guard let list = (object?["displays"] ?? value) as? [[String: Any]] else { return }

        displays = list.compactMap { display in
            guard let id = ((display["id"] ?? display["displayId"]) as? NSNumber)?.int64Value else { return nil }
            return LiveRecording.ConnectedDisplay(
                id: id, name: display["name"] as? String ?? "Display \(id)",
                recorded: (display["recorded"] as? Bool) ?? false)
        }
    }

    /// A `warning` notification: a string, or `{message}` / `{warning}`.
    public mutating func applyWarning(_ value: Any?) {
        let object = value as? [String: Any]
        let text = (value as? String) ?? (object?["message"] as? String) ?? (object?["warning"] as? String)
        warning = text.flatMap { $0.isEmpty ? nil : $0 }
    }

    public func merged(into entry: LiveRecording) -> LiveRecording {
        var recording = entry
        if let state { recording.state = state }
        if let frames { recording.frames = max(frames, entry.frames) }
        if let lastFrameAt { recording.lastFrameAt = lastFrameAt }
        if let warning { recording.warning = warning }
        recording.mode = mode
        recording.connectedDisplays = displays ?? []
        recording.lastError = lastError
        return recording
    }
}

/// One subscribed connection to one live recording's socket. A refused socket or an `ended` notification makes the
/// recording count as gone; a dropped connection is tried again at most every 2 s while the file stays.
@MainActor
final class LiveRecordingSession {
    enum Link: Equatable { case connected, refused, disconnected, ended, noSocket }

    /// A new file (another pid or socket) is a new session.
    let key: String
    private(set) var link: Link = .disconnected
    private(set) var overlay = LiveRecordingOverlay()
    var onChange: (() -> Void)?

    private let socket: String?
    private var client: LiveRecordingRPCClient?
    private var retryAt = Date.distantPast

    init(entry: LiveRecording) {
        key = Self.key(entry)
        socket = entry.socket
    }

    static func key(_ entry: LiveRecording) -> String { "\(entry.id)|\(entry.pid)|\(entry.socket ?? "")" }

    /// The recording as the menu shows it, or nil while it counts as gone.
    func visible(_ entry: LiveRecording) -> LiveRecording? {
        switch link {
        case .connected:
            return overlay.merged(into: entry)
        case .noSocket:
            var recording = entry
            recording.canControl = false
            return recording
        case .refused, .disconnected, .ended:
            return nil
        }
    }

    func connectIfNeeded(now: Date = Date()) {
        guard let socket else {
            link = .noSocket
            return
        }

        guard link == .refused || link == .disconnected, now >= retryAt else { return }
        retryAt = now.addingTimeInterval(2)
        let client = LiveRecordingRPCClient(path: socket)
        do {
            try client.connect()
        } catch {
            link = .refused
            return
        }

        client.onNotification = { [weak self] method, params in
            MainActor.assumeIsolated { self?.notified(method, params) }
        }
        client.onClose = { [weak self, weak client] in
            MainActor.assumeIsolated {
                guard let self, self.client === client, self.link == .connected else { return }
                self.link = .disconnected
                self.onChange?()
            }
        }
        self.client = client
        link = .connected
        client.call("subscribe") { _ in }
        client.call("status") { [weak self] result in
            MainActor.assumeIsolated {
                if case let .success(value) = result { self?.changeOverlay { $0.applyStatus(value) } }
            }
        }
        reloadDisplays()
    }

    func close() {
        client?.close()
        client = nil
    }

    private func notified(_ method: String, _ params: Any?) {
        switch method {
        case "state": changeOverlay { $0.applyStatus(params) }
        case "frame": changeOverlay { $0.applyFrame(params) }
        case "displays": changeOverlay { $0.applyDisplays(params) }
        case "warning": changeOverlay { $0.applyWarning(params) }
        case "ended":
            link = .ended
            close()
            onChange?()
        default: break
        }
    }

    private func changeOverlay(_ change: (inout LiveRecordingOverlay) -> Void) {
        var next = overlay
        change(&next)
        guard next != overlay else { return }
        overlay = next
        onChange?()
    }

    private func reloadDisplays() {
        client?.call("displays.list") { [weak self] result in
            MainActor.assumeIsolated {
                if case let .success(value) = result { self?.changeOverlay { $0.applyDisplays(value) } }
            }
        }
    }

    // MARK: - Control calls

    /// `label` names the action in an error ("Pause failed: …").
    func call(_ method: String, params: [String: Any]? = nil, label: String) {
        guard let client, link == .connected else {
            changeOverlay { $0.lastError = "\(label) failed: not connected to the recorder" }
            return
        }

        client.call(method, params: params) { [weak self] result in
            MainActor.assumeIsolated {
                guard let self else { return }
                switch result {
                case let .success(value):
                    self.changeOverlay {
                        $0.lastError = nil
                        if method.hasPrefix("displays.") { $0.applyDisplays(value) } else { $0.applyStatus(value) }
                    }
                    if method.hasPrefix("displays.") { self.reloadDisplays() }
                case let .failure(error):
                    NSLog("live recording %@ failed: %@", method, error.localizedDescription)
                    self.changeOverlay { $0.lastError = "\(label) failed: \(error.localizedDescription)" }
                }
            }
        }
    }
}
