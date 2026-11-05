import Foundation

// The JSON the `tools meetings … --json` doors print, decoded with only the fields this part shows. The shapes live
// in TypeScript (src/meetings/lib/overview.ts, screen-timeline.ts, capture-cost.ts, match-preview.ts,
// dictionary-test.ts, export.ts, and the record schema in src/utils/meetings/record.ts).

// MARK: - Overview (`tools meetings overview --json`)

struct MeetingBadges: Decodable, Equatable, Hashable {
    let noProject: Bool
    let openQuestions: Int
    let unclearSpeakers: Int
    let recordingOnly: Bool
    let transcriptOnly: Bool
    let suggestedAboveApply: Int
    let suggested: Int
}

struct OverviewMeeting: Decodable, Equatable, Hashable, Identifiable {
    let id: String
    let title: String
    let start: String
    let end: String?
    let durationSec: Double?
    let day: String
    let project: String?
    let labels: [String]
    let hasTranscript: Bool
    let hasRecording: Bool
    let live: Bool
    let frames: Int
    let contextCount: Int
    let badges: MeetingBadges

    var displayTitle: String { title.trimmingCharacters(in: .whitespaces).isEmpty ? "Untitled meeting" : title }
    var startDate: Date? { MeetingsFormat.date(start) }
}

struct MeetingsOverview: Decodable, Equatable {
    struct ProjectCount: Decodable, Equatable, Hashable { let name: String; let meetings: Int }
    struct Count: Decodable, Equatable, Hashable { let id: String; let count: Int }
    struct NeedsYou: Decodable, Equatable {
        let noProject: [String]
        let questions: [Count]
        let suggestions: [Count]
        let total: Int
    }

    let generatedAt: String
    let days: Int
    let applyAbove: Double
    let meetings: [OverviewMeeting]
    /// Meetings that started before the window; nil from a CLI older than this field.
    let olderMeetings: Int?
    let projects: [ProjectCount]
    let needsYou: NeedsYou
}

// MARK: - One record (`tools meetings show <id> --json`)

struct MeetingItem: Decodable, Equatable, Hashable, Identifiable {
    let id: String
    let kind: String
    var status: String
    let confidence: Double?
    let rules: [String]?
    let label: String?
    let fromSec: Double?
    let toSec: Double?
    let atSec: Double?
    let speaker: String?
    let candidates: [String]?
    let heard: String?
    let proposed: String?
    let meaning: String?
    /// A term read aloud from a document: its exact text replaces the heard words, with the source.
    let quote: Quote?
    let joined: String?
    let about: String?
    let question: String?
    let choices: [String]?
    let answer: String?
    let priority: Double?
    let evidence: [String: JSONValue]?

    struct Quote: Decodable, Equatable, Hashable { let text: String; let source: String }

    /// Where the item sits on the transcript clock.
    var seconds: Double? { fromSec ?? atSec }
    /// A term with nothing to confirm yet: no spelling, meaning or quoted line (the CLI's own rule in decide.ts).
    var needsSpelling: Bool { kind == "term" && proposed == nil && meaning == nil && quote == nil }
    var reason: String? {
        if case .string(let text)? = evidence?["reason"] { return text }
        return nil
    }
}

struct MeetingContextRef: Decodable, Equatable, Hashable, Identifiable {
    let id: String
    let kind: String
    let ref: String
    let title: String?
    let note: String?
    let addedAt: String
}

struct MeetingRecordView: Decodable, Equatable {
    struct Speakers: Decodable, Equatable { let labels: [String: String] }
    struct Recording: Decodable, Equatable {
        struct Display: Decodable, Equatable, Hashable { let id: Int; let name: String?; let frames: Int? }
        let frames: Int?
        let status: String?
        let displays: [Display]?
    }

    let id: String
    let title: String
    let project: String?
    let labels: [String]
    let start: String
    let end: String?
    var items: [MeetingItem]
    let context: [MeetingContextRef]
    let speakers: Speakers
    let recording: Recording?
    let sources: [String: JSONValue]

    var displayTitle: String { title.trimmingCharacters(in: .whitespaces).isEmpty ? "Untitled meeting" : title }
}

// MARK: - Transcript (`tools meetings transcript <id> --format json`)

struct TranscriptLine: Decodable, Equatable, Hashable, Identifiable {
    let id: String?
    let startSec: Double?
    let speaker: String
    let text: String
    var rowID: String { id ?? "\(startSec ?? -1)-\(speaker)-\(text.prefix(24))" }
}

struct MeetingTranscript: Decodable, Equatable {
    let meeting: String
    let entries: [TranscriptLine]
}

// MARK: - Speakers (`tools meetings speakers stats <id> --json`)

struct SpeakerStat: Decodable, Equatable, Hashable, Identifiable {
    let label: String
    let origin: String?
    let turns: Int
    let lines: Int
    let words: Int?
    let spokenSec: Double
    let firstSec: Double?
    let lastSec: Double?
    var id: String { label }
}

struct SpeakerStats: Decodable, Equatable {
    let speakers: [SpeakerStat]
}

// MARK: - Screen timeline (`tools meetings screen <id> --timeline --json`)

struct OcrBox: Decodable, Equatable, Hashable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let text: String
    let confidence: Double
}

struct TimelineFrame: Decodable, Equatable, Hashable, Identifiable {
    let file: String
    let path: String
    let at: String
    let meetingSec: Double
    let displayId: Int?
    let width: Double
    let height: Double
    let lineCount: Int
    let changed: [OcrBox]
    let lines: [OcrBox]?
    var id: String { file }
}

struct ScreenTimeline: Decodable, Equatable {
    struct Display: Decodable, Equatable, Hashable { let id: Int?; let name: String?; let frames: Int }
    let meeting: String
    let folder: String
    let displays: [Display]
    let frames: [TimelineFrame]
}

// MARK: - Project proposals (`tools meetings assign proposals <id> --json`)

struct AssignProposals: Decodable, Equatable {
    struct Project: Decodable, Equatable, Hashable { let project: String; let score: Double }
    struct Label: Decodable, Equatable, Hashable { let project: String; let label: String }
    struct Body: Decodable, Equatable {
        let projects: [Project]
        let labels: [Label]
    }

    let proposals: Body
}

// MARK: - Config (`tools meetings config show --json`)

/// A display policy: "all", "follow-focus", "main", or a screen index.
struct DisplayPolicy: Decodable, Equatable, Hashable {
    let value: String

    init(_ value: String) { self.value = value }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let text = try? container.decode(String.self) {
            value = text
        } else {
            value = String(try container.decode(Int.self))
        }
    }
}

struct PairedBy: Decodable, Equatable, Hashable {
    let kind: String
    let entryId: String?
    let calendar: String?
    let title: String?
    let start: String?
    let meetingId: String?
    let at: String?
    let note: String?
}

struct PairedPerson: Decodable, Equatable, Hashable, Identifiable {
    let name: String
    let email: String?
    let pairedBy: [PairedBy]
    var id: String { email ?? name }
    var label: String { email.map { "\(name) <\($0)>" } ?? name }
}

struct DictionaryEntry: Decodable, Equatable, Hashable, Identifiable {
    let type: String
    let value: String
    let substitution: String?
    let spoken: [String]?
    let meaning: String?
    /// A fix that matches only the exact letter case.
    let caseSensitive: Bool?
    let level: String?
    var id: String { "\(type):\(value)" }
}

struct ProjectSettings: Decodable, Equatable {
    struct Match: Decodable, Equatable {
        struct Calendar: Decodable, Equatable { let calendars: [String] }
        struct Title: Decodable, Equatable { let words: [String] }
        let calendar: Calendar?
        let title: Title?
        let people: [PairedPerson]
    }
    struct Dictionary: Decodable, Equatable { let entries: [DictionaryEntry] }
    struct Export: Decodable, Equatable { let folder: String }

    let labels: [String]
    let match: Match?
    let dictionary: Dictionary?
    let export: Export?
}

struct MeetingsSettings: Decodable, Equatable {
    struct Global: Decodable, Equatable {
        struct Capture: Decodable, Equatable {
            let displays: DisplayPolicy
            let activeFps: Double
            let idleFps: Double
            let threshold: Double
            let retentionDays: Int
        }
        struct Assign: Decodable, Equatable {
            let ask: Bool
            let lookbackHours: Int
            let maxProposals: Int
            let calendarSlackMin: Int
            /// Absent in a config written before these keys: the defaults of today.
            let calendarLookbehindHours: Int?
            let folderWaitDays: Int?
            let retryFailedMin: Int?

            static let defaultCalendarLookbehindHours = 3
            static let defaultFolderWaitDays = 14
            static let defaultRetryFailedMin = 10
        }
        struct Suggest: Decodable, Equatable { let applyAbove: Double }
        struct Dictionary: Decodable, Equatable { let entries: [DictionaryEntry] }
        struct Export: Decodable, Equatable {
            /// beside, refuse or replace: what an export does with a note someone edited.
            let ifEdited: String
            static let defaultIfEdited = "beside"
        }

        let language: String
        let capture: Capture
        let assign: Assign
        let suggest: Suggest
        let dictionary: Dictionary
        /// Nil from a CLI older than `global.export`.
        let export: Export?
    }
    struct Source: Decodable, Equatable {
        struct Folders: Decodable, Equatable { let folders: [String] }
        struct AutoRecord: Decodable, Equatable {
            let enabled: Bool
            let notify: Bool
            let stopAfterSilenceSec: Int
        }
        let match: [String: Folders]
        let autoRecord: AutoRecord
    }
    struct Language: Decodable, Equatable {
        struct Fillers: Decodable, Equatable {
            let sounds: [String]
            let words: [String]
        }
        let ocr: [String]
        /// Absent in a config written before the key, and for a custom language without a list.
        let fillers: Fillers?
    }

    let global: Global
    let projects: [String: ProjectSettings]
    let sources: [String: Source]
    let languages: [String: Language]

    var projectNames: [String] { projects.keys.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending } }
    var wispr: Source? { sources["wisprflow"] }
    var meetingLanguage: Language? { languages[global.language] }
}

struct ConfigShow: Decodable, Equatable {
    let path: String
    let value: MeetingsSettings
    /// The same value as JSON, so a write can name the value it replaces (`config set --expect`).
    let raw: JSONValue

    private enum CodingKeys: String, CodingKey { case path, value }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        path = try container.decode(String.self, forKey: .path)
        value = try container.decode(MeetingsSettings.self, forKey: .value)
        raw = try container.decode(JSONValue.self, forKey: .value)
    }
}

// MARK: - Capture cost (`tools meetings record cost --json`)

struct CaptureCost: Decodable, Equatable {
    struct Observed: Decodable, Equatable {
        let meeting: String
        let displays: Int
        let minutes: Double
        let frames: Int
        let framesPerMin: Double
        let cpuSecPerMin: Double
    }
    /// One choice and its worst CPU cost: a display policy ("all", "main", a screen index) or a frame rate (0.5).
    struct Choice<Value: Decodable & Equatable>: Decodable, Equatable {
        let value: Value
        let maxCpuSecPerMin: Double
    }
    struct Threshold: Decodable, Equatable {
        let value: Double
        let keptShare: Double?
        let cpuSecPerMin: Double?
    }

    let keptFrameCpuMs: Double
    let source: String
    let observed: Observed?
    let displays: [Choice<DisplayPolicy>]
    let activeFps: [Choice<Double>]
    let idleFps: [Choice<Double>]
    let threshold: [Threshold]
    let thresholdNote: String?

    func displayCost(_ policy: String) -> Double? {
        displays.first { $0.value.value == policy }?.maxCpuSecPerMin
    }
}

// MARK: - Match preview (`tools meetings projects preview --json`)

struct MatchPreviewRow: Decodable, Equatable, Hashable, Identifiable {
    let id: String
    let title: String
    let start: String
    let project: String?
    let now: [String]
    let draft: [String]
    let changed: Bool
}

// MARK: - Dictionary (`dictionary show --json`, `dictionary test --json`)

struct DictionaryShow: Decodable, Equatable {
    let entries: [DictionaryEntry]
}

struct PhraseTest: Decodable, Equatable {
    struct Suggestion: Decodable, Equatable, Hashable { let heard: String; let value: String; let score: Double }
    let phrase: String
    let text: String
    let fired: [DictionaryEntry]
    let suggestions: [Suggestion]
}

// MARK: - A decision (`tools meetings confirm|reject <id> <items> --json`)

struct DecideResult: Decodable, Equatable {
    struct Skip: Decodable, Equatable { let id: String; let reason: String }
    let decided: [String]
    /// What `reopen --token` takes; nil from a CLI older than it.
    let token: String?
    let skipped: [Skip]
}

// MARK: - Export (`tools meetings export <id> --json`)

struct ExportResult: Decodable, Equatable {
    let meeting: String
    let folder: String
    let path: String
    let bytes: Int
    let replaced: Bool
    /// create, replace, beside or refuse; nil from a CLI older than it.
    let action: String?
    /// The edited note the export left as it was (`beside`).
    let kept: String?
    let written: Bool
    let warning: String?

    /// The note's words: "Exported", "Replaced", or the new note beside the edited one.
    var noticeText: String {
        let name = (path as NSString).lastPathComponent
        if action == "beside" { return "Exported \(name) beside your edited note" }
        return "\(replaced ? "Replaced" : "Exported") \(name)"
    }
}

// MARK: - Any JSON value, for the few open-ended fields

enum JSONValue: Decodable, Equatable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case array([JSONValue])
    case object([String: JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    /// The value at a config path, or null where the path ends.
    func at(_ path: [String]) -> JSONValue {
        guard let first = path.first else { return self }
        guard case .object(let fields) = self, let next = fields[first] else { return .null }
        return next.at(Array(path.dropFirst()))
    }

    /// The same JSON with `value` at `path`; the objects on the way are made.
    func setting(_ path: [String], to value: JSONValue) -> JSONValue {
        guard let first = path.first else { return value }
        var fields: [String: JSONValue] = [:]
        if case .object(let existing) = self { fields = existing }
        fields[first] = (fields[first] ?? .null).setting(Array(path.dropFirst()), to: value)
        return .object(fields)
    }

    /// A value the page writes, as JSON (null when it is not JSON).
    init(foundation value: Any) {
        let text = MeetingsCLI.jsonArgument(value)
        self = (try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))) ?? .null
    }

    /// The value as Foundation objects, for `MeetingsCLI.jsonArgument`.
    var foundation: Any {
        switch self {
        case .string(let text): return text
        case .number(let number): return number
        case .bool(let flag): return flag
        case .array(let values): return values.map(\.foundation)
        case .object(let fields): return fields.mapValues(\.foundation)
        case .null: return NSNull()
        }
    }
}

// MARK: - Formatting

enum MeetingsFormat {
    private static let iso: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let isoPlain = ISO8601DateFormatter()

    static func date(_ text: String?) -> Date? {
        guard let text else { return nil }
        return iso.date(from: text) ?? isoPlain.date(from: text)
    }

    /// "Today", "Yesterday", else "Mon 2 Nov", from a `YYYY-MM-DD` day.
    static func dayTitle(_ day: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        let parser = DateFormatter()
        parser.calendar = calendar
        parser.timeZone = calendar.timeZone
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.dateFormat = "yyyy-MM-dd"
        guard let date = parser.date(from: day) else { return day }
        if calendar.isDate(date, inSameDayAs: now) { return "Today" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            return "Yesterday"
        }
        let out = DateFormatter()
        out.calendar = calendar
        out.timeZone = calendar.timeZone
        out.locale = Locale(identifier: "en_GB")
        out.dateFormat = calendar.isDate(date, equalTo: now, toGranularity: .year) ? "EEE d MMM" : "EEE d MMM yyyy"
        return out.string(from: date)
    }

    /// "15:00".
    static func time(_ text: String?) -> String {
        guard let date = date(text) else { return "" }
        let out = DateFormatter()
        out.locale = Locale(identifier: "en_GB")
        out.dateFormat = "HH:mm"
        return out.string(from: date)
    }

    /// "1:05:09" or "5:09".
    static func clock(_ seconds: Double) -> String {
        let total = max(0, Int(seconds.rounded(.down)))
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }

    /// "1 h 05 min", "42 min", "50 s".
    static func length(_ seconds: Double?) -> String? {
        guard let seconds, seconds > 0 else { return nil }
        if seconds < 60 { return "\(Int(seconds.rounded())) s" }
        let minutes = Int((seconds / 60).rounded())
        if minutes < 60 { return "\(minutes) min" }
        return String(format: "%d h %02d min", minutes / 60, minutes % 60)
    }

    /// "2.7 s CPU per minute".
    static func cpu(_ seconds: Double) -> String {
        seconds < 10 ? String(format: "%.1f s CPU per minute", seconds) : String(format: "%.0f s CPU per minute", seconds)
    }
}
