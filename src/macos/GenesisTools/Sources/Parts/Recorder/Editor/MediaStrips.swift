import AVFoundation
import AppKit
import Observation

/// The filmstrip's thumbnails: one every `spacingUs` of the SOURCE, so a clip shows the frames of its own source
/// range wherever it sits on the timeline. Made on a background task with a generous tolerance (a tile needs a
/// nearby frame, not the exact one), smallest first, and published in one step.
@MainActor
@Observable
final class Filmstrip {
    struct Tile: Identifiable {
        let id: Int
        let sourceUs: Int64
        let image: CGImage
    }

    private(set) var tiles: [Tile] = []
    private(set) var spacingUs: Int64 = 1_000_000
    private var task: Task<Void, Never>?

    func load(video: URL, durationUs: Int64, count: Int = 60) {
        task?.cancel()
        let spacing = max(100_000, durationUs / Int64(max(1, count)))
        spacingUs = spacing
        task = Task.detached(priority: .utility) { [weak self] in
            let span = HubPerf.begin("recorder.filmstrip", "\(video.lastPathComponent) every \(spacing / 1000) ms")
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: video))
            generator.maximumSize = CGSize(width: 240, height: 150)
            generator.appliesPreferredTrackTransform = true
            let tolerance = CMTime(value: spacing / 2, timescale: 1_000_000)
            generator.requestedTimeToleranceBefore = tolerance
            generator.requestedTimeToleranceAfter = tolerance
            let times = stride(from: Int64(0), to: durationUs, by: Int(spacing)).map { CMTime(value: $0, timescale: 1_000_000) }
            var made: [Tile] = []
            // One decoding pass over the movie for every tile; asking for one image at a time seeks for each.
            for await result in generator.images(for: times) {
                if Task.isCancelled { break }
                guard let image = try? result.image else { continue }
                let requested = Int64((result.requestedTime.seconds * 1_000_000).rounded())
                made.append(Tile(id: Int(requested / spacing), sourceUs: requested, image: image))
            }
            made.sort { $0.sourceUs < $1.sourceUs }
            span.end()
            let tiles = made
            await MainActor.run { self?.tiles = tiles }
        }
    }

    /// The tile nearest a source time.
    func tile(atSource us: Int64) -> Tile? {
        guard !tiles.isEmpty else { return nil }
        let index = Int((Double(us) / Double(spacingUs)).rounded(.down))
        return tiles[min(max(0, index), tiles.count - 1)]
    }
}

/// The loudest sample per bucket of the movie's first audio track, 0...1, for the timeline's audio lane.
@MainActor
@Observable
final class Waveform {
    private(set) var peaks: [Float] = []
    private(set) var hasAudio = false
    private var task: Task<Void, Never>?

    func load(video: URL, buckets: Int = 1200) {
        task?.cancel()
        task = Task.detached(priority: .utility) { [weak self] in
            let span = HubPerf.begin("recorder.waveform", video.lastPathComponent)
            defer { span.end() }
            let asset = AVURLAsset(url: video)
            guard let track = try? await asset.loadTracks(withMediaType: .audio).first,
                  let duration = try? await asset.load(.duration), duration.seconds > 0,
                  let reader = try? AVAssetReader(asset: asset) else {
                await MainActor.run { self?.hasAudio = false }
                return
            }
            let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false,
                AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false, AVNumberOfChannelsKey: 1,
                AVSampleRateKey: 8000,
            ])
            output.alwaysCopiesSampleData = false
            reader.add(output)
            guard reader.startReading() else { return }
            let total = max(1, Int(duration.seconds * 8000))
            let perBucket = max(1, total / buckets)
            var peaks = [Float](repeating: 0, count: buckets)
            var position = 0
            while !Task.isCancelled, let buffer = output.copyNextSampleBuffer(), let block = CMSampleBufferGetDataBuffer(buffer) {
                var length = 0
                var pointer: UnsafeMutablePointer<Int8>?
                guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == noErr,
                      let pointer else { continue }
                pointer.withMemoryRebound(to: Int16.self, capacity: length / 2) { samples in
                    for index in 0..<(length / 2) {
                        let bucket = min(buckets - 1, position / perBucket)
                        let value = Float(abs(Int32(samples[index]))) / 32768
                        if value > peaks[bucket] { peaks[bucket] = value }
                        position += 1
                    }
                }
            }
            let result = peaks
            await MainActor.run {
                self?.peaks = result
                self?.hasAudio = true
            }
        }
    }

    /// The peak over a source range, 0...1.
    func peak(fromUs: Int64, toUs: Int64, durationUs: Int64) -> Float {
        guard !peaks.isEmpty, durationUs > 0 else { return 0 }
        let first = Int(Double(fromUs) / Double(durationUs) * Double(peaks.count))
        let last = Int(Double(toUs) / Double(durationUs) * Double(peaks.count))
        let low = min(max(0, first), peaks.count - 1)
        let high = min(max(low, last), peaks.count - 1)
        return peaks[low...high].max() ?? 0
    }
}
