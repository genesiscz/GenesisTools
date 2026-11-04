import Darwin
import Foundation

/// The live recordings folder, read again on every change to it (a DispatchSource on the folder) and once a second
/// (a recorder that died leaves its file behind, and only the liveness check notices). Reads off the main thread.
@MainActor
public final class LiveRecordingsWatcher: ObservableObject {
    @Published public private(set) var recordings: [LiveRecording] = []
    /// After every read, changed or not: the clock in an open menu moves with it.
    public var onRefresh: (([LiveRecording]) -> Void)?

    private let store: LiveRecordingStore
    private let queue = DispatchQueue(label: "genesis.live-recordings", qos: .utility)
    private var source: DispatchSourceFileSystemObject?
    private var timer: Timer?
    private var reading = false
    private var readAgain = false

    public init(store: LiveRecordingStore = .live) {
        self.store = store
    }

    deinit {
        timer?.invalidate()
        source?.cancel()
    }

    public func start() {
        guard timer == nil else { return }
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
        timer.tolerance = 0.2
        // `.common`, so the clock keeps going while a menu tracks.
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        refresh()
    }

    public func stop() {
        timer?.invalidate()
        timer = nil
        source?.cancel()
        source = nil
    }

    public func refresh() {
        watchFolder()
        guard !reading else {
            readAgain = true
            return
        }

        reading = true
        let store = store
        queue.async { [weak self] in
            let list = store.load()
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.apply(list) }
            }
        }
    }

    private func apply(_ list: [LiveRecording]) {
        reading = false
        if list != recordings { recordings = list }
        onRefresh?(list)
        if readAgain {
            readAgain = false
            refresh()
        }
    }

    /// The folder may not exist yet (no recorder ran on this Mac); the timer tries again each second.
    private func watchFolder() {
        guard source == nil else { return }
        let descriptor = open(store.folder.path, O_EVTONLY | O_CLOEXEC)
        guard descriptor >= 0 else { return }

        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: descriptor, eventMask: [.write, .delete, .rename], queue: .main)
        source.setEventHandler { [weak self] in
            MainActor.assumeIsolated {
                guard let self, let source = self.source else { return }
                // The folder itself went away or moved: watch the new one at the next tick.
                if !source.data.isDisjoint(with: [.delete, .rename]) {
                    source.cancel()
                    self.source = nil
                }
                self.refresh()
            }
        }
        source.setCancelHandler { close(descriptor) }
        source.resume()
        self.source = source
    }
}
