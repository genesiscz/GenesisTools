import AVFoundation
import AppKit
import Darwin
import ImageIO
import QuickLookThumbnailing
import UniformTypeIdentifiers

/// What a file shows as: a picture, a moving picture with a poster frame, or any other document.
public enum MediaKind: String, Sendable {
    case image, video, file

    /// By the file's extension only: no disk access, safe in a view body.
    public static func of(path: String) -> MediaKind {
        let ext = (path as NSString).pathExtension
        guard !ext.isEmpty, let type = UTType(filenameExtension: ext) else { return .file }
        if type.conforms(to: .image) { return .image }
        if type.conforms(to: .movie) || type.conforms(to: .video) { return .video }
        return .file
    }
}

/// The identity of a file's current bytes. A path that now holds other bytes (a new capture written over an old
/// one) is a new identity, so the cache can never show a stale picture for it.
public struct MediaFileIdentity: Hashable, Sendable {
    public let path: String
    let device: Int64
    let inode: UInt64
    let size: Int64
    let modifiedNanoseconds: Int64

    /// One `stat`; nil when the file is gone.
    public static func current(_ path: String) -> MediaFileIdentity? {
        var info = stat()
        guard stat(path, &info) == 0 else { return nil }
        return MediaFileIdentity(
            path: path, device: Int64(info.st_dev), inode: UInt64(info.st_ino), size: Int64(info.st_size),
            modifiedNanoseconds: Int64(info.st_mtimespec.tv_sec) * 1_000_000_000 + Int64(info.st_mtimespec.tv_nsec))
    }
}

/// A decoded thumbnail. `CGImage` is immutable, so sharing it across threads is safe.
public struct MediaThumbnail: @unchecked Sendable {
    public let image: CGImage
    public let kind: MediaKind
    /// The source's own size in pixels after orientation, so a view can lay out the real aspect ratio.
    public let sourceSize: CGSize
    /// Seconds, for a video.
    public let duration: Double?
    /// The file type's icon, not a picture of the content: drawn as it is, without a frame.
    public var isIcon = false

    public var aspect: CGFloat {
        sourceSize.height > 0 ? sourceSize.width / sourceSize.height : CGFloat(image.width) / CGFloat(max(1, image.height))
    }
}

public enum MediaThumbnailResult: Sendable {
    case ready(MediaThumbnail)
    case failed(String)
}

/// Thumbnails for images, video poster frames and documents, decoded off the main thread, keyed by file identity
/// and pixel size, deduplicated while in flight and bounded in memory. Pixel sizes round up to powers of two, so a
/// resize does not decode again, and a larger cached picture serves a smaller request.
public actor MediaThumbnailCache {
    public static let shared = MediaThumbnailCache()

    private struct Key: Hashable {
        let identity: MediaFileIdentity
        let bucket: Int
    }

    private var ready: [Key: MediaThumbnail] = [:]
    private var failures: [MediaFileIdentity: String] = [:]
    private var order: [Key] = []
    private var bytes = 0
    private var inflight: [Key: Task<MediaThumbnailResult, Never>] = [:]
    private var running = 0
    private var waiting: [CheckedContinuation<Void, Never>] = []

    private let byteLimit: Int
    private let concurrency: Int
    /// A decode that has not finished by then reports a failure instead of holding the tile in a loading state.
    private let deadline: Duration

    public init(byteLimit: Int = 96 << 20, concurrency: Int = 3, deadline: Duration = .seconds(20)) {
        self.byteLimit = byteLimit
        self.concurrency = concurrency
        self.deadline = deadline
    }

    public static func bucket(forPixels pixels: CGFloat) -> Int {
        let wanted = max(64, min(4096, Int(pixels.rounded(.up))))
        var bucket = 64
        while bucket < wanted { bucket <<= 1 }
        return bucket
    }

    /// `reload` forgets an earlier failure for this file (the retry button) and decodes again.
    public func thumbnail(path: String, maxPixels: CGFloat, kind: MediaKind? = nil, reload: Bool = false) async
        -> MediaThumbnailResult
    {
        guard let identity = MediaFileIdentity.current(path) else {
            return .failed("The file is no longer there.")
        }
        let bucket = Self.bucket(forPixels: maxPixels)
        if reload {
            failures[identity] = nil
        } else if let failure = failures[identity] {
            return .failed(failure)
        }
        if let hit = cached(identity: identity, atLeast: bucket) {
            return .ready(hit)
        }
        let key = Key(identity: identity, bucket: bucket)
        if let running = inflight[key] { return await running.value }
        let resolvedKind = kind ?? MediaKind.of(path: path)
        let deadline = deadline
        let task = Task<MediaThumbnailResult, Never> {
            await self.acquire()
            let result = await Self.decode(path: path, bucket: bucket, kind: resolvedKind, deadline: deadline)
            await self.release()
            return result
        }
        inflight[key] = task
        let result = await task.value
        inflight[key] = nil
        switch result {
        case .ready(let thumbnail): store(thumbnail, for: key)
        case .failed(let message): failures[identity] = message
        }
        return result
    }

    /// Drops everything; for tests and memory pressure.
    public func removeAll() {
        ready.removeAll()
        failures.removeAll()
        order.removeAll()
        bytes = 0
    }

    var cachedBytes: Int { bytes }

    private func cached(identity: MediaFileIdentity, atLeast bucket: Int) -> MediaThumbnail? {
        var candidate = bucket
        while candidate <= 4096 {
            let key = Key(identity: identity, bucket: candidate)
            if let hit = ready[key] {
                touch(key)
                return hit
            }
            candidate <<= 1
        }
        return nil
    }

    private func store(_ thumbnail: MediaThumbnail, for key: Key) {
        if ready[key] == nil { bytes += Self.cost(thumbnail) }
        ready[key] = thumbnail
        touch(key)
        while bytes > byteLimit, let oldest = order.first, oldest != key {
            order.removeFirst()
            if let gone = ready.removeValue(forKey: oldest) { bytes -= Self.cost(gone) }
        }
    }

    private func touch(_ key: Key) {
        if let index = order.firstIndex(of: key) { order.remove(at: index) }
        order.append(key)
    }

    private static func cost(_ thumbnail: MediaThumbnail) -> Int {
        thumbnail.image.bytesPerRow * thumbnail.image.height
    }

    private func acquire() async {
        if running < concurrency {
            running += 1
            return
        }
        await withCheckedContinuation { waiting.append($0) }
    }

    private func release() {
        if waiting.isEmpty {
            running -= 1
        } else {
            waiting.removeFirst().resume()
        }
    }

    // MARK: - Decoding (never on the main thread: the cache actor or a detached task runs it)

    private static func decode(path: String, bucket: Int, kind: MediaKind, deadline: Duration) async
        -> MediaThumbnailResult
    {
        let started = ContinuousClock.now
        let decoded = await firstResult(within: deadline) { () async -> MediaThumbnailResult in
            switch kind {
            case .image:
                if let image = decodeImage(path: path, bucket: bucket) { return .ready(image) }
                // Quick Look reads a few formats ImageIO does not; its file-type icon is no picture of this one.
                let fallback = await decodeDocument(path: path, bucket: bucket, kind: .image)
                if case .ready(let thumbnail) = fallback, thumbnail.isIcon {
                    return .failed("The image could not be read.")
                }
                return fallback
            case .video: return await decodeVideo(path: path, bucket: bucket)
            case .file: return await decodeDocument(path: path, bucket: bucket, kind: .file)
            }
        }
        let result = decoded ?? .failed("The preview took too long to make.")
        let elapsed = ContinuousClock.now - started
        if elapsed > .milliseconds(100) {
            PerfLog.mark("media.thumbnail SLOW kind=\(kind.rawValue) px=\(bucket) \(elapsed) \((path as NSString).lastPathComponent)")
        }
        return result
    }

    /// The work's result, or nil once `deadline` passes, whichever comes first. A task group would wait for its
    /// children before returning, and ImageIO decodes synchronously with no cancellation point, so a stalled decode
    /// would hold the caller and its concurrency slot past the deadline. Here the work runs in its own task: on expiry
    /// it is cancelled (Quick Look and AVFoundation requests stop), the caller goes on at once, and a late result is
    /// dropped.
    static func firstResult<T: Sendable>(within deadline: Duration, _ work: @escaping @Sendable () async -> T) async
        -> T?
    {
        await withCheckedContinuation { (continuation: CheckedContinuation<T?, Never>) in
            let race = DeadlineRace(continuation)
            race.start(
                timer: Task {
                    try? await Task.sleep(for: deadline)
                    if !Task.isCancelled { race.finish(nil) }
                },
                worker: Task { race.finish(await work()) })
        }
    }

    private static func decodeImage(path: String, bucket: Int) -> MediaThumbnail? {
        let url = URL(fileURLWithPath: path) as CFURL
        guard let source = CGImageSourceCreateWithURL(url, [kCGImageSourceShouldCache: false] as CFDictionary)
        else { return nil }
        var sourceSize = CGSize.zero
        if let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
            let width = properties[kCGImagePropertyPixelWidth] as? Int,
            let height = properties[kCGImagePropertyPixelHeight] as? Int
        {
            let orientation = properties[kCGImagePropertyOrientation] as? Int ?? 1
            sourceSize = orientation >= 5 ? CGSize(width: height, height: width) : CGSize(width: width, height: height)
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: bucket,
            // Decode now, here, so drawing on the main thread never decodes.
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        if sourceSize == .zero { sourceSize = CGSize(width: image.width, height: image.height) }
        return MediaThumbnail(image: image, kind: .image, sourceSize: sourceSize, duration: nil)
    }

    private static func decodeVideo(path: String, bucket: Int) async -> MediaThumbnailResult {
        let asset = AVURLAsset(url: URL(fileURLWithPath: path))
        do {
            let duration = try await asset.load(.duration).seconds
            var sourceSize = CGSize.zero
            if let track = try await asset.loadTracks(withMediaType: .video).first {
                let (natural, transform) = try await track.load(.naturalSize, .preferredTransform)
                let oriented = natural.applying(transform)
                sourceSize = CGSize(width: abs(oriented.width), height: abs(oriented.height))
            } else {
                return .failed("The video has no picture track.")
            }
            let generator = AVAssetImageGenerator(asset: asset)
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: bucket, height: bucket)
            generator.requestedTimeToleranceBefore = .positiveInfinity
            generator.requestedTimeToleranceAfter = .positiveInfinity
            // A first frame is often black (a fade in, a screen recording's first blank frame).
            let poster = duration.isFinite && duration > 0 ? min(1, duration * 0.1) : 0
            let (image, _) = try await withTaskCancellationHandler {
                try await generator.image(at: CMTime(seconds: poster, preferredTimescale: 600))
            } onCancel: {
                generator.cancelAllCGImageGeneration()
            }
            return .ready(MediaThumbnail(
                image: image, kind: .video, sourceSize: sourceSize,
                duration: duration.isFinite ? duration : nil))
        } catch {
            return .failed("The video could not be read: \(error.localizedDescription)")
        }
    }

    private static func decodeDocument(path: String, bucket: Int, kind: MediaKind) async -> MediaThumbnailResult {
        let request = QLThumbnailGenerator.Request(
            fileAt: URL(fileURLWithPath: path), size: CGSize(width: bucket, height: bucket), scale: 1,
            representationTypes: .all)
        do {
            let representation = try await withTaskCancellationHandler {
                try await QLThumbnailGenerator.shared.generateBestRepresentation(for: request)
            } onCancel: {
                QLThumbnailGenerator.shared.cancel(request)
            }
            let image = representation.cgImage
            return .ready(MediaThumbnail(
                image: image, kind: kind, sourceSize: CGSize(width: image.width, height: image.height), duration: nil,
                isIcon: representation.type == .icon))
        } catch {
            return .failed(kind == .image ? "The image could not be read." : "No preview for this file.")
        }
    }
}

/// One continuation resumed exactly once, by the work or by the deadline; the loser is cancelled.
private final class DeadlineRace<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T?, Never>?
    private var timer: Task<Void, Never>?
    private var worker: Task<Void, Never>?

    init(_ continuation: CheckedContinuation<T?, Never>) {
        self.continuation = continuation
    }

    func start(timer: Task<Void, Never>, worker: Task<Void, Never>) {
        lock.lock()
        let finished = continuation == nil
        if !finished {
            self.timer = timer
            self.worker = worker
        }
        lock.unlock()
        // Either task can finish before this runs; whatever is still running then is not needed.
        if finished {
            timer.cancel()
            worker.cancel()
        }
    }

    func finish(_ value: T?) {
        lock.lock()
        let pending = continuation
        continuation = nil
        let tasks = [timer, worker]
        timer = nil
        worker = nil
        lock.unlock()
        guard let pending else { return }
        pending.resume(returning: value)
        for task in tasks { task?.cancel() }
    }
}

public enum MediaFormat {
    /// "0:07", "1:05", "1:02:09": a video's length as the system shows it.
    public static func duration(_ seconds: Double) -> String {
        let total = max(0, Int(seconds.rounded()))
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let rest = total % 60
        return hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, rest)
            : String(format: "%d:%02d", minutes, rest)
    }
}
