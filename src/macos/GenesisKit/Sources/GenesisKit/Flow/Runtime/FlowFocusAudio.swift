import Darwin
import Foundation

/// Admission to the elected runtime's microphone. Attach a gated recorder before allowing it
/// to open input, then release after the recorder has closed input and exited.
@MainActor
public final class FlowFocusAudioLease {
    private weak var runtime: FlowFocusRuntime?
    private let token: UUID
    private var released = false

    init(runtime: FlowFocusRuntime, token: UUID) {
        self.runtime = runtime
        self.token = token
    }

    public func attachRecorder(pid: Int32) async throws {
        guard !released, let runtime, let identity = FlowAudioProcess.read(pid: pid) else {
            throw FlowFocusMailbox.Failure.unavailable("The recorder is no longer available.")
        }
        let value = FlowAudioAttachment(token: token, recorder: identity)
        _ = try await runtime.send(action: "audio.attach", payload: JSONEncoder().encode(value))
    }

    public func release() async throws {
        guard !released else { return }
        guard let runtime else {
            throw FlowFocusMailbox.Failure.unavailable("The audio owner is no longer available.")
        }
        _ = try await runtime.send(action: "audio.release", payload: JSONEncoder().encode(token))
        released = true
    }
}

struct FlowAudioProcess: Codable, Equatable {
    let pid: Int32
    let seconds: UInt64
    let microseconds: UInt64

    static func read(pid: Int32) -> Self? {
        var info = proc_bsdinfo()
        let size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size))
        guard size == MemoryLayout<proc_bsdinfo>.size, info.pbi_uid == geteuid() else { return nil }
        return Self(pid: pid, seconds: info.pbi_start_tvsec, microseconds: info.pbi_start_tvusec)
    }

    var isAlive: Bool {
        if let current = Self.read(pid: pid) { return current == self }
        return kill(pid, 0) == 0 || errno == EPERM
    }

    func isDescendant(of ancestor: Self) -> Bool {
        guard ancestor.isAlive, isAlive, pid != ancestor.pid else { return false }
        var current = pid
        for _ in 0 ..< 32 {
            var info = proc_bsdinfo()
            guard proc_pidinfo(current, PROC_PIDTBSDINFO, 0, &info,
                               Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size else { return false }
            let parent = Int32(info.pbi_ppid)
            if parent == ancestor.pid { return true }
            guard parent > 1, parent != current else { return false }
            current = parent
        }
        return false
    }
}

struct FlowAudioAdmission: Codable {
    let token: UUID
    let holder: FlowAudioProcess
    var recorder: FlowAudioProcess?
    var attachBefore: Date
}

struct FlowAudioAttachment: Codable {
    let token: UUID
    let recorder: FlowAudioProcess
}

/// This record is subordinate to FlowFocusLease: only the elected runtime processes commands
/// or writes it. It survives runtime handoff, so a new owner cannot reopen pre-roll over a live
/// Voice Notes recorder. It is never an alternative feature-owner lock.
@MainActor
final class FlowFocusAudioCoordinator {
    private let url: URL
    private let flow: FlowSession
    private var admission: FlowAudioAdmission?
    private var processExit: DispatchSourceProcess?
    private var attachmentDeadline: Task<Void, Never>?
    private var elected = false
    var onFailure: ((String) -> Void)?

    init(directory: URL, flow: FlowSession) {
        url = directory.appendingPathComponent("audio-admission.json")
        self.flow = flow
    }

    func start() throws {
        elected = true
        try refresh()
    }

    func stopObserving() {
        elected = false
        attachmentDeadline?.cancel()
        attachmentDeadline = nil
        processExit?.cancel()
        processExit = nil
    }

    func acquire(_ requested: FlowAudioAdmission) throws {
        try requireOwner()
        try refresh()
        if admission?.token == requested.token { return }
        guard admission == nil, flow.phase == .idle || flow.phase == .error else {
            throw FlowFocusMailbox.Failure.unavailable("Audio is already in use. Finish the current dictation or recording first.")
        }
        guard requested.recorder == nil, requested.holder.isAlive else {
            throw FlowFocusMailbox.Failure.unavailable("The recording host is no longer available.")
        }
        var admitted = requested
        admitted.attachBefore = Date().addingTimeInterval(30)
        try persist(admitted)
    }

    func attach(_ request: FlowAudioAttachment) throws {
        try requireOwner()
        try refresh()
        guard var current = admission, current.token == request.token,
              request.recorder.isDescendant(of: current.holder) else {
            throw FlowFocusMailbox.Failure.unavailable("This recorder does not belong to the admitted recording host.")
        }
        if let existing = current.recorder, existing != request.recorder {
            throw FlowFocusMailbox.Failure.unavailable("A recorder is already attached to this audio admission.")
        }
        current.recorder = request.recorder
        try persist(current)
    }

    func release(_ token: UUID) throws {
        try requireOwner()
        try refresh()
        guard let current = admission else { return }
        guard current.token == token else {
            throw FlowFocusMailbox.Failure.unavailable("This audio admission belongs to another recording.")
        }
        guard current.recorder?.isAlive != true else {
            throw FlowFocusMailbox.Failure.unavailable("Stop the recorder before releasing audio.")
        }
        try clear()
    }

    private func requireOwner() throws {
        guard elected else { throw FlowFocusMailbox.Failure.unavailable("Flow and Focus do not own audio here.") }
    }

    private func refresh() throws {
        guard FileManager.default.fileExists(atPath: url.path) else {
            install(nil)
            return
        }
        let current = try JSONDecoder().decode(FlowAudioAdmission.self, from: Data(contentsOf: url))
        guard (current.recorder ?? current.holder).isAlive,
              current.recorder != nil || current.attachBefore > Date() else {
            try clear()
            return
        }
        install(current)
    }

    private func persist(_ value: FlowAudioAdmission) throws {
        try FlowFocusLease.writePrivate(JSONEncoder().encode(value), to: url)
        install(value)
    }

    private func clear() throws {
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        install(nil)
    }

    private func install(_ value: FlowAudioAdmission?) {
        let previousProcess = admission.map { $0.recorder ?? $0.holder }
        admission = value
        flow.setExternalAudioHeld(value != nil)
        attachmentDeadline?.cancel()
        attachmentDeadline = nil
        if let value, value.recorder == nil {
            let seconds = max(0, value.attachBefore.timeIntervalSinceNow)
            attachmentDeadline = Task { @MainActor [weak self] in
                do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
                guard let self, self.elected, self.admission?.token == value.token else { return }
                do { try self.refresh() }
                catch { self.onFailure?(error.localizedDescription) }
            }
        }
        let process = value.map { $0.recorder ?? $0.holder }
        guard previousProcess != process || processExit == nil else { return }
        processExit?.cancel()
        processExit = nil
        guard let process else { return }
        let source = DispatchSource.makeProcessSource(identifier: process.pid, eventMask: .exit, queue: .main)
        source.setEventHandler { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.elected,
                      self.admission.map({ $0.recorder ?? $0.holder }) == process else { return }
                // NOTE_EXIT proves this exact watched process ended, even before its parent
                // reaps the zombie. A liveness poll here could miss the only exit wakeup.
                do { try self.clear() }
                catch { self.onFailure?(error.localizedDescription) }
            }
        }
        processExit = source
        source.resume()
    }
}
