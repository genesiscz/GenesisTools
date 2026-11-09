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
    /// Every tile of the last load arrived (or failed); a bench waits for it.
    @ObservationIgnored private(set) var loaded = false
    private var task: Task<Void, Never>?

    func load(video: URL, durationUs: Int64, count: Int = 60) {
        task?.cancel()
        loaded = false
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
            await MainActor.run {
                self?.tiles = tiles
                self?.loaded = true
            }
        }
    }

    /// The tile at or before a source time, by its slot: the list can lack slots (a frame that did not decode, or a
    /// strip still loading), so a position in the array is not the slot.
    func tile(atSource us: Int64) -> Tile? {
        let slot = Int((Double(us) / Double(spacingUs)).rounded(.down))
        return tiles.last(where: { $0.id <= slot }) ?? tiles.first
    }
}

/// The loudest sample per bucket of each of the movie's audio tracks, for the timeline's audio lane. Every track is read
/// in one pass, so a mute or an unmute in the Audio tab redraws the lane without reading the file again.
@MainActor
@Observable
final class Waveform {
    /// One bucket array per audio track, in the movie's track order (the index `audio.mutedTracks` uses), 0...1 of full
    /// scale.
    private(set) var peaks: [[Float]] = []
    /// The loudest bucket of each track.
    private var loudest: [Float] = []
    private(set) var hasAudio = false
    /// The read finished; with `hasAudio` false the movie has no sound track.
    private(set) var loaded = false
    private var task: Task<Void, Never>?

    /// The audio tracks the last read found.
    var trackCount: Int { peaks.count }

    func load(video: URL, buckets: Int = 1200) {
        task?.cancel()
        task = Task.detached(priority: .utility) { [weak self] in
            let span = HubPerf.begin("recorder.waveform", video.lastPathComponent)
            defer { span.end() }
            let asset = AVURLAsset(url: video)
            guard let tracks = try? await asset.loadTracks(withMediaType: .audio), !tracks.isEmpty,
                  let duration = try? await asset.load(.duration), duration.seconds > 0,
                  let reader = try? AVAssetReader(asset: asset) else {
                await MainActor.run { self?.publish([]) }
                return
            }
            let outputs = tracks.map { track in
                let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
                    AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false,
                    AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false, AVNumberOfChannelsKey: 1,
                    AVSampleRateKey: 8000,
                ])
                output.alwaysCopiesSampleData = false
                return output
            }
            // A reader that cannot start still ends the load: the lane waits for `loaded`, and stayed blank for good.
            guard outputs.allSatisfy({ reader.canAdd($0) }) else {
                await MainActor.run { self?.publish([]) }
                return
            }
            outputs.forEach { reader.add($0) }
            guard reader.startReading() else {
                await MainActor.run { self?.publish([]) }
                return
            }
            let total = max(1, Int(duration.seconds * 8000))
            let perBucket = max(1, total / buckets)
            var peaks = [[Float]](repeating: [Float](repeating: 0, count: buckets), count: outputs.count)
            var positions = [Int](repeating: 0, count: outputs.count)
            var open = [Bool](repeating: true, count: outputs.count)
            // One reader feeds every track, so the tracks are read in turn: reading one to its end first makes the
            // reader hold the others' samples meanwhile.
            while !Task.isCancelled, open.contains(true) {
                for index in outputs.indices where open[index] {
                    guard let buffer = outputs[index].copyNextSampleBuffer() else {
                        open[index] = false
                        continue
                    }
                    var length = 0
                    var pointer: UnsafeMutablePointer<Int8>?
                    guard let block = CMSampleBufferGetDataBuffer(buffer),
                          CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == noErr,
                          let pointer else { continue }
                    pointer.withMemoryRebound(to: Int16.self, capacity: length / 2) { samples in
                        Self.fold(UnsafeBufferPointer(start: samples, count: length / 2), perBucket: perBucket,
                                  into: &peaks[index], position: &positions[index])
                    }
                }
            }
            let read = peaks
            await MainActor.run { self?.publish(read) }
        }
    }

    /// Each sample's level into its bucket's peak.
    private nonisolated static func fold(_ samples: UnsafeBufferPointer<Int16>, perBucket: Int, into peaks: inout [Float],
                                         position: inout Int) {
        for sample in samples {
            let bucket = min(peaks.count - 1, position / perBucket)
            let value = Float(abs(Int32(sample))) / 32768
            if value > peaks[bucket] { peaks[bucket] = value }
            position += 1
        }
    }

    private func publish(_ read: [[Float]]) {
        peaks = read
        loudest = read.map { $0.max() ?? 0 }
        hasAudio = !read.isEmpty
        loaded = true
    }

    /// The peak over a source range of the given tracks, 0...1: the loudest of them there, scaled to the loudest moment
    /// of those tracks, so the tracks keep their level against each other and a quiet recording still shows its shape.
    func peak(fromUs: Int64, toUs: Int64, durationUs: Int64, tracks: IndexSet) -> Float {
        let shown = tracks.filter { $0 < peaks.count }
        guard let any = shown.first, !peaks[any].isEmpty, durationUs > 0 else { return 0 }
        let count = peaks[any].count
        let first = Int(Double(fromUs) / Double(durationUs) * Double(count))
        let last = Int(Double(toUs) / Double(durationUs) * Double(count))
        let low = min(max(0, first), count - 1)
        let high = min(max(low, last), count - 1)
        var peak: Float = 0
        var scale: Float = 0
        for track in shown {
            peak = max(peak, peaks[track][low...high].max() ?? 0)
            scale = max(scale, loudest[track])
        }
        return scale > 0.0005 ? peak / scale : peak
    }
}

extension EditProject.AudioSettings {
    /// The source audio tracks the preview and the export play, of `count`: none while the sound is off, else every
    /// track `mutedTracks` does not name (the rule of `EditRenderer.render`).
    func audibleTracks(count: Int) -> IndexSet {
        guard include else { return [] }
        return IndexSet((0..<max(0, count)).filter { !mutedTracks.contains($0) })
    }
}
