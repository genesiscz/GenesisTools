import Foundation

// MARK: - The library: the known projects, the dictionary and the source rules, the Swift mirror of their Meetings
// service methods (src/meetings/lib/service/api.ts and src/meetings/lib/library-schema.ts; decision 13). The settings
// page ran each of them as a `tools meetings` command; the service answers the same JSON, so the results reuse the
// types that decoded the commands' `--json` (MatchPreviewRow, DictionaryShow, PhraseTest, ProjectRemoval). The protocol
// fixture holds a real request and reply of each, and MeetingsLibraryAPITests decodes them with these types.

/// A dictionary entry as it is saved (`dictionaryEntrySchema`): a fix or an abbreviation with its substitution, a term
/// with its spoken forms and meaning, or a word to keep. Each type fills its own members; the encoder leaves the rest
/// out, so the service's strict schema takes it.
struct SavedDictionaryEntry: Codable, Equatable, Hashable {
    /// fix, abbr, term or keep.
    var type: String
    var value: String
    /// fix: the right spelling; abbr: the expansion.
    var substitution: String?
    /// term: how people say it.
    var spoken: [String]?
    /// term: what it means, shown after its first mention.
    var meaning: String?
    /// fix: only the exact letter case.
    var caseSensitive: Bool?

    init(type: String, value: String, substitution: String? = nil, spoken: [String]? = nil, meaning: String? = nil,
         caseSensitive: Bool? = nil) {
        self.type = type
        self.value = value
        self.substitution = substitution
        self.spoken = spoken
        self.meaning = meaning
        self.caseSensitive = caseSensitive
    }
}

extension MeetingsAPI {
    // MARK: Projects

    /// `projects.add`: a known project; `added` is false when it was known already.
    enum ProjectsAdd: MeetingsServiceMethod {
        static let name = "projects.add"

        struct Params: Codable, Equatable { var name: String }

        struct Result: Decodable, Equatable {
            let name: String
            let added: Bool
        }
    }

    /// `projects.rename`: the project renamed in its settings, dictionary, pairings and meetings. Renaming it back
    /// is its Undo.
    enum ProjectsRename: MeetingsServiceMethod {
        static let name = "projects.rename"

        struct Params: Codable, Equatable {
            var from: String
            var to: String
        }

        struct Result: Decodable, Equatable {
            let from: String
            let to: String
            /// The meetings whose project changed with it.
            let meetings: [String]
        }
    }

    /// `projects.remove`: the project removed, its settings kept in a backup file. Refused while meetings have it,
    /// unless `unassign`.
    enum ProjectsRemove: MeetingsServiceMethod {
        static let name = "projects.remove"

        struct Params: Codable, Equatable {
            var name: String
            var unassign: Bool?
        }

        typealias Result = ProjectRemoval
    }

    /// `projects.labels`: a project's known labels, with `add` and `remove` applied.
    enum ProjectsLabels: MeetingsServiceMethod {
        static let name = "projects.labels"

        struct Params: Codable, Equatable {
            var project: String
            var add: [String]?
            var remove: [String]?
        }

        struct Result: Decodable, Equatable {
            let project: String
            let labels: [String]
        }
    }

    /// `projects.unpair`: the pairings one calendar entry made (`entry`), or one person from one project.
    enum ProjectsUnpair: MeetingsServiceMethod {
        static let name = "projects.unpair"

        /// A person as a pairing names them: a name, and the address when it is known.
        struct Person: Codable, Equatable {
            var name: String
            var email: String?
        }

        struct Params: Codable, Equatable {
            var entry: String?
            var project: String?
            var person: Person?
        }

        /// One removed pairing; `left`: the person is no longer paired with the project at all.
        struct Unpaired: Decodable, Equatable {
            let project: String
            let name: String
            let email: String?
            let left: Bool
        }

        struct Result: Decodable, Equatable { let removed: [Unpaired] }
    }

    /// `projects.preview`: the recent meetings against the saved match rules and a draft of them.
    enum ProjectsPreview: MeetingsServiceMethod {
        static let name = "projects.preview"

        /// One project's rules as they are edited: folders per source, calendars and title words.
        struct Draft: Codable, Equatable {
            var folders: [String: [String]]?
            var calendars: [String]?
            var titleWords: [String]?
        }

        struct Params: Codable, Equatable {
            /// By project name: these rules in place of its saved ones.
            var draft: [String: Draft]?
            /// The newest meetings to check (20 when nil).
            var limit: Int?
        }

        typealias Result = [MatchPreviewRow]
    }

    /// `projects.suggestions`: the values the rule fields offer while they are typed. A list that could not be read
    /// says why in its `reason`.
    enum ProjectsSuggestions: MeetingsServiceMethod {
        static let name = "projects.suggestions"

        struct Params: Codable, Equatable {}

        /// A list of values, and why it is partial when the read was not possible.
        struct Values: Decodable, Equatable {
            let values: [String]
            let reason: String?
        }

        /// A source's folders: its own list (`from` "source"), or the folders its meetings sit in ("meetings").
        struct Folders: Decodable, Equatable {
            let values: [String]
            let from: String
            let reason: String?
        }

        struct Result: Decodable, Equatable {
            /// By source id ("wisprflow").
            let folders: [String: Folders]
            let calendars: Values
            let titleWords: [String]
            let labels: [String]
        }
    }

    /// `projects.meetingPeople`: the people of the project's meetings who are not paired with it yet.
    enum ProjectsMeetingPeople: MeetingsServiceMethod {
        static let name = "projects.meetingPeople"

        struct Params: Codable, Equatable { var project: String }

        /// One person: in how many of the project's meetings, and the newest of them.
        struct Person: Decodable, Equatable, Hashable, Identifiable {
            struct Meeting: Decodable, Equatable, Hashable {
                let id: String
                let title: String
                let start: String
            }

            let name: String
            let email: String?
            let meetings: Int
            let last: Meeting
            var id: String { email ?? name }
            var label: String { email.map { "\(name) <\($0)>" } ?? name }
        }

        typealias Result = [Person]
    }

    /// `projects.pairFromMeetings`: people of the project's meetings paired with it, each with its source.
    enum ProjectsPairFromMeetings: MeetingsServiceMethod {
        static let name = "projects.pairFromMeetings"

        struct Params: Codable, Equatable {
            var project: String
            /// nil pairs everyone `projects.meetingPeople` lists.
            var people: [ProjectsUnpair.Person]?
        }

        struct Paired: Decodable, Equatable {
            let name: String
            let email: String?
            let by: PairedBy
        }

        struct Result: Decodable, Equatable {
            let project: String
            let paired: [Paired]
        }
    }

    // MARK: Dictionary

    /// `dictionary.show`: the merged dictionary of a scope (the global one when `project` is nil), each entry with its
    /// level.
    enum DictionaryShowEntries: MeetingsServiceMethod {
        static let name = "dictionary.show"

        struct Params: Codable, Equatable { var project: String? }

        typealias Result = DictionaryShow
    }

    /// `dictionary.add`: an entry added or replaced. `replace` renames the entry with that value in one write;
    /// `ifAbsent` refuses an entry the level has (`dictionary-exists`), as an Undo's add needs.
    enum DictionaryAdd: MeetingsServiceMethod {
        static let name = "dictionary.add"

        struct Params: Codable, Equatable {
            var entry: SavedDictionaryEntry
            var project: String?
            var replace: String?
            var ifAbsent: Bool?
        }

        struct Result: Decodable, Equatable {
            let entry: SavedDictionaryEntry
            /// `global` or `project <name>`.
            let level: String
            /// The project joined the known projects with this entry.
            let projectAdded: Bool
            /// The value of the entry a rename replaced.
            let replaced: String?
        }
    }

    /// `dictionary.remove`: an entry removed by its value; `removed` is false when the level did not have it.
    enum DictionaryRemove: MeetingsServiceMethod {
        static let name = "dictionary.remove"

        struct Params: Codable, Equatable {
            var value: String
            var project: String?
        }

        struct Result: Decodable, Equatable {
            let value: String
            let level: String
            let removed: Bool
        }
    }

    /// `dictionary.test`: what the scope's dictionary does to one phrase.
    enum DictionaryTest: MeetingsServiceMethod {
        static let name = "dictionary.test"

        struct Params: Codable, Equatable {
            var phrase: String
            var project: String?
        }

        typealias Result = PhraseTest
    }

    // MARK: Config

    /// `config.edit`: several config changes in one write, all or none (the page's Save rules writes a project's
    /// source folders and title words this way). An edit with `expect` is refused with `config-stale` when another
    /// editor changed its value since the page read it.
    enum ConfigEdit: MeetingsServiceMethod {
        static let name = "config.edit"

        /// One change: `value` to write, or `unset` to put the default back. `expect` is the value read there; a
        /// `.null` expect says the path held nothing, which differs from no expect at all.
        struct Edit: Codable, Equatable {
            /// A dotted path, or a JSON array of keys (`["projects","a.b","labels"]`) for a key with a dot.
            var path: String
            var value: JSONValue?
            var unset: Bool?
            var expect: JSONValue?

            init(path: String, value: JSONValue? = nil, unset: Bool? = nil, expect: JSONValue? = nil) {
                self.path = path
                self.value = value
                self.unset = unset
                self.expect = expect
            }

            private enum CodingKeys: String, CodingKey { case path, value, unset, expect }

            // A present null is a value (`expect: null`: the page read nothing there), not an absent member.
            init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                path = try container.decode(String.self, forKey: .path)
                value = container.contains(.value) ? try container.decode(JSONValue.self, forKey: .value) : nil
                unset = try container.decodeIfPresent(Bool.self, forKey: .unset)
                expect = container.contains(.expect) ? try container.decode(JSONValue.self, forKey: .expect) : nil
            }

            func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                try container.encode(path, forKey: .path)
                try container.encodeIfPresent(value, forKey: .value)
                try container.encodeIfPresent(unset, forKey: .unset)
                try container.encodeIfPresent(expect, forKey: .expect)
            }
        }

        struct Params: Codable, Equatable { var edits: [Edit] }

        /// Each changed path as keys, and the value it holds now (its default after an unset).
        struct Change: Decodable, Equatable {
            let path: [String]
            let value: JSONValue
        }

        typealias Result = [Change]
    }

    // MARK: The tone (config version 5)

    /// `global.playback.listen.tone.sound` as config version 5 keeps it (`toneSoundSettingSchema` in
    /// src/utils/meetings/config.ts): a sine (version 4's shape), a named preset, or a sound file. A preset or a file
    /// without a volume plays at the preset's own or the default one. The encoder writes only the case's members, so
    /// the strict schema takes it in `config.set`, `tone.preview` and `moment.plan`'s `toneSound`.
    enum ToneSoundSetting: Codable, Equatable, Hashable {
        case sine(hz: Double, sec: Double, volume: Double)
        case preset(String, volume: Double?)
        case file(String, volume: Double?)

        private enum CodingKeys: String, CodingKey { case hz, sec, volume, preset, file }

        /// DEFAULT_TONE_SOUND in src/utils/meetings/config.ts: what a config without `tone.sound` plays.
        static let defaultSine = (hz: 880.0, sec: 0.15, volume: 0.6)
        static let engineDefault = ToneSoundSetting.sine(hz: defaultSine.hz, sec: defaultSine.sec, volume: defaultSine.volume)

        /// The sound file's path; nil for a sine or a preset.
        var filePath: String? {
            if case .file(let path, _) = self { return path }
            return nil
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let volume = try container.decodeIfPresent(Double.self, forKey: .volume)
            if let preset = try container.decodeIfPresent(String.self, forKey: .preset) {
                self = .preset(preset, volume: volume)
            } else if let file = try container.decodeIfPresent(String.self, forKey: .file) {
                self = .file(file, volume: volume)
            } else {
                // The engine's defaults fill a sine's missing members, as the config reads it.
                self = .sine(hz: try container.decodeIfPresent(Double.self, forKey: .hz) ?? Self.defaultSine.hz,
                             sec: try container.decodeIfPresent(Double.self, forKey: .sec) ?? Self.defaultSine.sec,
                             volume: volume ?? Self.defaultSine.volume)
            }
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case .sine(let hz, let sec, let volume):
                try container.encode(hz, forKey: .hz)
                try container.encode(sec, forKey: .sec)
                try container.encode(volume, forKey: .volume)
            case .preset(let name, let volume):
                try container.encode(name, forKey: .preset)
                try container.encodeIfPresent(volume, forKey: .volume)
            case .file(let path, let volume):
                try container.encode(path, forKey: .file)
                try container.encodeIfPresent(volume, forKey: .volume)
            }
        }
    }

    /// `tone.presets`: the named tones a sound picker offers, three sines and the Mac's alert sounds. Picking one
    /// writes `.preset(name, volume: nil)` with `config.set`; `tone.preview` plays it.
    enum TonePresets: MeetingsServiceMethod {
        static let name = "tone.presets"

        struct Params: Codable, Equatable {}

        struct Preset: Decodable, Equatable, Hashable {
            let name: String
            let label: String
            /// sine or file.
            let kind: String
            /// The volume it plays at when the setting names none.
            let volume: Double
            /// A sine's pitch and length.
            let hz: Double?
            let sec: Double?
            /// A file preset's sound file.
            let file: String?
            /// False when this Mac lacks the file: the picker greys the row out.
            let available: Bool
        }

        struct Result: Decodable, Equatable { let presets: [Preset] }
    }
}
