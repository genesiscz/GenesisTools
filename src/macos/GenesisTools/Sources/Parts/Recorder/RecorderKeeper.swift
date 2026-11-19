import Darwin
import Foundation

/// Runs in the widget. A healthy recorder costs one kernel exit subscription and no timer.
@MainActor
package final class RecorderKeeper {
    package static let shared = RecorderKeeper(owner: { recorderInstance.runningPID }, launch: { completion in
        DispatchQueue.global(qos: .utility).async {
            let result = FaceLaunch.startAndWait(["--recorder", "--no-activate"], timeout: 10)
            DispatchQueue.main.async { completion(result) }
        }
    }, watch: observeExit, later: { seconds, run in
        let work = DispatchWorkItem(block: run)
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
        return { work.cancel() }
    })

    typealias Cancel = () -> Void
    private let owner: () -> pid_t?
    private let launch: (@escaping (Result<pid_t, Error>) -> Void) -> Void
    private let watch: (pid_t, @escaping (Int32) -> Void) throws -> Cancel
    private let later: (TimeInterval, @escaping () -> Void) -> Cancel
    private var enabled = false
    private var launching = false
    private var cancelWatch: Cancel?
    private var cancelRetry: Cancel?
    private var nextDelay: TimeInterval = 1
    private var generation: UInt = 0

    init(owner: @escaping () -> pid_t?, launch: @escaping (@escaping (Result<pid_t, Error>) -> Void) -> Void,
         watch: @escaping (pid_t, @escaping (Int32) -> Void) throws -> Cancel,
         later: @escaping (TimeInterval, @escaping () -> Void) -> Cancel) {
        self.owner = owner
        self.launch = launch
        self.watch = watch
        self.later = later
    }

    package func setEnabled(_ value: Bool) {
        enabled = value
        if value {
            ensureRunning()
        } else {
            generation &+= 1
            cancelRetry?()
            cancelRetry = nil
            cancelWatch?()
            cancelWatch = nil
            nextDelay = 1
        }
    }

    private func ensureRunning() {
        guard enabled, !launching, cancelWatch == nil, cancelRetry == nil else { return }
        if let pid = owner() {
            observe(pid)
            return
        }
        launching = true
        launch { [weak self] result in
            guard let self else { return }
            launching = false
            guard enabled else { return }
            switch result {
            case .success(let pid):
                // A concurrent install/launch can win the instance lock while our launcher forwards to it.
                observe(owner() ?? pid)
            case .failure(let error):
                HubPerf.log("recorder: keeper could not launch: \(error.localizedDescription)")
                retry()
            }
        }
    }

    private func observe(_ pid: pid_t) {
        let started = ContinuousClock.now
        let observedGeneration = generation
        do {
            cancelWatch = try watch(pid) { [weak self] status in
                guard let self, generation == observedGeneration else { return }
                HubPerf.log("recorder: pid \(pid) exited with \(Self.exitReason(status))")
                cancelWatch?()
                cancelWatch = nil
                if started.duration(to: .now) >= .seconds(60) { nextDelay = 1 }
                retry()
            }
        } catch {
            HubPerf.log("recorder: keeper could not observe pid \(pid): \(error.localizedDescription)")
            retry()
        }
    }

    private func retry() {
        guard enabled else { return }
        let delay = nextDelay
        nextDelay = min(60, delay * 2)
        let scheduledGeneration = generation
        cancelRetry = later(delay) { [weak self] in
            guard let self, generation == scheduledGeneration else { return }
            cancelRetry = nil
            ensureRunning()
        }
    }

    static func exitReason(_ status: Int32) -> String {
        let signal = status & 0x7f
        return signal == 0 ? "code \((status >> 8) & 0xff)" : "signal \(signal)"
    }

    /// NOTE_EXITSTATUS supplies a wait status for a same-user process, including a recorder launched by
    /// Launch Services before the widget started. SIGKILL cannot be logged from inside the dying face.
    private static func observeExit(_ pid: pid_t, exited: @escaping (Int32) -> Void) throws -> Cancel {
        guard pid > 0 else { throw POSIXError(.ESRCH) }
        let descriptor = kqueue()
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        var change = kevent(ident: UInt(pid), filter: Int16(EVFILT_PROC), flags: UInt16(EV_ADD | EV_ONESHOT),
                            fflags: UInt32(NOTE_EXIT) | UInt32(NOTE_EXITSTATUS), data: 0, udata: nil)
        guard fcntl(descriptor, F_SETFD, FD_CLOEXEC) == 0, kevent(descriptor, &change, 1, nil, 0, nil) == 0 else {
            let error = POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            close(descriptor)
            throw error
        }
        let source = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: .main)
        source.setEventHandler {
            var event = kevent()
            var timeout = timespec()
            if kevent(descriptor, nil, 0, &event, 1, &timeout) == 1 {
                exited(Int32(truncatingIfNeeded: event.data))
            }
        }
        source.setCancelHandler { close(descriptor) }
        source.resume()
        return { source.cancel() }
    }
}
