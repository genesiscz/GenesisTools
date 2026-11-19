import CryptoKit
import Foundation

extension EditProject {
    struct AudioLane: Codable, Equatable, Identifiable {
        enum Source: String, Codable, CaseIterable { case mic, system, movie, voiceover, music }

        var id: String
        var source: Source
        var file: String?
        var track: Int?
        var offsetMs = 0
        var muted = false
        var volume = 1.0
        var name: String?

        var displayName: String {
            if let name, !name.isEmpty { return name }
            switch source {
            case .mic: return "Microphone"
            case .system: return "System sound"
            case .movie:
                guard let track, track >= 0 else { return "Movie track" }
                return "Movie track \(UInt(track) + 1)"
            case .voiceover: return "Voiceover"
            case .music: return "Music"
            }
        }
    }

    struct AudioFacts: Codable, Equatable {
        struct Mixed: Codable, Equatable {
            var source: AudioLane.Source
            var file: String
            var offsetMs: Int
        }

        var movieTracks: Int
        var mixedFrom: [Mixed]
    }

    func audioLanes(facts: AudioFacts) -> [AudioLane] {
        if let saved = audio.lanes { return saved }
        let muted = Set(audio.mutedTracks)
        var lanes: [AudioLane] = []
        for source in [AudioLane.Source.mic, .system] {
            let inputs = facts.mixedFrom.filter { $0.source == source }
            for (index, input) in inputs.enumerated() {
                let id = index == 0 ? source.rawValue : "\(source.rawValue)-\(index + 1)"
                let name = inputs.count > 1 ? "\(source == .mic ? "Microphone" : "System sound") \(index + 1)" : nil
                lanes.append(AudioLane(id: id, source: source, file: input.file,
                                       offsetMs: input.offsetMs, muted: muted.contains(0), name: name))
            }
        }
        let firstTrack = lanes.isEmpty ? 0 : 1
        for track in firstTrack..<max(firstTrack, facts.movieTracks) {
            lanes.append(AudioLane(id: "movie-\(track)", source: .movie, track: track, muted: muted.contains(track)))
        }
        for clip in audio.voiceovers ?? [] {
            lanes.append(AudioLane(id: Self.voiceoverLaneID(clip.id), source: .voiceover, name: Self.voiceoverLaneName(clip)))
        }
        if audio.music != nil { lanes.append(AudioLane(id: "music", source: .music)) }
        return lanes
    }

    func movieTracksPlayed(_ lanes: [AudioLane], facts: AudioFacts) -> [Int] {
        var excluded = Set<Int>()
        for lane in lanes {
            if let file = lane.file, !file.isEmpty, facts.mixedFrom.contains(where: { $0.source == lane.source }) {
                excluded.insert(0)
            } else if lane.file == nil, let track = lane.track, lane.muted {
                excluded.insert(track)
            }
        }
        return (0..<max(0, facts.movieTracks)).filter { !excluded.contains($0) }
    }

    static func voiceoverLaneID(_ id: String) -> String {
        if (1...40).contains(id.utf16.count),
           id.range(of: #"^(?:(?:mic|system)(?:-[0-9]+)?|music|movie-[0-9]+|voice-[0-9a-f]{32})$"#,
                    options: .regularExpression) == nil { return id }
        return "voice-" + SHA256.hash(data: Data(id.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    static func voiceover(forLaneID laneID: String, in clips: [Voiceover]) -> Voiceover? {
        clips.first { laneID == voiceoverLaneID($0.id) } ?? clips.first { laneID == $0.id }
    }

    static func voiceoverLaneName(_ clip: Voiceover) -> String? {
        guard let label = clip.label, !label.isEmpty else { return nil }
        return String(decoding: label.utf16.prefix(40), as: UTF16.self)
    }
}

// Keep the memberwise initializer for the editor. A partial JSON lane gets the schema defaults on first read.
extension EditProject.AudioLane {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: try c.decode(String.self, forKey: .id), source: try c.decode(Source.self, forKey: .source),
                  file: try c.decodeIfPresent(String.self, forKey: .file), track: try c.decodeIfPresent(Int.self, forKey: .track),
                  offsetMs: try c.decodeIfPresent(Int.self, forKey: .offsetMs) ?? 0,
                  muted: try c.decodeIfPresent(Bool.self, forKey: .muted) ?? false,
                  volume: try c.decodeIfPresent(Double.self, forKey: .volume) ?? 1,
                  name: try c.decodeIfPresent(String.self, forKey: .name))
    }
}
