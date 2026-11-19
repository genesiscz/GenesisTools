import CryptoKit
import Darwin
import Foundation
import Security

/// A menu click in the widget reaches the recorder that holds this home's lock. The Unix peer's audit token comes
/// from the kernel, so another local process cannot make a payload look as though GenesisTools sent it.
enum RecorderMenuIPC {
    enum Delivery: Equatable, Sendable { case delivered, unavailable, refused }

    static func addressKey(for lockFile: URL) -> String {
        SHA256.hash(data: Data(lockFile.resolvingSymlinksInPath().path.utf8))
            .prefix(12).map { String(format: "%02x", $0) }.joined()
    }

    static func socketPath(key: String, pid: pid_t) -> String? {
        // The OS supplies a short, per-user directory shared with the other face. An inherited TMPDIR can differ.
        let capacity = Int(PATH_MAX)
        var directory = [CChar](repeating: 0, count: capacity)
        let size = confstr(_CS_DARWIN_USER_TEMP_DIR, &directory, capacity)
        guard size > 0, size <= capacity else { return nil }
        return NSString(string: String(cString: directory)).appendingPathComponent("gt-rec-menu-\(key)-\(pid)")
    }

    @MainActor
    static func send(_ command: RecorderMenu.Command) {
        var owner = recorderInstance.runningPID
        if owner == nil {
            guard command != .quit else { return }
            FaceLaunch.start(["--recorder", "--no-activate"], activates: false)
        }
        Task {
            let deadline = ContinuousClock.now + .seconds(5)
            repeat {
                owner = owner ?? recorderInstance.runningPID
                if let pid = owner {
                    let result = await Task.detached(priority: .userInitiated) { deliver(command, to: pid) }.value
                    if result == .delivered { return }
                    if result == .refused { break }
                }
                try? await Task.sleep(for: .milliseconds(100))
            } while ContinuousClock.now < deadline
            RecorderNotice.failure("Recorder did not accept the menu action.")
        }
    }

    @MainActor
    static func listen(key: String = recorderAddressKey,
                       _ handle: @escaping @MainActor @Sendable (RecorderMenu.Command) -> Void) -> DispatchSourceRead? {
        guard let path = socketPath(key: key, pid: getpid()) else { return nil }
        // lint-rules-ignore: a one-byte command socket that authenticates the peer's code signature; JSONRPCSocketClient only dials JSON-RPC
        let listener = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listener >= 0 else { return nil }
        // A killed process can leave the socket file behind. Only this pid binds this pathname.
        unlink(path)
        guard fcntl(listener, F_SETFD, FD_CLOEXEC) == 0,
              fcntl(listener, F_SETFL, O_NONBLOCK) == 0,
              withAddress(path, { bind(listener, $0, $1) }) == 0,
              chmod(path, 0o600) == 0, Darwin.listen(listener, 8) == 0 else {
            HubPerf.log("recorder: could not listen for menu actions (errno \(errno))")
            close(listener)
            unlink(path)
            return nil
        }
        let source = DispatchSource.makeReadSource(fileDescriptor: listener, queue: .global(qos: .userInitiated))
        source.setEventHandler {
            let peer = accept(listener, nil, nil)
            guard peer >= 0 else { return }
            defer { close(peer) }

            // Authenticate before reading a command. A silent peer must never block Recorder's main thread.
            guard configure(peer), authenticatedPeer(peer) else { return }
            var byte: UInt8 = 0
            guard recv(peer, &byte, 1, 0) == 1, let command = RecorderMenu.Command(rawValue: byte) else { return }

            // Reply before the menu action can open a modal panel or quit.
            guard Darwin.send(peer, &byte, 1, 0) == 1 else { return }
            Task { @MainActor in handle(command) }
        }
        source.setCancelHandler {
            close(listener)
            unlink(path)
        }
        source.resume()
        return source
    }

    static func deliver(_ command: RecorderMenu.Command, to pid: pid_t, key: String = recorderAddressKey) -> Delivery {
        guard let path = socketPath(key: key, pid: pid) else { return .refused }
        // lint-rules-ignore: a one-byte command socket that authenticates the peer's code signature; JSONRPCSocketClient only dials JSON-RPC
        let peer = socket(AF_UNIX, SOCK_STREAM, 0)
        guard peer >= 0 else { return .refused }
        defer { close(peer) }
        guard configure(peer) else { return .refused }

        guard let connected = withAddress(path, { connect(peer, $0, $1) }) else { return .refused }
        if connected != 0 { return .unavailable }
        guard authenticatedPeer(peer, expectedPID: pid) else { return .refused }
        var request = command.rawValue
        var reply: UInt8 = 0
        // Once sent, do not retry an ambiguous result. The first request may already have started a recording.
        guard Darwin.send(peer, &request, 1, 0) == 1, recv(peer, &reply, 1, 0) == 1, reply == request else {
            return .refused
        }
        return .delivered
    }

    static func unlinkOwnSocket() {
        if let path = socketPath(key: recorderAddressKey, pid: getpid()) { unlink(path) }
    }

    static func authenticatedPeer(_ socket: Int32, expectedPID: pid_t? = nil) -> Bool {
        var uid: uid_t = 0
        var gid: gid_t = 0
        guard getpeereid(socket, &uid, &gid) == 0, uid == geteuid() else { return false }
        if let expectedPID {
            var pid: pid_t = 0
            var size = socklen_t(MemoryLayout<pid_t>.size)
            guard getsockopt(socket, SOL_LOCAL, LOCAL_PEERPID, &pid, &size) == 0, pid == expectedPID else { return false }
        }

        var token = audit_token_t()
        var size = socklen_t(MemoryLayout<audit_token_t>.size)
        guard getsockopt(socket, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &size) == 0,
              size == MemoryLayout<audit_token_t>.size else { return false }
        let attributes = [kSecGuestAttributeAudit as String: withUnsafeBytes(of: &token) { Data($0) }] as CFDictionary
        let flags = SecCSFlags()
        var own: SecCode?
        var ownStatic: SecStaticCode?
        var requirement: SecRequirement?
        var peer: SecCode?
        guard SecCodeCopySelf(flags, &own) == errSecSuccess, let own,
              SecCodeCopyStaticCode(own, flags, &ownStatic) == errSecSuccess, let ownStatic,
              SecCodeCopyDesignatedRequirement(ownStatic, flags, &requirement) == errSecSuccess, let requirement,
              SecCodeCopyGuestWithAttributes(nil, attributes, flags, &peer) == errSecSuccess, let peer else { return false }
        return SecCodeCheckValidity(peer, flags, requirement) == errSecSuccess
    }

    private static func configure(_ socket: Int32) -> Bool {
        var one: Int32 = 1
        var deadline = timeval(tv_sec: 2, tv_usec: 0)
        let size = socklen_t(MemoryLayout<timeval>.size)
        return fcntl(socket, F_SETFD, FD_CLOEXEC) == 0
            && fcntl(socket, F_SETFL, 0) == 0
            && setsockopt(socket, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size)) == 0
            && setsockopt(socket, SOL_SOCKET, SO_RCVTIMEO, &deadline, size) == 0
            && setsockopt(socket, SOL_SOCKET, SO_SNDTIMEO, &deadline, size) == 0
    }

    private static func withAddress<T>(_ path: String, _ use: (UnsafePointer<sockaddr>, socklen_t) -> T) -> T? {
        var address = sockaddr_un()
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { return nil }
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
        let length = MemoryLayout<sockaddr_un>.size
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(length)
        return withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { use($0, socklen_t(length)) }
        }
    }
}
