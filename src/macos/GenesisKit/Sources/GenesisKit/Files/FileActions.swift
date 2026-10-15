//
//  FileActions.swift
//
//  Finder's file verbs for a sidebar or a tab: open, show in Finder, copy the path, rename, duplicate,
//  move to the Trash, and a new file or folder. Deleting is always a move to the Trash, which Finder's
//  "Put Back" undoes. Creating never replaces anything that is already there.
//

import AppKit
import SwiftUI

/// What a file verb did, for the host to follow (retitle a tab, close a trashed file's tab, open a new file).
public enum FileChange: Equatable, Sendable {
    case renamed(from: URL, to: URL)
    case duplicated(original: URL, copy: URL)
    case trashed(URL)
    /// A new empty file or folder (New File… / New Folder…).
    case created(URL)
}

public enum FileOperations {
    /// Why `name` cannot be a new file name in `folder`, or nil when it can.
    public static func problem(renaming url: URL, to name: String) -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if let problem = nameProblem(trimmed) {
            return problem
        }
        let target = url.deletingLastPathComponent().appendingPathComponent(trimmed)
        if target.path != url.path, FileManager.default.fileExists(atPath: target.path), !sameFile(url, target) {
            return "\"\(trimmed)\" already exists in this folder."
        }
        return nil
    }

    /// Why `name` cannot name a new item in `folder`, or nil when it can. An existing name is refused
    /// (on a case-insensitive volume `notes.md` is taken by `Notes.md` too): creating never replaces.
    public static func problem(creating name: String, in folder: URL) -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if let problem = nameProblem(trimmed) {
            return problem
        }
        if FileManager.default.fileExists(atPath: folder.appendingPathComponent(trimmed).path) {
            return "\"\(trimmed)\" already exists in \(folder.lastPathComponent). Choose another name."
        }
        return nil
    }

    /// The rules every name follows, wherever it goes.
    static func nameProblem(_ trimmed: String) -> String? {
        if trimmed.isEmpty {
            return "A name cannot be empty."
        }
        if trimmed.contains("/") || trimmed.contains(":") {
            return "A name cannot contain / or :."
        }
        if trimmed == "." || trimmed == ".." {
            return "That name is reserved."
        }
        return nil
    }

    /// True when both URLs reach one file: `Note.md` and `note.md` on a case-insensitive volume.
    static func sameFile(_ a: URL, _ b: URL) -> Bool {
        let key: Set<URLResourceKey> = [.fileResourceIdentifierKey]
        guard let first = try? a.resourceValues(forKeys: key).fileResourceIdentifier,
              let second = try? b.resourceValues(forKeys: key).fileResourceIdentifier
        else { return false }
        return first.isEqual(second)
    }

    /// Finder's naming: `Note copy.md`, then `Note copy 2.md`, and so on.
    public static func duplicateURL(for url: URL) -> URL {
        let folder = url.deletingLastPathComponent()
        let ext = url.pathExtension
        let base = url.deletingPathExtension().lastPathComponent
        func candidate(_ index: Int) -> URL {
            let name = index == 1 ? "\(base) copy" : "\(base) copy \(index)"
            return folder.appendingPathComponent(ext.isEmpty ? name : "\(name).\(ext)")
        }
        var index = 1
        while FileManager.default.fileExists(atPath: candidate(index).path) {
            index += 1
        }
        return candidate(index)
    }

    /// What New File… and New Folder… suggest.
    public static func defaultName(for kind: PathKind) -> String {
        kind == .file ? "Untitled.md" : "Untitled Folder"
    }

    /// `name` when it is free in `folder`, else `Untitled 2.md`, `Untitled 3.md`, …: the suggestion is
    /// never a name the prompt would refuse.
    public static func freeName(_ name: String, in folder: URL) -> String {
        let ext = (name as NSString).pathExtension
        let stem = (name as NSString).deletingPathExtension
        var candidate = name
        var index = 2
        while FileManager.default.fileExists(atPath: folder.appendingPathComponent(candidate).path) {
            candidate = ext.isEmpty ? "\(stem) \(index)" : "\(stem) \(index).\(ext)"
            index += 1
        }
        return candidate
    }

    /// An empty file or a folder named `name` in `folder`. Throws when the name is taken: it never
    /// replaces a file or merges into a folder.
    public static func create(_ kind: PathKind, named name: String, in folder: URL) throws -> URL {
        let target = folder.appendingPathComponent(name.trimmingCharacters(in: .whitespacesAndNewlines))
        switch kind {
        case .file:
            try Data().write(to: target, options: .withoutOverwriting)
        case .folder:
            try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false)
        }
        return target.standardizedFileURL
    }

    public static func rename(_ url: URL, to name: String) throws -> URL {
        let target = url.deletingLastPathComponent().appendingPathComponent(name.trimmingCharacters(in: .whitespacesAndNewlines))
        try FileManager.default.moveItem(at: url, to: target)
        return target
    }

    public static func duplicate(_ url: URL) throws -> URL {
        let target = duplicateURL(for: url)
        try FileManager.default.copyItem(at: url, to: target)
        return target
    }

    public static func trash(_ url: URL) throws {
        try FileManager.default.trashItem(at: url, resultingItemURL: nil)
    }

    /// Asks for a new name with the current one selected up to its extension, as Finder does.
    @MainActor
    public static func promptRename(_ url: URL) -> String? {
        promptName(title: "Rename \"\(url.lastPathComponent)\"", detail: nil, initial: url.lastPathComponent, button: "Rename")
    }

    /// An alert with a name field. `initial` is selected up to its extension, so typing replaces the
    /// stem and keeps `.md`. `detail` says why the last name was refused. nil when cancelled.
    @MainActor
    public static func promptName(title: String, detail: String?, initial: String, button: String) -> String? {
        let alert = NSAlert()
        alert.messageText = title
        if let detail {
            alert.informativeText = detail
            alert.alertStyle = .warning
        }
        alert.addButton(withTitle: button)
        alert.addButton(withTitle: "Cancel")
        let field = NSTextField(string: initial)
        field.frame = NSRect(x: 0, y: 0, width: 300, height: 24)
        field.setAccessibilityLabel("Name")
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        let stem = (initial as NSString).deletingPathExtension
        DispatchQueue.main.async {
            field.currentEditor()?.selectedRange = NSRange(location: 0, length: (stem as NSString).length)
        }
        guard alert.runModal() == .alertFirstButtonReturn else { return nil }
        return field.stringValue
    }

    @MainActor
    static func report(_ message: String) {
        let alert = NSAlert()
        alert.messageText = message
        alert.alertStyle = .warning
        alert.runModal()
    }

    // MARK: The verbs, as a menu runs them

    /// New File… / New Folder…: asks for a name (a free `Untitled.md` suggested), asks again with the
    /// reason while the name is taken or invalid, creates it, and hands the new URL to `created`.
    @MainActor
    public static func runCreate(_ kind: PathKind, in folder: URL, created: (URL) -> Void) {
        let what = kind == .file ? "file" : "folder"
        var name = freeName(defaultName(for: kind), in: folder)
        var refused: String?
        while true {
            guard let typed = promptName(
                title: "New \(what) in \"\(folder.lastPathComponent)\"",
                detail: refused,
                initial: name,
                button: "Create"
            ) else { return }

            name = typed
            if let problem = problem(creating: typed, in: folder) {
                refused = problem
                continue
            }

            do {
                let url = try create(kind, named: typed, in: folder)
                GenesisKit.log("file.create \(what) \(url.path)")
                created(url)
            } catch {
                report("Could not create the \(what): \(error.localizedDescription)")
            }
            return
        }
    }

    /// Rename…: refused first by `guardChange` (unsaved edits), then a name prompt.
    @MainActor
    public static func runRename(_ url: URL, guardChange: ((URL) -> String?)?, changed: (FileChange) -> Void) {
        if let reason = guardChange?(url) {
            report(reason)
            return
        }
        guard let name = promptRename(url), name != url.lastPathComponent else { return }
        if let problem = problem(renaming: url, to: name) {
            report(problem)
            return
        }
        do {
            let renamed = try rename(url, to: name)
            changed(.renamed(from: url, to: renamed))
        } catch {
            report("Could not rename: \(error.localizedDescription)")
        }
    }

    /// Duplicate. The copy runs off the main thread: a large folder or package would freeze the app for its length.
    @MainActor
    public static func runDuplicate(_ url: URL, changed: @escaping (FileChange) -> Void) {
        Task.detached(priority: .userInitiated) {
            let result = Result { try FileOperations.duplicate(url) }
            await MainActor.run {
                switch result {
                case .success(let copy):
                    changed(.duplicated(original: url, copy: copy))
                case .failure(let error):
                    FileOperations.report("Could not duplicate: \(error.localizedDescription)")
                }
            }
        }
    }

    /// Move to Trash: refused first by `guardChange` (unsaved edits).
    @MainActor
    public static func runTrash(_ url: URL, guardChange: ((URL) -> String?)?, changed: (FileChange) -> Void) {
        if let reason = guardChange?(url) {
            report(reason)
            return
        }
        do {
            try trash(url)
            changed(.trashed(url))
        } catch {
            report("Could not move to the Trash: \(error.localizedDescription)")
        }
    }
}

/// The context menu of a file or folder, Finder's order. `changed` hears what a verb did.
/// `guardChange` may refuse a rename or a trash first (a tab with unsaved edits) with a reason.
/// A host that picks its own verbs uses `PathActionsMenu(url:kind:actions:handlers:)` instead.
public struct FileItemMenu: View {
    let url: URL
    let isFolder: Bool
    let open: (() -> Void)?
    let setRoot: (() -> Void)?
    let guardChange: ((URL) -> String?)?
    let changed: (FileChange) -> Void

    public init(
        url: URL,
        isFolder: Bool,
        open: (() -> Void)? = nil,
        setRoot: (() -> Void)? = nil,
        guardChange: ((URL) -> String?)? = nil,
        changed: @escaping (FileChange) -> Void
    ) {
        self.url = url
        self.isFolder = isFolder
        self.open = open
        self.setRoot = setRoot
        self.guardChange = guardChange
        self.changed = changed
    }

    public var body: some View {
        if let open {
            Button(isFolder ? "Open Folder" : "Open") { open() }
        }
        if let setRoot {
            Button("Show as Root") { setRoot() }
        }
        Button(isFolder ? "Open in Finder" : "Open with Default App") {
            isFolder ? PathOpener.finder(url.path) : PathOpener.open(url.path)
        }
        Button("Show in Finder") { PathOpener.reveal(url.path) }
        Divider()
        Button("Copy Path") { PathOpener.copy(url.path, what: "path") }
        Button("Copy Name") { PathOpener.copy(url.lastPathComponent, what: "name") }
        Divider()
        Button("Rename…") { FileOperations.runRename(url, guardChange: guardChange, changed: changed) }
        Button("Duplicate") { FileOperations.runDuplicate(url, changed: changed) }
        Divider()
        Button("Move to Trash") { FileOperations.runTrash(url, guardChange: guardChange, changed: changed) }
    }
}
