import AVFoundation
import AppKit
import ImageIO
import SwiftUI
import UniformTypeIdentifiers
import XCTest

@testable import GenesisKitBase
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

    /// ImageIO decodes synchronously and never checks for cancellation; a task group would wait for it.
    private static func decodeThatIgnoresCancellation(seconds: TimeInterval) -> Int {
        Thread.sleep(forTimeInterval: seconds)
        return 1
    }

    func testTheDecodeDeadlineHoldsEvenWhenTheDecodeIgnoresCancellation() async {
        let started = ContinuousClock.now
        let stalled = Task { Self.decodeThatIgnoresCancellation(seconds: 0.8) }
        let late = await MediaThumbnailCache.firstResult(of: stalled, within: .milliseconds(40))
        XCTAssertNil(late)
        XCTAssertLessThan(ContinuousClock.now - started, .milliseconds(500),
                          "the caller is free at the deadline, not when the decoder gives up")
        XCTAssertTrue(stalled.isCancelled, "the work is told to stop at the deadline")
        let quick = await MediaThumbnailCache.firstResult(of: Task { 7 }, within: .seconds(5))
        XCTAssertEqual(quick, 7)
    }

    /// Counts the decoders running at once, and the most there ever were.
    private final class DecoderGauge: @unchecked Sendable {
        private let lock = NSLock()
        private var running = 0
        private(set) var peak = 0

        func enter() {
            lock.lock()
            running += 1
            peak = max(peak, running)
            lock.unlock()
        }

        func leave() {
            lock.lock()
            running -= 1
            lock.unlock()
        }
    }

    private static func message(_ result: MediaThumbnailResult) -> String? {
        if case .failed(let message) = result { return message }
        return nil
    }

    /// The files decoded, in order, and a gate that holds one decoder until the test releases it.
    private final class DecodeLog: @unchecked Sendable {
        private let lock = NSLock()
        private var names: [String] = []
        private var gate: CheckedContinuation<Void, Never>?
        var decoded: [String] { lock.withLock { names } }
        var isHeld: Bool { lock.withLock { gate != nil } }
        func record(_ path: String) { lock.withLock { names.append((path as NSString).lastPathComponent) } }
        func hold() async { await withCheckedContinuation { gate in lock.withLock { self.gate = gate } } }
        func release() { lock.withLock { gate }?.resume() }
    }

    func testARequestEveryTileLeftIsWithdrawnFromTheQueueWhileOneAnotherTileWantsStays() async throws {
        let paths = try ["busy.png", "scrolled-past.png", "shared.png"].map { name in
            let url = directory.appendingPathComponent(name)
            try Self.writePNG(url, width: 8, height: 8, color: CGColor(red: 0, green: 1, blue: 0, alpha: 1))
            return url.path
        }
        let log = DecodeLog()
        let cache = MediaThumbnailCache(concurrency: 1, deadline: .seconds(5)) { path, _, _ in
            log.record(path)
            if path.hasSuffix("busy.png") { await log.hold() }
            return .failed("decoded \((path as NSString).lastPathComponent)")
        }
        let busy = Task { await cache.thumbnail(path: paths[0], maxPixels: 64) }
        let deadline = ContinuousClock.now + .seconds(2)
        while !log.isHeld, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertTrue(log.isHeld, "the first decoder holds the only slot")
        // A tile scrolled out of view, and one of two tiles showing the same file, while both wait for the slot.
        let gone = Task { await cache.thumbnail(path: paths[1], maxPixels: 64) }
        let kept = Task { await cache.thumbnail(path: paths[2], maxPixels: 64) }
        let left = Task { await cache.thumbnail(path: paths[2], maxPixels: 64) }
        while await cache.consumerCount < 4, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
        let waitingTiles = await cache.consumerCount
        XCTAssertEqual(waitingTiles, 4, "the busy tile, the scrolled-past one and both shared tiles")
        gone.cancel()
        left.cancel()
        while await cache.consumerCount > 2, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
        log.release()

        let (busyResult, keptResult, goneResult) = (await busy.value, await kept.value, await gone.value)
        XCTAssertEqual(Self.message(busyResult), "decoded busy.png")
        XCTAssertEqual(Self.message(keptResult), "decoded shared.png", "a request another tile still waits for stays")
        XCTAssertEqual(Self.message(goneResult), MediaThumbnailCache.tooLong)
        XCTAssertEqual(log.decoded, ["busy.png", "shared.png"], "the request no tile waits for never decoded")
        let again = await cache.thumbnail(path: paths[1], maxPixels: 64)
        XCTAssertEqual(Self.message(again), "decoded scrolled-past.png", "a tile that comes back decodes the file afresh")
    }

    func testADecoderPastItsDeadlineKeepsItsSlotAndTheQueueBehindItGivesUpInTime() async throws {
        let paths = try ["stall.png", "queued.png", "later.png"].map { name in
            let url = directory.appendingPathComponent(name)
            try Self.writePNG(url, width: 8, height: 8, color: CGColor(red: 0, green: 0, blue: 1, alpha: 1))
            return url.path
        }
        let gauge = DecoderGauge()
        let cache = MediaThumbnailCache(concurrency: 1, deadline: .milliseconds(40)) { path, _, _ in
            gauge.enter()
            defer { gauge.leave() }
            if path.hasSuffix("stall.png") { _ = Self.decodeThatIgnoresCancellation(seconds: 0.4) }
            return .failed("decoded \((path as NSString).lastPathComponent)")
        }
        let started = ContinuousClock.now
        let stalled = await cache.thumbnail(path: paths[0], maxPixels: 64)
        let queued = await cache.thumbnail(path: paths[1], maxPixels: 64)
        XCTAssertEqual(Self.message(stalled), MediaThumbnailCache.tooLong)
        XCTAssertEqual(Self.message(queued), MediaThumbnailCache.tooLong,
                       "the only slot still belongs to the stalled decoder, so the next request expires in the queue")
        XCTAssertLessThan(ContinuousClock.now - started, .milliseconds(350))
        XCTAssertEqual(gauge.peak, 1, "a decoder past its deadline still counts against the limit")

        try await Task.sleep(for: .milliseconds(450))
        let later = await cache.thumbnail(path: paths[2], maxPixels: 64)
        XCTAssertEqual(Self.message(later), "decoded later.png", "the slot comes back when the stalled decoder exits")
        XCTAssertEqual(gauge.peak, 1)

        let retried = await cache.thumbnail(path: paths[1], maxPixels: 64)
        XCTAssertEqual(Self.message(retried), "decoded queued.png",
                       "a request that never got a slot says nothing about its file, so the next one decodes it")
        let settled = await cache.thumbnail(path: paths[0], maxPixels: 64)
        XCTAssertEqual(Self.message(settled), "decoded stall.png",
                       "the late decoder's own answer replaced the timeout, without decoding the file again")
    }

    /// A decode that ends right at its deadline: its late answer and the recorded timeout race. However they land,
    /// the late answer wins, so no file is left on "took too long" until Retry.
    func testADecodeEndingAtItsDeadlineNeverLeavesTheTimeoutBehind() async throws {
        let names = (0 ..< 48).map { "edge-\($0).png" }
        let paths = try names.map { name in
            let url = directory.appendingPathComponent(name)
            try Self.writePNG(url, width: 4, height: 4, color: CGColor(red: 0, green: 1, blue: 0, alpha: 1))
            return url.path
        }
        let cache = MediaThumbnailCache(concurrency: names.count, deadline: .milliseconds(20)) { path, _, _ in
            _ = Self.decodeThatIgnoresCancellation(seconds: 0.02)
            return .failed("decoded \((path as NSString).lastPathComponent)")
        }
        await withTaskGroup(of: Void.self) { group in
            for path in paths { group.addTask { _ = await cache.thumbnail(path: path, maxPixels: 64) } }
        }
        try await Task.sleep(for: .milliseconds(300))
        for (path, name) in zip(paths, names) {
            let again = await cache.thumbnail(path: path, maxPixels: 64)
            XCTAssertEqual(Self.message(again), "decoded \(name)", "the late answer replaced the timeout")
        }
    }

    /// A tile that got "took too long" hears when the decoder past its deadline answers, so it loads again.
    func testATileShowingTheTimeoutHearsTheLateAnswer() async throws {
        let paths = try ["slow.png", "queued.png", "cancelled.png"].map { name in
            let url = directory.appendingPathComponent(name)
            try Self.writePNG(url, width: 8, height: 8, color: CGColor(red: 1, green: 0, blue: 0, alpha: 1))
            return url.path
        }
        let cache = MediaThumbnailCache(concurrency: 1, deadline: .milliseconds(40)) { path, _, _ in
            if !path.hasSuffix("queued.png") { _ = Self.decodeThatIgnoresCancellation(seconds: 0.3) }
            return .failed("decoded \((path as NSString).lastPathComponent)")
        }
        let first = await cache.thumbnail(path: paths[0], maxPixels: 64)
        XCTAssertEqual(Self.message(first), MediaThumbnailCache.tooLong)
        let queued = await cache.thumbnail(path: paths[1], maxPixels: 64)
        XCTAssertEqual(Self.message(queued), MediaThumbnailCache.tooLong)
        let noDecoder = await cache.lateAnswer(path: paths[1], maxPixels: 64)
        XCTAssertFalse(noDecoder, "no decoder ran for a request that expired in the queue, so no answer is coming")

        let started = ContinuousClock.now
        let heard = await cache.lateAnswer(path: paths[0], maxPixels: 64)
        XCTAssertTrue(heard, "the waiting tile hears the late answer")
        XCTAssertLessThan(ContinuousClock.now - started, .seconds(2))
        let reloaded = await cache.thumbnail(path: paths[0], maxPixels: 64)
        XCTAssertEqual(Self.message(reloaded), "decoded slow.png", "and its reload reads that answer")
        let afterwards = await cache.lateAnswer(path: paths[0], maxPixels: 64)
        XCTAssertTrue(afterwards, "a tile that asks after the answer landed reloads at once")

        let stalled = await cache.thumbnail(path: paths[2], maxPixels: 64)
        XCTAssertEqual(Self.message(stalled), MediaThumbnailCache.tooLong)
        let waiting = Task { await cache.lateAnswer(path: paths[2], maxPixels: 64) }
        var registered = await cache.lateWaiterCount
        var polls = 0
        while registered == 0, polls < 200 {
            try await Task.sleep(for: .milliseconds(5))
            registered = await cache.lateWaiterCount
            polls += 1
        }
        XCTAssertEqual(registered, 1)
        waiting.cancel()
        let cancelled = await waiting.value
        XCTAssertFalse(cancelled, "a tile that went away stops waiting")
        let left = await cache.lateWaiterCount
        XCTAssertEqual(left, 0)
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

    /// Counts decoder runs across the test's concurrent closures.
    private final class DecodeCounter: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0
        var count: Int { lock.withLock { value } }
        func add() { lock.withLock { value += 1 } }
    }

    func testRememberedFailuresAreCappedAndAFileWrittenOverReplacesItsOwn() async throws {
        let decodes = DecodeCounter()
        let cache = MediaThumbnailCache(failureLimit: 2, concurrency: 1, deadline: .seconds(5)) { _, _, _ in
            decodes.add()
            return .failed("fixture failure")
        }
        let paths = try (0 ..< 3).map { index in
            let url = directory.appendingPathComponent("broken-\(index).png")
            try Data("not an image \(index)".utf8).write(to: url)
            return url.path
        }
        for path in paths { _ = await cache.thumbnail(path: path, maxPixels: 64) }
        let remembered = await cache.failureCount
        XCTAssertEqual(remembered, 2, "the oldest failed path makes room")
        _ = await cache.thumbnail(path: paths[2], maxPixels: 64)
        XCTAssertEqual(decodes.count, 3, "a remembered failure answers without decoding again")
        _ = await cache.thumbnail(path: paths[0], maxPixels: 64)
        XCTAssertEqual(decodes.count, 4, "an evicted failure decodes again")

        // The same path, other bytes: a new identity that replaces the path's entry instead of adding one.
        try Data("other bytes, longer than before".utf8).write(to: URL(fileURLWithPath: paths[0]))
        _ = await cache.thumbnail(path: paths[0], maxPixels: 64)
        XCTAssertEqual(decodes.count, 5, "new bytes are decoded, not answered from the old failure")
        let afterRewrite = await cache.failureCount
        XCTAssertEqual(afterRewrite, 2)
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

/// Copy image reads an original the thumbnail pipeline never reads whole, so it answers inside a budget.
final class MediaImageCopyTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("media-copy-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: directory)
    }

    func testAPictureWithinTheBudgetIsPreparedAsTiffAtItsOwnSize() throws {
        let url = directory.appendingPathComponent("wide.png")
        try MediaThumbnailCacheTests.writePNG(url, width: 800, height: 400, color: CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        guard case .image(let tiff) = MediaImageCopy.prepare(path: url.path) else {
            return XCTFail("A small readable PNG must be prepared")
        }

        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: tiff))
        XCTAssertEqual(bitmap.pixelsWide, 800)
        XCTAssertEqual(bitmap.pixelsHigh, 400)
    }

    func testAPictureReachedThroughASymbolicLinkIsPreparedLikeTheFileItself() throws {
        let url = directory.appendingPathComponent("target.png")
        try MediaThumbnailCacheTests.writePNG(url, width: 40, height: 30, color: CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        let link = directory.appendingPathComponent("link.png")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: url)
        guard case .image(let tiff) = MediaImageCopy.prepare(path: link.path) else {
            return XCTFail("a link to a readable PNG is that picture, not 'not a picture file'")
        }

        XCTAssertEqual(NSBitmapImageRep(data: tiff)?.pixelsWide, 40)
        let fifo = directory.appendingPathComponent("pipe.png")
        XCTAssertEqual(mkfifo(fifo.path, 0o600), 0)
        let fifoLink = directory.appendingPathComponent("pipe-link.png")
        try FileManager.default.createSymbolicLink(at: fifoLink, withDestinationURL: fifo)
        XCTAssertEqual(MediaImageCopy.prepare(path: fifoLink.path), .failed("This is not a picture file."),
                       "a link to a pipe is still refused before anything opens it")
    }

    func testAFileOverTheByteBudgetIsNeverReadAndTheFileItselfIsOffered() throws {
        let url = directory.appendingPathComponent("big.png")
        try MediaThumbnailCacheTests.writePNG(url, width: 64, height: 64, color: CGColor(red: 0, green: 1, blue: 0, alpha: 1))
        let bytes = try XCTUnwrap(try url.resourceValues(forKeys: [.fileSizeKey]).fileSize)
        guard case .fileOnly(let reason) = MediaImageCopy.prepare(path: url.path, maxBytes: bytes - 1) else {
            return XCTFail("A file past the byte budget must not become a picture")
        }

        XCTAssertFalse(reason.isEmpty)
        guard case .image = MediaImageCopy.prepare(path: url.path, maxBytes: bytes) else {
            return XCTFail("A file exactly at the budget is still copied")
        }
    }

    func testAPictureOverThePixelBudgetIsNeverDecodedAndTheFileItselfIsOffered() throws {
        let url = directory.appendingPathComponent("many-pixels.png")
        try MediaThumbnailCacheTests.writePNG(url, width: 800, height: 400, color: CGColor(red: 0, green: 0, blue: 1, alpha: 1))
        guard case .fileOnly(let reason) = MediaImageCopy.prepare(path: url.path, maxPixels: 319_999) else {
            return XCTFail("A small file with too many pixels must not be decoded")
        }

        XCTAssertTrue(reason.contains("800"), reason)
        guard case .image = MediaImageCopy.prepare(path: url.path, maxPixels: 320_000) else {
            return XCTFail("A picture exactly at the budget is still copied")
        }
    }

    func testWhatIsNotAReadableRegularImageFailsWithAReasonInsteadOfBlockingOrCopying() throws {
        let text = directory.appendingPathComponent("note.png")
        try Data("not an image".utf8).write(to: text)
        let fifo = directory.appendingPathComponent("pipe.png")
        XCTAssertEqual(mkfifo(fifo.path, 0o600), 0)
        for path in [text.path, fifo.path, directory.path, directory.appendingPathComponent("gone.png").path] {
            guard case .failed(let reason) = MediaImageCopy.prepare(path: path) else {
                return XCTFail("\(path) must fail")
            }

            XCTAssertFalse(reason.isEmpty)
        }
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

    /// Holds the copy's file read until the test lets it finish.
    private final class ReadGate: @unchecked Sendable {
        private let lock = NSLock()
        private var waiters: [CheckedContinuation<Void, Never>] = []
        private var started = 0
        private var opened = false
        var reads: Int { lock.withLock { started } }

        /// Returns at once once the gate is open, so a read that starts after `open()` cannot wait forever.
        func wait() async {
            await withCheckedContinuation { continuation in
                let resumeNow = lock.withLock {
                    started += 1
                    if opened { return true }
                    waiters.append(continuation)
                    return false
                }
                if resumeNow { continuation.resume() }
            }
        }

        func open() {
            let pending = lock.withLock {
                opened = true
                defer { waiters = [] }
                return waiters
            }
            pending.forEach { $0.resume() }
        }
    }

    private func waitForCopy(_ state: MediaPreviewState) async throws {
        let deadline = ContinuousClock.now + .seconds(2)
        while state.copyStatus == .copying, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertNotEqual(state.copyStatus, .copying, "the copy did not finish within 2 s")
    }

    func testCopyAdmitsOneCopyAtATimeAndARefusalSaysWhy() async throws {
        let state = MediaPreviewState()
        let gate = ReadGate()
        var written: [String] = []
        state.loadImage = { _ in
            // lint-rules-ignore: the test always opens the gate, and a read after open() returns at once
            await gate.wait()
            return .image(Data([1]))
        }
        state.writeImage = { _, path in
            written.append(path)
            return .copied
        }
        state.copyImage(items[0])
        state.copyImage(items[0])
        state.copyImage(items[1])
        XCTAssertEqual(state.copyStatus, .copying)
        let deadline = ContinuousClock.now + .seconds(2)
        while gate.reads == 0, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
        gate.open()
        try await waitForCopy(state)
        XCTAssertEqual(gate.reads, 1, "clicks while a copy runs start no second read")
        XCTAssertEqual(written, [items[0].path])
        XCTAssertEqual(state.copyStatus, .copied)

        state.loadImage = { _ in .failed("Too large.") }
        state.copyImage(items[1])
        try await waitForCopy(state)
        XCTAssertEqual(state.copyStatus, .refused("Too large."))
        XCTAssertEqual(written, [items[0].path], "a refused image writes nothing")

        state.loadImage = { _ in .fileOnly("Too large to copy as a picture.") }
        state.copyImage(items[2])
        try await waitForCopy(state)
        XCTAssertEqual(written, [items[0].path, items[2].path], "an image too large for the picture still offers its file")
    }

    func testTheDefaultLoaderPreparesAPictureInsideTheBudgetOffTheMainActor() async throws {
        let png = FileManager.default.temporaryDirectory.appendingPathComponent("copy-\(UUID().uuidString).png")
        try MediaThumbnailCacheTests.writePNG(png, width: 40, height: 30, color: CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        defer { try? FileManager.default.removeItem(at: png) }
        guard case .image(let tiff) = await MediaPreviewState().loadImage(png.path) else {
            return XCTFail("a small readable PNG is prepared by the default loader")
        }

        XCTAssertEqual(NSBitmapImageRep(data: tiff)?.pixelsWide, 40)
    }

    func testACopyWhoseReadStallsIsRefusedAtItsDeadlineAndItsLateAnswerNeverReachesTheClipboard() async throws {
        let state = MediaPreviewState()
        state.copyDeadline = .milliseconds(50)
        let gate = ReadGate()
        var written: [String] = []
        state.loadImage = { _ in
            // lint-rules-ignore: the test always opens the gate, and a read after open() returns at once
            await gate.wait()
            return .image(Data([1]))
        }
        state.writeImage = { _, path in
            written.append(path)
            return .copied
        }
        state.copyImage(items[0])
        try await waitForCopy(state)
        guard case .refused(let timedOut) = state.copyStatus else { return XCTFail("the stalled copy is refused") }
        XCTAssertTrue(timedOut.contains("took too long"), timedOut)

        // The stalled read still runs: a new click starts no second read beside it.
        state.copyImage(items[0])
        XCTAssertEqual(state.copyStatus, .refused("The last image read has not finished yet. Try again in a moment."))
        XCTAssertEqual(gate.reads, 1)

        // The stalled read answers now. Until its answer lands, a click is still told to wait.
        gate.open()
        let deadline = ContinuousClock.now + .seconds(2)
        while ContinuousClock.now < deadline {
            state.copyImage(items[1])
            if state.copyStatus == .copying { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        try await waitForCopy(state)
        XCTAssertEqual(state.copyStatus, .copied)
        XCTAssertEqual(written, [items[1].path], "the expired read wrote nothing; the next click copied once it ended")
        XCTAssertEqual(gate.reads, 2)
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

/// A tile reloads when its file changes at the same path (eve, PR #487 t27): `MediaFileChange` must fire on an in-place
/// write, on an atomic replace and when a missing file appears, and return false at once when cancelled.
final class MediaFileChangeTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("media-change-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: directory)
    }

    /// Starts the wait, lets the source arm, runs `change`, and returns what the wait answered within 3 s.
    private func waitAnswer(path: String, change: @escaping () throws -> Void) async throws -> Bool {
        let seen = MediaFileIdentity.current(path)
        let wait = Task { await MediaFileChange.next(path: path, seen: seen, debounce: .milliseconds(10)) }
        try await Task.sleep(for: .milliseconds(150))
        try change()
        let deadline = Task {
            try await Task.sleep(for: .seconds(3))
            wait.cancel()
        }
        let answer = await wait.value
        deadline.cancel()
        return answer
    }

    func testAnInPlaceWriteIsAChange() async throws {
        let file = directory.appendingPathComponent("a.png")
        try Data([1]).write(to: file)
        let answer = try await waitAnswer(path: file.path) {
            let handle = try FileHandle(forWritingTo: file)
            try handle.seekToEnd()
            try handle.write(contentsOf: Data([2]))
            try handle.close()
        }
        XCTAssertTrue(answer)
    }

    func testAnAtomicReplaceIsAChange() async throws {
        let file = directory.appendingPathComponent("b.png")
        try Data([1]).write(to: file)
        let answer = try await waitAnswer(path: file.path) { try Data([3, 4]).write(to: file, options: .atomic) }
        XCTAssertTrue(answer)
    }

    func testAMissingFileThatAppearsIsAChange() async throws {
        let file = directory.appendingPathComponent("later.png")
        let answer = try await waitAnswer(path: file.path) { try Data([5]).write(to: file) }
        XCTAssertTrue(answer)
    }

    /// A decode the test holds open until it has changed the file.
    private final class HeldDecode: @unchecked Sendable {
        private let lock = NSLock()
        private var continuation: CheckedContinuation<Void, Never>?
        var isHeld: Bool { lock.withLock { continuation != nil } }

        func hold() async {
            await withCheckedContinuation { continuation in lock.withLock { self.continuation = continuation } }
        }

        func release() {
            lock.withLock { continuation }?.resume()
        }
    }

    func testATileShowingTheTimeoutReloadsWhenTheLateAnswerLandsThoughTheFileNeverChanges() async throws {
        let file = directory.appendingPathComponent("slow.png")
        try Data([1]).write(to: file)
        let seen = MediaFileIdentity.current(file.path)
        let lateAnswer: @Sendable () async -> Bool = {
            try? await Task.sleep(for: .milliseconds(50))
            return true
        }
        let reload = Task {
            await MediaFileChange.nextReload(path: file.path, seen: seen, lateAnswer: lateAnswer, debounce: .milliseconds(10))
        }
        let deadline = Task {
            try await Task.sleep(for: .seconds(3))
            reload.cancel()
        }
        let answer = await reload.value
        deadline.cancel()
        XCTAssertTrue(answer, "the late answer reloads the tile")

        // No late answer is coming: the file watch still runs, and the file's change reloads the tile.
        let watched = try await waitReload(path: file.path, lateAnswer: { false }) {
            try Data([2, 3]).write(to: file, options: .atomic)
        }
        XCTAssertTrue(watched)
    }

    private func waitReload(path: String, lateAnswer: @escaping @Sendable () async -> Bool,
                            change: @escaping () throws -> Void) async throws -> Bool
    {
        let seen = MediaFileIdentity.current(path)
        let wait = Task {
            await MediaFileChange.nextReload(path: path, seen: seen, lateAnswer: lateAnswer, debounce: .milliseconds(10))
        }
        try await Task.sleep(for: .milliseconds(150))
        try change()
        let deadline = Task {
            try await Task.sleep(for: .seconds(3))
            wait.cancel()
        }
        let answer = await wait.value
        deadline.cancel()
        return answer
    }

    func testAFileReplacedWhileItsThumbnailDecodesReloadsOnceTheDecodeEnds() async throws {
        let file = directory.appendingPathComponent("repaired.png")
        try Data([1]).write(to: file)
        let decode = HeldDecode()
        // What the tile does: note the file, decode it (held here), then watch it.
        let tile = Task {
            let seen = MediaFileIdentity.current(file.path)
            await decode.hold()
            return await MediaFileChange.next(path: file.path, seen: seen, debounce: .milliseconds(10))
        }
        for _ in 0 ..< 200 where !decode.isHeld { try await Task.sleep(for: .milliseconds(5)) }
        try Data([2, 3]).write(to: file, options: .atomic)
        decode.release()
        let deadline = Task {
            try await Task.sleep(for: .seconds(3))
            tile.cancel()
        }
        let answer = await tile.value
        deadline.cancel()
        XCTAssertTrue(answer, "the replacement during the decode reloads the tile without waiting for another change")
    }

    func testPastTheWatchLimitATileWaitsWithoutADescriptorAndThenWatchesItsFile() async throws {
        let slots = MediaWatchSlots(limit: 1)
        let first = directory.appendingPathComponent("first.png")
        let second = directory.appendingPathComponent("second.png")
        let gone = directory.appendingPathComponent("gone.png")
        for file in [first, second, gone] { try Data([1]).write(to: file) }
        func until(_ condition: () async -> Bool) async throws {
            for _ in 0 ..< 200 {
                if await condition() { return }
                try await Task.sleep(for: .milliseconds(5))
            }
        }
        func watching(_ file: URL) -> Task<Bool, Never> {
            let seen = MediaFileIdentity.current(file.path)
            return Task { await MediaFileChange.next(path: file.path, seen: seen, debounce: .milliseconds(10), slots: slots) }
        }
        let watchingFirst = watching(first)
        try await until { await slots.inUse == 1 }
        let watchingSecond = watching(second)
        let leaving = watching(gone)
        try await until { await slots.waitingCount == 2 }
        let held = await slots.inUse
        XCTAssertEqual(held, 1, "one watch at the limit, however many tiles wait")

        leaving.cancel()
        let left = await leaving.value
        XCTAssertFalse(left, "a tile that goes away while it waits answers at once")
        watchingFirst.cancel()
        let firstAnswer = await watchingFirst.value
        XCTAssertFalse(firstAnswer)

        // The freed slot goes to the second tile, which then sees its own file change.
        try await Task.sleep(for: .milliseconds(150))
        try Data([2, 3]).write(to: second, options: .atomic)
        let deadline = Task {
            try await Task.sleep(for: .seconds(3))
            watchingSecond.cancel()
        }
        let secondAnswer = await watchingSecond.value
        deadline.cancel()
        XCTAssertTrue(secondAnswer)
        let after = await slots.inUse
        XCTAssertEqual(after, 0, "every slot came back")
    }

    func testPastTheWatchLimitATileStillSeesItsOwnFileReplacedWhileEveryWatchStaysTaken() async throws {
        let slots = MediaWatchSlots(limit: 1)
        let still = directory.appendingPathComponent("still.png")
        let waiting = directory.appendingPathComponent("waiting.png")
        for file in [still, waiting] { try Data([1]).write(to: file) }
        let stillSeen = MediaFileIdentity.current(still.path)
        let watchingStill = Task {
            await MediaFileChange.next(path: still.path, seen: stillSeen, debounce: .milliseconds(10), slots: slots)
        }
        defer { watchingStill.cancel() }
        var polls = 0
        while await slots.inUse == 0, polls < 200 {
            polls += 1
            try await Task.sleep(for: .milliseconds(5))
        }
        let waitingSeen = MediaFileIdentity.current(waiting.path)
        let watchingWaiting = Task {
            await MediaFileChange.next(path: waiting.path, seen: waitingSeen, debounce: .milliseconds(10), slots: slots,
                                       overflowCheck: .milliseconds(150))
        }
        polls = 0
        while await slots.waitingCount == 0, polls < 200 {
            polls += 1
            try await Task.sleep(for: .milliseconds(5))
        }
        let queuedBefore = await slots.waitingCount
        XCTAssertEqual(queuedBefore, 1, "the second tile waits for the only watch")
        try Data([2, 3]).write(to: waiting, options: .atomic)
        let deadline = Task {
            try await Task.sleep(for: .seconds(2))
            watchingWaiting.cancel()
        }
        let answer = await watchingWaiting.value
        deadline.cancel()
        XCTAssertTrue(answer, "the waiting tile saw its file replaced though the only watch stayed taken")
        let held = await slots.inUse
        let queued = await slots.waitingCount
        XCTAssertEqual(held, 1, "the unchanged tile keeps its watch")
        XCTAssertEqual(queued, 0, "the tile that saw its change no longer waits for a slot")
    }

    func testCancellationAnswersFalseAtOnce() async throws {
        let file = directory.appendingPathComponent("c.png")
        try Data([1]).write(to: file)
        let seen = MediaFileIdentity.current(file.path)
        let wait = Task { await MediaFileChange.next(path: file.path, seen: seen) }
        try await Task.sleep(for: .milliseconds(100))
        let start = ContinuousClock.now
        wait.cancel()
        let answer = await wait.value
        XCTAssertFalse(answer)
        XCTAssertLessThan(ContinuousClock.now - start, .milliseconds(500))
    }
}
