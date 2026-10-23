import Darwin
import Foundation

/// A release-time snapshot, not an atomic transport authentication: libproc cannot prevent a holder
/// from forking or passing an fd after inspection. Unknown or incomplete observations deny release,
/// except confirmed exits and EPERM on the fd tables of protected system executables. A holder that
/// execs into such a binary while keeping the read end is not seen. That exception trusts the system
/// binary's code not to relay the bytes; it does not prove the read end was closed.
enum VaultRecipient {
    /// One process image: the pid, its start time, and the kernel's exec generation and image UUID.
    /// `==` leaves `executable` out. For a hard-linked binary (every `~/.genesis-tools/bin/gt-<tool>` is one
    /// inode) proc_pidpath reports whichever name was looked up last, so any other `gt-*` start during the
    /// approval changed it and the key was refused (2026-10-20). `execGeneration` is new on every exec of
    /// the pid, so it catches every exec a path compare caught, and an exec into the same path too.
    struct Identity: Equatable {
        var pid: pid_t
        var startSeconds: UInt64
        var startMicroseconds: UInt64
        /// The kernel's `p_idversion`.
        var execGeneration: Int32
        /// LC_UUID of the main executable.
        var imageUUID: UUID
        /// For display and grant keys only.
        var executable: String

        static func == (lhs: Identity, rhs: Identity) -> Bool {
            lhs.pid == rhs.pid && lhs.startSeconds == rhs.startSeconds && lhs.startMicroseconds == rhs.startMicroseconds
                && lhs.execGeneration == rhs.execGeneration && lhs.imageUUID == rhs.imageUUID
        }
    }

    enum Endpoint: Equatable {
        case pipe(handle: UInt64, peer: UInt64)
        case socket(pcb: UInt64, peer: UInt64)
        case other

        var connected: Bool {
            switch self {
            case let .pipe(handle, peer), let .socket(handle, peer):
                return handle != 0 && peer != 0 && handle != peer
            case .other:
                return false
            }
        }

        func isPeer(of output: Endpoint) -> Bool {
            switch (self, output) {
            case let (.pipe(handle, peer), .pipe(outputHandle, outputPeer)),
                 let (.socket(handle, peer), .socket(outputHandle, outputPeer)):
                return handle == outputPeer && peer == outputHandle
            default:
                return false
            }
        }
    }

    enum ReadFailure {
        case exited
        case unavailable(code: Int32, executable: String?)

        var maySkip: Bool {
            switch self {
            case .exited:
                return true
            case let .unavailable(code, executable):
                // /System/Volumes/Data is the user's writable data volume, not the sealed system volume.
                guard code == EPERM, let executable,
                      executable == (executable as NSString).standardizingPath,
                      !executable.hasPrefix("/System/Volumes/") else { return false }
                return ["/usr/bin/", "/usr/sbin/", "/usr/libexec/", "/bin/", "/sbin/", "/System/"]
                    .contains { executable.hasPrefix($0) }
            }
        }
    }

    struct ProcessFDs {
        var pid: pid_t
        /// nil means the table, or any relevant descriptor in it, could not be read completely.
        var endpoints: [Endpoint]?
        var failure: ReadFailure? = nil

        var maySkip: Bool { endpoints == nil && failure?.maySkip == true }
    }

    static func rejection(stdout: Endpoint, caller: Identity?, current: Identity?, processes: [ProcessFDs]) -> String? {
        guard stdout.connected else { return "vault stdout must be a connected pipe or Unix-domain socket" }
        guard let caller, let current else { return "the caller's process identity could not be read" }
        guard current == caller else { return "the caller's process instance or executable changed before key release" }
        if let unreadable = processes.first(where: { $0.endpoints == nil && !$0.maySkip }) {
            // Name the process: 37 refusals on 2026-10-20 and 21 said only "a process", so nobody could tell which.
            var detail = "pid \(unreadable.pid)"
            if case let .unavailable(code, executable) = unreadable.failure {
                detail += ", \(String(cString: strerror(code)))"
                if let executable { detail += ", \(executable)" }
            }
            return "\(unreadableTable) (\(detail))"
        }
        let holders = Set(processes.filter { process in
            process.endpoints?.contains(where: { $0.isPeer(of: stdout) }) == true
        }.map(\.pid))
        guard holders.subtracting([caller.pid]).isEmpty else { return "another process holds the output" }
        guard holders == Set([caller.pid]) else {
            return "the verified caller must be the sole holder of vault stdout's other end"
        }
        return nil
    }

    static func identity(_ pid: pid_t) -> Identity? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.stride)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
              info.pbi_pid == UInt32(pid), info.pbi_start_tvsec != 0 else { return nil }
        guard let image = image(pid), let executable = executablePath(pid) else { return nil }
        return Identity(pid: pid, startSeconds: info.pbi_start_tvsec, startMicroseconds: info.pbi_start_tvusec,
                        execGeneration: image.generation, imageUUID: image.uuid, executable: executable)
    }

    /// `PROC_PIDUNIQIDENTIFIERINFO` is private: its struct is read by offset from XNU's proc_info_private.h
    /// (`p_uuid[16]`, `p_uniqueid`, `p_puniqueid`, `int32_t p_idversion`, then reserved fields; 56 bytes).
    /// A short read or a zero generation is no identity, so release is denied.
    private static func image(_ pid: pid_t) -> (generation: Int32, uuid: UUID)? {
        let flavor: Int32 = 17
        var bytes = [UInt8](repeating: 0, count: 56)
        let read = bytes.withUnsafeMutableBytes { proc_pidinfo(pid, flavor, 0, $0.baseAddress, Int32($0.count)) }
        guard read == Int32(bytes.count) else { return nil }
        let generation = bytes.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 32, as: Int32.self) }
        let uuid = bytes.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 0, as: uuid_t.self) }
        guard generation != 0 else { return nil }
        return (generation, UUID(uuid: uuid))
    }

    private struct InspectionFailure: Error {
        var reason: String
        var code: Int32 = 0
        var fdTable: Bool = false
    }

    private static func hasExited(_ pid: pid_t) -> Bool {
        kill(pid, 0) == -1 && errno == ESRCH
    }

    private static func executablePath(_ pid: pid_t) -> String? {
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
        return String(cString: buffer)
    }

    private static func pids(kind: UInt32, uid: uid_t) throws -> Set<pid_t> {
        let needed = proc_listpids(kind, uid, nil, 0)
        guard needed > 0 else { throw InspectionFailure(reason: "the user's process list could not be read") }
        var buffer = [pid_t](repeating: 0, count: Int(needed) / MemoryLayout<pid_t>.stride + 128)
        let capacity = Int32(buffer.count * MemoryLayout<pid_t>.stride)
        let bytes = buffer.withUnsafeMutableBytes { proc_listpids(kind, uid, $0.baseAddress, capacity) }
        guard bytes > 0, bytes < capacity, Int(bytes) % MemoryLayout<pid_t>.stride == 0 else {
            throw InspectionFailure(reason: "the user's process list was incomplete")
        }
        return Set(buffer.prefix(Int(bytes) / MemoryLayout<pid_t>.stride).filter { $0 > 0 })
    }

    private static func userPids() throws -> Set<pid_t> {
        // Include processes with this real uid even if their effective uid has changed.
        try pids(kind: UInt32(PROC_UID_ONLY), uid: getuid())
            .union(pids(kind: UInt32(PROC_RUID_ONLY), uid: getuid()))
    }

    private static func descriptors(_ pid: pid_t) throws -> [proc_fdinfo] {
        errno = 0
        let needed = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nil, 0)
        let sizeError = errno
        guard needed >= 0, sizeError == 0 else {
            throw InspectionFailure(reason: "the fd table for process \(pid) could not be read", code: sizeError, fdTable: true)
        }
        let stride = MemoryLayout<proc_fdinfo>.stride
        var buffer = [proc_fdinfo](repeating: proc_fdinfo(), count: Int(needed) / stride + 32)
        let capacity = Int32(buffer.count * stride)
        errno = 0
        let bytes = buffer.withUnsafeMutableBytes { proc_pidinfo(pid, PROC_PIDLISTFDS, 0, $0.baseAddress, capacity) }
        let readError = errno
        guard bytes >= 0, readError == 0, bytes < capacity, Int(bytes) % stride == 0 else {
            throw InspectionFailure(reason: "the fd table for process \(pid) was incomplete", code: readError, fdTable: true)
        }
        return Array(buffer.prefix(Int(bytes) / stride))
    }

    private static func endpoint(_ pid: pid_t, fd: Int32, type: UInt32) throws -> Endpoint {
        if type == UInt32(PROX_FDTYPE_PIPE) {
            var info = pipe_fdinfo()
            let size = Int32(MemoryLayout<pipe_fdinfo>.stride)
            guard proc_pidfdinfo(pid, fd, PROC_PIDFDPIPEINFO, &info, size) == size else {
                throw InspectionFailure(reason: "pipe \(fd) of process \(pid) could not be inspected", code: errno)
            }
            return .pipe(handle: info.pipeinfo.pipe_handle, peer: info.pipeinfo.pipe_peerhandle)
        }
        if type == UInt32(PROX_FDTYPE_SOCKET) {
            var info = socket_fdinfo()
            let size = Int32(MemoryLayout<socket_fdinfo>.stride)
            guard proc_pidfdinfo(pid, fd, PROC_PIDFDSOCKETINFO, &info, size) == size else {
                throw InspectionFailure(reason: "socket \(fd) of process \(pid) could not be inspected", code: errno)
            }
            guard info.psi.soi_family == AF_UNIX, info.psi.soi_kind == SOCKINFO_UN else { return .other }
            return .socket(pcb: info.psi.soi_pcb, peer: info.psi.soi_proto.pri_un.unsi_conn_pcb)
        }
        return .other
    }

    private static func stdoutEndpoint() throws -> Endpoint {
        var status = stat()
        guard fstat(STDOUT_FILENO, &status) == 0 else {
            throw InspectionFailure(reason: "vault stdout could not be inspected")
        }
        switch status.st_mode & mode_t(S_IFMT) {
        case mode_t(S_IFIFO):
            return try endpoint(getpid(), fd: STDOUT_FILENO, type: UInt32(PROX_FDTYPE_PIPE))
        case mode_t(S_IFSOCK):
            return try endpoint(getpid(), fd: STDOUT_FILENO, type: UInt32(PROX_FDTYPE_SOCKET))
        default:
            return .other
        }
    }

    private static func processFDs(_ pid: pid_t, output: Endpoint) -> ProcessFDs {
        do {
            let fds = try descriptors(pid)
            var endpoints: [Endpoint] = []
            for fd in fds {
                switch (output, fd.proc_fdtype) {
                case (.pipe, UInt32(PROX_FDTYPE_PIPE)), (.socket, UInt32(PROX_FDTYPE_SOCKET)):
                    endpoints.append(try endpoint(pid, fd: fd.proc_fd, type: fd.proc_fdtype))
                default:
                    break
                }
            }
            return ProcessFDs(pid: pid, endpoints: endpoints)
        } catch let error as InspectionFailure {
            if error.code == ESRCH || hasExited(pid) {
                return ProcessFDs(pid: pid, endpoints: nil, failure: .exited)
            }
            // Only a refused fd TABLE qualifies for the protected-system exception. A descriptor
            // changing or becoming unreadable inside an otherwise readable table still denies release.
            let failure: ReadFailure? = error.fdTable
                ? .unavailable(code: error.code, executable: executablePath(pid)) : nil
            return ProcessFDs(pid: pid, endpoints: nil, failure: failure)
        } catch {
            return ProcessFDs(pid: pid, endpoints: nil, failure: hasExited(pid) ? .exited : nil)
        }
    }

    /// Inspects every user process, then each process that appeared meanwhile, until two lists in a row
    /// add nothing. A busy session starts processes all the time, so one strict before/after pair denied
    /// the key many times a day (82 on 2026-10-19). Exits cannot introduce a new reader; a process that
    /// left the list without exiting changed uid, and a list that never settles still denies.
    static func settledTables(rounds: Int, list: () throws -> Set<pid_t>, inspect: (pid_t) -> ProcessFDs,
                              exited: (pid_t) -> Bool) rethrows -> [ProcessFDs]? {
        var seen = try list()
        var tables = seen.sorted().map(inspect)
        for _ in 0..<rounds {
            let current = try list()
            guard seen.subtracting(current).allSatisfy(exited) else { return nil }
            let added = current.subtracting(seen)
            if added.isEmpty { return tables }
            tables += added.sorted().map(inspect)
            seen.formUnion(added)
        }
        return nil
    }

    static let unreadableTable = "the vault recipient could not be verified because a process fd table was unreadable"
    static let unsettledList = "the user's process list changed during vault recipient inspection"

    /// Runs the whole inspection again, up to `attempts` times, while it fails only because a table could not be read
    /// or the list did not settle. Those are moments, not holders: 7 releases in the logs of 2026-10-20 and 21 met one,
    /// and each failed a whole usage poll, and a probe of all 1,726 user processes later found only login and ps,
    /// which the check skips. Every attempt is the full check, so a release still needs one that passes completely.
    static func retryingTransient(attempts: Int, pause: () -> Void, _ inspect: () -> String?) -> String? {
        var reason = inspect()
        for _ in 1..<max(1, attempts) {
            guard let current = reason, current.hasPrefix(unreadableTable) || current == unsettledList else { break }
            pause()
            reason = inspect()
        }
        return reason
    }

    static func releaseRejection(caller: Identity?) -> String? {
        retryingTransient(attempts: 3, pause: { usleep(50_000) }) { inspectRelease(caller: caller) }
    }

    private static func inspectRelease(caller: Identity?) -> String? {
        do {
            let output = try stdoutEndpoint()
            guard output.connected else { return "vault stdout must be a connected pipe or Unix-domain socket" }
            guard let tables = try settledTables(rounds: 16, list: userPids,
                                                 inspect: { processFDs($0, output: output) }, exited: hasExited) else {
                return unsettledList
            }
            guard try stdoutEndpoint() == output else { return "vault stdout changed during recipient inspection" }
            return rejection(stdout: output, caller: caller, current: caller.flatMap { identity($0.pid) }, processes: tables)
        } catch let error as InspectionFailure {
            return error.reason
        } catch {
            return "the vault recipient could not be inspected"
        }
    }
}
