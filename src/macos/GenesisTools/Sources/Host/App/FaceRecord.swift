import Foundation

/// A window face's exact argv, written at launch to `~/.genesis-tools/app/faces/<pid>.json`.
///
/// A rebuild kills every face of the replaced bundle and starts the settings window, the hub, a review, the
/// widget and Clicky again with the arguments they had (src/macos/lib/permissions/relaunch.ts). `ps` joins argv with
/// spaces, so a path with a space (`--repo "/x/My Repo"`) cannot be read back from it; this record can.
/// It goes at a normal exit; one left by a SIGTERM is pruned by the next rebuild.
package enum FaceRecord {
    static var directory: URL {
        // `genesisHome()`, as the TS side and the relay journal: a sandboxed GENESIS_TOOLS_HOME holds all three.
        URL(fileURLWithPath: genesisHome()).appendingPathComponent(".genesis-tools/app/faces", isDirectory: true)
    }

    /// The faces a rebuild reopens (and that keep a link relay in front of them): the settings window, the hub,
    /// a review, the widget and the feature settings, never a scripted run.
    static func isWindowFace(_ argv: [String]) -> Bool {
        if argv.contains("--snapshot") || argv.contains("--bench") {
            return false
        }
        let first = argv.first ?? ""
        return first.isEmpty || first == "--window" || first.hasPrefix("-psn_") || first == "--hub" || first == "--review" || first == "--widget" || first == "--features" || first == "--clicky" || first == "--markdown"
    }

    static func encode(pid: Int32, argv: [String], windows: [[String]]? = nil, front: Int? = nil) -> Data? {
        struct Record: Encodable {
            let pid: Int32
            let argv: [String]
            let windows: [[String]]?
            let front: Int?
            let startedAt: String
        }
        return try? JSONEncoder().encode(
            Record(pid: pid, argv: argv, windows: windows, front: front, startedAt: ISO8601DateFormatter().string(from: Date())))
    }

    /// The review process holds every review window: its record lists them all, so a rebuild reopens each one
    /// (`readFaceWindows` in relaunch.ts), not only the launch that started the process. `front` is the index of the
    /// window in front: every window has the process's pid, so only it comes back in front (`readFaceFrontWindows`).
    package static func writeWindows(argv: [String], windows: [[String]], front: Int? = nil) {
        guard !NativePreview.enabled, let data = encode(pid: getpid(), argv: argv, windows: windows, front: front) else { return }
        do {
            try data.write(to: directory.appendingPathComponent("\(getpid()).json"), options: .atomic)
        } catch {
            FileHandle.standardError.write(Data("face record: \(error)\n".utf8))
        }
    }

    /// Call once at launch with the arguments after the executable.
    static func write(_ argv: [String]) {
        guard isWindowFace(argv), let data = encode(pid: getpid(), argv: argv) else { return }
        let url = directory.appendingPathComponent("\(getpid()).json")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
        } catch {
            FileHandle.standardError.write(Data("face record: \(error)\n".utf8))
            return
        }
        atexit {
            let own = FaceRecord.directory.appendingPathComponent("\(getpid()).json")
            try? FileManager.default.removeItem(at: own)
        }
    }
}
