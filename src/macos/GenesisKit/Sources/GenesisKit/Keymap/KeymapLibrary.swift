import Foundation

/// Where a command's key works. Two commands in one scope must not share a key: one of them could never run. A
/// narrower scope (the find bar, a sheet) may reuse a window key: while it is open its handler is the newer one and
/// takes the key, and the window's command works again once it closes (the find bar's ⇧⌘G is Previous Match, the
/// window's is Go to Location).
public struct KeymapScope: Hashable, Sendable, ExpressibleByStringLiteral, CustomStringConvertible {
    public let id: String
    public init(_ id: String) { self.id = id }
    public init(stringLiteral value: String) { self.id = value }
    public var description: String { id }

    /// Any window of the app: the menu bar's commands (Quit, Hide, Close Window).
    public static let app: KeymapScope = "app"
    /// The app's main window.
    public static let window: KeymapScope = "window"
    /// System-wide, registered with macOS while the app runs (dictation, the companion key).
    public static let global: KeymapScope = "global"

    /// Whether one key in both scopes is a conflict: the same scope, or the app's menu (`.app`) against any scope but
    /// `.global`, because a window's handler takes the key before the menu sees it.
    public func meets(_ other: KeymapScope) -> Bool {
        if self == other { return true }
        if self == .global || other == .global { return false }
        return self == .app || other == .app
    }
}

/// One thing a key can do: its id, its words for the help list, its default keys and where it works.
public struct KeymapCommand: Identifiable, Hashable, Sendable {
    /// Stable, dotted: "markdown.tab.next". Saved in the user's configuration, so never renamed lightly.
    public let id: String
    /// "Next Tab": the help list's row title and the start of a tooltip.
    public let title: String
    /// The help list's section: "Tabs", "View".
    public let group: String
    /// One sentence more, when the title alone leaves a question.
    public let detail: String?
    public let defaults: [KeyChord]
    public let scope: KeymapScope
    /// False for a key the user cannot change here (Return in a field, the system's Copy): listed in the help,
    /// not offered in the editor.
    public let configurable: Bool

    public init(
        _ id: String, _ title: String, group: String, detail: String? = nil, keys: [KeyChord],
        scope: KeymapScope = .window, configurable: Bool = true
    ) {
        self.id = id
        self.title = title
        self.group = group
        self.detail = detail
        self.defaults = keys
        self.scope = scope
        self.configurable = configurable
    }
}

/// Every command one app (or one window kind) has, with its default keys: the single place that knows them. Menus,
/// tooltips, the help list and the editor all read it, so none of them can drift from the real keys.
public struct KeymapLibrary: Sendable {
    /// "markdown". Names the saved configuration file.
    public let id: String
    /// "Markdown Viewer": the help window's subtitle.
    public let title: String
    public let commands: [KeymapCommand]

    public init(id: String, title: String, commands: [KeymapCommand]) {
        var seen = Set<String>()
        for command in commands {
            precondition(seen.insert(command.id).inserted, "KeymapLibrary \(id): command \(command.id) is listed twice")
        }
        self.id = id
        self.title = title
        self.commands = commands
    }

    public func command(_ id: String) -> KeymapCommand? { commands.first { $0.id == id } }

    /// The groups in the order their first command appears.
    public var groups: [String] {
        var seen = Set<String>()
        return commands.map(\.group).filter { seen.insert($0).inserted }
    }
}

/// The user's own keys for one library. Only what differs from the defaults is kept, so a default the app changes
/// later reaches every user who never touched that command.
public struct KeymapConfiguration: Codable, Equatable, Sendable {
    public var version = 1
    /// By command id. An empty list turns the command's key off.
    public var overrides: [String: [KeyChord]] = [:]

    public init(overrides: [String: [KeyChord]] = [:]) { self.overrides = overrides }
}

/// Reads and writes a configuration as JSON. A missing file is an empty configuration; a file that cannot be read is
/// logged and treated as empty, and left in place until the next save replaces it.
public struct KeymapStore: Sendable {
    public let fileURL: URL

    public init(fileURL: URL) { self.fileURL = fileURL }

    /// `<directory>/<library>.json`, in the host's keymap folder (`GenesisKitHost.keymapDirectory`), else in
    /// `~/Library/Application Support/GenesisKit/Keymaps`.
    public static func standard(library: String) -> KeymapStore {
        let directory = GenesisKit.host?.keymapDirectory
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("GenesisKit/Keymaps", isDirectory: true)
        return KeymapStore(fileURL: directory.appendingPathComponent("\(library).json"))
    }

    public func load() -> KeymapConfiguration {
        guard let data = try? Data(contentsOf: fileURL) else { return KeymapConfiguration() }
        do {
            return try JSONDecoder().decode(KeymapConfiguration.self, from: data)
        } catch {
            GenesisKit.log("keymap: \(fileURL.path) could not be read (\(error)); using the default keys")
            return KeymapConfiguration()
        }
    }

    public func save(_ configuration: KeymapConfiguration) throws {
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(configuration).write(to: fileURL, options: .atomic)
    }
}
