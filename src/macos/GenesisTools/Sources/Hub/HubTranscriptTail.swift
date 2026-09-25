import Foundation

/// Wakes the open transcript when its session file grows: a file-system event source on the JSONL
/// (write, extend), coalesced to one callback per `debounce`, never a timer poll. A rename or delete
/// (a rotated or replaced file) reopens the file once, so a new inode keeps being followed.
@MainActor
final class HubTranscriptTail {
    private let path: String
    private let debounce: TimeInterval
    private let onGrow: () -> Void
    private var source: DispatchSourceFileSystemObject?
    private var pending: DispatchWorkItem?

    init(path: String, debounce: TimeInterval = 0.25, onGrow: @escaping () -> Void) {
        self.path = path
        self.debounce = debounce
        self.onGrow = onGrow
        open()
    }

    deinit {
        source?.cancel()
    }

    func stop() {
        pending?.cancel()
        pending = nil
        source?.cancel()
        source = nil
    }

    private func open() {
        let descriptor = Darwin.open(path, O_EVTONLY)
        guard descriptor >= 0 else {
            HubPerf.log("transcript.tail cannot watch \((path as NSString).lastPathComponent) (errno \(errno))")
            return
        }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: descriptor, eventMask: [.write, .extend, .rename, .delete], queue: .main)
        source.setEventHandler { [weak self] in
            MainActor.assumeIsolated {
                guard let self, let source = self.source else { return }
                if source.data.contains(.rename) || source.data.contains(.delete) {
                    self.stop()
                    // The writer replaced the file: follow the new one at the same path.
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                        MainActor.assumeIsolated { self?.open() }
                    }
                }
                self.schedule()
            }
        }
        source.setCancelHandler { Darwin.close(descriptor) }
        self.source = source
        source.resume()
    }

    private func schedule() {
        guard pending == nil else { return }
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                self?.pending = nil
                self?.onGrow()
            }
        }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + debounce, execute: work)
    }
}
