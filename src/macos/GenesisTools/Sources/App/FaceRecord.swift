import Foundation

/// A window face's exact argv, written at launch to `~/.genesis-tools/app/faces/<pid>.json`.
///
/// A rebuild kills every face of the replaced bundle and starts the hub, review and settings windows
/// again with the arguments they had (src/macos/lib/permissions/relaunch.ts). `ps` joins argv with
/// spaces, so a path with a space (`--repo "/x/My Repo"`) cannot be read back from it; this record can.
/// It goes at a normal exit; one left by a SIGTERM is pruned by the next rebuild.
enum FaceRecord {
    static var directory: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".genesis-tools/app/faces", isDirectory: true)
    }

    /// The windows a rebuild reopens: the settings window, the hub and a review, never a scripted run.
    static func isWindowFace(_ argv: [String]) -> Bool {
        if argv.contains("--snapshot") || argv.contains("--bench") {
            return false
        }
        let first = argv.first ?? ""
        return first.isEmpty || first == "--window" || first.hasPrefix("-psn_") || first == "--hub" || first == "--review"
    }

    static func encode(pid: Int32, argv: [String]) -> Data? {
        struct Record: Encodable {
            let pid: Int32
            let argv: [String]
            let startedAt: String
        }
        return try? JSONEncoder().encode(Record(pid: pid, argv: argv, startedAt: ISO8601DateFormatter().string(from: Date())))
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
