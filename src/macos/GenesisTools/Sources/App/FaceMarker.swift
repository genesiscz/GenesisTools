import Darwin
import Foundation

/// Private libSystem API: the pid macOS holds responsible for `pid` (what `launchctl procinfo` prints
/// as "responsible pid"). TCC asks this process's identity when `pid` touches a protected resource.
@_silgen_name("responsibility_get_pid_responsible_for_pid")
func responsibility_get_pid_responsible_for_pid(_ pid: pid_t) -> pid_t

/// The launcher markers an app face (hub, window, --rpc, link router) hands its children, so a `tools`
/// they start skips both launcher stages when it would only reach the identity it already has.
///
/// A face is NOT always its own responsible process. Launch Services (`open`, a Dock click, a
/// notification) makes it responsible for itself, but a face run directly from a shell inherits the
/// shell's responsible process: a terminal, or the stage B of a launched tool. So the face asks the
/// kernel, and marks its children only when the responsible process is this bundle's identity. It then
/// records the inode of THAT process's binary, which is what stage B records for its own tree: `tools`
/// compares it with the installed launcher (`genesisAppLauncher()`) and re-enters after a rebuild.
/// Any other responsible process (a terminal) removes inherited markers, so the children use the launcher.
enum FaceMarker {
    struct Responsible: Equatable {
        /// The bundle id of the app whose executable the responsible process runs, nil for a bare binary.
        let bundleId: String?
        /// The inode of that executable, nil when it can no longer be found.
        let inode: UInt64?
    }

    /// The marker values to set (a value) or remove (nil).
    static func updates(ownBundleId: String, responsible: Responsible?) -> [String: String?] {
        guard let responsible, responsible.bundleId == ownBundleId, let inode = responsible.inode else {
            return [bundleIdVariable: nil, inodeVariable: nil]
        }

        return [bundleIdVariable: ownBundleId, inodeVariable: String(inode)]
    }

    /// The process macOS holds responsible for this one, read from the kernel.
    static func responsibleProcess() -> Responsible? {
        let pid = responsibility_get_pid_responsible_for_pid(getpid())
        guard pid > 0 else { return nil }

        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
        let path = String(cString: buffer)

        var info = stat()
        let inode: UInt64? = stat(path, &info) == 0 ? UInt64(info.st_ino) : nil
        // <name>.app/Contents/MacOS/<executable>
        let bundleURL = URL(fileURLWithPath: path).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let bundleId = bundleURL.pathExtension == "app" ? Bundle(url: bundleURL)?.bundleIdentifier : nil
        return Responsible(bundleId: bundleId, inode: inode)
    }

    /// Call once at launch, before any thread or child starts: `setenv` is not safe beside a spawn.
    static func install() {
        let ownBundleId = Bundle.main.bundleIdentifier ?? fallbackBundleId
        for (key, value) in updates(ownBundleId: ownBundleId, responsible: responsibleProcess()) {
            if let value {
                setenv(key, value, 1)
            } else {
                unsetenv(key)
            }
        }
    }
}
