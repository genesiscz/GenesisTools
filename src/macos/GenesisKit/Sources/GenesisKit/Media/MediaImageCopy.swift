import Foundation
import ImageIO
import UniformTypeIdentifiers

/// What Copy image puts on the pasteboard for a picture in the preview. The thumbnail pipeline downsamples and never
/// holds an original, but a copy needs the whole picture, and the file shelf takes any file of any size. So this
/// answers inside a budget, off the main thread: an original past it is never read, and the file itself is offered.
public enum MediaImageCopy {
    /// A file past this many bytes is not read.
    public static let maxBytes = 64 << 20
    /// A picture past this many pixels is not decoded: 48 million, the ceiling the question store applies.
    public static let maxPixels = 48_000_000

    public enum Outcome: Equatable, Sendable {
        /// The picture as TIFF, in its own orientation and size, ready for the pasteboard.
        case image(Data)
        /// Too large to copy as a picture. The file itself can still be copied; the text says why, in a few words.
        case fileOnly(String)
        case failed(String)
    }

    public static func prepare(path: String, maxBytes: Int = maxBytes, maxPixels: Int = maxPixels) -> Outcome {
        // The file a link points at is the picture: `isRegularFile` describes a link itself, which is no regular file.
        let url = URL(fileURLWithPath: path).resolvingSymlinksInPath()
        // A regular file only: opening a FIFO with no writer would wait for one, and a directory is no picture.
        guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]) else {
            return .failed("The file is no longer there.")
        }

        guard values.isRegularFile == true else { return .failed("This is not a picture file.") }
        let bytes = values.fileSize ?? 0
        if bytes > maxBytes {
            return .fileOnly("\(bytes >> 20) MB is too large to copy as a picture.")
        }

        // The header only: ImageIO reads the size without decoding the picture.
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
            let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
            let width = properties[kCGImagePropertyPixelWidth] as? Int,
            let height = properties[kCGImagePropertyPixelHeight] as? Int,
            width > 0, height > 0
        else { return .failed("The image could not be read.") }

        if width * height > maxPixels {
            return .fileOnly("\(width) × \(height) pixels is too large to copy as a picture.")
        }

        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: max(width, height),
            kCGImageSourceShouldCacheImmediately: true,
        ]
        let data = NSMutableData()
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
            let destination = CGImageDestinationCreateWithData(data, UTType.tiff.identifier as CFString, 1, nil)
        else { return .failed("The image could not be read.") }

        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { return .failed("The image could not be read.") }
        return .image(data as Data)
    }
}
