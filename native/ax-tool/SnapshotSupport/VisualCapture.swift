import AppKit
import CryptoKit
import Darwin
import Foundation

public struct VisualRect: Codable, Equatable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x; self.y = y; self.width = width; self.height = height
    }
    public init(_ rect: CGRect) {
        self.init(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height)
    }
    public var cgRect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
    public var valid: Bool {
        [x, y, width, height].allSatisfy { $0.isFinite } && width > 0 && height > 0
    }
}

public struct VisualTransform: Codable, Equatable {
    public let sourceWidth: Int
    public let sourceHeight: Int
    public let crop: VisualRect
    public let processedWidth: Int
    public let processedHeight: Int

    public init(sourceWidth: Int, sourceHeight: Int, crop: VisualRect? = nil,
                processedWidth: Int? = nil, processedHeight: Int? = nil) throws {
        guard sourceWidth > 0, sourceHeight > 0, sourceWidth <= 16384, sourceHeight <= 16384,
              sourceWidth * sourceHeight <= 33554432 else {
            throw VisualCaptureError.invalid("image dimensions exceed the visual observation budget")
        }
        let selected = crop ?? VisualRect(x: 0, y: 0, width: Double(sourceWidth), height: Double(sourceHeight))
        guard selected.valid, selected.x >= 0, selected.y >= 0,
              selected.x + selected.width <= Double(sourceWidth), selected.y + selected.height <= Double(sourceHeight) else {
            throw VisualCaptureError.invalid("crop is outside the source image")
        }
        let width = processedWidth ?? Int(selected.width)
        let height = processedHeight ?? Int(selected.height)
        guard width > 0, height > 0, width <= 16384, height <= 16384, width * height <= 33554432 else {
            throw VisualCaptureError.invalid("processed image dimensions exceed the visual observation budget")
        }
        self.sourceWidth = sourceWidth; self.sourceHeight = sourceHeight
        self.crop = selected; self.processedWidth = width; self.processedHeight = height
    }
    public func sourceRect(_ region: VisualRect) throws -> VisualRect {
        guard region.valid, region.x >= 0, region.y >= 0,
              region.x + region.width <= Double(processedWidth), region.y + region.height <= Double(processedHeight) else {
            throw VisualCaptureError.invalid("detected region is outside the processed image")
        }
        return VisualRect(x: crop.x + region.x * crop.width / Double(processedWidth),
                          y: crop.y + region.y * crop.height / Double(processedHeight),
                          width: region.width * crop.width / Double(processedWidth),
                          height: region.height * crop.height / Double(processedHeight))
    }
    public func screenRect(_ source: VisualRect, window: VisualRect) throws -> VisualRect {
        guard source.valid, window.valid, source.x >= 0, source.y >= 0,
              source.x + source.width <= Double(sourceWidth), source.y + source.height <= Double(sourceHeight) else {
            throw VisualCaptureError.invalid("source region or window geometry is invalid")
        }
        return VisualRect(x: window.x + source.x * window.width / Double(sourceWidth),
                          y: window.y + source.y * window.height / Double(sourceHeight),
                          width: source.width * window.width / Double(sourceWidth),
                          height: source.height * window.height / Double(sourceHeight))
    }
}

public struct VisualRegion: Codable {
    public let id: String
    public let source: VisualRect
    public init(id: String, source: VisualRect) { self.id = id; self.source = source }
}
public enum VisualCaptureError: Error, LocalizedError {
    case invalid(String)
    case stale(String)
    case scopeChanged(String)
    public var category: SnapshotRefusal {
        switch self {
        case .invalid: return .refused
        case .stale: return .staleObservation
        case .scopeChanged: return .scopeChanged
        }
    }
    public var errorDescription: String? {
        switch self { case .invalid(let message), .stale(let message), .scopeChanged(let message): return message }
    }
}
public struct VisualCaptureIdentity: Codable {
    public let id: String
    public let pid: Int32
    public let launch: Double
    public let windowID: Int
    public let bounds: VisualRect
    public let created: Double
    public let pngHash: String
    public let pixelHash: String
    public let transform: VisualTransform
    public let scaleX: Double
    public let scaleY: Double
    public let regions: [VisualRegion]

    public init(pid: Int32, launch: Double, windowID: Int, bounds: VisualRect, created: Double,
                pngHash: String, pixelHash: String, transform: VisualTransform, regions: [VisualRegion] = []) {
        self.id = UUID().uuidString
        self.pid = pid; self.launch = launch; self.windowID = windowID; self.bounds = bounds
        self.created = created; self.pngHash = pngHash; self.pixelHash = pixelHash
        self.transform = transform; self.regions = regions
        self.scaleX = Double(transform.sourceWidth) / bounds.width
        self.scaleY = Double(transform.sourceHeight) / bounds.height
    }
    public func validate(pid: Int32, launch: Double, windowID: Int, bounds: VisualRect,
                         pixelHash: String, width: Int, height: Int, now: Double) throws {
        guard UUID(uuidString: id) != nil, self.pid == pid, self.launch == launch,
              self.windowID == windowID, self.bounds == bounds else {
            throw VisualCaptureError.scopeChanged("visual capture app/window or geometry changed; observe again")
        }
        guard now.isFinite, created.isFinite, now >= created, now - created <= 30 else {
            throw VisualCaptureError.stale("visual capture expired; observe again")
        }
        guard self.pixelHash == pixelHash, width == transform.sourceWidth, height == transform.sourceHeight else {
            throw VisualCaptureError.stale("window pixels changed since capture; observe again")
        }
    }
    public func center(of regionID: String) throws -> CGPoint {
        let matches = regions.filter { $0.id == regionID }
        guard matches.count == 1 else { throw VisualCaptureError.invalid("unknown or ambiguous visual region") }
        let rect = try transform.screenRect(matches[0].source, window: bounds)
        return CGPoint(x: rect.x + rect.width / 2, y: rect.y + rect.height / 2)
    }
}

public func visualPixelHash(_ image: CGImage) throws -> String {
    _ = try VisualTransform(sourceWidth: image.width, sourceHeight: image.height)
    let stride = image.width * 4
    var data = Data(count: stride * image.height)
    try data.withUnsafeMutableBytes { (buffer: UnsafeMutableRawBufferPointer) in
        guard let context = CGContext(data: buffer.baseAddress, width: image.width, height: image.height,
            bitsPerComponent: 8, bytesPerRow: stride, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else {
            throw VisualCaptureError.invalid("cannot normalize screenshot pixels")
        }
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    }
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func visualUsePath(_ capture: VisualCaptureIdentity, directory: URL?) throws -> URL {
    guard let id = UUID(uuidString: capture.id) else { throw VisualCaptureError.invalid("invalid capture ID") }
    let root = directory ?? FileManager.default.temporaryDirectory.appendingPathComponent("genesis-control-visual-\(getuid())", isDirectory: true)
    return root.appendingPathComponent(id.uuidString + ".used")
}

public func visualCaptureWasUsed(_ capture: VisualCaptureIdentity, directory: URL? = nil) throws -> Bool {
    let file = try visualUsePath(capture, directory: directory)
    var info = stat()
    if lstat(file.path, &info) == 0 { return true }
    guard errno == ENOENT else { throw VisualCaptureError.invalid("cannot inspect visual capture use") }
    return false
}

public func consumeVisualCapture(_ capture: VisualCaptureIdentity, directory: URL? = nil) throws {
    let file = try visualUsePath(capture, directory: directory)
    let root = file.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let attributes = try FileManager.default.attributesOfItem(atPath: root.path)
    guard attributes[.type] as? FileAttributeType == .typeDirectory,
          (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
          ((attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0) & 0o077 == 0 else {
        throw VisualCaptureError.invalid("visual-use directory is not private")
    }
    let descriptor = open(file.path, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else {
        throw VisualCaptureError.invalid(errno == EEXIST ? "visual capture already used; observe again" : "cannot claim visual capture")
    }
    close(descriptor)
}

public func admitVisualCapture(capture: VisualCaptureIdentity, pid: Int32, launch: Double,
    windowID: Int, bounds: VisualRect, pixelHash: String, width: Int, height: Int, now: Double,
    consume: () throws -> Void) throws {
    try capture.validate(pid: pid, launch: launch, windowID: windowID, bounds: bounds,
                         pixelHash: pixelHash, width: width, height: height, now: now)
    try consume()
}
