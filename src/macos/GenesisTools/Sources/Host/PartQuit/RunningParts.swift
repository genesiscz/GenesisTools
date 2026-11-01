import AppKit
import Darwin
import Foundation

/// One running face of this app: its process and its face flag (`--widget`, `--features`, `--hub`, ...).
struct RunningFace: Equatable, Sendable {
    let pid: Int32
    let face: String
}

/// What runs right now, read from the kernel and not from the settings: every window face of this bundle, and the
/// parts that are up in some face (PartPresence: the widget's panels, Clicky turned on, the settings window open). The
/// quit question (QuitDecision.swift) names only what this says runs.
struct RunningPartsSnapshot: Equatable, Sendable {
    var ownPid: Int32
    var faces: [RunningFace]
    var livePresences: Set<String>
}

/// Reads the snapshot. The live probe asks the kernel; tests pass a fake, so they start no process.
@MainActor
protocol RunningPartsProbing {
    func snapshot() -> RunningPartsSnapshot
}

/// Every process Launch Services knows under this bundle id (each face is an `NSApplication`; the launcher, which runs
/// `tools`, bun services and Claude sessions, never touches AppKit), each read back by its argv from `KERN_PROCARGS2`.
/// A process whose first argument is no face this table names (the link relay, `--rpc`, `--mic`, a scripted
/// `--snapshot` run) is left out.
@MainActor
struct LiveRunningPartsProbe: RunningPartsProbing {
    func snapshot() -> RunningPartsSnapshot {
        let own = getpid()
        var pids = Set(
            NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
                .filter { !$0.isTerminated }.map(\.processIdentifier))
        pids.insert(own)
        let faces = pids.sorted().compactMap { pid -> RunningFace? in
            let arguments = pid == own ? CommandLine.arguments : VaultProcess.procArgs(pid)?.arguments
            guard let arguments, let face = PartQuit.face(ofArguments: Array(arguments.dropFirst())) else { return nil }
            return RunningFace(pid: pid, face: face)
        }
        return RunningPartsSnapshot(ownPid: own, faces: faces, livePresences: PartPresence.live())
    }
}

/// A part the user sees holds a lock file while it is up, so any face can ask the kernel whether it runs. A process
/// scan sees only faces, and a face can run with nothing on screen: the widget with "Show the widget" off, the feature
/// settings face with its window closed and Clicky off (it stays to host the widget's Dictation and Focus runtime). The
/// kernel drops the lock when the process ends.
@MainActor
package enum PartPresence {
    /// The widget's edge panels ("Show the widget" on), in `--widget`.
    package static let widget = "widget"
    /// Clicky turned on (its key sounds play), in `--features`. Off, its status item may still show, greyed.
    package static let clicky = "clicky"
    /// The feature settings window open, in `--features`.
    package static let settingsWindow = "settings-window"

    private static var descriptors: [String: Int32] = [:]

    static func lockFile(_ part: String, in directory: URL) -> URL {
        directory.appendingPathComponent("\(part)-up.lock")
    }

    /// Call when the part comes up in this process.
    package static func hold(_ part: String, in directory: URL = NativePreview.root) {
        guard descriptors[part] == nil else { return }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            PerfLog.mark("part.presence \(part): \(error.localizedDescription)")
            return
        }
        let descriptor = open(lockFile(part, in: directory).path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { return }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            close(descriptor)
            return
        }
        descriptors[part] = descriptor
    }

    /// Call when the part stops in this process.
    package static func release(_ part: String) {
        guard let descriptor = descriptors.removeValue(forKey: part) else { return }
        flock(descriptor, LOCK_UN)
        close(descriptor)
    }

    /// Every part of the quit question's table (PartQuit.presences) that is up in some process.
    static func live(in directory: URL = NativePreview.root) -> Set<String> {
        Set(PartQuit.presences.map(\.id).filter { isUp($0, in: directory) })
    }

    /// Holds the part's lock while `up`, else drops it. Cheap to call on every state change.
    package static func set(_ part: String, up: Bool) {
        up ? hold(part) : release(part)
    }

    /// True while this process or another one holds the part's lock.
    static func isUp(_ part: String, in directory: URL = NativePreview.root) -> Bool {
        if descriptors[part] != nil { return true }
        let descriptor = open(lockFile(part, in: directory).path, O_RDONLY | O_CLOEXEC)
        guard descriptor >= 0 else { return false }
        defer { close(descriptor) }
        guard flock(descriptor, LOCK_SH | LOCK_NB) == 0 else { return true }
        flock(descriptor, LOCK_UN)
        return false
    }
}
