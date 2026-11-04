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
            // A strip needs a frame near each time, not that frame: snapping to a keyframe skips the decode from the
            // keyframe to the time. With x264's 4 s keyframe interval and half a tile of tolerance, a 60 s 4K movie
            // showed no strip after 8 s.
            let tolerance = CMTime(value: max(spacing, 2_000_000), timescale: 1_000_000)
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
                // The strip fills in as tiles arrive instead of all at the end.
                if made.count % 12 == 0 {
                    let partial = made.sorted { $0.sourceUs < $1.sourceUs }
                    await MainActor.run { self?.tiles = partial }
                }
            }
            made.sort { $0.sourceUs < $1.sourceUs }
            span.end()
            let tiles = made
            await MainActor.run { self?.tiles = tiles }
        }
    }

    /// The tile at or before a source time, by its slot: the list can lack slots (a frame that did not decode, or a
    /// strip still loading), so a position in the array is not the slot.
    func tile(atSource us: Int64) -> Tile? {
        let slot = Int((Double(us) / Double(spacingUs)).rounded(.down))
        return tiles.last(where: { $0.id <= slot }) ?? tiles.first
    }
}

/// The loudest sample per bucket of the movie's first audio track, 0...1, for the timeline's audio lane.
@MainActor
@Observable
final class Waveform {
    private(set) var peaks: [Float] = []
    private(set) var hasAudio = false
    /// The read finished; with `hasAudio` false the movie has no sound track.
    private(set) var loaded = false
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
                await MainActor.run {
                    self?.hasAudio = false
                    self?.loaded = true
                }
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
            // Scaled to the movie's own loudest moment, so a quiet recording still shows its shape.
            let loudest = peaks.max() ?? 0
            let result = loudest > 0.0005 ? peaks.map { $0 / loudest } : peaks
            await MainActor.run {
                self?.peaks = result
                self?.hasAudio = true
                self?.loaded = true
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
