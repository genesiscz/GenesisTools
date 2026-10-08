// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Flow/FlowStore.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import Foundation

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
final class FlowStore {

    static let shared = FlowStore()

    private let directory: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    private init() {
        let home = FileManager.default.homeDirectoryForCurrentUser
        directory = home.appendingPathComponent(".genesis/flow", isDirectory: true)

        encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601

        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        ensureDirectory()
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

    func loadConfig() -> FlowConfig { load(configURL) ?? FlowConfig() }
    func saveConfig(_ value: FlowConfig) { save(value, to: configURL) }

    func loadHistory() -> [FlowEntry] { load(historyURL) ?? [] }
    func saveHistory(_ value: [FlowEntry]) { save(value, to: historyURL) }

    func loadDictionary() -> [FlowDictionaryRule] { load(dictionaryURL) ?? [] }
    func saveDictionary(_ value: [FlowDictionaryRule]) { save(value, to: dictionaryURL) }

    func loadSuggestions() -> [FlowSuggestion] { load(suggestionsURL) ?? [] }
    func saveSuggestions(_ value: [FlowSuggestion]) { save(value, to: suggestionsURL) }

    func loadSnippets() -> [FlowSnippet] { load(snippetsURL) ?? [] }
    func saveSnippets(_ value: [FlowSnippet]) { save(value, to: snippetsURL) }

    func loadTransforms() -> [FlowTransform] { load(transformsURL) ?? FlowStore.defaultTransforms }
    func saveTransforms(_ value: [FlowTransform]) { save(value, to: transformsURL) }

    func loadStats() -> FlowStats { load(statsURL) ?? FlowStats() }
    func saveStats(_ value: FlowStats) { save(value, to: statsURL) }

    func loadScratchpad() -> String {
        (try? String(contentsOf: scratchpadURL, encoding: .utf8)) ?? ""
    }

    func saveScratchpad(_ text: String) {
        writeAtomic(Data(text.utf8), to: scratchpadURL)
    }

    /// Shipped starting set. Users can delete them; they are not re-seeded,
    /// because an empty transforms file is a legitimate choice.
    static let defaultTransforms: [FlowTransform] = [
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

    private func ensureDirectory() {
        let fm = FileManager.default
        guard !fm.fileExists(atPath: directory.path) else { return }
        do {
            try fm.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        } catch {
            Log.flow.error("FlowStore: could not create \(self.directory.path): \(error.localizedDescription)")
        }
    }

    private func load<T: Decodable>(_ url: URL) -> T? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            // A corrupt file is moved aside, never overwritten in place. The
            // user keeps a chance of recovering it by hand, and the next save
            // starts clean instead of failing forever.
            backupCorrupt(url)
            Log.flow.error("FlowStore: \(url.lastPathComponent) was unreadable, moved aside: \(error.localizedDescription)")
            return nil
        }
    }

    private func save<T: Encodable>(_ value: T, to url: URL) {
        do {
            writeAtomic(try encoder.encode(value), to: url)
        } catch {
            Log.flow.error("FlowStore: encoding \(url.lastPathComponent) failed: \(error.localizedDescription)")
        }
    }

    /// Write to a unique temp file in the same directory, then rename over the
    /// target. Rename is atomic within a filesystem, so a reader never sees a
    /// half-written file and a crash mid-write cannot truncate the old one.
    private func writeAtomic(_ data: Data, to url: URL) {
        ensureDirectory()
        let temp = directory.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
        do {
            try data.write(to: temp, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temp.path)
            _ = try FileManager.default.replaceItemAt(url, withItemAt: temp)
        } catch {
            try? FileManager.default.removeItem(at: temp)
            Log.flow.error("FlowStore: writing \(url.lastPathComponent) failed: \(error.localizedDescription)")
        }
    }

    private func backupCorrupt(_ url: URL) {
        let stamp = Int(Date().timeIntervalSince1970)
        let target = url.deletingLastPathComponent()
            .appendingPathComponent("\(url.lastPathComponent).corrupt-\(stamp)")
        try? FileManager.default.moveItem(at: url, to: target)
    }
}
