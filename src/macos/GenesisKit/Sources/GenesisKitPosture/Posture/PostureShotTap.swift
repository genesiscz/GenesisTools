import CoreImage
import Foundation
import GenesisKit

/// Saves the next camera frames, each with the sample the engine read from it, so real readings can be
/// replayed in tests (`PostureShotsTests`). A debug tool: the frames show the user's face, so the folder
/// they go to must stay out of git.
///
/// Each frame becomes `<directory>/<label>/<stamp>-<NN>.png` plus a `.json` with the `PoseSample`.
final class PostureShotTap: @unchecked Sendable {
    struct Slot: Sendable {
        var base: URL
    }

    private struct Request {
        var folder: URL
        var stamp: String
        var remaining: Int
        var next = 1
    }

    private let lock = NSLock()
    private var request: Request?
    private let context = CIContext()

    /// Starts saving the next `count` frames; a new call replaces a capture still running.
    func start(count: Int, label: String, directory: URL) {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let folder = directory.appendingPathComponent(label, isDirectory: true)
        lock.withLock {
            request = count > 0 ? Request(folder: folder, stamp: formatter.string(from: Date()), remaining: count) : nil
        }
    }

    /// The file base for this frame, or nil when no capture is running.
    func take() -> Slot? {
        lock.withLock {
            guard var current = request else { return nil }
            let base = current.folder.appendingPathComponent(String(format: "%@-%02d", current.stamp, current.next))
            current.next += 1
            current.remaining -= 1
            request = current.remaining > 0 ? current : nil
            return Slot(base: base)
        }
    }

    /// Writes the frame as PNG and the sample as JSON. Failures are dropped: this is a debug aid.
    func write(_ frame: CameraFrame, sample: PoseSample?, to slot: Slot) {
        let folder = slot.base.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let image = CIImage(cvPixelBuffer: frame.pixelBuffer)
        if let space = CGColorSpace(name: CGColorSpace.sRGB),
           let png = context.pngRepresentation(of: image, format: .RGBA8, colorSpace: space) {
            try? png.write(to: slot.base.appendingPathExtension("png"))
        }
        if let sample {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try? encoder.encode(sample).write(to: slot.base.appendingPathExtension("json"))
        }
    }
}
