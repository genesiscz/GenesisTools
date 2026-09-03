// Launcher face of GenesisTools.app: makes this signed bundle the macOS TCC "responsible
// process" for everything `tools` runs, so Calendar, Reminders, Contacts, Full Disk Access,
// Accessibility and Automation grants attach to GenesisTools instead of to whichever terminal
// (or launchd job) happened to start the command.
//
// Two stages, because responsibility is decided at spawn time by the parent:
//   stage A (started by the terminal)  -> re-spawns itself with the disclaim attribute
//   stage B (disclaimed, = GenesisTools) -> spawns the real program; its children inherit B
// Both stages stay alive only to proxy exit status, signals and parent death.

import Darwin
import Foundation

/// Private libSystem API (used by Chromium, kitty, WezTerm): the spawned child stops being
/// attributed to us and becomes its own responsible process.
@_silgen_name("responsibility_spawnattrs_setdisclaim")
func responsibility_spawnattrs_setdisclaim(_ attrs: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

let stageMarker = "GENESIS_TOOLS_APP_STAGE"
let bundleIdVariable = "GENESIS_TOOLS_APP_BUNDLE_ID"
let fallbackBundleId = "com.genesiscz.genesistools"

var childPid: pid_t = 0

func bundleVersion() -> String {
    Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
}

func warn(_ message: String) {
    FileHandle.standardError.write(Data("GenesisTools: \(message)\n".utf8))
}

func launcherUsage() -> Never {
    FileHandle.standardError.write(Data("""
    GenesisTools launcher \(bundleVersion())
    usage: GenesisTools <program> [args...]
    Runs <program> with this app bundle as the TCC responsible process.
    With no arguments, opens the GenesisTools settings window.
      --version   print the bundle version

    """.utf8))
    exit(64)
}

func spawnChild(path: String, arguments: [String], environment: [String: String], disclaim: Bool) -> pid_t {
    var attrs: posix_spawnattr_t? = nil
    guard posix_spawnattr_init(&attrs) == 0 else {
        warn("posix_spawnattr_init failed: \(String(cString: strerror(errno)))")
        exit(70)
    }
    defer { posix_spawnattr_destroy(&attrs) }

    if disclaim {
        let rc = responsibility_spawnattrs_setdisclaim(&attrs, 1)
        if rc != 0 {
            warn("responsibility_spawnattrs_setdisclaim failed (\(rc)); permissions will follow the terminal")
        }
    }

    var argv: [UnsafeMutablePointer<CChar>?] = arguments.map { strdup($0) }
    argv.append(nil)
    var envp: [UnsafeMutablePointer<CChar>?] = environment.map { strdup("\($0.key)=\($0.value)") }
    envp.append(nil)
    defer {
        argv.forEach { free($0) }
        envp.forEach { free($0) }
    }

    var pid: pid_t = 0
    let rc = path.contains("/")
        ? posix_spawn(&pid, path, nil, &attrs, argv, envp)
        : posix_spawnp(&pid, path, nil, &attrs, argv, envp)
    if rc != 0 {
        warn("cannot run \(path): \(String(cString: strerror(rc)))")
        exit(rc == ENOENT ? 127 : 126)
    }

    return pid
}

func forwardSignals() {
    for sig in [SIGINT, SIGTERM, SIGHUP, SIGQUIT] {
        signal(sig) { received in
            if childPid > 0 {
                kill(childPid, received)
            }
        }
    }
}

/// macOS has no PR_SET_PDEATHSIG. If our parent dies (terminal closed, `tools` killed),
/// terminate the child instead of leaving a headless tool running for days.
func watchParentDeath() {
    let parent = getppid()
    DispatchQueue.global(qos: .utility).async {
        let kq = kqueue()
        if kq == -1 {
            return
        }

        var change = kevent(
            ident: UInt(parent), filter: Int16(EVFILT_PROC), flags: UInt16(EV_ADD | EV_ONESHOT),
            fflags: UInt32(NOTE_EXIT), data: 0, udata: nil
        )
        var event = kevent()
        if kevent(kq, &change, 1, &event, 1, nil) > 0, childPid > 0 {
            kill(childPid, SIGTERM)
        }
    }
}

func waitAndExit(_ pid: pid_t) -> Never {
    var status: Int32 = 0
    while waitpid(pid, &status, 0) == -1 {
        if errno != EINTR {
            warn("waitpid failed: \(String(cString: strerror(errno)))")
            exit(70)
        }
    }

    let signalNumber = status & 0x7f
    if signalNumber != 0 {
        exit(128 + signalNumber)
    }

    exit((status >> 8) & 0xff)
}

func runLauncher(_ arguments: [String]) -> Never {
    var environment = ProcessInfo.processInfo.environment
    let bundleId = Bundle.main.bundleIdentifier ?? fallbackBundleId

    // Handlers go in before the spawn: a child inherits SIG_IGN but resets handlers to SIG_DFL,
    // so this is what keeps Ctrl-C working for a tool started from a shell that ignored SIGINT.
    forwardSignals()

    if environment[stageMarker] != "responsible" {
        let me = Bundle.main.executablePath ?? CommandLine.arguments[0]
        environment[stageMarker] = "responsible"
        childPid = spawnChild(path: me, arguments: CommandLine.arguments, environment: environment, disclaim: true)
    } else {
        environment.removeValue(forKey: stageMarker)
        environment[bundleIdVariable] = bundleId
        childPid = spawnChild(path: arguments[0], arguments: arguments, environment: environment, disclaim: false)
    }

    watchParentDeath()
    waitAndExit(childPid)
}
