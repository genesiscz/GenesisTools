//
//  MarkdownDocument.swift
//  GenesisKit
//
//  One open file of the markdown window: its text, the draft, the disk watcher and the merge on a conflict.
//

import AppKit
import Combine
import SwiftUI
import UniformTypeIdentifiers


/// One open file: its text, a watcher that re-reads it after a write or an
/// atomic save (rename), and a `missing` flag once it is gone.
///
/// Editing follows the VS Code / JetBrains contract (researched 2026-09-08,
/// vault `Dev/Swift/ExternalFileChangeDetectAndMerge.md`): `text` is the disk
/// truth as last read or saved, `draft` holds unsaved edits. A clean document
/// silently follows the file. A dirty one never loses the draft: the new disk
/// content parks in `diskChange`, a save is refused until the reader picks
/// reload / keep mine / merge, and the merge is a real three-way merge with
/// `text` as the common base.
@MainActor
final class MarkdownDocument: ObservableObject, Identifiable {
    let url: URL
    @Published private(set) var text = "" {
        didSet { cachedStats = nil }
    }
    @Published private(set) var missing = false
    /// Unsaved edits. nil = nothing typed since the last load or save.
    @Published private(set) var draft: String? {
        didSet { cachedStats = nil }
    }
    /// The file as it is on disk now, when it changed under unsaved edits.
    @Published private(set) var diskChange: String?
    /// Conflict regions left in `draft` by the last merge, for the banner.
    @Published private(set) var mergeConflicts = 0
    @Published private(set) var saveError: String?
    /// File attributes as of the last read, for the status bar.
    @Published private(set) var modifiedAt: Date?
    @Published private(set) var byteSize = 0
    private var source: DispatchSourceFileSystemObject?
    /// Editors save by writing a temp file and renaming it over the old
    /// inode, and some delete first and create later. The file watcher dies
    /// with the inode, so the folder is watched too and re-arms it.
    private var folderSource: DispatchSourceFileSystemObject?

    /// The path, stored once and native (`String.nativeUTF8`): the tab bar, the selection and every lookup by id compare
    /// it, and `url.path` built a new bridged string on each read (2026-10-15: N tabs cost N² of them per tab bar pass).
    nonisolated let id: String
    let title: String

    /// A note is its bare name (`Plan.md` is "Plan"); every other file keeps its
    /// extension, so `package.json`, `sample.json` and `file.ts` stay apart from
    /// a note of the same name.
    nonisolated static func title(for url: URL) -> String {
        url.pathExtension.lowercased() == "md" ? url.deletingPathExtension().lastPathComponent : url.lastPathComponent
    }
    var folder: URL { url.deletingLastPathComponent() }

    var isDirty: Bool { draft != nil && draft != text }
    var hasDiskChange: Bool { diskChange != nil }
    /// What the editor and the preview show: the draft while there is one.
    var displayText: String { draft ?? text }

    /// Word count and reading time of `displayText`. Counted once per text
    /// change: the status bar re-renders on every scroll-spy and find update
    /// of the model, and counting walks the whole document.
    var stats: MarkdownStats {
        if let cachedStats { return cachedStats }
        let fresh = MarkdownStats.of(displayText)
        cachedStats = fresh
        return fresh
    }

    private var cachedStats: MarkdownStats?

    func edit(_ new: String) {
        draft = new
        if new == text, diskChange == nil { draft = nil }
    }

    enum SaveOutcome: Equatable {
        case saved
        case nothingToSave
        /// The file changed on disk under the draft: resolve first.
        case blockedByDiskChange
        case failed(String)
    }

    /// Writes the draft. Refused while `diskChange` is set, so an external
    /// edit is never overwritten without the reader deciding.
    @discardableResult
    func save() -> SaveOutcome {
        guard let draft, draft != text else { return .nothingToSave }
        if diskChange != nil { return .blockedByDiskChange }
        // The watcher reports on the main queue, so an external write can
        // land after the last callback and before this save. Read the file
        // again rather than trusting `diskChange` alone. A missing file is
        // fine (the save recreates it); one that exists but cannot be read is not.
        if let onDisk = try? String(contentsOf: url, encoding: .utf8) {
            if onDisk != text {
                diskChange = onDisk
                return .blockedByDiskChange
            }
        } else if FileManager.default.fileExists(atPath: url.path) {
            let message = "The file on disk could not be read, so it was not overwritten."
            saveError = message
            return .failed(message)
        }
        do {
            try draft.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            saveError = error.localizedDescription
            return .failed(error.localizedDescription)
        }
        saveError = nil
        missing = false
        text = draft
        MarkdownVaultSuggestions.shared.forget()
        self.draft = nil
        mergeConflicts = 0
        readAttributes()
        return .saved
    }

    /// Drop the draft and show the file as it is on disk.
    func takeDisk() {
        guard let disk = diskChange else { return }
        text = disk
        draft = nil
        diskChange = nil
        mergeConflicts = 0
    }

    /// Throw the draft away (conflict markers included) and show the file as
    /// it is on disk now. Unlike `reload`, which only follows the watcher,
    /// this works after a merge too, when `text` already equals the disk.
    func discardDraft() {
        draft = nil
        diskChange = nil
        mergeConflicts = 0
        reload()
    }

    /// Keep the draft and let the next save overwrite the disk version.
    func keepMine() {
        guard let disk = diskChange else { return }
        text = disk
        diskChange = nil
    }

    /// Three-way merge: the last loaded text is the base, the draft is ours,
    /// the disk is theirs. Clean regions combine; conflicts land in the draft
    /// as `<<<<<<< mine` / `>>>>>>> on disk` blocks to resolve by hand.
    @discardableResult
    func mergeDiskChange() -> Int {
        guard let disk = diskChange, let mine = draft else { return 0 }
        let result = TextMerge.merge(base: text, ours: mine, theirs: disk)
        draft = result.text(trailingNewline: Self.mergedTrailingNewline(base: text, ours: mine, theirs: disk))
        text = disk
        diskChange = nil
        mergeConflicts = result.conflictCount
        return result.conflictCount
    }

    /// The end-of-file newline is merged like a line: a side that changed it
    /// against the base wins, so removing it in the draft is not undone by an
    /// unrelated disk edit that still ends in one.
    static func mergedTrailingNewline(base: String, ours: String, theirs: String) -> Bool {
        let b = base.hasSuffix("\n")
        let o = ours.hasSuffix("\n")
        return o != b ? o : theirs.hasSuffix("\n")
    }

    /// Mine versus disk, for the compare view.
    var diskDiff: [TextMerge.DiffLine] {
        TextMerge.diff(old: diskChange ?? text, new: draft ?? text)
    }

    init(url: URL) {
        self.url = url
        id = url.path.nativeUTF8
        title = Self.title(for: url).nativeUTF8
        reload()
        watch()
        watchFolder()
    }

    deinit {
        source?.cancel()
        folderSource?.cancel()
    }

    func reload() {
        guard let loaded = try? String(contentsOf: url, encoding: .utf8) else {
            missing = true
            return
        }
        missing = false
        readAttributes()
        // The app's own save, or a touch without a content change: nothing
        // to report. Content, not mtime, is what tells an own write from an
        // external one. A change parked earlier is gone from disk again (the
        // other editor went back to the base), so it is dropped too.
        if loaded == text {
            diskChange = nil
            return
        }
        if isDirty {
            diskChange = loaded
        } else {
            text = loaded
            draft = nil
            diskChange = nil
        }
    }

    private func readAttributes() {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        modifiedAt = attrs?[.modificationDate] as? Date
        byteSize = (attrs?[.size] as? NSNumber)?.intValue ?? text.utf8.count
    }

    private func watch() {
        source?.cancel()
        source = nil
        let fd = open(url.path, O_EVTONLY)
        guard fd >= 0 else { return }
        let src = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .extend, .rename, .delete, .attrib],
            queue: .main
        )
        src.setEventHandler { [weak self] in
            guard let self else { return }
            let flags = self.source?.data ?? []
            self.reload()
            if flags.contains(.rename) || flags.contains(.delete) {
                // The descriptor now points at the dead inode. Drop it; the
                // folder watcher re-arms once the path exists again.
                self.source?.cancel()
                self.source = nil
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
                    self?.rearmIfNeeded()
                }
            }
        }
        src.setCancelHandler { close(fd) }
        src.resume()
        source = src
    }

    private func watchFolder() {
        let fd = open(folder.path, O_EVTONLY)
        guard fd >= 0 else { return }
        let src = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write], queue: .main)
        src.setEventHandler { [weak self] in self?.rearmIfNeeded() }
        src.setCancelHandler { close(fd) }
        src.resume()
        folderSource = src
    }

    /// A directory entry changed: if our file is back (or new) and unwatched,
    /// watch it again and read it.
    private func rearmIfNeeded() {
        guard source == nil, FileManager.default.fileExists(atPath: url.path) else { return }
        watch()
        reload()
    }
}
