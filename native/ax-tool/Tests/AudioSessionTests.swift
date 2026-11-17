import AVFoundation
import CoreMedia
import Foundation
import SnapshotSupport
import XCTest
@testable import ax_tool

final class AudioSessionTests: XCTestCase {
    private func pcm(samples: Int, at: CMTime) throws -> CMSampleBuffer {
        var description = AudioStreamBasicDescription(mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0)
        var format: CMAudioFormatDescription?
        XCTAssertEqual(CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &description,
            layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil,
            formatDescriptionOut: &format), noErr)
        let audioFormat = try XCTUnwrap(format)
        var block: CMBlockBuffer?
        XCTAssertEqual(CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil,
            blockLength: samples * 4, blockAllocator: kCFAllocatorDefault, customBlockSource: nil,
            offsetToData: 0, dataLength: samples * 4, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block), noErr)
        let data = try XCTUnwrap(block)
        XCTAssertEqual(CMBlockBufferFillDataBytes(with: 0, blockBuffer: data, offsetIntoDestination: 0, dataLength: samples * 4), noErr)
        var buffer: CMSampleBuffer?
        XCTAssertEqual(CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: kCFAllocatorDefault,
            dataBuffer: data, formatDescription: audioFormat, sampleCount: samples, presentationTimeStamp: at,
            packetDescriptions: nil, sampleBufferOut: &buffer), noErr)
        return try XCTUnwrap(buffer)
    }

    func testSampleRotationAndMutedSpanWithoutADevice() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("audio-session-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        var lines: [Data] = []
        var failures: [String] = []
        let audio = SegmentedAudio(directory: directory, seconds: 0.1, emit: { lines.append($0) })
        audio.failed = { failures.append($0) }
        let zero = CMClockGetTime(CMClockGetHostTimeClock())
        let first = try pcm(samples: 1200, at: zero)
        audio.queue.sync { audio.append(first, source: .mic) }
        audio.setMuted(.mic, true)
        let muted = try pcm(samples: 2400, at: CMTimeAdd(zero, CMTime(value: 1200, timescale: 48_000)))
        audio.queue.sync { audio.append(muted, source: .mic) }
        audio.setMuted(.mic, false)
        let rest = try pcm(samples: 10800, at: CMTimeAdd(zero, CMTime(value: 3600, timescale: 48_000)))
        audio.queue.sync { audio.append(rest, source: .mic) }
        try await audio.finish()
        XCTAssertEqual(failures, [])
        var rows = try lines.map { line -> [String: Any] in
            XCTAssertEqual(line.last, 0x0a)
            return try XCTUnwrap(JSONSerialization.jsonObject(with: line) as? [String: Any])
        }
        rows.sort { ($0["zeroAt"] as? String ?? "") < ($1["zeroAt"] as? String ?? "") }
        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(rows.compactMap { $0["durationMs"] as? Int }, [100, 100, 100])
        XCTAssertEqual(rows.first?["mutedSpans"] as? [[Int]], [[25, 75]])
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let starts = rows.compactMap { $0["zeroAt"] as? String }.compactMap { formatter.date(from: $0) }
        XCTAssertEqual(starts.count, 3)
        for index in 1..<starts.count {
            XCTAssertEqual(starts[index].timeIntervalSince(starts[index - 1]), 0.1, accuracy: 0.001)
        }
        for row in rows {
            let data = try JSONSerialization.data(withJSONObject: row)
            let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            XCTAssertEqual(Set(decoded.keys), Set(["file", "source", "at", "zeroAt", "durationMs", "mutedSpans", "lostSpans", "kept"]))
            let file = try XCTUnwrap(row["file"] as? String)
            XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent(file).path))
        }
    }

    func testPauseClosesAPartialSegmentAndResumeKeepsWallTime() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("audio-pause-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        var lines: [Data] = []
        let audio = SegmentedAudio(directory: directory, seconds: 60, emit: { lines.append($0) })
        let zero = CMClockGetTime(CMClockGetHostTimeClock())
        let first = try pcm(samples: 1200, at: zero)
        audio.queue.sync { audio.append(first, source: .mic) }
        audio.setPaused(true)
        let skipped = try pcm(samples: 1200, at: CMTimeAdd(zero, CMTime(value: 1, timescale: 1)))
        audio.queue.sync { audio.append(skipped, source: .mic) }
        audio.setPaused(false)
        let resumed = try pcm(samples: 1200, at: CMTimeAdd(zero, CMTime(value: 2, timescale: 1)))
        audio.queue.sync { audio.append(resumed, source: .mic) }
        try await audio.finish()
        try await audio.finish()
        let rows = try lines.map { try XCTUnwrap(JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows.compactMap { $0["durationMs"] as? Int }, [25, 25])
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let starts = rows.compactMap { $0["zeroAt"] as? String }.compactMap { formatter.date(from: $0) }.sorted()
        XCTAssertEqual(starts.count, 2)
        if starts.count == 2 { XCTAssertEqual(starts[1].timeIntervalSince(starts[0]), 2, accuracy: 0.001) }
    }

    /// Generated PCM arrives faster than real time. Wait on the encoder's event, with a deadline, in tests only.
    private func ready(_ input: AVAssetWriterInput) -> Bool {
        if input.isReadyForMoreMediaData { return true }
        let ready = DispatchSemaphore(value: 0)
        let observation = input.observe(\.isReadyForMoreMediaData, options: [.initial, .new]) { input, _ in
            if input.isReadyForMoreMediaData { ready.signal() }
        }
        defer { observation.invalidate() }
        return ready.wait(timeout: .now() + 5) == .success
    }

    func testTimestampJumpAndBothWriterRefusalsPreserveFileTime() async throws {
        for refusal in ["timestamp-jump", "not-ready", "append-false", "final-not-ready"] {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("audio-loss-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: directory) }
            let url = directory.appendingPathComponent("mic.m4a")
            let track = AudioTrack(source: .mic, movieInput: nil, sidecarURL: url)
            track.sidecarReady = ready
            let zero = CMTime(value: 123, timescale: 1)
            track.appendSidecar(try pcm(samples: 4800, at: zero), at: zero)
            if refusal != "timestamp-jump" {
                let at = CMTimeAdd(zero, CMTime(value: 4800, timescale: 48_000))
                if refusal == "append-false" {
                    track.sidecarAppend = { _, _ in false }
                } else {
                    track.sidecarReady = { _ in false }
                }
                track.appendSidecar(try pcm(samples: 79_200, at: at), at: at)
                track.sidecarAppend = { $0.append($1) }
                track.sidecarReady = ready
            }
            if refusal != "final-not-ready" {
                let at = CMTimeAdd(zero, CMTime(value: 84_000, timescale: 48_000))
                track.appendSidecar(try pcm(samples: 4800, at: at), at: at)
            }
            track.finishSidecar()
            XCTAssertTrue(track.sidecarWritten, "\(refusal): \(track.failures)")
            let duration = try await AVURLAsset(url: url).load(.duration)
            let expectedMs = refusal == "final-not-ready" ? 1750 : 1850
            XCTAssertEqual(CMTimeGetSeconds(duration) * 1000, Double(expectedMs), accuracy: 25, refusal)
            XCTAssertEqual(track.fileTimeline.durationMs, expectedMs, refusal)
            XCTAssertEqual(track.lostSpans.count, 1, refusal)
            let span = try XCTUnwrap(track.lostSpans.first)
            XCTAssertEqual(span[0], 100, accuracy: 25, refusal)
            XCTAssertEqual(span[1] - span[0], 1650, accuracy: 25, refusal)
        }
    }

    func testOverlappingBuffersAreTrimmedWithoutShiftingOrShorteningTheFile() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("audio-overlap-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("mic.m4a")
        let track = AudioTrack(source: .mic, movieInput: nil, sidecarURL: url)
        track.sidecarReady = ready
        let zero = CMTime(value: 123, timescale: 1)
        for (offset, samples) in [(0, 4800), (2400, 4800), (0, 1200), (7200, 2400)] {
            let at = CMTimeAdd(zero, CMTime(value: Int64(offset), timescale: 48_000))
            track.appendSidecar(try pcm(samples: samples, at: at), at: at)
        }
        track.finishSidecar()
        XCTAssertTrue(track.sidecarWritten, "\(track.failures)")
        XCTAssertEqual(track.fileTimeline.durationMs, 200)
        XCTAssertEqual(track.lostSpans, [])
        let duration = try await AVURLAsset(url: url).load(.duration)
        XCTAssertEqual(CMTimeGetSeconds(duration) * 1000, 200, accuracy: 25)
    }

    func testThreeMinuteSegmentsKeepCaptureTimeAndALateFirstSample() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("audio-clock-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        var lines: [Data] = []
        let host = CMTime(value: 123, timescale: 1)
        let wall = Date(timeIntervalSince1970: 1_700_000_000)
        let audio = SegmentedAudio(directory: directory, seconds: 60, emit: { lines.append($0) }, clock: (host, wall))
        let first = CMTimeAdd(host, CMTime(value: 700, timescale: 1000))
        let buffer = try pcm(samples: 3 * 60 * 48_000, at: first)
        audio.queue.sync { audio.append(buffer, source: .mic) }
        let duplicate = try pcm(samples: 480, at: CMTimeAdd(first, CMTime(value: 179, timescale: 1)))
        audio.queue.sync { audio.append(duplicate, source: .mic) }
        try await audio.finish()
        let rows = try lines.map { try XCTUnwrap(JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
            .sorted { ($0["zeroAt"] as? String ?? "") < ($1["zeroAt"] as? String ?? "") }
        XCTAssertEqual(rows.count, 3)
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let starts = try rows.map { try XCTUnwrap(formatter.date(from: XCTUnwrap($0["zeroAt"] as? String))) }
        XCTAssertEqual(try XCTUnwrap(starts.first).timeIntervalSince(wall), 0.7, accuracy: 0.020)
        for index in rows.indices {
            let file = try XCTUnwrap(rows[index]["file"] as? String)
            let duration = try await AVURLAsset(url: directory.appendingPathComponent(file)).load(.duration)
            XCTAssertEqual(CMTimeGetSeconds(duration), 60, accuracy: 0.020)
            XCTAssertEqual(rows[index]["durationMs"] as? Int, 60_000)
            if index + 1 < starts.count {
                XCTAssertEqual(starts[index + 1].timeIntervalSince(starts[index]), CMTimeGetSeconds(duration), accuracy: 0.020)
            }
        }
    }
}
