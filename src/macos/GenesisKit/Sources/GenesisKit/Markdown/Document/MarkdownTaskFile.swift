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
/// disk, and is then renamed over the original. A reader sees the old file or the new one, never a torn one.
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
    /// `expected` is the content `data` was made from: the file is read again right before the rename, and a file
    /// that no longer has it is left alone (`.changed`), so a write that landed meanwhile is never overwritten.
    static func replace(_ url: URL, with data: [UInt8], expected: [UInt8]?) throws {
        let target = url.resolvingSymlinksInPath()
        let temporary = target.deletingLastPathComponent()
            .appendingPathComponent(".\(target.lastPathComponent).\(UUID().uuidString).tmp")
        let descriptor = open(temporary.path, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw Failure.system("create the temporary file", errno) }
        var placed = false
        defer {
            if !placed { try? FileManager.default.removeItem(at: temporary) }
        }
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
                    let written = write(descriptor, base + offset, buffer.count - offset)
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
        if let expected {
            guard let now = FileManager.default.contents(atPath: target.path), now.elementsEqual(expected) else {
                throw Failure.changed
            }
        }
        guard rename(temporary.path, target.path) == 0 else { throw Failure.system("rename", errno) }
        placed = true
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
