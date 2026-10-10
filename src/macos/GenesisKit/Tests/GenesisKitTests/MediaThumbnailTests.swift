import AVFoundation
import AppKit
import ImageIO
import SwiftUI
import UniformTypeIdentifiers
import XCTest

@testable import GenesisKit

final class MediaThumbnailCacheTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("media-thumbnail-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: directory)
    }

    static func writePNG(_ url: URL, width: Int, height: Int, color: CGColor) throws {
        let context = try XCTUnwrap(CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(color)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try XCTUnwrap(context.makeImage())
        let destination = try XCTUnwrap(
            CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
    }

    func testBucketsRoundUpToPowersOfTwoWithinBounds() {
        XCTAssertEqual(MediaThumbnailCache.bucket(forPixels: 1), 64)
        XCTAssertEqual(MediaThumbnailCache.bucket(forPixels: 100), 128)
        XCTAssertEqual(MediaThumbnailCache.bucket(forPixels: 128), 128)
        XCTAssertEqual(MediaThumbnailCache.bucket(forPixels: 129), 256)
        XCTAssertEqual(MediaThumbnailCache.bucket(forPixels: 90_000), 4096)
    }

    func testImageThumbnailKeepsAspectAndALargerPictureServesASmallerRequest() async throws {
        let url = directory.appendingPathComponent("wide.png")
        try Self.writePNG(url, width: 800, height: 400, color: CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        let cache = MediaThumbnailCache()
        guard case .ready(let large) = await cache.thumbnail(path: url.path, maxPixels: 500) else {
            return XCTFail("A readable PNG must give a thumbnail")
        }
        XCTAssertEqual(large.kind, .image)
        XCTAssertEqual(large.aspect, 2, accuracy: 0.001)
        XCTAssertEqual(large.image.width, 512, "Decoded at the 512 px bucket, not at the 800 px source")
        guard case .ready(let small) = await cache.thumbnail(path: url.path, maxPixels: 100) else {
            return XCTFail("The cached picture must serve a smaller request")
        }
        XCTAssertTrue(small.image === large.image, "A smaller request must reuse the larger decode")
    }

    func testRewrittenFileIsANewIdentityAndNeverShowsTheOldPicture() async throws {
        let url = directory.appendingPathComponent("capture.png")
        try Self.writePNG(url, width: 300, height: 100, color: CGColor(red: 0, green: 0, blue: 1, alpha: 1))
        let cache = MediaThumbnailCache()
        guard case .ready(let first) = await cache.thumbnail(path: url.path, maxPixels: 128) else {
            return XCTFail("First picture")
        }
        XCTAssertEqual(first.aspect, 3, accuracy: 0.001)
        try FileManager.default.removeItem(at: url)
        try Self.writePNG(url, width: 100, height: 200, color: CGColor(red: 0, green: 1, blue: 0, alpha: 1))
        guard case .ready(let second) = await cache.thumbnail(path: url.path, maxPixels: 128) else {
            return XCTFail("Second picture")
        }
        XCTAssertEqual(second.aspect, 0.5, accuracy: 0.001)
    }

    func testMissingAndUnreadableFilesFailWithAReasonAndRetryDecodesAgain() async throws {
        let cache = MediaThumbnailCache()
        guard case .failed(let missing) = await cache.thumbnail(path: directory.appendingPathComponent("gone.png").path, maxPixels: 64)
        else { return XCTFail("A missing file must fail") }
        XCTAssertTrue(missing.contains("no longer there"))

        let broken = directory.appendingPathComponent("broken.png")
        try Data("not an image".utf8).write(to: broken)
        guard case .failed = await cache.thumbnail(path: broken.path, maxPixels: 64) else {
            return XCTFail("Garbage bytes must fail")
        }
        guard case .failed = await cache.thumbnail(path: broken.path, maxPixels: 64, reload: true) else {
            return XCTFail("A retry decodes again and still fails on garbage")
        }
    }

    func testVideoGivesAPosterFrameItsLengthAndAspect() async throws {
        let url = directory.appendingPathComponent("clip.mov")
        try await Self.writeVideo(url, width: 64, height: 48, frames: 30, fps: 10)
        let cache = MediaThumbnailCache()
        guard case .ready(let poster) = await cache.thumbnail(path: url.path, maxPixels: 128) else {
            return XCTFail("A readable video must give a poster frame")
        }
        XCTAssertEqual(poster.kind, .video)
        XCTAssertEqual(poster.aspect, 64.0 / 48.0, accuracy: 0.01)
        XCTAssertEqual(try XCTUnwrap(poster.duration), 3, accuracy: 0.15)
    }

    /// `MEDIA_THUMBNAIL_PERF=1 swift test --filter testDecodeCostOfAFiveKScreenshot`: cold decode per bucket of a
    /// 5120 × 2880 PNG (a Retina 5K screenshot), the old transcript cache's 256 px decode, and a warm hit.
    func testDecodeCostOfAFiveKScreenshot() async throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["MEDIA_THUMBNAIL_PERF"] == "1")
        let url = directory.appendingPathComponent("5k.png")
        try Self.writePNG(url, width: 5120, height: 2880, color: CGColor(red: 0.2, green: 0.4, blue: 0.9, alpha: 1))
        let clock = ContinuousClock()
        var lines: [String] = []
        for bucket in [256, 512, 1024] {
            let cache = MediaThumbnailCache()
            let cold = await clock.measure { _ = await cache.thumbnail(path: url.path, maxPixels: CGFloat(bucket)) }
            let warm = await clock.measure { _ = await cache.thumbnail(path: url.path, maxPixels: CGFloat(bucket)) }
            lines.append("bucket \(bucket): cold \(cold), warm \(warm)")
        }
        let old = await clock.measure { _ = await TranscriptThumbnailCache().thumbnail(for: url.path) }
        lines.append("old TranscriptThumbnailCache 256 px: cold \(old)")
        print("MEDIA_THUMBNAIL_PERF\n" + lines.joined(separator: "\n"))
    }

    func testDurationAndKindFormatting() {
        XCTAssertEqual(MediaFormat.duration(7.4), "0:07")
        XCTAssertEqual(MediaFormat.duration(65), "1:05")
        XCTAssertEqual(MediaFormat.duration(3729), "1:02:09")
        XCTAssertEqual(MediaKind.of(path: "/fixture/Screenshot.PNG"), .image)
        XCTAssertEqual(MediaKind.of(path: "/fixture/recording.mov"), .video)
        XCTAssertEqual(MediaKind.of(path: "/fixture/clip.mp4"), .video)
        XCTAssertEqual(MediaKind.of(path: "/fixture/notes.pdf"), .file)
        XCTAssertEqual(MediaKind.of(path: "/fixture/noextension"), .file)
    }

    func testFrameFitsTheAspectInsideTheBox() {
        XCTAssertEqual(MediaThumbnailView.frame(aspect: 2, height: 100, maxWidth: 300), CGSize(width: 200, height: 100))
        XCTAssertEqual(MediaThumbnailView.frame(aspect: 4, height: 100, maxWidth: 260), CGSize(width: 260, height: 65))
        XCTAssertEqual(MediaThumbnailView.frame(aspect: 0.5, height: 100, maxWidth: 260, minWidth: 60), CGSize(width: 60, height: 100))
        XCTAssertEqual(MediaThumbnailView.frame(aspect: nil, height: 60, maxWidth: 200), CGSize(width: 80, height: 60))
    }

    static func writeVideo(_ url: URL, width: Int, height: Int, frames: Int, fps: Int32) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height,
        ])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
            kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
        ])
        writer.add(input)
        XCTAssertTrue(writer.startWriting())
        writer.startSession(atSourceTime: .zero)
        for index in 0..<frames {
            let deadline = Date().addingTimeInterval(5)
            while !input.isReadyForMoreMediaData {
                guard Date() < deadline else { throw XCTSkip("The video writer never became ready") }
                try await Task.sleep(for: .milliseconds(10))
            }
            var buffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, try XCTUnwrap(adaptor.pixelBufferPool), &buffer)
            let pixels = try XCTUnwrap(buffer)
            CVPixelBufferLockBaseAddress(pixels, [])
            memset(CVPixelBufferGetBaseAddress(pixels), Int32(index * 8 % 255), CVPixelBufferGetDataSize(pixels))
            CVPixelBufferUnlockBaseAddress(pixels, [])
            XCTAssertTrue(adaptor.append(pixels, withPresentationTime: CMTime(value: CMTimeValue(index), timescale: fps)))
        }
        input.markAsFinished()
        writer.endSession(atSourceTime: CMTime(value: CMTimeValue(frames), timescale: fps))
        await writer.finishWriting()
        XCTAssertEqual(writer.status, .completed, writer.error?.localizedDescription ?? "")
    }
}

@MainActor
final class MediaPreviewStateTests: XCTestCase {
    private let items = ["a", "b", "c"].map { MediaPreviewItem(id: $0, path: "/fixture/\($0).png") }

    override func tearDown() {
        MediaPreviewState.active?.dismiss()
        super.tearDown()
    }

    func testPresentSelectsTheClickedItemAndStepsWrapAround() {
        let state = MediaPreviewState()
        state.present(items, selectedID: "c")
        XCTAssertEqual(state.current?.id, "c")
        state.step(1)
        XCTAssertEqual(state.current?.id, "a")
        state.step(-1)
        XCTAssertEqual(state.current?.id, "c")
        state.dismiss()
        XCTAssertFalse(state.isOpen)
        XCTAssertNil(MediaPreviewState.active)
    }

    func testOnlyOnePreviewIsOpenAcrossSurfaces() {
        let inbox = MediaPreviewState()
        let shelf = MediaPreviewState()
        inbox.present(items, selectedID: "a")
        shelf.present(items, selectedID: "b")
        XCTAssertFalse(inbox.isOpen)
        XCTAssertTrue(shelf.isOpen)
        XCTAssertTrue(MediaPreviewState.active === shelf)
    }

    func testKeyboardClosesWithEscapeAndLeavesSpaceAndArrowsToATextField() {
        let state = MediaPreviewState()
        XCTAssertFalse(MediaPreviewKeyboard.handle(keyCode: 53, editingText: false), "Nothing open: Esc belongs to the window")
        state.present(items, selectedID: "a")
        XCTAssertFalse(MediaPreviewKeyboard.handle(keyCode: 124, editingText: true))
        XCTAssertEqual(state.current?.id, "a")
        XCTAssertTrue(MediaPreviewKeyboard.handle(keyCode: 124, editingText: false))
        XCTAssertEqual(state.current?.id, "b")
        XCTAssertFalse(MediaPreviewKeyboard.handle(keyCode: 49, editingText: true))
        XCTAssertTrue(state.isOpen)
        XCTAssertTrue(MediaPreviewKeyboard.handle(keyCode: 53, editingText: true), "Esc closes even while typing")
        XCTAssertFalse(state.isOpen)
    }
}

/// The picture really reaches the screen: a red PNG drawn by `MediaThumbnailView` in an off-screen window.
@MainActor
final class MediaThumbnailRenderTests: XCTestCase {
    func testThumbnailDrawsTheImageNotAnIcon() throws {
        _ = NSApplication.shared
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("media-render-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("red.png")
        try MediaThumbnailCacheTests.writePNG(url, width: 400, height: 300, color: CGColor(red: 1, green: 0, blue: 0, alpha: 1))

        let host = NSHostingView(rootView: MediaThumbnailView(path: url.path).frame(width: 80, height: 60))
        let window = NSWindow(contentRect: CGRect(x: -10000, y: -10000, width: 80, height: 60),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.contentView = host
        window.orderBack(nil)
        defer { window.close() }

        var redness = 0.0
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
            host.layoutSubtreeIfNeeded()
            guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { continue }
            host.cacheDisplay(in: host.bounds, to: rep)
            if let color = rep.colorAt(x: Int(rep.size.width / 2), y: Int(rep.size.height / 2))?.usingColorSpace(.sRGB) {
                redness = Double(color.redComponent - max(color.greenComponent, color.blueComponent))
            }
            if redness > 0.5 { break }
        }
        XCTAssertGreaterThan(redness, 0.5, "The thumbnail's centre must be the image's red, not a placeholder")
    }
}

@MainActor
final class WidgetCaptureFeedbackTests: XCTestCase {
    private let empty = Data(#"{"revision":0,"items":[],"statePath":"/fixture/widget-shelf/state.json"}"#.utf8)
    private let staged = Data(#"{"id":"fixture-capture","kind":"capture","name":"Screenshot.png","path":"/fixture/capture.png","sha256":"hash","bytes":1,"createdAt":1,"assetId":"fixture-image"}"#.utf8)

    private func complete(_ store: WidgetShelfStore, action: () -> Void) async {
        let finished = expectation(description: "Shelf operation finishes")
        let subscription = store.$isBusy.dropFirst().filter { !$0 }.prefix(1).sink { _ in finished.fulfill() }
        action()
        await fulfillment(of: [finished], timeout: 2)
        withExtendedLifetime(subscription) {}
    }

    func testOnlyAStagedCaptureReopensTheShelf() async {
        var reopened = 0
        var response = staged
        let store = WidgetShelfStore(request: { args, _ in
            args.first == "capture" ? response : self.empty
        }, onCaptureStaged: { reopened += 1 })
        await complete(store) { store.capture() }
        XCTAssertEqual(reopened, 1)
        XCTAssertEqual(store.notice, "Screenshot staged. Choose an inbox when you are ready.")

        response = Data(#"{"cancelled":true,"reason":"user"}"#.utf8)
        await complete(store) { store.capture() }
        XCTAssertEqual(reopened, 1, "Escape is not an arrival")
        XCTAssertEqual(store.notice, "Capture cancelled.")
        XCTAssertNil(store.error)

        await complete(store) { store.importFiles([URL(fileURLWithPath: "/fixture/report.pdf")]) }
        XCTAssertEqual(reopened, 1, "An import is not a capture")
    }

    func testFirstInventoryReadMarksTheShelfLoaded() async {
        let store = WidgetShelfStore(request: { _, _ in self.empty })
        XCTAssertFalse(store.loaded)
        let loaded = expectation(description: "Loaded")
        let subscription = store.$loaded.filter { $0 }.prefix(1).sink { _ in loaded.fulfill() }
        store.refresh()
        await fulfillment(of: [loaded], timeout: 2)
        withExtendedLifetime(subscription) {}
    }

    func testScreenRecordingDenialIsRecognisedByItsCode() {
        let denied = ToolsBridgeError.refused(
            "ERROR: [screen-recording-denied] Screen Recording is not allowed for this app, so macOS returned no image (could not create image from window)\n")
        XCTAssertTrue(WidgetCaptureError.isScreenRecordingDenied(denied))
        XCTAssertFalse(WidgetCaptureError.isScreenRecordingDenied(ToolsBridgeError.refused("ERROR: Screenshot capture failed: disk full")))
    }
}
