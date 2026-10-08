import AVFoundation
import Combine
import Foundation

@MainActor
public final class NativeAudioPlayback: ObservableObject {
    @Published public private(set) var duration = 0.0
    @Published public private(set) var position = 0.0
    @Published public private(set) var selectionStart = 0.0
    @Published public private(set) var selectionEnd = 0.0
    @Published public private(set) var isPlaying = false
    @Published public private(set) var isLoading = false
    @Published public private(set) var error: String?
    private var player: AVPlayer?
    private var periodic: Any?
    private var boundary: Any?
    private var ended: NSObjectProtocol?
    private var failed: NSObjectProtocol?
    private var loadTask: Task<Void, Never>?
    private var directory: URL?
    private var epoch = UUID()
    private var identity = ""
    private var playbackEpoch = UUID()

    public init() {}
    public var canPlay: Bool { player != nil && !isLoading }
    public var mediaPosition: Double { player?.currentTime().seconds ?? 0 }
    public var volume: Float = 1 { didSet { player?.volume = max(0, min(1, volume)) } }

    public func load(data: Data, fileExtension: String, identity: String, duration: Double) {
        if self.identity == identity { return }
        clear()
        guard duration.isFinite, duration > 0, duration <= 900 else {
            error = "Choose a recording of at most fifteen minutes."
            return
        }
        self.identity = identity
        self.duration = duration
        selectionEnd = duration
        isLoading = true
        let operation = epoch
        loadTask = Task { [weak self] in
            guard let self else { return }
            var prepared: URL?
            do {
                try Task.checkCancellation()
                let folder = try await Task.detached(priority: .userInitiated) {
                    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("genesis-audio-" + UUID().uuidString, isDirectory: true)
                    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                    do {
                        let ext = fileExtension.range(of: "^[a-z0-9]{1,10}$", options: .regularExpression) == nil ? "audio" : fileExtension
                        try data.write(to: folder.appendingPathComponent("source." + ext), options: .atomic)
                        return (folder, folder.appendingPathComponent("source." + ext))
                    } catch {
                        Self.remove(folder)
                        throw error
                    }
                }.value
                prepared = folder.0
                try Task.checkCancellation()
                let asset = AVURLAsset(url: folder.1)
                let deadline = Task {
                    try? await Task.sleep(nanoseconds: 15_000_000_000)
                    if !Task.isCancelled { asset.cancelLoading() }
                }
                defer { deadline.cancel() }
                let playable = try await withTaskCancellationHandler {
                    try await asset.load(.isPlayable)
                } onCancel: { asset.cancelLoading() }
                try Task.checkCancellation()
                guard epoch == operation else { throw CancellationError() }
                guard playable else { throw NSError(domain: "NativeAudio", code: 1, userInfo: [NSLocalizedDescriptionKey: "macOS cannot play this recording. Its original is still preserved."]) }
                directory = folder.0
                prepared = nil
                player = AVPlayer(playerItem: AVPlayerItem(asset: asset))
                player?.volume = max(0, min(1, volume))
                player?.automaticallyWaitsToMinimizeStalling = false
                ended = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: player?.currentItem, queue: .main) { [weak self] _ in
                    Task { @MainActor in if self?.epoch == operation { self?.pause() } }
                }
                failed = NotificationCenter.default.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: player?.currentItem, queue: .main) { [weak self] notification in
                    let detail = (notification.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error)?.localizedDescription ?? "Audio playback failed."
                    Task { @MainActor in if self?.epoch == operation { self?.pause(); self?.error = detail } }
                }
                isLoading = false
                seek(to: selectionStart)
            } catch {
                if let prepared { Self.remove(prepared) }
                if epoch == operation {
                    isLoading = false
                    if !(error is CancellationError) { self.error = error.localizedDescription }
                }
                PerfLog.mark("native-audio: preparation ended: \(error)")
            }
        }
    }

    @discardableResult
    public func select(start: Double, end: Double) -> Bool {
        let boundedEnd = min(end, duration)
        guard start.isFinite, end.isFinite, start >= 0, boundedEnd > start, end <= duration + 0.0005 else {
            error = "Enter a start and end within this recording."
            return false
        }
        pause()
        error = nil
        selectionStart = start
        selectionEnd = boundedEnd
        seek(to: start)
        return true
    }

    public func seek(to value: Double) {
        guard value.isFinite, duration > 0 else { return }
        let time = min(selectionEnd, max(selectionStart, value))
        position = time
        player?.seek(to: CMTime(seconds: time, preferredTimescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero)
    }

    public func playSelection() {
        guard let player, !isLoading, selectionEnd > selectionStart else { return }
        pause()
        error = nil
        let token = playbackEpoch
        player.currentItem?.forwardPlaybackEndTime = CMTime(seconds: selectionEnd, preferredTimescale: 1000)
        boundary = player.addBoundaryTimeObserver(forTimes: [NSValue(time: CMTime(seconds: selectionEnd, preferredTimescale: 1000))], queue: .main) { [weak self] in
            Task { @MainActor in
                guard let self, self.playbackEpoch == token else { return }
                self.pause()
                self.position = self.selectionEnd
            }
        }
        periodic = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.2, preferredTimescale: 1000), queue: .main) { [weak self] time in
            let seconds = time.seconds
            Task { @MainActor in
                guard let self, self.playbackEpoch == token, seconds.isFinite else { return }
                self.position = min(self.selectionEnd, max(self.selectionStart, seconds))
            }
        }
        isPlaying = true
        position = selectionStart
        player.seek(to: CMTime(seconds: selectionStart, preferredTimescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self, weak player] finished in
            Task { @MainActor in
                guard let self, self.playbackEpoch == token else { return }
                if finished { player?.play() }
                else { self.pause(); self.error = "The recording could not seek to this interval." }
            }
        }
    }

    public func pause() {
        playbackEpoch = UUID()
        player?.pause()
        isPlaying = false
        if let periodic { player?.removeTimeObserver(periodic); self.periodic = nil }
        if let boundary { player?.removeTimeObserver(boundary); self.boundary = nil }
    }

    public func clear() {
        epoch = UUID()
        loadTask?.cancel()
        loadTask = nil
        pause()
        if let ended { NotificationCenter.default.removeObserver(ended); self.ended = nil }
        if let failed { NotificationCenter.default.removeObserver(failed); self.failed = nil }
        player = nil
        if let directory { Self.remove(directory); self.directory = nil }
        identity = ""
        duration = 0; position = 0; selectionStart = 0; selectionEnd = 0
        isLoading = false; error = nil
    }

    private nonisolated static func remove(_ folder: URL) {
        do { try FileManager.default.removeItem(at: folder) }
        catch { PerfLog.mark("native-audio: temporary file cleanup failed: \(error)") }
    }

    deinit {
        loadTask?.cancel()
        if let periodic { player?.removeTimeObserver(periodic) }
        if let boundary { player?.removeTimeObserver(boundary) }
        if let ended { NotificationCenter.default.removeObserver(ended) }
        if let failed { NotificationCenter.default.removeObserver(failed) }
        if let directory { Self.remove(directory) }
    }
}
