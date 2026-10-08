// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Flow/FlowStore.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import Foundation
import Darwin

/// On-disk home for everything Flow owns: `~/.genesis/flow/`.
///
/// Deliberately NOT in `client.json`. Every dictation turn writes history and
/// stats, and `ConfigStore.mutate` takes a cross-process `flock` shared with
/// the CLI, MCP and eve — it busy-waits up to 5 s for that lock and runs
/// synchronously on the main actor. Putting a per-turn write behind it would
/// stall the UI on someone else's contention.
///
/// Write discipline is lifted from BridgeVoice's `storage::io`: temp file +
/// atomic rename, owner-only permissions, and a corrupt file gets renamed
/// aside rather than silently replaced with defaults.
@MainActor
public final class FlowStore {

    public static var shared = FlowStore(writesEnabled: false)

    public let directory: URL
    public var writesEnabled: Bool
    public var forwardWrite: ((String, Data) -> Void)?
    public var didWrite: (() -> Void)?
    public var onFailure: ((String) -> Void)?
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private var writeFailure: Error?

    public init(directory: URL? = nil, writesEnabled: Bool = true) {
        self.directory = directory ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".genesis/flow", isDirectory: true)
        self.writesEnabled = writesEnabled

        encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601

        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
    }

    // MARK: - Paths

    private var configURL: URL { directory.appendingPathComponent("config.json") }
    private var historyURL: URL { directory.appendingPathComponent("history.json") }
    private var dictionaryURL: URL { directory.appendingPathComponent("dictionary.json") }
    private var suggestionsURL: URL { directory.appendingPathComponent("suggestions.json") }
    private var snippetsURL: URL { directory.appendingPathComponent("snippets.json") }
    private var transformsURL: URL { directory.appendingPathComponent("transforms.json") }
    private var statsURL: URL { directory.appendingPathComponent("stats.json") }
    private var scratchpadURL: URL { directory.appendingPathComponent("scratchpad.md") }

    // MARK: - Typed accessors

    public func loadConfig() -> FlowConfig { load(configURL) ?? FlowConfig() }
    public func saveConfig(_ value: FlowConfig) { save(value, to: configURL) }

    func persistConfig(_ value: FlowConfig) throws {
        try writeOwned(encoder.encode(value), to: configURL)
    }

    public func loadHistory() -> [FlowEntry] { load(historyURL) ?? [] }
    public func saveHistory(_ value: [FlowEntry]) {
        do {
            guard writesEnabled else {
                throw FlowFocusMailbox.Failure.unavailable("Only the active Flow and Focus owner can save changes.")
            }
            let encoded = try encoder.encode(value)
            let previousIDs = Set(loadHistory().map(\.id))
            let retainedIDs = Set(value.map(\.id))
            if value.isEmpty || !previousIDs.isSubset(of: retainedIDs) {
                try FlowEvents.retain(entryIDs: retainedIDs, at: directory.appendingPathComponent("events.jsonl"))
            }
            try writeOwned(encoded, to: historyURL)
        } catch {
            writeFailure = error
            onFailure?(error.localizedDescription)
            FlowFocusLog.flow.error("FlowStore: history retention failed: \(error.localizedDescription)")
        }
    }

    public func loadDictionary() -> [FlowDictionaryRule] { load(dictionaryURL) ?? [] }
    public func saveDictionary(_ value: [FlowDictionaryRule]) { save(value, to: dictionaryURL) }

    public func loadSuggestions() -> [FlowSuggestion] { load(suggestionsURL) ?? [] }
    public func saveSuggestions(_ value: [FlowSuggestion]) { save(value, to: suggestionsURL) }

    public func loadSnippets() -> [FlowSnippet] { load(snippetsURL) ?? [] }
    public func saveSnippets(_ value: [FlowSnippet]) { save(value, to: snippetsURL) }

    public func loadTransforms() -> [FlowTransform] { load(transformsURL) ?? FlowStore.defaultTransforms }
    public func saveTransforms(_ value: [FlowTransform]) { save(value, to: transformsURL) }

    public func loadStats() -> FlowStats { load(statsURL) ?? FlowStats() }
    public func saveStats(_ value: FlowStats) { save(value, to: statsURL) }

    public func loadScratchpad() -> String {
        (try? String(contentsOf: scratchpadURL, encoding: .utf8)) ?? ""
    }

    public func saveScratchpad(_ text: String) {
        writeAtomic(Data(text.utf8), to: scratchpadURL)
    }

    /// Shipped starting set. Users can delete them; they are not re-seeded,
    /// because an empty transforms file is a legitimate choice.
    public static let defaultTransforms: [FlowTransform] = [
        FlowTransform(
            name: "Clean up",
            prompt: """
            Rewrite the text to remove filler words, false starts and repetitions. \
            Keep the speaker's wording and meaning otherwise identical. \
            Do not add content. Return only the rewritten text.
            """,
            isDefault: true
        ),
        FlowTransform(
            name: "Email",
            prompt: """
            Restructure the text as a short professional email body. \
            Keep every fact from the original. No greeting or sign-off unless \
            the speaker dictated one. Return only the email body.
            """
        ),
        FlowTransform(
            name: "Bullets",
            prompt: """
            Restructure the text as a concise bulleted list, one idea per bullet, \
            preserving the original order and every fact. Return only the list.
            """
        ),
        FlowTransform(
            name: "Commit message",
            prompt: """
            Rewrite the text as a git commit message: an imperative subject line \
            under 72 characters, then a blank line, then a body explaining what \
            changed and why. Return only the commit message.
            """
        ),
    ]

    // MARK: - IO

    private func ensureDirectory() throws {
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
    }

    private func load<T: Decodable>(_ url: URL) -> T? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            // A corrupt file is moved aside, never overwritten in place. The
            // user keeps a chance of recovering it by hand, and the next save
            // starts clean instead of failing forever.
            if writesEnabled { backupCorrupt(url) }
            FlowFocusLog.flow.error("FlowStore: \(url.lastPathComponent) was unreadable: \(error.localizedDescription)")
            return nil
        }
    }

    private func save<T: Encodable>(_ value: T, to url: URL) {
        do {
            writeAtomic(try encoder.encode(value), to: url)
        } catch {
            FlowFocusLog.flow.error("FlowStore: encoding \(url.lastPathComponent) failed: \(error.localizedDescription)")
            writeFailure = error
            onFailure?(error.localizedDescription)
        }
    }

    /// Write to a unique temp file in the same directory, then rename over the
    /// target. Rename is atomic within a filesystem, so a reader never sees a
    /// half-written file and a crash mid-write cannot truncate the old one.
    private func writeAtomic(_ data: Data, to url: URL) {
        if let forwardWrite {
            forwardWrite(url.lastPathComponent, data)
            return
        }
        do {
            try writeOwned(data, to: url)
        } catch {
            FlowFocusLog.flow.error("FlowStore: writing \(url.lastPathComponent) failed: \(error.localizedDescription)")
            writeFailure = error
            onFailure?(error.localizedDescription)
        }
    }

    private func writeOwned(_ data: Data, to url: URL) throws {
        guard writesEnabled else {
            throw FlowFocusMailbox.Failure.unavailable("Only the active Flow and Focus owner can save changes.")
        }
        try ensureDirectory()
        let temp = directory.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
        do {
            try data.write(to: temp, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temp.path)
            guard rename(temp.path, url.path) == 0 else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            }
            didWrite?()
        } catch {
            try? FileManager.default.removeItem(at: temp)
            throw error
        }
    }

    func verifyingWrites<T>(_ operation: () throws -> T) throws -> T {
        let previous = writeFailure
        writeFailure = nil
        defer { writeFailure = previous }
        let value = try operation()
        if let writeFailure { throw writeFailure }
        return value
    }

    func writeFromClient(name: String, data: Data) throws {
        guard ["scratchpad.md"].contains(name), writesEnabled else {
            throw FlowFocusMailbox.Failure.unavailable("That Flow file is not writable through the client channel.")
        }
        try writeOwned(data, to: directory.appendingPathComponent(name))
    }

    private func backupCorrupt(_ url: URL) {
        let stamp = Int(Date().timeIntervalSince1970)
        let target = url.deletingLastPathComponent()
            .appendingPathComponent("\(url.lastPathComponent).corrupt-\(stamp)")
        try? FileManager.default.moveItem(at: url, to: target)
    }
}
