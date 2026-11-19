import Foundation

// MARK: - Voices: the Swift mirror of the voices methods of the Meetings service (src/meetings/lib/service/api.ts,
// `VOICES_METHODS`; the same functions as `tools meetings voices`). The protocol fixture holds a real request and reply
// of each, and MeetingsVoicesTests decodes them with these types. The Voices pane (VoicesPane.swift) calls them.

extension MeetingsAPI {
    /// `voices.list`: the project's people with their voice samples; a person of a meeting with none has no samples.
    enum VoicesList: MeetingsServiceMethod {
        static let name = "voices.list"
        struct Params: Codable, Equatable {
            var project: String?
            var scope: VoiceBrowseScope?
            var person: String?
        }
        struct Result: Decodable, Equatable {
            struct Conflict: Decodable, Equatable { let file: String; let message: String }
            let people: [VoicePerson]
            var learnt: [LearntVoice]?
            var conflicts: [Conflict]?
        }
    }

    /// `voices.preview`: the lines the voice model would name, with their score, or why it names none. Saves nothing.
    enum VoicesPreview: MeetingsServiceMethod {
        static let name = "voices.preview"
        struct Params: Codable, Equatable { var meeting: String }
        struct Result: Decodable, Equatable {
            let meeting: String
            let project: String?
            let lines: [VoicePreviewLine]
        }
    }

    /// `voices.apply`: the suggestion pass of the speaker rules. Its names stay suggestions with their score.
    enum VoicesApply: MeetingsServiceMethod {
        static let name = "voices.apply"
        struct Params: Codable, Equatable { var meeting: String }
        struct Result: Decodable, Equatable { let meeting: String; let added: Int; let warnings: [String] }
    }

    /// `voices.remove`: with `preview`, which suggested lines lose a voice name; without, the removal itself.
    enum VoicesRemove: MeetingsServiceMethod {
        static let name = "voices.remove"
        struct Params: Codable, Equatable {
            var project: String?
            var person: String?
            var scope: VoiceBrowseScope?
            var id: String?
            var planToken: String?
            /// One numbered sample; nil removes all of the person's samples.
            var sample: Int?
            var preview: Bool?
        }
        struct Affected: Decodable, Equatable, Hashable { let meeting: String; let item: String; let fromSec: Double; let toSec: Double }
        struct Result: Decodable, Equatable {
            let project: String
            let person: String
            let removed: Int
            let affected: [Affected]
            var ids: [String]?
            var planToken: String?
            var token: String?
        }
    }

    enum VoicesSample: MeetingsServiceMethod {
        static let name = "voices.sample"
        struct Params: Codable, Equatable {
            var scope: VoiceBrowseScope?
            var project: String?
            var person: String?
            var id: String?
            var sample: Int?
        }
        struct Result: Decodable, Equatable {
            let meeting: String
            let track: String
            let path: String
            let channel: Int?
            let fromSec, toSec, fileFromSec, fileToSec: Double
        }
    }

    enum VoicesMove: MeetingsServiceMethod {
        static let name = "voices.move"
        struct Params: Codable, Equatable {
            let id: String; let person: String; let to: VoiceOwner
            let preview: Bool; let planToken: String?; let token: String
        }
        typealias Result = VoiceCorrectionReply
    }
    enum VoicesReject: MeetingsServiceMethod {
        static let name = "voices.reject"
        struct Params: Codable, Equatable {
            let id: String; let person: String; let reason: String
            let preview: Bool; let planToken: String?; let token: String
        }
        typealias Result = VoiceCorrectionReply
    }
    enum VoicesUndo: MeetingsServiceMethod {
        static let name = "voices.undo"
        struct Params: Codable, Equatable { let token: String; let requestToken: String }
        typealias Result = VoiceCorrectionReply
    }

    enum VoicesJobs: MeetingsServiceMethod {
        static let name = "voices.jobs"
        struct Params: Codable, Equatable { var project: String? }
        typealias Result = [VoiceJob]
    }
    enum VoicesJobsCancel: MeetingsServiceMethod {
        static let name = "voices.jobs.cancel"
        struct Params: Codable, Equatable { let id: String }
        typealias Result = VoiceJob?
    }

    /// The worker count for an automatic voice pass.
    enum VoicesWorkers: MeetingsServiceMethod {
        static let name = "voices.workers"
        struct Params: Codable, Equatable {}
        struct Result: Decodable, Equatable { let auto: Int; let performanceCores: Double; let idleCores: Double }
    }
}

struct VoiceJob: Decodable, Equatable, Identifiable {
    static let event = "voices.job"
    enum State: String, Decodable { case queued, running, done, cancelled, failed }
    struct Progress: Decodable, Equatable { let done, total: Int; let step: String }
    let id, kind, project: String
    let meeting: String?
    let state: State
    let progress: Progress
    let added, skipped: Int
    let error: String?
    var canCancel: Bool { state == .queued || state == .running }

    func matches(_ destination: VoiceDestination, meetings: Set<String>) -> Bool {
        if let project = destination.project, project != self.project { return false }
        if let current = destination.meeting { return current == meeting }
        if destination.owner != nil { return meeting.map(meetings.contains) == true }
        return true
    }
}

typealias VoiceOwner = PeopleMergeRecord.Person

struct VoiceBrowseScope: Codable, Equatable, Hashable {
    let kind: String
    var project: String?
    var meeting: String?
    static let all = Self(kind: "all")
    static func project(_ name: String) -> Self { Self(kind: "project", project: name) }
    static func meeting(_ id: String) -> Self { Self(kind: "meeting", meeting: id) }
}

struct LearntVoice: Decodable, Equatable {
    struct Sample: Decodable, Equatable {
        struct Neighbor: Decodable, Equatable { let owner: VoiceOwner; let score: Double }
        let id: String
        let score: Double?
        let outlier: Bool
        let reason: String?
        let neighbor: Neighbor?
        let neighborReason: String?

        var explanation: String {
            if let score { return (outlier ? "Doubtful match · cosine " : "Cosine ") + VoiceScore.text(score) }
            switch reason {
            case "zero-vector": return "This print has no measurable voice"
            case "zero-centroid": return "The comparison prints have no common direction"
            case "too-few-independent": return "Needs two other independent samples on this track"
            default: return "No compatible comparison"
            }
        }
    }
    let owner: VoiceOwner
    let seat, track, model: String
    let dimension, count, independent: Int
    let meanCosine: Double?
    let samples: [Sample]
}

struct VoiceCorrectionReply: Decodable, Equatable {
    let status: String
    var reason: String?
    var token: String?
    var planToken: String?
    var ids: [String]?
    var affected: [MeetingsAPI.VoicesRemove.Affected]?

    func require(_ expected: String) throws {
        guard status == expected else {
            throw MeetingsCLI.Failure(sentence: reason ?? "The sample changed. Read it again before correcting it.", detail: status)
        }
    }
}

/// One person of the library and their confirmed voice samples.
struct VoicePerson: Decodable, Equatable, Identifiable {
    let project: String
    let person: String
    /// The project's meetings that name them or hold one of their samples.
    let meetings: [String]
    let samples: [VoiceSample]

    var owner: VoiceOwner?
    var projects: [String]?
    var id: String { owner?.email?.lowercased() ?? "\(project)/\(person)" }
}

/// One confirmed voice sample: where it was heard and what was said there.
struct VoiceSample: Decodable, Equatable, Hashable, Identifiable {
    /// Its number in the person's list: what `voices.remove` and `voices.sample` take.
    let sample: Int
    let meeting: String
    /// `mic` or `call`.
    let seat: String
    let track: String
    let fromSec: Double
    let toSec: Double
    let confirmedAt: String
    let words: String
    /// Its sound is on this Mac and covers its time.
    let available: Bool

    struct Source: Decodable, Hashable {
        let rootMeeting: String
        let lineKey: String
        let recordingKey: String
    }
    var source: Source?
    var stableID: String?
    var title: String?
    var project: String?
    var owner: VoiceOwner?
    var origin: String?
    var acquiredBy: String?
    var transferred: Bool?

    private enum CodingKeys: String, CodingKey {
        case stableID = "id", title, project, owner, origin, acquiredBy, transferred, source
        case sample, meeting, seat, track, fromSec, toSec, confirmedAt, words, available
    }
    var id: String { stableID ?? "legacy/\(meeting)/\(sample)" }
    func playbackKey(person: String) -> String { stableID ?? "\(id)/\(person)/\(track)/\(fromSec)" }
}

/// One line of `voices.preview`: the voice model's name for it with the score, or the reason it gives none.
struct VoicePreviewLine: Decodable, Equatable, Hashable, Identifiable {
    struct Next: Decodable, Equatable, Hashable { let person: String; let score: Double }

    let index: Int
    let seat: String
    let fromSec: Double
    let toSec: Double
    let text: String
    /// The name the line carries now.
    let current: String
    /// The name the model gives; nil when it gives none.
    let person: String?
    /// The cosine of the best match, never a probability.
    let score: Double?
    /// The runner-up, or the person whose missing sample holds the line back (`unsampled-present`).
    let next: Next?
    let reason: String

    var id: Int { index }

    /// What the model does with the line, in words.
    var outcome: String { VoiceReason.words(reason, person: person, next: next?.person) }

    /// The person whose missing sample holds this line back.
    var waitsFor: String? { reason == "unsampled-present" ? next?.person : nil }
}

/// The reasons of the speaker labelers (`LineLabel.reason` in src/meetings/lib/speaker-labels/types.ts) in words.
enum VoiceReason {
    static func words(_ reason: String, person: String?, next: String?) -> String {
        switch reason {
        case "named": return person.map { "Named \($0)" } ?? "Named"
        case "below-gate": return "Too close to call"
        case "no-rival-sample": return "Only one person here has samples, and the match is not close enough"
        case "unsampled-present": return next.map { "Waits for a sample of \($0)" } ?? "Waits for a sample"
        case "not-the-seat-person": return next.map { "Does not sound like \($0)" } ?? "Does not sound like the seat's person"
        case "no-voice": return "Too short or no clear voice"
        case "seat-of-one": return "The only person at the seat"
        case "seat-shared": return "Several people share the seat"
        case "seat-unknown": return "The seat is not known"
        case "exclusion": return "Only one possible speaker remains"
        case "exclusion-not-one-voice": return "The remaining lines may contain several voices"
        case "exclusion-too-few-lines": return "Too few lines to identify the remaining voice"
        default: return "No reliable voice match"
        }
    }
}

/// A voice model's score as the window prints it beside a name: two decimals, as `tools meetings` prints
/// `by voice 0.71`. It is a cosine of two voices, so it is never written as a percent.
enum VoiceScore {
    static func text(_ score: Double) -> String { String(format: "%.2f", score) }

    /// The people whose score a speaker question's choices give as a voice cosine (`PeopleText.personKey`): each one an
    /// open range the question decides names by the voice model, not by exclusion. These are the ranges the question's
    /// own text names "(by voice 0.63)" (`questionView` in src/meetings/lib/questions.ts), so the chip writes the same
    /// number the same way and never as "63 %" (w_n3evy8d2).
    static func people(decidedBy question: MeetingItem, item: (String) -> MeetingItem?) -> Set<String> {
        guard question.kind == "question", question.about == "speaker" else { return [] }
        return Set((question.decides ?? []).compactMap(item).compactMap { range -> String? in
            guard range.kind == "speaker-range", range.status == "suggested", range.rules?.contains("voice-embedding") == true,
                  let speaker = range.speaker, !speaker.isEmpty else { return nil }
            if case .string("exclusion")? = range.evidence?["reason"] { return nil }
            return PeopleText.personKey(speaker)
        })
    }
}
