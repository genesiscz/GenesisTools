//
//  MarkdownPathCompletion.swift
//  GenesisKit
//
//  The list under "Go to Location…" (⇧⌘G): what the typed path names, the entries of the one folder it is in
//  that match its last part, and the files opened lately. One directory read per folder, never a walk, so a vault
//  folder with thousands of notes costs one listing; the loader runs it off the main thread. Plain functions over
//  strings and one directory read, so the tests need no window.
//

import Foundation

/// One entry of a folder: its name, and whether it is a folder (a link to a folder counts as one).
struct MarkdownPathEntry: Equatable, Sendable {
    var name: String
    var isFolder: Bool
}

/// What the field holds, split for the list.
struct MarkdownPathQuery: Equatable, Sendable {
    /// The folder whose entries are listed: absolute and standardized.
    var folder: String
    /// The part after the last slash, matched against the entries. Empty lists the whole folder.
    var segment: String
    /// The text before the segment as typed (a `~` stays a `~`): Tab puts a name after it.
    var head: String
}

/// One row of the list.
struct MarkdownPathSuggestion: Identifiable, Equatable, Sendable {
    enum Source: Equatable, Sendable {
        /// An entry of the listed folder.
        case folder
        /// A file opened lately, shown while the field still holds the folder it opened with.
        case recent
    }

    var path: String
    var name: String
    var isFolder: Bool
    var source: Source
    /// The offsets of the characters of `name` that the typed part matched, drawn in the accent.
    var matched: [Int] = []

    /// A recent file can also be an entry of the listed folder: two rows, two ids.
    var id: String { source == .recent ? "recent:" + path : path }
}

/// Why a folder lists nothing at all.
enum MarkdownPathFolderProblem: Equatable, Sendable {
    /// Nothing exists at the folder's path.
    case missing
    /// The path names a file, so it holds no entries.
    case notAFolder
    /// The folder exists and could not be read (permissions, or a privacy grant for Desktop, Documents, Downloads).
    case unreadable
}

/// The list for one text of the field.
struct MarkdownPathSuggestions: Equatable, Sendable {
    /// The field's text these rows are for. A row acts only while the field still holds it.
    var text: String
    var query: MarkdownPathQuery
    var recents: [MarkdownPathSuggestion] = []
    var entries: [MarkdownPathSuggestion] = []
    /// How many entries matched, before the cap.
    var total = 0
    /// Files whose name matched but which the file filter leaves out ("Notes" lists no JSON).
    var filteredOut = 0
    /// Hidden entries left out because the typed name does not start with a dot.
    var hiddenOut = 0
    var problem: MarkdownPathFolderProblem?

    var rows: [MarkdownPathSuggestion] { recents + entries }
    var truncated: Bool { total > entries.count }

    /// The row Return and Tab take while nobody moved the selection: the first one when there is something to match
    /// (a typed name, or the recent files), none while the field names a folder, so Return shows that folder.
    var automaticIndex: Int? {
        guard !rows.isEmpty, !query.segment.isEmpty || !recents.isEmpty else { return nil }
        return 0
    }
}

/// Every setting the list reads. The sheet builds its list again whenever this value changes, so a setting the list
/// follows belongs here.
struct MarkdownPathOptions: Equatable, Sendable {
    var files: MarkdownGoToFiles = .notes
    var showsHidden = false
    /// The recent files passed in lead the list ("Recent files first"). Off: they are left out.
    var showsRecents = true
    /// The rows a folder shows at most; the rest wait for a longer name.
    var limit = 200
}

/// What the reader picked when Return or Tab came.
enum MarkdownGoToPick: Equatable, Sendable {
    /// The reader moved to this row (Up, Down, a click).
    case chosen(MarkdownPathSuggestion)
    /// The reader moved above the first row: the text alone counts.
    case text
    /// Nobody moved: the list's automatic row, when it has one.
    case automatic(MarkdownPathSuggestion?)
}

/// What Return does.
enum MarkdownGoToAction: Equatable, Sendable {
    /// Opens the file: a new tab, or its own tab when it is open.
    case open(URL)
    /// Shows the folder or the file in the file sidebar.
    case reveal(URL)
    /// Puts this text in the field: a folder's path, whose entries the list then shows.
    case complete(String)
    /// What is wrong, shown under the field.
    case problem(String)
}

enum MarkdownPathCompletion {
    /// The recent files the list leads with at most.
    static let recentLimit = 8

    // MARK: The text

    /// The path a pasted or typed text holds: surrounding quotes and a trailing newline dropped, a `file://` URL
    /// read as its path (a folder URL keeps its closing slash). Nil-free: blank text stays blank.
    static func cleaned(_ raw: String) -> String {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.count >= 2, let first = text.first, first == text.last, first == "\"" || first == "'" {
            text = String(text.dropFirst().dropLast())
        }

        if text.hasPrefix("file://"), let url = URL(string: text) {
            let path = url.standardizedFileURL.path
            return text.hasSuffix("/") && !path.hasSuffix("/") ? path + "/" : path
        }
        return text
    }

    /// The folder the text is in and the name being typed in it. A bare `~` is the home folder; a relative path is
    /// taken from `base`.
    static func query(_ raw: String, base: URL) -> MarkdownPathQuery {
        var text = cleaned(raw)
        if text == "~" { text = "~/" }
        guard let slash = text.lastIndex(of: "/") else {
            return MarkdownPathQuery(folder: absolute("", base: base), segment: text, head: "")
        }

        let head = String(text[...slash])
        return MarkdownPathQuery(folder: absolute(head, base: base), segment: String(text[text.index(after: slash)...]),
                                 head: head)
    }

    static func absolute(_ head: String, base: URL) -> String {
        let expanded = (head as NSString).expandingTildeInPath
        let url = expanded.hasPrefix("/")
            ? URL(fileURLWithPath: expanded, isDirectory: true)
            : base.appendingPathComponent(expanded, isDirectory: true)
        return url.standardizedFileURL.path
    }

    /// A folder as the field shows it: `~` for the home folder, a closing slash.
    static func display(folder: URL) -> String {
        let path = (folder.standardizedFileURL.path as NSString).abbreviatingWithTildeInPath
        return path.hasSuffix("/") ? path : path + "/"
    }

    // MARK: The folder

    /// One folder's entries, or nil when it cannot be listed. The folder flags come with the listing (prefetched
    /// resource keys); only a symbolic link costs a second look, to tell a link to a folder from a link to a file.
    static func read(_ folder: String) -> [MarkdownPathEntry]? {
        let url = URL(fileURLWithPath: folder, isDirectory: true)
        let keys: [URLResourceKey] = [.isDirectoryKey, .isSymbolicLinkKey]
        guard let items = try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: keys) else {
            return nil
        }

        return items.map { item in
            let values = try? item.resourceValues(forKeys: Set(keys))
            var isFolder = values?.isDirectory ?? false
            if values?.isSymbolicLink == true {
                var flag: ObjCBool = false
                isFolder = FileManager.default.fileExists(atPath: item.path, isDirectory: &flag) && flag.boolValue
            }
            return MarkdownPathEntry(name: item.lastPathComponent, isFolder: isFolder)
        }
    }

    static func problem(at folder: String) -> MarkdownPathFolderProblem {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: folder, isDirectory: &isDirectory) else { return .missing }
        return isDirectory.boolValue ? .unreadable : .notAFolder
    }

    /// Whether a file of this name is listed: folders always are, files by the setting.
    static func lists(file name: String, _ files: MarkdownGoToFiles) -> Bool {
        let ext = (name as NSString).pathExtension
        switch files {
        case .notes: return FileTree.kind(ofFileExtension: ext) != .file
        case .readable: return FileTree.isReadable(fileExtension: ext)
        }
    }

    // MARK: Matching

    struct Match: Equatable {
        /// Lower is better: 0 the whole name, 1 its start, 2 the start of a word in it, 3 anywhere in it, 4 its
        /// letters in order with others between them.
        var score: Int
        var positions: [Int]

        /// How far apart the matched letters are; a tighter match sorts first among equal scores.
        var span: Int { (positions.last ?? 0) - (positions.first ?? 0) }
    }

    /// How `segment` matches `name`, ignoring case; nil when it does not.
    static func match(_ segment: String, in name: String) -> Match? {
        // One lowercased string per character keeps the offsets those of `name`.
        let needle = segment.map { $0.lowercased() }
        let hay = name.map { $0.lowercased() }
        guard !needle.isEmpty else { return Match(score: 0, positions: []) }
        guard needle.count <= hay.count else { return nil }
        if needle == hay { return Match(score: 0, positions: Array(hay.indices)) }
        if hay.starts(with: needle) { return Match(score: 1, positions: Array(0..<needle.count)) }

        let characters = Array(name)
        var inside: Int?
        for start in stride(from: 1, through: hay.count - needle.count, by: 1) where hay[start] == needle[0] {
            guard Array(hay[start..<(start + needle.count)]) == needle else { continue }
            if startsWord(characters, at: start) {
                return Match(score: 2, positions: Array(start..<(start + needle.count)))
            }
            if inside == nil { inside = start }
        }
        if let inside {
            return Match(score: 3, positions: Array(inside..<(inside + needle.count)))
        }

        var positions: [Int] = []
        var index = 0
        for letter in needle {
            while index < hay.count, hay[index] != letter { index += 1 }
            guard index < hay.count else { return nil }
            positions.append(index)
            index += 1
        }
        return Match(score: 4, positions: positions)
    }

    /// A word starts after a separator, at a capital after a small letter (`planReview`), and where digits begin.
    static func startsWord(_ characters: [Character], at index: Int) -> Bool {
        guard index > 0 else { return true }
        let previous = characters[index - 1]
        let current = characters[index]
        if " -_.+(".contains(previous) { return true }
        if previous.isLowercase, current.isUppercase { return true }
        return current.isNumber && !previous.isNumber
    }

    // MARK: The list

    /// The rows for `raw`. `recents` are paths, newest first, passed only while the field holds the folder it opened
    /// with; `options.showsRecents` decides whether they show. `isCancelled` is asked before each folder read and
    /// while ranking a large folder, so a stale request starts no read and stops early (its rows are empty then).
    static func suggest(
        _ raw: String,
        base: URL,
        recents: [String] = [],
        options: MarkdownPathOptions = MarkdownPathOptions(),
        isCancelled: () -> Bool = { false },
        read: (String) -> [MarkdownPathEntry]? = MarkdownPathCompletion.read
    ) -> MarkdownPathSuggestions {
        var parsed = Self.query(raw, base: base)
        guard !isCancelled() else { return MarkdownPathSuggestions(text: raw, query: parsed) }
        var listing = read(parsed.folder)
        // A path that names a folder without its closing slash (a pasted folder path, `..`): that folder's entries.
        // A lone `.` stays a name, since it is how hidden files are asked for.
        let namesFolder = parsed.segment == ".."
            || listing?.contains(where: { $0.isFolder && $0.name == parsed.segment }) == true
        if !parsed.segment.isEmpty, namesFolder {
            guard !isCancelled() else { return MarkdownPathSuggestions(text: raw, query: parsed) }
            let folder = URL(fileURLWithPath: parsed.folder).appendingPathComponent(parsed.segment).standardizedFileURL.path
            if let inner = read(folder) {
                parsed = MarkdownPathQuery(folder: folder, segment: "", head: parsed.head + parsed.segment + "/")
                listing = inner
            }
        }

        var result = MarkdownPathSuggestions(text: raw, query: parsed)
        result.recents = options.showsRecents ? recentRows(recents) : []
        guard let listing else {
            result.problem = problem(at: parsed.folder)
            return result
        }

        let segment = parsed.segment
        let hidden = options.showsHidden || segment.hasPrefix(".")
        var scored: [(match: Match, entry: MarkdownPathEntry)] = []
        for (index, entry) in listing.enumerated() {
            if index % 512 == 511, isCancelled() { return result }
            if entry.name.hasPrefix("."), !hidden {
                result.hiddenOut += 1
                continue
            }
            guard let found = Self.match(segment, in: entry.name) else { continue }
            if !entry.isFolder, !lists(file: entry.name, options.files) {
                result.filteredOut += 1
                continue
            }
            scored.append((found, entry))
        }

        if segment.isEmpty {
            // Browsing a folder: folders first, then files, each in Finder's order.
            scored.sort { a, b in
                if a.entry.isFolder != b.entry.isFolder { return a.entry.isFolder }
                return a.entry.name.localizedStandardCompare(b.entry.name) == .orderedAscending
            }
        } else {
            scored.sort { a, b in
                if a.match.score != b.match.score { return a.match.score < b.match.score }
                if a.match.span != b.match.span { return a.match.span < b.match.span }
                if a.entry.name.count != b.entry.name.count { return a.entry.name.count < b.entry.name.count }
                return a.entry.name.localizedStandardCompare(b.entry.name) == .orderedAscending
            }
        }

        result.total = scored.count
        let folder = URL(fileURLWithPath: parsed.folder, isDirectory: true)
        result.entries = scored.prefix(options.limit).map { item in
            MarkdownPathSuggestion(
                path: folder.appendingPathComponent(item.entry.name).path, name: item.entry.name,
                isFolder: item.entry.isFolder, source: .folder, matched: item.match.positions
            )
        }
        return result
    }

    /// The recent files that are still on disk, at most `recentLimit`.
    static func recentRows(_ paths: [String]) -> [MarkdownPathSuggestion] {
        var rows: [MarkdownPathSuggestion] = []
        for path in paths where rows.count < recentLimit {
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), !isDirectory.boolValue else {
                continue
            }
            rows.append(MarkdownPathSuggestion(path: path, name: (path as NSString).lastPathComponent, isFolder: false,
                                               source: .recent))
        }
        return rows
    }

    // MARK: Tab and Return

    /// The field's text after Tab on `row`: the folder's entry after what was typed (a folder with its closing slash,
    /// so the list goes inside it), or a recent file's whole path.
    static func completion(of row: MarkdownPathSuggestion, in query: MarkdownPathQuery) -> String {
        switch row.source {
        case .recent: return (row.path as NSString).abbreviatingWithTildeInPath
        case .folder: return query.head + row.name + (row.isFolder ? "/" : "")
        }
    }

    /// What Return does. A row the reader moved to wins; then a file the text names exactly (a pasted path); then the
    /// automatic row; then a folder the text names, which shows in the file sidebar. With `reveal` (⌘Return) the pick
    /// shows in the sidebar instead of opening. A folder row goes into the field, so the list shows its entries.
    static func action(text: String, base: URL, pick: MarkdownGoToPick, query: MarkdownPathQuery,
                       reveal: Bool) -> MarkdownGoToAction {
        let typed = MarkdownGoTo.url(from: text, base: base)
        var isDirectory: ObjCBool = false
        let exists = typed.map { FileManager.default.fileExists(atPath: $0.path, isDirectory: &isDirectory) } ?? false

        func act(_ row: MarkdownPathSuggestion) -> MarkdownGoToAction {
            let url = URL(fileURLWithPath: row.path)
            if reveal { return .reveal(url) }
            if row.isFolder { return .complete(completion(of: row, in: query)) }
            return opening(url)
        }

        switch pick {
        case .chosen(let row):
            return act(row)
        case .automatic(let row?) where !(exists && !isDirectory.boolValue):
            return act(row)
        case .text, .automatic:
            break
        }

        guard let typed else { return .problem("Type a path.") }
        guard exists else { return .problem("Nothing at \((typed.path as NSString).abbreviatingWithTildeInPath).") }
        if isDirectory.boolValue || reveal { return .reveal(typed) }
        return opening(typed)
    }

    /// A file the viewer opens as a tab, or the note that it does not.
    static func opening(_ url: URL) -> MarkdownGoToAction {
        guard FileTree.isReadable(url) else {
            return .problem("\u{201C}\(url.lastPathComponent)\u{201D} is not a file this viewer opens.")
        }
        return .open(url)
    }
}

/// The folders "Go to Location…" listed while its sheet is open, so typing inside one folder reads it once. A request
/// that asks for a folder while another request reads it waits for that read instead of starting its own, so fast
/// typing over a slow folder still costs one listing. A folder that could not be read is not kept, so one created
/// meanwhile shows on the next keystroke.
final class MarkdownPathCache: @unchecked Sendable {
    /// A read under way. The requests that want the same folder meanwhile wait on `done`, then take `entries`.
    private final class Reading: @unchecked Sendable {
        let done = DispatchGroup()
        var entries: [MarkdownPathEntry]?

        init() { done.enter() }
    }

    private enum Slot {
        case listed([MarkdownPathEntry])
        case reading(Reading)
    }

    private enum Lookup {
        case hit([MarkdownPathEntry])
        case wait(Reading)
        case read(Reading)
    }

    /// How long a request waits for another request's read of the same folder before it reads the folder itself.
    static let waitLimit: DispatchTimeInterval = .seconds(10)

    private let lock = NSLock()
    private var folders: [String: Slot] = [:]
    private let reader: @Sendable (String) -> [MarkdownPathEntry]?

    /// `read` lists one folder; a test hands in its own to count or hold the reads.
    init(read: @escaping @Sendable (String) -> [MarkdownPathEntry]? = MarkdownPathCompletion.read) {
        reader = read
    }

    func read(_ folder: String) -> [MarkdownPathEntry]? {
        let lookup: Lookup = lock.withLock {
            switch folders[folder] {
            case .listed(let entries)?:
                return .hit(entries)
            case .reading(let reading)?:
                return .wait(reading)
            case nil:
                let reading = Reading()
                folders[folder] = .reading(reading)
                return .read(reading)
            }
        }

        switch lookup {
        case .hit(let entries):
            return entries
        case .wait(let reading):
            // A read that hangs (a stalled network volume) holds this request for at most the deadline; then it
            // reads the folder itself, and keeps nothing, since the first read stores its listing when it ends.
            guard reading.done.wait(timeout: .now() + Self.waitLimit) == .success else { return reader(folder) }
            return reading.entries
        case .read(let reading):
            let entries = reader(folder)
            // Nil drops the slot: an unreadable folder is asked again by the next request.
            lock.withLock { folders[folder] = entries.map(Slot.listed) }
            reading.entries = entries
            reading.done.leave()
            return entries
        }
    }
}
