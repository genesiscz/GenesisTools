//
//  MarkdownDocumentLinks.swift
//  GenesisKit
//
//  What a click inside a rendered document points at: relative links, wikilinks, file links with lines.
//

import AppKit
import Combine
import SwiftUI
import UniformTypeIdentifiers

/// Resolves what a click inside a rendered document points at: a relative link
/// against the file's folder, a wikilink against the folder, the vault root, and then
/// by note name anywhere in the vault (Obsidian's shortest-path form).
public enum MarkdownDocumentLinks {
    /// The vault's shared file index, for links that name a note only by its name.
    static func vaultIndex(_ vaultRoot: String?) -> VaultFileIndex? {
        guard let vaultRoot, !vaultRoot.isEmpty else { return nil }
        return VaultFileIndex.forVault(URL(fileURLWithPath: (vaultRoot as NSString).expandingTildeInPath))
    }

    /// The heading a link points at: `Note#Heading` → "Heading", none → nil.
    /// A `#page=2` style fragment on a non-markdown file is left to its app.
    static func fragment(of ref: String) -> String? {
        guard let hash = ref.firstIndex(of: "#") else { return nil }
        let fragment = ref[ref.index(after: hash)...].trimmingCharacters(in: .whitespacesAndNewlines)
        return fragment.isEmpty ? nil : fragment
    }

    /// The first line of a line fragment: `L147`, `L147-L190` and `147-190` give 147.
    static func lineNumber(_ fragment: String?) -> Int? {
        MarkdownLineRange.parse(fragment)?.first
    }

    static func resolve(
        _ ref: String,
        folder: URL,
        vaultRoot: String?,
        index: VaultFileIndex? = nil,
        exists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
    ) -> URL? {
        var target = ref.trimmingCharacters(in: .whitespacesAndNewlines)
        if let hash = target.firstIndex(of: "#") {
            target = String(target[..<hash])
        }
        target = target.removingPercentEncoding ?? target
        if target.hasPrefix("<"), target.hasSuffix(">") {
            target = String(target.dropFirst().dropLast())
        }
        target = target.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !target.isEmpty else { return nil }

        if target.hasPrefix("/") || target.hasPrefix("~") {
            let path = (target as NSString).expandingTildeInPath
            return exists(path) ? URL(fileURLWithPath: path) : nil
        }

        var roots = [folder]
        if let vaultRoot, !vaultRoot.isEmpty {
            roots.append(URL(fileURLWithPath: vaultRoot))
        }
        // A bare note may have a nearer match outside this folder. Wait for the index before
        // accepting a vault-root match, then rank all indexed candidates together.
        let ext = (target as NSString).pathExtension.lowercased()
        if !target.contains("/"), let index {
            let local = folder.appendingPathComponent(target).standardizedFileURL
            if exists(local.path) { return local }
            if ext != "md" {
                let md = folder.appendingPathComponent("\(target).md").standardizedFileURL
                if exists(md.path) { return md }
            }
            // Keep a literal non-note file at the root ahead of note-name lookup.
            if ext != "md", let vaultRoot {
                let literal = URL(fileURLWithPath: vaultRoot).appendingPathComponent(target).standardizedFileURL
                if exists(literal.path) { return literal }
            }
            guard index.isReady else { return nil }
            let near = index.relativeFolder(folder)
            for path in index.notes(named: target, near: near) {
                let url = index.root.appendingPathComponent(path).standardizedFileURL
                if exists(url.path) { return url }
            }
        }
        for root in roots {
            let direct = root.appendingPathComponent(target).standardizedFileURL
            if exists(direct.path) { return direct }
            if direct.pathExtension.lowercased() != "md" {
                let md = root.appendingPathComponent("\(target).md").standardizedFileURL
                if exists(md.path) { return md }
            }
        }
        // `[[Overview]]` in `Project/Design/Figma.md` names `Project/Overview.md`: Obsidian finds a note by its
        // name (or a path tail) anywhere in the vault, the nearest one first.
        guard let index, !target.hasPrefix("../"), !target.hasPrefix("./") else { return nil }
        let near = index.relativeFolder(folder)
        for path in index.notes(named: target, near: near) {
            let url = index.root.appendingPathComponent(path).standardizedFileURL
            if exists(url.path) { return url }
        }
        return nil
    }

    /// An editor-style line suffix: `file.go:20`, `file.go:20-37`, `file.go:L20-L37`, and
    /// `file.go:20:5` (the column is dropped). Gives the path and the lines as a fragment the
    /// line parser takes, or nil when the text ends in no line.
    static func lineSuffix(_ target: String) -> (path: String, fragment: String)? {
        let pattern = #"^(.+?):(L?\d+(?:-L?\d+)?)(?::\d+)?$"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let match = regex.firstMatch(in: target, range: NSRange(target.startIndex..., in: target)),
              let path = Range(match.range(at: 1), in: target),
              let lines = Range(match.range(at: 2), in: target),
              MarkdownLineRange.parse(String(target[lines])) != nil
        else { return nil }
        return (String(target[path]), String(target[lines]))
    }

    /// The file a link names and its fragment, for every form a note uses: no fragment,
    /// `#L20`, `#L20-L37`, `#L20-37`, `#Heading`, `:20` and `:20-37`. A file whose real name
    /// ends in `:20` wins over the line reading.
    static func locate(
        _ ref: String,
        folder: URL,
        vaultRoot: String?,
        index: VaultFileIndex? = nil,
        exists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
    ) -> (url: URL, fragment: String?)? {
        let fragment = fragment(of: ref)
        if let url = resolve(ref, folder: folder, vaultRoot: vaultRoot, index: index, exists: exists) {
            return (url, fragment)
        }
        guard fragment == nil, let suffix = lineSuffix(ref.trimmingCharacters(in: .whitespacesAndNewlines)),
              let url = resolve(suffix.path, folder: folder, vaultRoot: vaultRoot, index: index, exists: exists)
        else { return nil }
        return (url, suffix.fragment)
    }

    /// Whether "Open in <default app>" may be offered for a file a note links to. A document
    /// (`isDocument`) may. So may a type no app declares (`.go` on a Mac without Go tooling is
    /// `dyn.…`), as long as the file is not executable: Launch Services treats it as data.
    /// Scripts and executables are still refused, unless the app is a code editor (`opensAtLine`),
    /// which shows a file and never runs it.
    static func mayOpenWithDefaultApp(_ url: URL, app: DefaultApp) -> Bool {
        if app.opensAtLine || isDocument(url) { return true }
        guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isExecutableKey, .contentTypeKey]),
              values.isRegularFile == true, values.isExecutable != true, let type = values.contentType
        else { return false }
        return type.isDynamic && !type.conforms(to: .executable) && !type.conforms(to: .script)
    }

    /// `https://…`, `ssh://…`, `vnc://…`: a URL, never a path in the vault.
    static func hasScheme(_ ref: String) -> Bool {
        ref.range(of: #"^[a-zA-Z][a-zA-Z0-9+.-]*://"#, options: .regularExpression) != nil
    }

    /// A `file:` link's decoded path and fragment, kept apart: a `#` in a file
    /// name arrives as `%23` and belongs to the path. nil for anything else.
    static func fileParts(_ ref: String) -> (path: String, fragment: String?)? {
        guard ref.lowercased().hasPrefix("file:"), let url = URL(string: ref), url.isFileURL,
              !url.path.isEmpty else { return nil }
        let fragment = url.fragment(percentEncoded: false)
        return (url.path, fragment?.isEmpty == false ? fragment : nil)
    }

    /// A `file:` link as the path (plus its `#fragment`) the resolver takes,
    /// or nil for anything else. `resolve` cuts at the first `#` and then
    /// percent-decodes, so a `#` or `%` in the file name goes back encoded.
    public static func filePath(_ ref: String) -> String? {
        guard let parts = fileParts(ref) else { return nil }
        let path = parts.path.replacingOccurrences(of: "%", with: "%25").replacingOccurrences(of: "#", with: "%23")
        guard let fragment = parts.fragment else { return path }
        return "\(path)#\(fragment)"
    }

    /// Whether a local link target may go to its default app. A note is
    /// untrusted, so only a document may: a regular file whose type is content
    /// (text, PDF, image, media, an office file). An app or any other bundle,
    /// a folder, an executable, a script (`.command`, `.sh`, AppleScript),
    /// Terminal settings, a location file (`.webloc`, `.fileloc`) and an
    /// archive or installer are refused, so one click cannot launch anything.
    static func isDocument(_ url: URL) -> Bool {
        guard url.isFileURL,
              let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .contentTypeKey]),
              values.isRegularFile == true, let type = values.contentType else { return false }
        return type.conforms(to: .content) && !type.conforms(to: .executable) && !type.conforms(to: .script)
    }

    /// Where a `file:` link in a vault note goes (Knowledge's native preview sends these).
    public enum FileLinkTarget: Equatable, Sendable {
        /// A note inside the vault: its vault-relative path, opened in place.
        case note(path: String, fragment: String?)
        /// Anything `isDocument` accepts, for its default app.
        case document(URL)
    }

    /// nil for a link that is not `file:`, and for apps, scripts and folders.
    public static func fileLinkTarget(_ ref: String, vaultRoot: String?) -> FileLinkTarget? {
        guard let parts = fileParts(ref) else { return nil }
        let url = URL(fileURLWithPath: parts.path).standardizedFileURL
        if url.pathExtension.lowercased() == "md", let vaultRoot {
            let root = URL(fileURLWithPath: vaultRoot).standardizedFileURL.path + "/"
            if url.path.hasPrefix(root) {
                return .note(path: String(url.path.dropFirst(root.count)), fragment: parts.fragment)
            }
        }
        return isDocument(url) ? .document(url) : nil
    }
}
