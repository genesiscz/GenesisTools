import CoreGraphics
import Foundation

/// An 8-bit grayscale image, row-major with the top row first. The one pixel form the drawn check
/// and the OCR change detector read, so a capture is converted once per snapshot.
public struct GrayImage {
    public let width: Int
    public let height: Int
    public let bytesPerRow: Int
    public let pixels: [UInt8]

    /// Nil when the buffer is shorter than the geometry says, so no read can run past its end.
    public init?(width: Int, height: Int, bytesPerRow: Int, pixels: [UInt8]) {
        guard width > 0, height > 0, bytesPerRow >= width, pixels.count >= bytesPerRow * (height - 1) + width else {
            return nil
        }

        self.width = width
        self.height = height
        self.bytesPerRow = bytesPerRow
        self.pixels = pixels
    }

    /// For buffers this module built itself, tightly packed.
    init(packedWidth width: Int, height: Int, pixels: [UInt8]) {
        self.width = width
        self.height = height
        self.bytesPerRow = width
        self.pixels = pixels
    }

    /// The capture drawn into a device-gray bitmap. A per-pixel colour conversion keeps a flat
    /// patch flat, which is all both readers depend on.
    public init?(_ image: CGImage) {
        let width = image.width
        let height = image.height
        guard width > 0, height > 0, width <= 16384, height <= 16384, width * height <= 33_554_432 else {
            return nil
        }

        var buffer = [UInt8](repeating: 0, count: width * height)
        let drawn = buffer.withUnsafeMutableBytes { bytes -> Bool in
            guard let context = CGContext(data: bytes.baseAddress, width: width, height: height, bitsPerComponent: 8,
                                          bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(),
                                          bitmapInfo: CGImageAlphaInfo.none.rawValue) else {
                return false
            }

            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else {
            return nil
        }

        self.init(width: width, height: height, bytesPerRow: width, pixels: buffer)
    }

    public subscript(x: Int, y: Int) -> UInt8 {
        pixels[y * bytesPerRow + x]
    }

    /// Lowest and highest value inside `[x1, x2) x [y1, y2)`, stopping early once the spread
    /// passes `stopAbove`. Callers pass bounds already clamped to the image.
    func extrema(x1: Int, y1: Int, x2: Int, y2: Int, stopAbove: Int = 255) -> (low: UInt8, high: UInt8)? {
        guard x2 > x1, y2 > y1 else {
            return nil
        }

        var low = UInt8.max
        var high = UInt8.min
        for y in y1..<y2 {
            let row = y * bytesPerRow
            for x in x1..<x2 {
                let value = pixels[row + x]
                low = min(low, value)
                high = max(high, value)
            }
            if Int(high) - Int(low) > stopAbove {
                break
            }
        }
        return (low, high)
    }
}

/// A frame in global logical points mapped into the pixels of a window capture, with the same
/// scale and origin the visual transform uses: a Retina capture of a window at a negative origin
/// lands at 2x from the window's own top-left.
public func sourcePixelRect(_ frame: CGRect, window: CGRect, imageWidth: Int, imageHeight: Int) -> CGRect? {
    guard window.width > 0, window.height > 0, imageWidth > 0, imageHeight > 0,
          [frame.minX, frame.minY, frame.width, frame.height].allSatisfy({ $0.isFinite }) else {
        return nil
    }

    let scaleX = Double(imageWidth) / window.width
    let scaleY = Double(imageHeight) / window.height
    return CGRect(x: (frame.minX - window.minX) * scaleX, y: (frame.minY - window.minY) * scaleY,
                  width: frame.width * scaleX, height: frame.height * scaleY)
}
