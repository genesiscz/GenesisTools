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
}
