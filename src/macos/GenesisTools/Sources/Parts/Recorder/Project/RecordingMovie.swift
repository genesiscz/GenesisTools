import AVFoundation
import Foundation

/// Which file is the movie of a recording folder, for every list that asks: the menu bar's Recent rows, the library
/// window (its cards, drag and Copy Movie) and the editor's open. The CLI and the REPL answer the same with
/// `movieOf` and `shareableMovie` (src/recorder/lib/library.ts, quick-actions.ts); both sides run the cases in
/// src/utils/recording-editor/__fixtures__/recording-movies.json. Read off the main thread or at a click, never in a body.
enum RecordingMovie {
    /// The recording's own movie, in the order the editor looks for one: the recorder's movie, then the proxy
    /// `tools recorder proxy` makes of a frames recording (a meeting recording often has only that).
    static let names = ["screen.mp4", "screen.mov", "proxy.mp4"]
    /// The camera's movie beside `screen.mp4`: part of the recording, never an export of it.
    static let camera = "camera.mov"
    private static let exportExtensions: Set<String> = ["mp4", "gif", "webm", "mov"]

    /// The recording's own movie, nil for a frames recording that has no proxy yet.
    static func own(in folder: URL) -> URL? {
        names.map { folder.appendingPathComponent($0) }.first { FileManager.default.fileExists(atPath: $0.path) }
    }

    /// A movie file's length in milliseconds, nil when it has none or is not a movie. A frames or meeting recording writes
    /// no settings.video.durationMs, so the library card reads its proxy's own length. Blocks for the read: call it off
    /// the main thread (readRecents runs on a background queue).
    nonisolated static func lengthMs(_ url: URL) -> Double? {
        final class Box: @unchecked Sendable { var ms: Double? }
        let box = Box()
        let done = DispatchSemaphore(value: 0)
        Task.detached {
            if let duration = try? await AVURLAsset(url: url).load(.duration), duration.isNumeric, duration.seconds > 0 {
                box.ms = duration.seconds * 1000
            }
            done.signal()
        }
        guard done.wait(timeout: .now() + 3) == .success else { return nil }
        return box.ms
    }

    /// The file a drag or Copy Movie hands out: the newest finished export beside the recording (an MP4, GIF, WebM
    /// or MOV), else the recording's own movie.
    static func shareable(in folder: URL) -> URL? {
        let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        let source = Set(names + [camera])
        let exports = files.filter { exportExtensions.contains($0.pathExtension.lowercased()) }
            .filter { !source.contains($0.lastPathComponent) && !$0.lastPathComponent.contains(".partial.") }
        let modified = { (url: URL) in (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast }
        return exports.max { modified($0) < modified($1) } ?? own(in: folder)
    }
}
