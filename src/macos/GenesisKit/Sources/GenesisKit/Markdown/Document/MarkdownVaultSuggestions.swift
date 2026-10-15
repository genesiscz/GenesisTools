//
//  MarkdownVaultSuggestions.swift
//  GenesisKit
//
//  The names and tags the `[[` / `#` completion offers, and the property vocabulary of the Properties block.
//  A host may answer itself (`GenesisKitHost.markdownCompletions`); otherwise they come from the vault's
//  `VaultIndex`, opened read-only at `GenesisKitHost.markdownVaultRoot`. No vault, or no index yet: nothing.
//

import Foundation

@MainActor
final class MarkdownVaultSuggestions {
    static let shared = MarkdownVaultSuggestions()

    /// Repeated keystrokes ask the same question; one answer per query is enough.
    private var cache: [String: [String]] = [:]

    func values(for request: MarkdownCompletion.Request) -> [String] {
        let key = "\(request.kind)|\(request.query.lowercased())"
        if let hit = cache[key] { return hit }
        let values = GenesisKit.host?.markdownCompletions(request) ?? indexCompletions(request)
        if cache.count > 200 { cache.removeAll() }
        cache[key] = values
        return values
    }

    /// Property keys and their values, as JSON for the page's Properties block.
    /// Recomputed at most once a minute: the host reads every note's props.
    func propertyVocabularyJSON() -> String {
        if let vocabulary, Date().timeIntervalSince(vocabularyAt) < 60 { return vocabulary }
        let json = GenesisKit.host?.markdownPropertyVocabularyJSON() ?? indexVocabularyJSON()
        vocabulary = json
        vocabularyAt = Date()
        return json
    }

    private var vocabulary: String?
    private var vocabularyAt = Date.distantPast

    private func indexCompletions(_ request: MarkdownCompletion.Request) -> [String] {
        guard let index = openIndex() else { return [] }
        switch request.kind {
        case .wikilink: return index.noteNames(matching: request.query)
        case .tag: return index.tags(matching: request.query)
        }
    }

    private func indexVocabularyJSON() -> String {
        guard let index = openIndex() else { return "{}" }
        let data = (try? JSONSerialization.data(withJSONObject: index.propertyVocabulary())) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    private var index: VaultIndex?
    private var indexRoot: String?
    private var indexTriedAt = Date.distantPast

    /// The vault can change under the window (settings, another vault), so the connection follows the root.
    /// A vault the vault pane never indexed has no file yet; that is retried once a minute, not per keystroke.
    private func openIndex() -> VaultIndex? {
        guard let root = GenesisKit.host?.markdownVaultRoot, !root.isEmpty else { return nil }
        if indexRoot == root, let index { return index }
        if indexRoot == root, Date().timeIntervalSince(indexTriedAt) < 60 { return nil }
        indexRoot = root
        indexTriedAt = Date()
        index = try? VaultIndex(vaultRoot: root, readOnly: true)
        return index
    }

    /// The vault index is rebuilt in the background; drop the memo so a note written this session shows up.
    func forget() {
        cache.removeAll()
        vocabulary = nil
    }
}
