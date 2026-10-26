//
//  MarkdownMedia.swift
//  GenesisKit
//
//  Images and JSON files a rendered note references. The page lives on the
//  `genres://asset/` origin, so `![](x.webp)` and `![[x.webp]]` resolved against
//  the bundled assets and never showed. Swift now reads the references out of
//  the document itself, resolves each with Obsidian's rules (the note's folder,
//  the vault root, the configured attachment folder, then a vault-wide name
//  lookup), and hands the page an opaque `gnmedia://m/<token>` for each file it
//  found. The scheme handler serves only those tokens: the page can never name
//  a path, and a file must sit inside the vault or under the note's folder
//  after symlinks are resolved.
//

import Foundation
import WebKit

enum MarkdownMedia {
    static let scheme = "gnmedia"

    enum Kind: String {
        case image, json
    }

    /// The image types the page may show. SVG is served with its own
    /// `default-src 'none'` policy, and an `<img>` never runs its script anyway.
    static let imageTypes: [String: String] = [
        "webp": "image/webp", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "gif": "image/gif", "avif": "image/avif", "svg": "image/svg+xml",
    ]

    static let maxImageBytes = 64 * 1024 * 1024
    static let maxJSONBytes = 2 * 1024 * 1024

    static func kind(ofExtension ext: String) -> Kind? {
        let ext = ext.lowercased()
        if imageTypes[ext] != nil { return .image }
        if ext == "json" { return .json }
        return nil
    }

    /// One reference as the document wrote it, and whether it was an embed.
    struct Reference: Hashable {
        let key: String
        let embed: Bool
    }

    /// The lookup key both sides agree on: trimmed, `<…>` and `#fragment`
    /// removed, percent-decoded. The page computes the same thing from the
    /// `src` / `href` markdown-it emits (which percent-encodes spaces).
    static func key(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("<"), s.hasSuffix(">") {
            s = String(s.dropFirst().dropLast())
        }
        if !s.lowercased().hasPrefix("file:"), let hash = s.firstIndex(of: "#") {
            s = String(s[..<hash])
        }
        return (s.removingPercentEncoding ?? s).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static let wikilinkPattern = try! NSRegularExpression(
        pattern: #"(!?)\[\[([^\]\|#]+)(?:#[^\]\|]*)?(?:\|[^\]]*)?\]\]"#)
    private static let markdownPattern = try! NSRegularExpression(
        // The destination may hold one level of balanced parentheses (`photo(1).png`), as markdown-it reads it.
        pattern: #"(!?)\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>\n]*>|(?:[^()\s\\]|\\.|\((?:[^()\s\\]|\\.)*\))+)"#)
    private static let definitionPattern = try! NSRegularExpression(
        pattern: #"(?m)^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]*>|\S+)"#)
    private static let htmlImagePattern = try! NSRegularExpression(
        pattern: #"(?i)<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#)

    /// Every image or JSON reference in the body: `![[x.webp|600]]`,
    /// `![](a/x.png)`, `[data](x.json)`, `[[x.json]]`, `[ref]: x.png`, and
    /// `<img src="x.png">`. A remote URL is not a reference (the page loads it).
    static func references(in markdown: String) -> [Reference] {
        let ns = markdown as NSString
        let range = NSRange(location: 0, length: ns.length)
        var out: [Reference] = []
        var seen = Set<Reference>()
        func add(_ raw: String, embed: Bool) {
            let k = key(raw)
            guard !k.isEmpty, !isRemote(k), let kind = kind(ofExtension: (k as NSString).pathExtension) else { return }
            // A plain link to an image stays a link; only its embed is a picture.
            guard embed || kind == .json else { return }
            let ref = Reference(key: k, embed: embed)
            if seen.insert(ref).inserted { out.append(ref) }
        }
        func group(_ m: NSTextCheckingResult, _ i: Int) -> String? {
            let r = m.range(at: i)
            return r.location == NSNotFound ? nil : ns.substring(with: r)
        }
        for m in wikilinkPattern.matches(in: markdown, range: range) {
            if let target = group(m, 2) { add(target, embed: group(m, 1) == "!") }
        }
        for m in markdownPattern.matches(in: markdown, range: range) {
            if let target = group(m, 2) { add(target, embed: group(m, 1) == "!") }
        }
        // A definition may be used as `![x][ref]` or `[x][ref]`; either is allowed.
        for m in definitionPattern.matches(in: markdown, range: range) {
            if let target = group(m, 1) { add(target, embed: true) }
        }
        for m in htmlImagePattern.matches(in: markdown, range: range) {
            if let target = group(m, 1) ?? group(m, 2) ?? group(m, 3) { add(target, embed: true) }
        }
        return out
    }

    static func isRemote(_ key: String) -> Bool {
        guard let colon = key.range(of: #"^[a-zA-Z][a-zA-Z0-9+.-]*:"#, options: .regularExpression) else { return false }
        return key[colon].lowercased() != "file:"
    }

    /// Where the document lives, for resolving and for the containment check.
    struct Context: Equatable {
        var folder: URL
        var vaultRoot: URL?
    }

    /// The file a reference points at, or nil when it does not exist, is not an
    /// allowed type, or resolves (symlinks included) outside both the vault and
    /// the document's folder.
    static func resolve(_ key: String, in context: Context, index: VaultFileIndex? = nil) -> URL? {
        for candidate in candidates(key, in: context, attachmentFolder: index?.attachmentFolder) {
            if let url = admitted(candidate, in: context) { return url }
        }
        // Obsidian's shortest-path form: only the name (or a path tail) is written.
        guard let index, let vault = context.vaultRoot, !key.hasPrefix("/"), !key.hasPrefix("~"),
              !key.lowercased().hasPrefix("file:") else { return nil }
        for path in index.lookup(key) {
            if let url = admitted(vault.appendingPathComponent(path), in: context) { return url }
        }
        return nil
    }

    static func candidates(_ key: String, in context: Context, attachmentFolder: String?) -> [URL] {
        if key.lowercased().hasPrefix("file:") {
            guard let url = URL(string: key), url.isFileURL else {
                let path = String(key.dropFirst(5)).replacingOccurrences(of: "^/*", with: "/", options: .regularExpression)
                return [URL(fileURLWithPath: path)]
            }
            return [url]
        }
        let vault = context.vaultRoot
        if key.hasPrefix("~") {
            return [URL(fileURLWithPath: (key as NSString).expandingTildeInPath)]
        }
        if key.hasPrefix("/") {
            // Obsidian treats a leading slash as the vault root; a real absolute
            // path is tried first and still has to pass the containment check.
            var out = [URL(fileURLWithPath: key)]
            if let vault { out.append(vault.appendingPathComponent(String(key.drop { $0 == "/" }))) }
            return out
        }
        var out = [context.folder.appendingPathComponent(key)]
        if let vault {
            out.append(vault.appendingPathComponent(key))
            if let folder = attachmentFolder, !folder.isEmpty, folder != "/" {
                if folder.hasPrefix("./") {
                    out.append(context.folder.appendingPathComponent(String(folder.dropFirst(2))).appendingPathComponent(key))
                } else {
                    out.append(vault.appendingPathComponent(folder).appendingPathComponent(key))
                }
            }
        }
        return out
    }

    /// The real path of `url` when it is a regular file of an allowed type
    /// inside the vault or under the document's folder.
    static func admitted(_ url: URL, in context: Context) -> URL? {
        guard let real = realPath(url), kind(ofExtension: real.pathExtension) != nil,
              let values = try? real.resourceValues(forKeys: [.isRegularFileKey]),
              values.isRegularFile == true else { return nil }
        let roots = [context.vaultRoot, context.folder].compactMap { $0 }
        let path = real.path
        for root in roots {
            guard let base = realPath(root)?.path else { continue }
            if path.hasPrefix(base.hasSuffix("/") ? base : base + "/") { return real }
        }
        return nil
    }

    /// realpath(3): every symlink and `..` resolved, nil when the path does not exist.
    static func realPath(_ url: URL) -> URL? {
        guard let resolved = realpath(url.path, nil) else { return nil }
        defer { free(resolved) }
        return URL(fileURLWithPath: String(cString: resolved))
    }
}

/// Vault-relative paths of every image and JSON file and of every note, for Obsidian's
/// "just the file name" references (`![[shot.png]]`, `[[Plan#Heading]]`), plus the configured
/// attachment folder. A main-queue cache, refreshed in the background at most every 30 s while used.
final class VaultFileIndex {
    let root: URL
    struct Snapshot: Sendable {
        var paths: [String]
        var attachmentFolder: String?
        /// Every `.md` file, vault-relative.
        var notes: [String] = []
    }

    private var snapshot = Snapshot(paths: [], attachmentFolder: nil)
    private var builtAt: Date?
    private var loading = false
    private var completions: [() -> Void] = []
    private let scan: @Sendable (URL) -> Snapshot

    private static var shared: [String: VaultFileIndex] = [:]

    static func forVault(_ root: URL) -> VaultFileIndex {
        let key = root.standardizedFileURL.path
        if let index = shared[key] { return index }
        let index = VaultFileIndex(root: root)
        shared[key] = index
        return index
    }

    init(root: URL, scan: @escaping @Sendable (URL) -> Snapshot = VaultFileIndex.scan) {
        self.root = root
        self.scan = scan
    }

    var attachmentFolder: String? { snapshot.attachmentFolder }

    /// False until the first scan has finished: a name-only reference that misses now may still be found.
    var isReady: Bool { builtAt != nil }

    /// Whether `refreshIfNeeded` would scan again now (no scan yet, or the last one is 30 s old).
    func isStale(now: Date = Date()) -> Bool {
        guard let builtAt else { return true }
        return now.timeIntervalSince(builtAt) >= 30
    }

    /// Never reads the filesystem on the caller's queue. Concurrent requests share one scan;
    /// callbacks run on the main queue after the complete snapshot has been published.
    func refreshIfNeeded(now: Date = Date(), completion: @escaping () -> Void) {
        if !isStale(now: now) { return }
        completions.append(completion)
        guard !loading else { return }
        loading = true
        let root = root, scan = scan
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let result = scan(root)
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.snapshot = result
                self.builtAt = now
                self.loading = false
                let callbacks = self.completions
                self.completions = []
                callbacks.forEach { $0() }
            }
        }
    }

    /// Vault-relative paths whose tail matches `key`, shortest first. A lookup only reads
    /// the cache; the page requests a refresh and renders again when it is ready.
    func lookup(_ key: String) -> [String] {
        let needle = key.lowercased()
        return snapshot.paths.filter { $0.lowercased() == needle || $0.lowercased().hasSuffix("/" + needle) }
            .sorted { $0.count < $1.count }
    }

    /// Vault-relative notes a link names by file name or path tail (`Plan`, `Design/Plan`, `Plan.md`), the way
    /// Obsidian resolves `[[Plan]]` written anywhere in the vault: the note that shares the most leading folders
    /// with `folder` (vault-relative, "" for the root) first, then the shortest path. Reads only the cache.
    func notes(named key: String, near folder: String) -> [String] {
        var needle = key.lowercased()
        if !needle.hasSuffix(".md") { needle += ".md" }
        let here = folder.split(separator: "/")
        func shared(_ path: String) -> Int {
            zip(path.split(separator: "/").dropLast(), here).prefix { $0 == $1 }.count
        }
        return snapshot.notes
            .filter { $0.lowercased() == needle || $0.lowercased().hasSuffix("/" + needle) }
            .map { (path: $0, shared: shared($0)) }
            .sorted { $0.shared != $1.shared ? $0.shared > $1.shared : $0.path.count < $1.path.count }
            .map(\.path)
    }

    private static func scan(_ root: URL) -> Snapshot {
        var found: [String] = []
        var notes: [String] = []
        let attachmentFolder = readAttachmentFolder(root)
        let fm = FileManager.default
        guard let en = fm.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey],
                                     options: [.skipsHiddenFiles, .skipsPackageDescendants]) else {
            return Snapshot(paths: [], attachmentFolder: attachmentFolder)
        }
        let base = root.standardizedFileURL.path
        for case let url as URL in en {
            if url.lastPathComponent == "node_modules" {
                en.skipDescendants()
                continue
            }
            let isNote = url.pathExtension.lowercased() == "md"
            guard isNote || MarkdownMedia.kind(ofExtension: url.pathExtension) != nil else { continue }
            let path = url.standardizedFileURL.path
            guard path.hasPrefix(base + "/") else { continue }
            let relative = String(path.dropFirst(base.count + 1))
            if isNote { notes.append(relative) } else { found.append(relative) }
        }
        return Snapshot(paths: found, attachmentFolder: attachmentFolder, notes: notes)
    }

    /// `.obsidian/app.json` `attachmentFolderPath`: "/" (vault root, the
    /// default), "./" (next to the note), "./x" or "x".
    static func readAttachmentFolder(_ root: URL) -> String? {
        let file = root.appendingPathComponent(".obsidian/app.json")
        guard let data = try? Data(contentsOf: file),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let folder = object["attachmentFolderPath"] as? String else { return nil }
        return folder.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// The files one page may load, by opaque token. A token stays the same for
/// the same file across renders, so typing in split view does not reload
/// every picture.
final class MarkdownMediaRegistry {
    struct Entry {
        let url: URL
        let kind: MarkdownMedia.Kind
        /// Where the file was admitted from: every read admits it again, so a file or folder swapped
        /// for a symlink after the render never reads outside the vault under an old token.
        let context: MarkdownMedia.Context

        /// The file, still inside the vault or the document's folder and still the same real path.
        var readableURL: URL? {
            guard let again = MarkdownMedia.admitted(url, in: context), again.path == url.path else { return nil }
            return again
        }
    }

    private(set) var entries: [String: Entry] = [:]
    private var tokenByPath: [String: String] = [:]
    private var generation = 0
    private let indexForVault: (URL) -> VaultFileIndex

    init(indexForVault: @escaping (URL) -> VaultFileIndex = VaultFileIndex.forVault) {
        self.indexForVault = indexForVault
    }

    /// Resolves the document's own references and returns the page's map:
    /// key → `{kind, src|token, name}`. Tokens no longer referenced are dropped.
    func update(
        markdown: String, context: MarkdownMedia.Context?, onIndexReady: (() -> Void)? = nil
    ) -> [String: [String: String]] {
        generation += 1
        let ticket = generation
        guard let context else {
            entries = [:]
            tokenByPath = [:]
            return [:]
        }
        let references = MarkdownMedia.references(in: markdown)
        let index = context.vaultRoot.map(indexForVault)
        // A link written as a bare note name (`[[Plan#Heading]]`) is found through the same scan: start it now, so
        // the first hover or click on it already has an answer.
        if references.isEmpty, markdown.contains("[[") || markdown.contains("](") {
            index?.refreshIfNeeded {}
        }
        if !references.isEmpty, let onIndexReady {
            index?.refreshIfNeeded { [weak self] in
                guard let self, self.generation == ticket else { return }
                onIndexReady()
            }
        }
        var next: [String: Entry] = [:]
        var nextTokens: [String: String] = [:]
        var map: [String: [String: String]] = [:]
        for ref in references where map[ref.key] == nil {
            guard let url = MarkdownMedia.resolve(ref.key, in: context, index: index),
                  let kind = MarkdownMedia.kind(ofExtension: url.pathExtension) else {
                // The vault scan is still running and will render again: a miss now is no answer yet, so the page
                // draws a quiet placeholder instead of "not found" (a pending lookup never shows its negative answer).
                if let index, !index.isReady, onIndexReady != nil {
                    map[ref.key] = ["kind": "pending", "name": (ref.key as NSString).lastPathComponent]
                }
                continue
            }
            let token = nextTokens[url.path] ?? tokenByPath[url.path] ?? UUID().uuidString.lowercased()
            nextTokens[url.path] = token
            next[token] = Entry(url: url, kind: kind, context: context)
            var item = ["kind": kind.rawValue, "name": url.lastPathComponent, "token": token]
            if kind == .image {
                item["src"] = "\(MarkdownMedia.scheme)://m/\(token)"
            }
            map[ref.key] = item
        }
        entries = next
        tokenByPath = nextTokens
        return map
    }

    func entry(_ token: String) -> Entry? {
        entries[token]
    }

    /// A registered JSON file's text, or nil (unknown token, other kind, too big, not UTF-8).
    func jsonText(_ token: String) -> String? {
        guard let entry = entries[token], entry.kind == .json, let url = entry.readableURL,
              let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              size <= MarkdownMedia.maxJSONBytes,
              let data = try? Data(contentsOf: url) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

extension MarkdownMedia {
    /// Serves `gnmedia://m/<token>` for images the registry holds, and nothing else.
    final class SchemeHandler: NSObject, WKURLSchemeHandler {
        let registry: MarkdownMediaRegistry

        init(registry: MarkdownMediaRegistry) {
            self.registry = registry
        }

        func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
            guard let url = task.request.url else { return }
            guard url.host == "m", url.pathComponents.count == 2,
                  let entry = registry.entry(url.lastPathComponent), entry.kind == .image,
                  let file = entry.readableURL,
                  let mime = MarkdownMedia.imageTypes[file.pathExtension.lowercased()],
                  let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize,
                  size <= MarkdownMedia.maxImageBytes,
                  let data = try? Data(contentsOf: file) else {
                task.didFailWithError(NSError(domain: MarkdownMedia.scheme, code: 404,
                    userInfo: [NSLocalizedDescriptionKey: "not a registered image"]))
                return
            }
            var headers = ["Content-Type": mime, "Content-Length": String(data.count),
                           "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"]
            if mime == "image/svg+xml" {
                headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:"
            }
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)
                ?? URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: nil)
            task.didReceive(response)
            task.didReceive(data)
            task.didFinish()
        }

        func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
    }
}
