import AVFoundation
import CoreMedia
import Foundation
import SnapshotSupport
import XCTest
@testable import ax_tool

final class AudioSessionTests: XCTestCase {
    private func closedRows(_ lines: [Data]) throws -> [[String: Any]] {
        try lines.map { line in
            XCTAssertEqual(line.last, 0x0a)
            return try XCTUnwrap(JSONSerialization.jsonObject(with: line) as? [String: Any])
        }.filter { $0["event"] == nil }
    }

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

    private func stereo(samples: Int, at: CMTime) throws -> CMSampleBuffer {
        let format = try XCTUnwrap(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000,
            channels: 2, interleaved: false))
        let pcm = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples)))
        pcm.frameLength = AVAudioFrameCount(samples)
        let channels = try XCTUnwrap(pcm.floatChannelData)
        for channel in 0..<2 {
            for sample in 0..<samples { channels[channel][sample] = channel == 0 ? 0.25 : -0.5 }
        }
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 48_000),
            presentationTimeStamp: at, decodeTimeStamp: .invalid)
        var buffer: CMSampleBuffer?
        var sampleSize = 8
        XCTAssertEqual(CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false,
            makeDataReadyCallback: nil, refcon: nil, formatDescription: format.formatDescription,
            sampleCount: samples, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
            sampleSizeEntryCount: 1, sampleSizeArray: &sampleSize, sampleBufferOut: &buffer), noErr)
        let result = try XCTUnwrap(buffer)
        XCTAssertEqual(CMSampleBufferSetDataBufferFromAudioBufferList(result, blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault, flags: 0, bufferList: pcm.mutableAudioBufferList), noErr)
        return result
    }

    private func directory() throws -> URL {
        let result = FileManager.default.temporaryDirectory.appendingPathComponent("audio-session-judge-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: result, withIntermediateDirectories: true)
        return result
    }

    func testLaunchMuteSilencesFirstStereoBufferAndLaunchPauseWritesNothingUntilResume() async throws {
        let directory = try directory()
        let host = CMTime(value: 123, timescale: 1)
        var mutedRows: [Data] = []
        let muted = SegmentedAudio(directory: directory, seconds: 60, emit: { mutedRows.append($0) }, muted: [.system])
        let first = try stereo(samples: 4800, at: host)
        muted.queue.sync { muted.append(first, source: .system) }
        try await muted.finish()
        let row = try XCTUnwrap(closedRows(mutedRows).first)
        XCTAssertEqual(row["mutedSpans"] as? [[Int]], [[0, 100]])
        let file = try AVAudioFile(forReading: directory.appendingPathComponent(try XCTUnwrap(row["file"] as? String)))
        let decoded = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
        try file.read(into: decoded)
        let channels = try XCTUnwrap(decoded.floatChannelData)
        for channel in 0..<2 {
            XCTAssertTrue((0..<Int(decoded.frameLength)).allSatisfy { abs(channels[channel][$0]) < 0.001 })
        }
        let pausedDirectory = try self.directory()
        var pausedRows: [Data] = []
        let paused = SegmentedAudio(directory: pausedDirectory, seconds: 60, emit: { pausedRows.append($0) }, paused: true,
            clock: { (host, Date(timeIntervalSince1970: 1_700_000_000)) })
        paused.queue.sync { paused.append(first, source: .system) }
        XCTAssertEqual(pausedRows.count, 0)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: pausedDirectory.path), [])
        paused.setPaused(false)
        let resumed = try stereo(samples: 4800, at: CMTimeAdd(host, CMTime(value: 1, timescale: 1)))
        paused.queue.sync { paused.append(resumed, source: .system) }
        try await paused.finish()
        let resumedRow = try XCTUnwrap(closedRows(pausedRows).first)
        XCTAssertEqual(resumedRow["zeroAt"] as? String, "2023-11-14T22:13:21.000Z")
        XCTAssertEqual(resumedRow["durationMs"] as? Int, 100)
    }

    func testRefusedOffsetCopyGivesTheNextWrittenSampleItsOwnZero() async throws {
        let directory = try directory()
        var lines: [Data] = []
        let host = CMTime(value: 123, timescale: 1)
        let wall = Date(timeIntervalSince1970: 1_700_000_000)
        let audio = SegmentedAudio(directory: directory, seconds: 0.1, emit: { lines.append($0) }, clock: { (host, wall) })
        audio.rangeCopy = { _, _ in (-12700, nil) }
        for offset in [0, 3840, 8640] {
            let time = CMTimeAdd(host, CMTime(value: Int64(offset), timescale: 48_000))
            let buffer = try stereo(samples: 4800, at: time)
            audio.queue.sync { audio.append(buffer, source: .system) }
        }
        try await audio.finish()
        let rows = try closedRows(lines).sorted { ($0["file"] as? String ?? "") < ($1["file"] as? String ?? "") }
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows.last?["file"] as? String, "audio-000002-system.m4a")
        XCTAssertEqual(rows.last?["zeroAt"] as? String, "2023-11-14T22:13:20.180Z")
        let started = try lines.compactMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            .filter { $0["event"] as? String == "segment-started" }
        XCTAssertEqual(started.last?["zeroAt"] as? String, rows.last?["zeroAt"] as? String)
    }

    func testNewSegmentReanchorsAfterWallClockSleepAndKeepsItsAnnouncedZero() async throws {
        let directory = try directory()
        var lines: [Data] = []
        let host = CMTime(value: 123, timescale: 1)
        let wall = Date(timeIntervalSince1970: 1_700_000_000)
        var anchor = (host: host, wall: wall)
        let audio = SegmentedAudio(directory: directory, seconds: 0.1, emit: { lines.append($0) }, clock: { anchor })
        let first = try stereo(samples: 4800, at: host)
        audio.queue.sync { audio.append(first, source: .system) }
        anchor = (CMTimeAdd(host, CMTime(value: 100, timescale: 1000)), wall.addingTimeInterval(60.1))
        let second = try stereo(samples: 2400, at: anchor.host)
        audio.queue.sync { audio.append(second, source: .system) }
        anchor.wall = wall.addingTimeInterval(120)
        try await audio.finish()
        let rows = try closedRows(lines).sorted { ($0["file"] as? String ?? "") < ($1["file"] as? String ?? "") }
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows.first?["zeroAt"] as? String, "2023-11-14T22:13:20.000Z")
        XCTAssertEqual(rows.last?["zeroAt"] as? String, "2023-11-14T22:14:20.100Z")
        let started = try lines.compactMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            .filter { $0["event"] as? String == "segment-started" }
        XCTAssertEqual(started.last?["zeroAt"] as? String, rows.last?["zeroAt"] as? String)
    }

    func testRefusedTrimReportsTheSourceStatusAndLostSpanIncludingTheFinalBuffer() async throws {
        let directory = try directory()
        let track = AudioTrack(source: .system, movieInput: nil, sidecarURL: directory.appendingPathComponent("system.m4a"))
        track.sidecarReady = ready
        let host = CMTime(value: 123, timescale: 1)
        track.appendSidecar(try stereo(samples: 4800, at: host), at: host)
        track.rangeCopy = { _, _ in (-12700, nil) }
        let overlap = CMTimeAdd(host, CMTime(value: 3840, timescale: 48_000))
        track.appendSidecar(try stereo(samples: 4800, at: overlap), at: overlap)
        XCTAssertTrue(track.failures.contains { $0.contains("system") && $0.contains("trim") && $0.contains("-12700") })
        track.finishSidecar()
        XCTAssertTrue(track.sidecarWritten, "\(track.failures)")
        XCTAssertEqual(track.fileTimeline.durationMs, 180)
        XCTAssertEqual(track.lostSpans, [[100, 180]])
    }

    func testStereoPlanarSplitMuteAndSilenceKeepBothChannelsAndSampleTime() async throws {
        let directory = try directory()
        let host = CMTime(value: 123, timescale: 1)
        let input = try stereo(samples: 9600, at: host)
        let cut = try XCTUnwrap(copyAudioRange(input, CFRange(location: 2400, length: 4800)).buffer)
        var cutBlock: CMBlockBuffer?
        let cutList = AudioBufferList.allocate(maximumBuffers: 2)
        defer { free(cutList.unsafeMutablePointer) }
        XCTAssertEqual(CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(cut,
            bufferListSizeNeededOut: nil, bufferListOut: cutList.unsafeMutablePointer,
            bufferListSize: MemoryLayout<AudioBufferList>.size + MemoryLayout<AudioBuffer>.size,
            blockBufferAllocator: kCFAllocatorDefault, blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: 0, blockBufferOut: &cutBlock), noErr)
        XCTAssertEqual(cutList.count, 2)
        for channel in 0..<2 {
            let data = try XCTUnwrap(cutList[channel].mData).assumingMemoryBound(to: Float.self)
            XCTAssertEqual(cutList[channel].mDataByteSize, 4800 * 4)
            XCTAssertTrue((0..<4800).allSatisfy { data[$0] == (channel == 0 ? 0.25 : -0.5) })
        }
        let planes = copyPCMFrames(input, CFRange(location: 2400, length: 4800), refused: -12700)
        XCTAssertEqual(planes.status, noErr)
        let planeCopy = try XCTUnwrap(planes.buffer)
        XCTAssertTrue(CMSampleBufferDataIsReady(planeCopy), "the per-plane copy is ready before it is returned")
        XCTAssertEqual(CMSampleBufferGetNumSamples(planeCopy), 4800)
        XCTAssertEqual(CMTimeCompare(CMSampleBufferGetPresentationTimeStamp(planeCopy),
            CMTimeAdd(host, CMTime(value: 2400, timescale: 48_000))), 0)
        XCTAssertEqual(copyPCMFrames(input, CFRange(location: 9000, length: 4800), refused: -12700).status, -12700)
        let silent = try XCTUnwrap(silentCopy(input))
        var block: CMBlockBuffer?
        let list = AudioBufferList.allocate(maximumBuffers: 2)
        defer { free(list.unsafeMutablePointer) }
        XCTAssertEqual(CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(silent,
            bufferListSizeNeededOut: nil, bufferListOut: list.unsafeMutablePointer,
            bufferListSize: MemoryLayout<AudioBufferList>.size + MemoryLayout<AudioBuffer>.size,
            blockBufferAllocator: kCFAllocatorDefault, blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: 0, blockBufferOut: &block), noErr)
        XCTAssertEqual(list.count, 2)
        for buffer in list {
            let samples = try XCTUnwrap(buffer.mData).assumingMemoryBound(to: Float.self)
            XCTAssertTrue((0..<Int(buffer.mDataByteSize) / 4).allSatisfy { samples[$0] == 0 })
        }
        var lines: [Data] = []
        let audio = SegmentedAudio(directory: directory, seconds: 0.1, emit: { lines.append($0) })
        audio.setMuted(.system, true)
        audio.queue.sync { audio.append(input, source: .system) }
        try await audio.finish()
        let rows = try closedRows(lines)
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows.compactMap { $0["durationMs"] as? Int }, [100, 100])
        XCTAssertTrue(rows.allSatisfy { $0["mutedSpans"] as? [[Int]] == [[0, 100]] })
        let track = AudioTrack(source: .system, movieInput: nil, sidecarURL: directory.appendingPathComponent("gap.m4a"))
        track.sidecarReady = ready
        track.appendSidecar(try stereo(samples: 4800, at: host), at: host)
        let next = CMTimeAdd(host, CMTime(value: 200, timescale: 1000))
        track.appendSidecar(try stereo(samples: 4800, at: next), at: next)
        track.finishSidecar()
        XCTAssertTrue(track.sidecarWritten, "\(track.failures)")
        XCTAssertEqual(track.fileTimeline.durationMs, 300)
        XCTAssertEqual(track.lostSpans, [[100, 200]])
        let file = try AVAudioFile(forReading: directory.appendingPathComponent("gap.m4a"))
        XCTAssertEqual(file.processingFormat.channelCount, 2)
        let decoded = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
        try file.read(into: decoded)
        let channels = try XCTUnwrap(decoded.floatChannelData)
        for channel in 0..<2 {
            XCTAssertLessThan(abs(channels[channel][7200]), 0.01)
            XCTAssertGreaterThan(abs(channels[channel][2400]), 0.1)
        }
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
        var rows = try closedRows(lines)
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
        let rows = try closedRows(lines)
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
        let audio = SegmentedAudio(directory: directory, seconds: 60, emit: { lines.append($0) }, clock: { (host, wall) })
        let first = CMTimeAdd(host, CMTime(value: 700, timescale: 1000))
        let buffer = try pcm(samples: 3 * 60 * 48_000, at: first)
        audio.queue.sync { audio.append(buffer, source: .mic) }
        let duplicate = try pcm(samples: 480, at: CMTimeAdd(first, CMTime(value: 179, timescale: 1)))
        audio.queue.sync { audio.append(duplicate, source: .mic) }
        try await audio.finish()
        let rows = try closedRows(lines)
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

    func testFirstSampleClockIsEmittedBeforeTheSegmentCloses() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("audio-open-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        var lines: [Data] = []
        let host = CMTime(value: 123, timescale: 1)
        let wall = Date(timeIntervalSince1970: 1_700_000_000)
        let audio = SegmentedAudio(directory: directory, seconds: 60, emit: { lines.append($0) }, clock: { (host, wall) })
        let first = CMTimeAdd(host, CMTime(value: 700, timescale: 1000))
        let buffer = try pcm(samples: 4800, at: first)
        audio.queue.sync { audio.append(buffer, source: .mic) }
        let next = try pcm(samples: 4800, at: CMTimeAdd(first, CMTime(value: 100, timescale: 1000)))
        audio.queue.sync { audio.append(next, source: .mic) }
        XCTAssertEqual(lines.count, 1, "the open segment is announced once before finish")
        let started = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(lines.first)) as? [String: Any])
        XCTAssertEqual(started["event"] as? String, "segment-started")
        XCTAssertEqual(started["file"] as? String, "audio-000001-mic.m4a")
        XCTAssertEqual(started["source"] as? String, "mic")
        XCTAssertEqual(started["zeroAt"] as? String, "2023-11-14T22:13:20.700Z")
        XCTAssertEqual(started["primingFrames"] as? Int, 2112)
        try await audio.finish()
        let closed = try XCTUnwrap(closedRows(lines).first)
        XCTAssertEqual(closed["zeroAt"] as? String, started["zeroAt"] as? String)
    }

    func testEncoderReportsPrimingInFramesAtEachSampleRate() throws {
        for rate in [32_000.0, 44_100.0, 48_000.0] {
            for channels in [1, 2] {
                var settings = aacSettings(channels: channels)
                settings[AVSampleRateKey] = rate
                let frames = try XCTUnwrap(sessionEncoderPrimingFrames(settings: settings))
                XCTAssertEqual(frames, 2112)
                if rate == 44_100 {
                    XCTAssertEqual(Double(frames) / rate, 0.047891156, accuracy: 0.000000001)
                }
            }
        }
    }
}
