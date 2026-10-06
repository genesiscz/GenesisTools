import AppKit
import AVFoundation
import CryptoKit
import Foundation
import ImageIO
import PDFKit
import UniformTypeIdentifiers
import Vision

public struct NativeSourcePage: Codable, Sendable {
    public var index: Int
    public var width: Double
    public var height: Double
}

public struct NativeSourceSnapshot: Sendable {
    public var data: Data
    public var kind: String
    public var mime: String
    public var contentHash: String
    public var fileExtension: String
    public var pages: [NativeSourcePage]
    public var textLength: Int?
    public var durationMs: Double?
    public var error: String?
}

/// Normalized source coordinates use a bottom-left origin, matching PDFKit and Vision.
public struct NativeSourceRect: Codable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x; self.y = y; self.width = width; self.height = height
    }

    public var isValid: Bool {
        [x, y, width, height].allSatisfy(\.isFinite) && x >= 0 && y >= 0 && width > 0 && height > 0
            && x + width <= 1.000000001 && y + height <= 1.000000001
    }

    public func absolute(in bounds: CGRect) -> CGRect {
        CGRect(x: bounds.minX + x * bounds.width, y: bounds.minY + y * bounds.height,
            width: width * bounds.width, height: height * bounds.height)
    }
}

public struct NativeTextBlock: Codable, Sendable {
    public var text: String
    public var alternatives: [String]
    public var bounds: NativeSourceRect?
}

public struct NativeTextExtraction: Codable, Sendable {
    public var method: String
    public var engine: String
    public var blocks: [NativeTextBlock]
}

private final class NativeVisionCancellation: @unchecked Sendable {
    let request: VNRecognizeTextRequest
    init(_ request: VNRecognizeTextRequest) { self.request = request }
    func cancel() { request.cancel() }
}

/// Serializes heavy PDF/image work without blocking a window's main actor.
public actor NativeSourceReader {
    public static let shared = NativeSourceReader()
    public static let maximumBytes = 100 * 1024 * 1024
    public static let maximumImagePixels = 80_000_000

    public func snapshot(url: URL) async throws -> NativeSourceSnapshot {
        let data = try readBounded(url: url)
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let ext = url.pathExtension.lowercased()
        var result = NativeSourceSnapshot(data: data, kind: "unsupported", mime: "application/octet-stream",
            contentHash: hash, fileExtension: "bin", pages: [], error: "This file has no supported reader. Its original bytes are preserved.")
        if let imageSource = CGImageSourceCreateWithData(data as CFData, nil),
           let type = CGImageSourceGetType(imageSource) as String?,
           [UTType.png.identifier, UTType.jpeg.identifier].contains(type),
           let properties = CGImageSourceCopyPropertiesAtIndex(imageSource, 0, nil) as? [CFString: Any],
           let rawWidth = properties[kCGImagePropertyPixelWidth] as? Int,
           let rawHeight = properties[kCGImagePropertyPixelHeight] as? Int {
            guard rawWidth > 0, rawHeight > 0, rawWidth <= 30000, rawHeight <= 30000,
                  rawWidth <= Self.maximumImagePixels / rawHeight else {
                result.error = "This image exceeds 80 million pixels or a 30,000-pixel side. The original is preserved."
                return result
            }
            let orientation = properties[kCGImagePropertyOrientation] as? Int ?? 1
            let swapped = [5, 6, 7, 8].contains(orientation)
            result.kind = "image"
            result.mime = type == UTType.png.identifier ? "image/png" : "image/jpeg"
            result.fileExtension = type == UTType.png.identifier ? "png" : "jpg"
            result.pages = [NativeSourcePage(index: 0, width: Double(swapped ? rawHeight : rawWidth), height: Double(swapped ? rawWidth : rawHeight))]
            result.error = nil
            return result
        }

        if data.prefix(5) == Data("%PDF-".utf8) || ext == "pdf" {
            result.fileExtension = "pdf"
            result.mime = "application/pdf"
            guard let pdf = PDFDocument(data: data), !pdf.isLocked, pdf.pageCount > 0, pdf.pageCount <= 100 else {
                result.error = "The PDF is unreadable, locked, empty or longer than 100 pages. The original is preserved."
                return result
            }
            for index in 0..<pdf.pageCount {
                try Task.checkCancellation()
                guard let page = pdf.page(at: index) else { throw sourceError("A PDF page could not be read.") }
                let bounds = page.bounds(for: .cropBox)
                guard bounds.width.isFinite, bounds.height.isFinite, bounds.width > 0, bounds.height > 0,
                      bounds.width <= 100000, bounds.height <= 100000 else { throw sourceError("A PDF page has invalid dimensions.") }
                let swapped = [90, 270].contains((page.rotation % 360 + 360) % 360)
                result.pages.append(NativeSourcePage(index: index,
                    width: swapped ? bounds.height : bounds.width, height: swapped ? bounds.width : bounds.height))
            }
            result.kind = "pdf"
            result.error = nil
            return result
        }

        if let type = UTType(filenameExtension: ext), type.conforms(to: .audio) {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("genesis-source-" + UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            defer {
                do { try FileManager.default.removeItem(at: directory) }
                catch { PerfLog.mark("native-source: audio probe cleanup failed: \(error)") }
            }
            let assetURL = directory.appendingPathComponent("audio." + ext)
            try data.write(to: assetURL, options: .atomic)
            let asset = AVURLAsset(url: assetURL)
            let duration = try await withTaskCancellationHandler {
                try await asset.load(.duration)
            } onCancel: {
                asset.cancelLoading()
            }
            try Task.checkCancellation()
            let milliseconds = CMTimeGetSeconds(duration) * 1000
            guard milliseconds.isFinite, milliseconds > 0, milliseconds <= 900000 else {
                result.error = "Audio must have a known duration of at most fifteen minutes. The original is preserved."
                return result
            }
            result.kind = "audio"
            result.mime = type.preferredMIMEType ?? "audio/octet-stream"
            result.fileExtension = ext.range(of: "^[a-z0-9]{1,10}$", options: .regularExpression) != nil ? ext : "audio"
            result.durationMs = milliseconds
            result.error = nil
            return result
        }

        if ["txt", "md", "csv", "tsv", "json", "log"].contains(ext),
           let text = String(data: data, encoding: .utf8), !text.contains("\0"), text.utf16.count <= 16 * 1024 * 1024 {
            result.kind = "text"
            result.mime = "text/plain"
            result.fileExtension = "txt"
            result.textLength = text.utf16.count
            result.error = nil
        }
        return result
    }

    public func extract(data: Data, kind: String, page index: Int, region: NativeSourceRect) async throws -> NativeTextExtraction {
        guard data.count <= Self.maximumBytes, region.isValid else { throw sourceError("Choose a bounded source region.") }
        try Task.checkCancellation()
        if kind == "pdf" {
            guard let document = PDFDocument(data: data), !document.isLocked, document.pageCount <= 100,
                  index >= 0, let page = document.page(at: index) else { throw sourceError("The PDF page is unavailable.") }
            let pageBounds = page.bounds(for: .cropBox)
            let rectangle = Self.pdfPageRect(region, bounds: pageBounds, rotation: page.rotation)
            if let selection = page.selection(for: rectangle), let text = selection.string, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                let blocks = selection.selectionsByLine().compactMap { line -> NativeTextBlock? in
                    guard let text = line.string, !text.isEmpty else { return nil }
                    let box = line.bounds(for: page).intersection(pageBounds)
                    guard !box.isNull, box.width > 0, box.height > 0 else { return nil }
                    return NativeTextBlock(text: String(text.prefix(32000)), alternatives: [],
                        bounds: Self.pdfDisplayRect(box, bounds: pageBounds, rotation: page.rotation))
                }
                return NativeTextExtraction(method: "pdf-text", engine: "PDF text layer", blocks: Array(blocks.prefix(1000)))
            }
            try Task.checkCancellation()
            let size = Self.pdfDisplaySize(page)
            let scale = min(2, 4096 / max(size.width, size.height))
            let image = page.thumbnail(of: NSSize(width: size.width * scale, height: size.height * scale), for: .cropBox)
            guard let bitmap = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { throw sourceError("The PDF page could not be rendered.") }
            return try await recognize(bitmap, region: region)
        }
        guard kind == "image", index == 0, let imageSource = CGImageSourceCreateWithData(data as CFData, nil),
              let bitmap = CGImageSourceCreateThumbnailAtIndex(imageSource, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 6000,
                kCGImageSourceShouldCacheImmediately: true
              ] as CFDictionary) else { throw sourceError("This source has no readable image page.") }
        return try await recognize(bitmap, region: region)
    }

    public func regionFingerprints(preview: Data, regions: [NativeSourceRect]) throws -> [String] {
        guard preview.count <= Self.maximumBytes, regions.count <= 1000, regions.allSatisfy(\.isValid),
              let source = CGImageSourceCreateWithData(preview as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
              image.width <= 6000, image.height <= 6000 else {
            throw sourceError("Choose bounded regions from a decoded page preview.")
        }
        let bounds = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        return try regions.map { region in
            try Task.checkCancellation()
            let target = CGRect(x: region.x * bounds.width, y: (1 - region.y - region.height) * bounds.height,
                width: region.width * bounds.width, height: region.height * bounds.height).integral.intersection(bounds)
            guard let crop = image.cropping(to: target) else { throw sourceError("The comparison region is unavailable.") }
            var pixels = [UInt8](repeating: 0, count: 256)
            try pixels.withUnsafeMutableBytes { bytes in
                guard let context = CGContext(data: bytes.baseAddress, width: 16, height: 16, bitsPerComponent: 8,
                    bytesPerRow: 16, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else {
                    throw sourceError("The source comparison could not be decoded.")
                }
                context.interpolationQuality = .medium
                context.draw(crop, in: CGRect(x: 0, y: 0, width: 16, height: 16))
            }
            let average = Double(pixels.reduce(0) { $0 + Int($1) }) / 256
            var result = ""
            for index in stride(from: 0, to: 256, by: 4) {
                let nibble = (0..<4).reduce(0) { value, bit in (value << 1) | (Double(pixels[index + bit]) < average ? 1 : 0) }
                result += String(nibble, radix: 16)
            }
            return result
        }
    }

    public func preview(data: Data, kind: String, page index: Int) throws -> Data {
        try Task.checkCancellation()
        guard data.count <= Self.maximumBytes else { throw sourceError("The source exceeds 100 MiB.") }
        let bitmap: CGImage
        if kind == "pdf" {
            guard let pdf = PDFDocument(data: data), !pdf.isLocked, pdf.pageCount <= 100,
                  index >= 0, let page = pdf.page(at: index) else { throw sourceError("The PDF page is unavailable.") }
            let size = Self.pdfDisplaySize(page)
            let scale = min(2, 2400 / max(size.width, size.height))
            let image = page.thumbnail(of: NSSize(width: size.width * scale, height: size.height * scale), for: .cropBox)
            guard let result = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
                throw sourceError("The page could not be rendered.")
            }
            bitmap = result
        } else {
            guard kind == "image", index == 0, let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let result = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceThumbnailMaxPixelSize: 2400
                  ] as CFDictionary) else { throw sourceError("This source has no image preview.") }
            bitmap = result
        }
        try Task.checkCancellation()
        guard let png = NSBitmapImageRep(cgImage: bitmap).representation(using: .png, properties: [:]) else {
            throw sourceError("The preview could not be encoded.")
        }
        return png
    }

    public nonisolated static func pdfPageRect(_ region: NativeSourceRect, bounds: CGRect, rotation: Int) -> CGRect {
        transformedRect(region.absolute(in: CGRect(x: 0, y: 0, width: 1, height: 1))) { point in
            let normalized: CGPoint
            switch (rotation % 360 + 360) % 360 {
            case 90: normalized = CGPoint(x: 1 - point.y, y: point.x)
            case 180: normalized = CGPoint(x: 1 - point.x, y: 1 - point.y)
            case 270: normalized = CGPoint(x: point.y, y: 1 - point.x)
            default: normalized = point
            }
            return CGPoint(x: bounds.minX + normalized.x * bounds.width, y: bounds.minY + normalized.y * bounds.height)
        }
    }

    public nonisolated static func pdfDisplayRect(_ rectangle: CGRect, bounds: CGRect, rotation: Int) -> NativeSourceRect {
        let box = transformedRect(rectangle) { point in
            let u = (point.x - bounds.minX) / bounds.width
            let v = (point.y - bounds.minY) / bounds.height
            switch (rotation % 360 + 360) % 360 {
            case 90: return CGPoint(x: v, y: 1 - u)
            case 180: return CGPoint(x: 1 - u, y: 1 - v)
            case 270: return CGPoint(x: 1 - v, y: u)
            default: return CGPoint(x: u, y: v)
            }
        }
        return NativeSourceRect(x: box.minX, y: box.minY, width: box.width, height: box.height)
    }

    private nonisolated static func transformedRect(_ rect: CGRect, transform: (CGPoint) -> CGPoint) -> CGRect {
        let corners = [CGPoint(x: rect.minX, y: rect.minY), CGPoint(x: rect.maxX, y: rect.minY),
            CGPoint(x: rect.minX, y: rect.maxY), CGPoint(x: rect.maxX, y: rect.maxY)].map(transform)
        let xs = corners.map(\.x), ys = corners.map(\.y)
        return CGRect(x: xs.min() ?? 0, y: ys.min() ?? 0,
            width: (xs.max() ?? 0) - (xs.min() ?? 0), height: (ys.max() ?? 0) - (ys.min() ?? 0))
    }

    private nonisolated static func pdfDisplaySize(_ page: PDFPage) -> NSSize {
        let bounds = page.bounds(for: .cropBox)
        let swapped = [90, 270].contains((page.rotation % 360 + 360) % 360)
        return NSSize(width: swapped ? bounds.height : bounds.width, height: swapped ? bounds.width : bounds.height)
    }

    private func recognize(_ image: CGImage, region: NativeSourceRect) async throws -> NativeTextExtraction {
        let bounds = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        let target = CGRect(x: region.x * bounds.width, y: (1 - region.y - region.height) * bounds.height,
            width: region.width * bounds.width, height: region.height * bounds.height).integral.intersection(bounds)
        guard target.width >= 2, target.height >= 2, let cropped = image.cropping(to: target) else {
            throw sourceError("Choose a larger region for text recognition.")
        }
        let actual = NativeSourceRect(x: target.minX / bounds.width, y: 1 - target.maxY / bounds.height,
            width: target.width / bounds.width, height: target.height / bounds.height)
        for level in [VNRequestTextRecognitionLevel.accurate, .fast] {
            try Task.checkCancellation()
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = level
            request.usesLanguageCorrection = true
            request.automaticallyDetectsLanguage = true
            let cancellation = NativeVisionCancellation(request)
            let observations = try await withTaskCancellationHandler {
                do {
                    try VNImageRequestHandler(cgImage: cropped).perform([request])
                    try Task.checkCancellation()
                    return request.results ?? []
                } catch {
                    if Task.isCancelled { throw CancellationError() }
                    throw error
                }
            } onCancel: { cancellation.cancel() }
            if !observations.isEmpty {
                let blocks = observations.prefix(1000).compactMap { observation -> NativeTextBlock? in
                    let candidates = observation.topCandidates(3)
                    guard let first = candidates.first else { return nil }
                    let box = observation.boundingBox
                    return NativeTextBlock(text: String(first.string.prefix(32000)),
                        alternatives: candidates.dropFirst().map { String($0.string.prefix(32000)) },
                        bounds: NativeSourceRect(x: actual.x + box.minX * actual.width,
                            y: actual.y + box.minY * actual.height,
                            width: box.width * actual.width, height: box.height * actual.height))
                }
                return NativeTextExtraction(method: "vision-ocr", engine: "Apple Vision", blocks: blocks)
            }
        }
        return NativeTextExtraction(method: "vision-ocr", engine: "Apple Vision", blocks: [])
    }

    private func readBounded(url: URL) throws -> Data {
        let before = try FileManager.default.attributesOfItem(atPath: url.path)
        guard before[.type] as? FileAttributeType == .typeRegular,
              let size = before[.size] as? NSNumber, size.int64Value <= Self.maximumBytes else {
            throw sourceError("Import a regular source file no larger than 100 MiB.")
        }
        let file = try FileHandle(forReadingFrom: url)
        defer {
            do { try file.close() }
            catch { PerfLog.mark("native-source: source close failed: \(error)") }
        }
        var data = Data()
        data.reserveCapacity(size.intValue)
        while let chunk = try file.read(upToCount: 1024 * 1024), !chunk.isEmpty {
            try Task.checkCancellation()
            guard data.count + chunk.count <= Self.maximumBytes else { throw sourceError("The source grew beyond 100 MiB while reading.") }
            data.append(chunk)
        }
        let after = try FileManager.default.attributesOfItem(atPath: url.path)
        guard before[.modificationDate] as? Date == after[.modificationDate] as? Date,
              before[.size] as? NSNumber == after[.size] as? NSNumber,
              data.count == size.intValue else { throw sourceError("The source changed during import. Try the stable version again.") }
        return data
    }

    private func sourceError(_ message: String) -> NSError {
        NSError(domain: "NativeSourceReader", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
