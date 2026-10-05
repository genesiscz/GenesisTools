//
//  FileActions.swift
//
//  Finder's file verbs for a sidebar or a tab: open, show in Finder, copy the path, rename, duplicate
//  and move to the Trash. Deleting is always a move to the Trash, which Finder's "Put Back" undoes.
//

import AppKit
import SwiftUI

/// What a file verb did, for the host to follow (retitle a tab, close a trashed file's tab).
public enum FileChange: Equatable, Sendable {
    case renamed(from: URL, to: URL)
    case duplicated(original: URL, copy: URL)
    case trashed(URL)
}

public enum FileOperations {
    /// Why `name` cannot be a new file name in `folder`, or nil when it can.
    public static func problem(renaming url: URL, to name: String) -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return "A name cannot be empty."
        }
        if trimmed.contains("/") || trimmed.contains(":") {
            return "A name cannot contain / or :."
        }
        if trimmed == "." || trimmed == ".." {
            return "That name is reserved."
        }
        let target = url.deletingLastPathComponent().appendingPathComponent(trimmed)
        if target.path != url.path, FileManager.default.fileExists(atPath: target.path), !sameFile(url, target) {
            return "\"\(trimmed)\" already exists in this folder."
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
        let alert = NSAlert()
        alert.messageText = "Rename \"\(url.lastPathComponent)\""
        alert.addButton(withTitle: "Rename")
        alert.addButton(withTitle: "Cancel")
        let field = NSTextField(string: url.lastPathComponent)
        field.frame = NSRect(x: 0, y: 0, width: 300, height: 24)
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        let stem = (url.lastPathComponent as NSString).deletingPathExtension
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
}

/// The context menu of a file or folder, Finder's order. `changed` hears what a verb did.
/// `guardChange` may refuse a rename or a trash first (a tab with unsaved edits) with a reason.
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
        Button("Rename…") { rename() }
        Button("Duplicate") { duplicate() }
        Divider()
        Button("Move to Trash") { trash() }
    }

    @MainActor
    private func rename() {
        if let reason = guardChange?(url) {
            FileOperations.report(reason)
            return
        }
        guard let name = FileOperations.promptRename(url), name != url.lastPathComponent else { return }
        if let problem = FileOperations.problem(renaming: url, to: name) {
            FileOperations.report(problem)
            return
        }
        do {
            let renamed = try FileOperations.rename(url, to: name)
            changed(.renamed(from: url, to: renamed))
        } catch {
            FileOperations.report("Could not rename: \(error.localizedDescription)")
        }
    }

    /// The copy runs off the main thread: a large folder or package would freeze the app for its length.
    @MainActor
    private func duplicate() {
        let url = url
        let changed = changed
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

    @MainActor
    private func trash() {
        if let reason = guardChange?(url) {
            FileOperations.report(reason)
            return
        }
        do {
            try FileOperations.trash(url)
            changed(.trashed(url))
        } catch {
            FileOperations.report("Could not move to the Trash: \(error.localizedDescription)")
        }
    }
}
