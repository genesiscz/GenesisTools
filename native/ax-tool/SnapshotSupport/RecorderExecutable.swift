import Darwin
import Foundation

/// The private executable a recorder runs from.
///
/// replayd, the ScreenCaptureKit daemon, keys a capture client by its executable path. When any
/// process started from a path exits, every live stream of every other process started from that
/// path ends with SCStreamError -3805 ("Failed during stream due to application connection being
/// interrupted"), also when the exiting process only listed shareable content and never streamed.
/// Measured 2026-10-14 on macOS 26.3.1 with a 40-line probe run twice through the GenesisTools
/// launcher: from one path the first stream died every time (7 of 7, also for windows of two
/// different apps), from a copy or an APFS clone at another path it lived every time (6 of 6), and
/// from a hard link to the same file `stopCapture` never returned. So each recorder re-executes
/// itself from its own clone, and one recording stopping no longer ends another.
public enum RecorderExecutable {
    /// Names the clone a recorder re-executed itself from; only that process reads it.
    public static let environmentKey = "AX_TOOL_RECORDER_COPY"

    public static func directory(root: URL, pid: pid_t) -> URL {
        root.appendingPathComponent(String(pid), isDirectory: true)
    }

    /// Entries of `root` whose recorder no longer runs. A name that is not a pid is never touched.
    public static func staleEntries(_ names: [String], isRunning: (pid_t) -> Bool) -> [String] {
        names.filter { name in
            guard let pid = pid_t(name), pid > 0 else { return false }
            return !isRunning(pid)
        }
    }

    public static func processIsRunning(_ pid: pid_t) -> Bool {
        kill(pid, 0) == 0 || errno == EPERM
    }

    /// Clones `source` to `<root>/<pid>/<name>`: a file of its own (own path, own inode, never a
    /// hard link) that shares the source's blocks on APFS and is a full copy elsewhere. Directories
    /// left by recorders that died without cleaning up are removed first.
    public static func makePrivateCopy(
        of source: URL, root: URL, pid: pid_t, isRunning: (pid_t) -> Bool = processIsRunning
    ) throws -> URL {
        let manager = FileManager.default
        try manager.createDirectory(at: root, withIntermediateDirectories: true)
        for name in staleEntries((try? manager.contentsOfDirectory(atPath: root.path)) ?? [], isRunning: isRunning) {
            try? manager.removeItem(at: root.appendingPathComponent(name))
        }
        let directory = directory(root: root, pid: pid)
        // Only a dead process with the same pid can have left this one.
        try? manager.removeItem(at: directory)
        try manager.createDirectory(at: directory, withIntermediateDirectories: true)
        let copy = directory.appendingPathComponent(source.lastPathComponent)
        if clonefile(source.path, copy.path, 0) != 0 {
            try manager.copyItem(at: source, to: copy)
        }
        return copy
    }

    /// Removes the directory of `copy` when it is the clone of the recorder with `pid` under `root`.
    public static func removeCopy(_ copy: URL, root: URL, pid: pid_t) {
        let owned = directory(root: root, pid: pid).standardizedFileURL.path
        guard copy.deletingLastPathComponent().standardizedFileURL.path == owned else { return }
        try? FileManager.default.removeItem(atPath: owned)
    }
}
