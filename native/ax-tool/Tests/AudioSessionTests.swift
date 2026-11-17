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
            XCTAssertEqual(Set(decoded.keys), Set(["file", "source", "at", "zeroAt", "durationMs", "mutedSpans", "kept"]))
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
}
