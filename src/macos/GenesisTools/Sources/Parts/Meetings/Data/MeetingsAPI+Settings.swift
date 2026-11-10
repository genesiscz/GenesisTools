import AVFoundation
import Foundation

// MARK: - Writes to the meetings config (F8; WaveB-Plan.md decisions 13 and 14)

/// One change to the meetings config: a value set, or a value back to its default. It goes through the Meetings
/// service (`config.set`, `config.unset`) when the service answers, and runs as the command (`config set`,
/// `config unset`) otherwise. `expect` is the value the reader saw at the path: another editor's change since then is
/// refused with `config-stale` on both ways, and nothing is written. nil writes without that check.
enum MeetingsConfigWrite: Equatable {
    case set(path: [String], value: JSONValue, expect: JSONValue?)
    case unset(path: [String], expect: JSONValue?)

    var path: [String] {
        switch self {
        case .set(let path, _, _), .unset(let path, _): return path
        }
    }

    /// The path as the service and the command both read it: a JSON array of segments, so a project name with a dot
    /// stays one segment.
    var pathArgument: String { MeetingsCLI.jsonArgument(path) }

    /// The command's argv after `tools meetings`.
    var args: [String] {
        switch self {
        case .set(_, let value, let expect):
            return ["config", "set", pathArgument, MeetingsCLI.jsonArgument(value.foundation)] + Self.expectArgs(expect)
        case .unset(_, let expect):
            return ["config", "unset", pathArgument] + Self.expectArgs(expect)
        }
    }

    private static func expectArgs(_ expect: JSONValue?) -> [String] {
        expect.map { ["--expect", MeetingsCLI.jsonArgument($0.foundation)] } ?? []
    }

    /// Runs the change through `service` when it answers, else as the command (`command` when given: a test passes one
    /// that records its argv). A refusal of the service (`config-stale`, a value the schema refuses) is the answer and
    /// is thrown as it is; only a service that does not answer falls back to the command.
    @MainActor
    func run(service: MeetingsService?, command: (([String]) async throws -> Void)? = nil) async throws {
        if let service {
            do {
                switch self {
                case .set(_, let value, let expect):
                    _ = try await service.call(MeetingsAPI.ConfigSet.self, .init(path: pathArgument, value: value, expect: expect))
                case .unset(_, let expect):
                    _ = try await service.call(MeetingsAPI.ConfigUnset.self, .init(path: pathArgument, expect: expect))
                }
                return
            } catch is MeetingsService.Unavailable {
                try Task.checkCancellation()
            }
        }
        if let command { return try await command(args) }
        _ = try await MeetingsCLI.run(args)
    }
}

extension MeetingsConfigWrite {
    /// A set that names the value `raw` (the config as last read) holds at `path`; no check when nothing was read.
    static func set(_ path: [String], _ value: JSONValue, readFrom raw: JSONValue?) -> MeetingsConfigWrite {
        .set(path: path, value: value, expect: raw.map { $0.at(path) })
    }

    /// An unset that names the value `raw` holds at `path`.
    static func unset(_ path: [String], readFrom raw: JSONValue?) -> MeetingsConfigWrite {
        .unset(path: path, expect: raw.map { $0.at(path) })
    }
}

// MARK: - The tone's preview (G52: a sound picker has a Play button)

/// Plays the tone alone with a sound, cut by the Moment engine (`tone.preview`), for the side panel's and the Settings
/// page's Play button. Only the service cuts it: a second tone maker in Swift would be a second engine (R7).
@MainActor
enum TonePreviewPlayer {
    /// Kept so the sound is not cut when the call returns; a new preview stops the one before.
    private static var player: AVAudioPlayer?

    /// Throws `MeetingsService.Unavailable` when no service answers; the caller says so in a notice.
    static func play(_ sound: ToneSound, service: MeetingsService?) async throws {
        guard let service else { throw MeetingsService.Unavailable(reason: "no Meetings service in this build") }
        let preview = try await service.call(MeetingsAPI.TonePreview.self, .init(sound: sound))
        let next = try AVAudioPlayer(contentsOf: URL(fileURLWithPath: preview.path))
        player?.stop()
        player = next
        next.play()
    }

    /// The notice of a preview the service could not cut yet.
    static let unavailableText = "The tone plays once the Meetings service answers. Try again in a moment."
}
