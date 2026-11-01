//
//  MarkdownTaskFile.swift
//  GenesisKit
//
//  A task box click written into the note on disk: the file read again, the item found by its line or its text, one
//  byte changed, and the result put in place atomically. Runs off the main thread.
//

import Darwin
import Foundation

/// Replaces a file's bytes in one step. The new bytes go to a temporary file in the same folder (created `O_EXCL`,
/// so nothing else can hold it), which takes the original's permissions, ACL and extended attributes, is synced to
/// disk, and is then put in the original's place. A reader sees the old file or the new one, never a torn one.
enum MarkdownAtomicWrite {
    enum Failure: Error, Equatable {
        /// The file no longer has the bytes the new content was made from.
        case changed
        /// A system call failed: what it was doing and `errno`.
        case system(String, Int32)

        var message: String {
            switch self {
            case .changed: "the file changed while it was written"
            case .system(let step, let code): "\(step): \(String(cString: strerror(code)))"
            }
        }
    }

    /// Writes `data` over `url`. A symlink is followed, so the note it points at changes and the link stays.
    ///
    /// `expected` is the content `data` was made from. The new file is swapped into place (`RENAME_SWAP`), and the
    /// file that comes out is checked AFTER the swap: one that no longer has `expected` goes back (`.changed`). So a
    /// write that landed before the swap is kept, whether it went into the file or was a new file renamed over it,
    /// and a write after the swap replaces this one. Apps that use file coordination wait for this write. What no
    /// check can see: a program that opened the old file before the swap and writes into it after the check; that
    /// needs the writer's cooperation. A volume that cannot swap gets the check right before a plain rename.
    ///
    /// `beforePlacing` runs between the check and the placement; a test writes there as another program would.
    static func replace(_ url: URL, with data: [UInt8], expected: [UInt8]?, beforePlacing: () -> Void = {}) throws {
        let target = url.resolvingSymlinksInPath()
        var coordination: NSError?
        var outcome: Result<Void, Error> = .success(())
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: target, options: .forReplacing,
                                                         error: &coordination) { granted in
            outcome = Result { try write(data, over: granted, expected: expected, beforePlacing: beforePlacing) }
        }
        if let coordination { throw coordination }
        try outcome.get()
    }

    private static func write(_ data: [UInt8], over target: URL, expected: [UInt8]?, beforePlacing: () -> Void) throws {
        let temporary = target.deletingLastPathComponent()
            .appendingPathComponent(".\(target.lastPathComponent).\(UUID().uuidString).tmp")
        let descriptor = open(temporary.path, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw Failure.system("create the temporary file", errno) }
        // Whatever is left at the temporary path when this returns: the new bytes that did not go in, or the old file
        // the swap took out. Never a file another program wrote: that one is put back in place first.
        defer { unlink(temporary.path) }
        var original = stat()
        let known = stat(target.path, &original) == 0
        var failure: Failure?
        if known, fchmod(descriptor, original.st_mode & 0o7777) != 0 {
            failure = .system("copy the permissions", errno)
        }
        if failure == nil {
            data.withUnsafeBytes { buffer in
                var offset = 0
                while offset < buffer.count, let base = buffer.baseAddress {
                    let written = Darwin.write(descriptor, base + offset, buffer.count - offset)
                    if written < 0 {
                        if errno == EINTR { continue }
                        failure = .system("write", errno)
                        return
                    }
                    offset += written
                }
            }
        }
        if failure == nil, fsync(descriptor) != 0 { failure = .system("sync", errno) }
        close(descriptor)
        if let failure { throw failure }
        // The ACL and the extended attributes (Finder tags, a sync client's own) go with the note. Not the stat data:
        // that would put the old modification time back. A copy that fails costs those, never the write.
        if known {
            _ = copyfile(target.path, temporary.path, nil, copyfile_flags_t(COPYFILE_ACL | COPYFILE_XATTR))
        }
        guard let expected else {
            guard rename(temporary.path, target.path) == 0 else { throw Failure.system("rename", errno) }
            return
        }
        // A file that already changed costs no swap.
        guard holds(target, expected) else { throw Failure.changed }
        beforePlacing()
        guard renamex_np(temporary.path, target.path, UInt32(RENAME_SWAP)) == 0 else {
            let code = errno
            guard code == ENOTSUP || code == EINVAL else { throw Failure.system("swap", code) }
            guard holds(target, expected) else { throw Failure.changed }
            guard rename(temporary.path, target.path) == 0 else { throw Failure.system("rename", errno) }
            return
        }
        // The old file is now at the temporary path. It still has `expected`: the new bytes stay, and it goes.
        if holds(temporary, expected) { return }
        // Someone wrote it meanwhile: their file goes back in place, and the new bytes come out.
        guard renamex_np(temporary.path, target.path, UInt32(RENAME_SWAP)) == 0 else {
            // Theirs is at the temporary path: a plain rename puts it back over the new bytes.
            guard rename(temporary.path, target.path) == 0 else { throw Failure.system("put the changed file back", errno) }
            throw Failure.changed
        }
        // What came out is not the new bytes: a third program renamed its own file over them after the swap. That one
        // is the newest, so it goes back in place, and the older write it replaced comes out.
        if !holds(temporary, data), renamex_np(temporary.path, target.path, UInt32(RENAME_SWAP)) != 0 {
            guard rename(temporary.path, target.path) == 0 else { throw Failure.system("put the newest file back", errno) }
        }
        throw Failure.changed
    }

    private static func holds(_ url: URL, _ bytes: [UInt8]) -> Bool {
        FileManager.default.contents(atPath: url.path)?.elementsEqual(bytes) == true
    }
}

/// One task click applied to the note on disk.
enum MarkdownTaskFile {
    enum Result: Equatable {
        /// The file has the new state; the item was on this line.
        case saved(line: Int)
        /// The item already had that state; nothing was written.
        case unchanged(line: Int)
        case notFound
        case ambiguous(Int)
        /// The system's words, for the log and the notice's Details.
        case failed(String)
    }

    /// One write at a time, in click order, off the main thread.
    static let queue = DispatchQueue(label: "genesiskit.markdown.tasks", qos: .userInitiated)

    /// Reads the file, finds the item (its line, else its text), changes its box and writes the file atomically. A
    /// file written by someone else between the read and the rename is read again, up to three times.
    static func apply(_ target: MarkdownTaskTarget, to url: URL) -> Result {
        for _ in 0..<3 {
            guard let data = FileManager.default.contents(atPath: url.path) else {
                return .failed("The file could not be read.")
            }
            let bytes = [UInt8](data)
            let item: MarkdownTaskLine
            switch MarkdownTaskList.locate(target, in: bytes) {
            case .atLine(let found), .moved(let found): item = found
            case .notFound: return .notFound
            case .ambiguous(let count): return .ambiguous(count)
            }
            guard let changed = MarkdownTaskList.setting(item, checked: target.checked, in: bytes) else {
                return .unchanged(line: item.line)
            }
            do {
                try MarkdownAtomicWrite.replace(url, with: changed, expected: bytes)
                return .saved(line: item.line)
            } catch MarkdownAtomicWrite.Failure.changed {
                continue
            } catch let failure as MarkdownAtomicWrite.Failure {
                return .failed(failure.message)
            } catch {
                return .failed(error.localizedDescription)
            }
        }
        return .failed("The file kept changing while the task was saved.")
    }
}
