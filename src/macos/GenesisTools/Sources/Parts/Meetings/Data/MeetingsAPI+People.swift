import Foundation

// MARK: - The people directory: the Swift mirror of its Meetings service methods (src/meetings/lib/service/api.ts,
// src/utils/meetings/people-directory.ts). The protocol fixture holds a real request and reply of each, and
// MeetingsContactsTests decodes them with these types. The person picker (R23, R44) and the Contacts view (R24) read
// these values; the calls are in MeetingDetailModel+People.swift (`PeopleCalls`).

/// Where the directory knows a person from (`PERSON_SOURCE_KINDS`).
enum PersonSourceKind: String, Codable, CaseIterable, Hashable {
    case meetings, projects, contacts, own

    /// The words a list shows for the source.
    var title: String {
        switch self {
        case .meetings: return "Meetings"
        case .projects: return "Projects"
        case .contacts: return "Contacts"
        case .own: return "Added by you"
        }
    }
}

/// Why a person has its place in a ranked list (`PERSON_RANKS`), best first.
enum PersonRank: String, Codable, CaseIterable, Hashable {
    case present, meeting, meetings, contacts, own

    /// The words a picker row shows for the rank.
    var title: String {
        switch self {
        case .present: return "In the call now"
        case .meeting: return "In this meeting"
        case .meetings: return "Earlier meetings"
        case .contacts: return "Contacts"
        case .own: return "Added by you"
        }
    }
}

/// How a meeting names a person (`MEETING_ROLES`).
enum MeetingRole: String, Codable, CaseIterable, Hashable {
    case participant, attendance, calendar, speaker
}

/// One person of the people directory (`knownPersonSchema`).
struct KnownPerson: Codable, Equatable, Hashable, Identifiable {
    /// `email:<address>` or `name:<name tokens>`: what the other people methods take as a person.
    var id: String
    var name: String
    var email: String?
    /// The user of this Mac (`self: true`).
    var isSelf: Bool
    var aliases: [String]
    var sources: [PersonSourceKind]
    var rank: PersonRank
    /// How many meetings name them.
    var meetings: Int
    /// ISO time of the last meeting that names them.
    var lastSeen: String?
    var projects: [String]
    var organization: String?
    var note: String?
    /// The merge token: `people.unmerge` with it splits this person again.
    var merge: String?
    var hidden: Bool

    private enum CodingKeys: String, CodingKey {
        case id, name, email, isSelf = "self", aliases, sources, rank, meetings, lastSeen, projects, organization, note, merge, hidden
    }

    init(id: String, name: String, email: String? = nil, isSelf: Bool = false, aliases: [String] = [],
         sources: [PersonSourceKind], rank: PersonRank, meetings: Int = 0, lastSeen: String? = nil,
         projects: [String] = [], organization: String? = nil, note: String? = nil, merge: String? = nil,
         hidden: Bool = false) {
        self.id = id
        self.name = name
        self.email = email
        self.isSelf = isSelf
        self.aliases = aliases
        self.sources = sources
        self.rank = rank
        self.meetings = meetings
        self.lastSeen = lastSeen
        self.projects = projects
        self.organization = organization
        self.note = note
        self.merge = merge
        self.hidden = hidden
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        email = try c.decodeIfPresent(String.self, forKey: .email)
        isSelf = try c.decodeIfPresent(Bool.self, forKey: .isSelf) ?? false
        aliases = try c.decodeIfPresent([String].self, forKey: .aliases) ?? []
        sources = try c.decode([PersonSourceKind].self, forKey: .sources)
        rank = try c.decode(PersonRank.self, forKey: .rank)
        meetings = try c.decodeIfPresent(Int.self, forKey: .meetings) ?? 0
        lastSeen = try c.decodeIfPresent(String.self, forKey: .lastSeen)
        projects = try c.decodeIfPresent([String].self, forKey: .projects) ?? []
        organization = try c.decodeIfPresent(String.self, forKey: .organization)
        note = try c.decodeIfPresent(String.self, forKey: .note)
        merge = try c.decodeIfPresent(String.self, forKey: .merge)
        hidden = try c.decodeIfPresent(Bool.self, forKey: .hidden) ?? false
    }

    /// The service writes `self` and `hidden` only when true (`z.literal(true).optional()`).
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encodeIfPresent(email, forKey: .email)
        if isSelf { try c.encode(true, forKey: .isSelf) }
        try c.encode(aliases, forKey: .aliases)
        try c.encode(sources, forKey: .sources)
        try c.encode(rank, forKey: .rank)
        try c.encode(meetings, forKey: .meetings)
        try c.encodeIfPresent(lastSeen, forKey: .lastSeen)
        try c.encode(projects, forKey: .projects)
        try c.encodeIfPresent(organization, forKey: .organization)
        try c.encodeIfPresent(note, forKey: .note)
        try c.encodeIfPresent(merge, forKey: .merge)
        if hidden { try c.encode(true, forKey: .hidden) }
    }

    /// One or two letters for an avatar: the first letters of the first and the last word, else of the address.
    var initials: String {
        let words = name.split(whereSeparator: { $0 == " " || $0 == "." || $0 == "-" }).filter { $0.first?.isLetter == true }
        let letters: [Character]
        if words.count >= 2, let first = words.first?.first, let last = words.last?.first {
            letters = [first, last]
        } else if let first = words.first?.first {
            letters = [first]
        } else if let first = (email ?? name).first(where: \.isLetter) {
            letters = [first]
        } else {
            letters = ["?"]
        }
        return String(letters).uppercased()
    }
}

/// A source's state in a `people.known` answer: `refused` and `off` carry the reason a picker shows, never an empty list.
struct PersonSourceState: Codable, Equatable, Hashable {
    enum State: String, Codable, Hashable { case ok, off, refused, failed }
    var kind: PersonSourceKind
    var state: State
    var reason: String?
}

/// A person the user added by hand (`people.json` entries).
struct PeopleOwnEntry: Codable, Equatable, Hashable {
    var name: String
    var email: String?
    var note: String?
    var addedAt: String
}

/// What merging two people would do (`mergePlanSchema`): nothing is written, and no meeting record changes on a merge.
struct PeopleMergePlan: Codable, Equatable, Hashable {
    /// One meeting that names either person; `people`: which of the two (0, 1) it names.
    struct Meeting: Codable, Equatable, Hashable, Identifiable {
        var id: String
        var title: String
        /// ISO start time.
        var start: String
        var people: [Int]
        var `as`: [MeetingRole]
    }

    /// A speaker label renamed to either person: it shows as the merged person.
    struct Label: Codable, Equatable, Hashable {
        var meeting: String
        var label: String
        var name: String
    }

    /// The two people, in the order asked (a tuple of two in TypeScript).
    var people: [KnownPerson]
    /// The name the merged person shows.
    var name: String
    var meetings: [Meeting]
    var labels: [Label]
}

/// A merge the people book holds (`peopleMergeSchema`): its token splits it again.
struct PeopleMergeRecord: Codable, Equatable, Hashable {
    struct Person: Codable, Equatable, Hashable {
        var name: String
        var email: String?
    }

    var token: String
    var people: [Person]
    var name: String
    /// ISO time of the merge.
    var at: String
}

extension MeetingsAPI {
    /// `people.known`: the ranked people for a query, a meeting and a moment of it. Nothing is preselected.
    enum PeopleKnown: MeetingsServiceMethod {
        static let name = "people.known"

        struct Params: Codable, Equatable {
            /// What was typed: case and accents do not matter. Empty lists everyone.
            var query: String
            var meeting: String?
            var atSec: Double?
            var limit: Int?
            var includeHidden: Bool?

            init(query: String = "", meeting: String? = nil, atSec: Double? = nil, limit: Int? = nil, includeHidden: Bool? = nil) {
                self.query = query
                self.meeting = meeting
                self.atSec = atSec
                self.limit = limit
                self.includeHidden = includeHidden
            }
        }

        struct Result: Decodable, Equatable {
            let query: String
            let people: [KnownPerson]
            /// How many matched before the limit.
            let total: Int
            let sources: [PersonSourceState]
        }
    }

    /// `people.add`: a person added by hand (the picker's "Add 'X' as new speaker").
    enum PeopleAdd: MeetingsServiceMethod {
        static let name = "people.add"

        struct Params: Codable, Equatable {
            var name: String
            var email: String?
            var note: String?
        }

        struct Result: Decodable, Equatable {
            let person: KnownPerson
            let entry: PeopleOwnEntry
            /// False when the book had them already: the email and note were added to their entry.
            let added: Bool
            /// True when they were hidden and adding showed them again.
            let shown: Bool
        }
    }

    /// `people.hide`: hides a person from every list, or shows them again with `hidden: false`.
    enum PeopleHide: MeetingsServiceMethod {
        static let name = "people.hide"

        struct Params: Codable, Equatable {
            /// An id (`email:…`, `name:…`), an email, or a name.
            var person: String
            var hidden: Bool?
        }

        struct Result: Decodable, Equatable {
            let person: KnownPerson
            let changed: Bool
        }
    }

    /// The params of `people.planMerge` and `people.merge`.
    struct PeopleMergeParams: Codable, Equatable {
        var a: String
        var b: String
        /// The name the merged person shows; the first person's when absent.
        var name: String?
    }

    /// `people.planMerge`: the meetings that name either person and the labels renamed to them; writes nothing.
    enum PeoplePlanMerge: MeetingsServiceMethod {
        static let name = "people.planMerge"
        typealias Params = PeopleMergeParams
        typealias Result = PeopleMergePlan
    }

    /// `people.merge`: an alias in the people book; no meeting record changes. Its token undoes it.
    enum PeopleMerge: MeetingsServiceMethod {
        static let name = "people.merge"
        typealias Params = PeopleMergeParams

        struct Result: Decodable, Equatable {
            let merge: PeopleMergeRecord
            let plan: PeopleMergePlan
        }
    }

    /// `people.unmerge`: splits a merge again by its token. Refused with `unknown-merge`.
    enum PeopleUnmerge: MeetingsServiceMethod {
        static let name = "people.unmerge"

        struct Params: Codable, Equatable { var token: String }

        struct Result: Decodable, Equatable { let merge: PeopleMergeRecord }
    }

    /// `decision.plan` as the speaker picker reads it: a rename's warning that another label holds the name (G-PPL-4),
    /// and an `assign`'s other stretches of the same label (R22's speaker version). The window's own `DecisionPlan`
    /// mirror (MeetingsAPI+Review.swift) reads the item reach; this one only these two members.
    enum PersonDecisionPlan: MeetingsServiceMethod {
        static let name = "decision.plan"
        typealias Params = DecisionParams

        struct Result: Decodable, Equatable {
            struct Reach: Decodable, Equatable {
                let stretches: [AssignStretch]?
            }

            let warnings: [String]?
            let reach: Reach?
        }
    }

    /// One more stretch an `assign` may reach (`AssignReachStretch`): the same label inside the hint range around it, or
    /// in a section with the same people present. Never "sounds the same".
    struct AssignStretch: Decodable, Equatable, Hashable, Identifiable {
        enum Why: String, Decodable, Hashable { case hintRange = "hint-range", presentSet = "present-set" }

        let label: String
        let fromSec: Double
        let toSec: Double
        let lines: Int
        let why: Why

        var id: String { "\(label)|\(fromSec)|\(toSec)" }
    }

    /// The refusal of a people method that names several people: data `{ code, candidates }`.
    struct AmbiguousPerson: Decodable, Equatable {
        let code: String
        let candidates: [KnownPerson]
    }
}
