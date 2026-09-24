import Foundation

/// A finished child process: its exit status and both streams.
struct ProcessCapture {
    var status: Int32
    var stdout: Data
    var stderr: Data
}

/// Thrown by `runCapturing` when the child outlived its timeout. The child was sent SIGTERM, then
/// SIGKILL if it was still running 2 s later.
struct ProcessTimeout: Error, CustomStringConvertible {
    var command: String
    var seconds: TimeInterval

    var description: String { "\(command) did not exit within \(Int(seconds)) s and was killed" }
}

extension Process {
    /// Starts the process, reads stdout and stderr while it runs, then waits for it to exit.
    /// Reading one pipe to its end before the other, or waiting before reading, deadlocks as soon as
    /// the child fills an unread pipe (64 KB) and blocks on its next write.
    /// `mergeStderr` sends both streams into one pipe, and `stderr` is then empty.
    /// The caller sets the executable, arguments, environment and stdin. `afterStart` runs once the
    /// process is running and before any output is read, e.g. to start feeding a stdin pipe.
    /// A child still running after `timeout` seconds is terminated and `ProcessTimeout` is thrown.
    /// The 60 s default is well above the slowest call the hub logged (`tools ai-spend session`, 25 s).
    func runCapturing(
        mergeStderr: Bool = false,
        timeout: TimeInterval = 60,
        afterStart: (() -> Void)? = nil
    ) throws -> ProcessCapture {
        let out = Pipe()
        let err: Pipe? = mergeStderr ? nil : Pipe()
        standardOutput = out
        standardError = err ?? out
        let exited = DispatchSemaphore(value: 0)
        terminationHandler = { _ in exited.signal() }
        try run()
        let outReader = PipeReader(out, stream: "stdout")
        let errReader = err.map { PipeReader($0, stream: "stderr") }
        afterStart?()
        if exited.wait(timeout: .now() + timeout) == .timedOut {
            terminate()
            if exited.wait(timeout: .now() + 2) == .timedOut {
                kill(processIdentifier, SIGKILL)
                _ = exited.wait(timeout: .now() + 2)
            }
            let deadline = DispatchTime.now() + 2
            _ = outReader.finish(by: deadline)
            _ = errReader?.finish(by: deadline)
            let command = ([executableURL?.lastPathComponent ?? "process"] + (arguments ?? []).prefix(3)).joined(separator: " ")
            FileHandle.standardError.write(Data("process: \(command) killed after \(Int(timeout)) s\n".utf8))
            throw ProcessTimeout(command: command, seconds: timeout)
        }

        let deadline = DispatchTime.now() + 2
        return ProcessCapture(
            status: terminationStatus,
            stdout: outReader.finish(by: deadline),
            stderr: errReader?.finish(by: deadline) ?? Data()
        )
    }
}

/// Collects one pipe as its data arrives, on the file handle's own dispatch source.
private final class PipeReader: @unchecked Sendable {
    private let handle: FileHandle
    private let stream: String
    private let lock = NSLock()
    private var data = Data()
    private let done = DispatchSemaphore(value: 0)

    init(_ pipe: Pipe, stream: String) {
        handle = pipe.fileHandleForReading
        self.stream = stream
        handle.readabilityHandler = { [self] handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                done.signal()
                return
            }
            lock.lock()
            data.append(chunk)
            lock.unlock()
        }
    }

    /// Called after the child exited, so the pipe reaches its end at once unless a grandchild
    /// inherited it (a login shell's background job). The shared deadline (2 s after exit) covers that
    /// case: what arrived so far is returned and the reader stops.
    func finish(by deadline: DispatchTime) -> Data {
        if done.wait(timeout: deadline) == .timedOut {
            handle.readabilityHandler = nil
            FileHandle.standardError.write(Data("process: \(stream) still open 2 s after exit, returned what arrived\n".utf8))
        }
        lock.lock()
        defer { lock.unlock() }
        return data
    }
}
