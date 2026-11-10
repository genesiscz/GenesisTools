import Foundation
import SwiftUI

/// The folders a typed path can complete to. `~` is the home folder; the part after the last `/` is the start of a
/// folder's name; hidden folders show only once the typed name starts with a dot. A folder this app may not read is a
/// failure with its sentence, never an empty list.
public enum FolderCompletion {
    /// The folder to list, the start of the name typed in it, and the typed path up to that name (kept as typed, so
    /// `~/` stays `~/`).
    public struct Typed: Equatable, Sendable {
        public let folder: String
        public let prefix: String
        public let typedParent: String
    }

    public static func split(_ typed: String, home: String = NSHomeDirectory()) -> Typed {
        let text = typed.isEmpty ? "~/" : (typed == "~" ? "~/" : typed)
        guard let slash = text.lastIndex(of: "/") else {
            // A bare name: a folder of the home folder.
            return Typed(folder: home, prefix: text, typedParent: "~/")
        }
        let parent = String(text[...slash])
        let prefix = String(text[text.index(after: slash)...])
        return Typed(folder: expand(parent, home: home), prefix: prefix, typedParent: parent)
    }

    /// `~` and `~/…` under the home folder; a path without a leading slash under the home folder too.
    public static func expand(_ path: String, home: String = NSHomeDirectory()) -> String {
        if path == "~" { return home }
        if path.hasPrefix("~/") { return home + "/" + path.dropFirst(2) }
        if path.hasPrefix("/") { return path }
        return home + "/" + path
    }

    /// The typed path as an absolute folder, without a trailing slash (but `/` itself).
    public static func absolute(_ typed: String, home: String = NSHomeDirectory()) -> String {
        let path = expand(typed.trimmingCharacters(in: .whitespaces), home: home)
        return path.count > 1 && path.hasSuffix("/") ? String(path.dropLast()) : path
    }

    /// The folders `typed` can complete to, each titled as the user would type it ("~/Documents").
    public static func folders(for typed: String, home: String = NSHomeDirectory(),
                               fileManager: FileManager = .default) throws -> [AutocompleteValue] {
        let parts = split(typed, home: home)
        var isFolder: ObjCBool = false
        guard fileManager.fileExists(atPath: parts.folder, isDirectory: &isFolder), isFolder.boolValue else { return [] }
        let names: [String]
        do {
            names = try fileManager.contentsOfDirectory(atPath: parts.folder)
        } catch {
            throw failure(error, folder: parts.folder, typed: parts.typedParent)
        }
        let showHidden = parts.prefix.hasPrefix(".")
        let base = URL(fileURLWithPath: parts.folder, isDirectory: true)
        let prefix = AutocompleteMatch.fold(parts.prefix)
        return names
            .filter { showHidden || !$0.hasPrefix(".") }
            .filter { prefix.isEmpty || AutocompleteMatch.fold($0).hasPrefix(prefix) }
            .filter { name in
                let url = base.appendingPathComponent(name)
                let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isPackageKey])
                if values?.isPackage == true { return false }
                if values?.isDirectory == true { return true }
                // A link to a folder.
                var linked: ObjCBool = false
                return fileManager.fileExists(atPath: url.path, isDirectory: &linked) && linked.boolValue
            }
            .sorted { $0.localizedStandardCompare($1) == .orderedAscending }
            .map { AutocompleteValue(parts.typedParent + $0, symbol: "folder") }
    }

    /// A read that failed, in words: a folder macOS keeps from this app says so.
    static func failure(_ error: Error, folder: String, typed: String) -> AutocompleteFailure {
        let name = typed == "~/" ? "your home folder" : "“\((folder as NSString).lastPathComponent)”"
        let ns = error as NSError
        let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError
        let denied = ns.code == NSFileReadNoPermissionError
            || (underlying?.domain == NSPOSIXErrorDomain && [Int(EPERM), Int(EACCES)].contains(underlying?.code ?? 0))
        if denied {
            return AutocompleteFailure("macOS does not let this app read \(name). Allow it in System Settings → Privacy & Security, or pick the folder in a folder panel.")
        }
        return AutocompleteFailure("The folders in \(name) could not be read: \(ns.localizedDescription)")
    }
}

/// A field that completes folders of the file system from a typed path, built on `AutocompleteField` with `search`.
/// Tab on a row fills the field with that folder and a `/`, so its own folders come up next; Return or a click on a
/// row takes it, and Return with no row marked takes the typed path (free text: a folder that does not exist yet).
/// `onChoose` gets the absolute path.
public struct AutocompleteFolderField: View {
    @Binding private var text: String
    private let placeholder: String
    private let label: String?
    private let identifier: String?
    private let preview: AutocompletePreview?
    private let home: String
    private let onChoose: (String) -> Void

    public init(_ placeholder: String = "A folder, ~/ for home", text: Binding<String>, label: String? = nil,
                identifier: String? = nil, home: String = NSHomeDirectory(), preview: AutocompletePreview? = nil,
                onChoose: @escaping (String) -> Void) {
        _text = text
        self.placeholder = placeholder
        self.label = label
        self.identifier = identifier
        self.home = home
        self.preview = preview
        self.onChoose = onChoose
    }

    public var body: some View {
        let home = home
        // A picture has no keyboard and no time for a search: it lists the folders at once.
        let source: AutocompleteSource<AutocompleteValue> = preview != nil
            ? .items((try? FolderCompletion.folders(for: text, home: home)) ?? [])
            : .search { typed in
                try Task.checkCancellation()
                return try FolderCompletion.folders(for: typed, home: home)
            }
        AutocompleteField<AutocompleteValue>(
            placeholder, text: $text, source: source,
            allowsFreeText: true, label: label, identifier: identifier, preview: preview
        ) { choice in
            if choice.key == .tab, let item = choice.item {
                text = item.title + "/"
                return
            }
            let path = FolderCompletion.absolute(choice.item?.title ?? choice.text, home: home)
            text = choice.item?.title ?? choice.text
            onChoose(path)
        }
    }
}
