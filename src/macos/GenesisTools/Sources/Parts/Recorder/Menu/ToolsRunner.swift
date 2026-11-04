import Foundation

/// Starts a `tools` command that outlives the click: a recording owns its process and socket, so the menu only
/// launches it and watches the live folder. Its output goes to `~/.genesis-tools/logs/recorder-start.log`, which a
/// failed start names.
enum ToolsRunner {
    static func detached(_ argv: [String]) throws {
        let binary = ToolsBridge.defaultBinaryPath()
        let plan = ToolsBridge.launchPlan(binaryPath: binary, argv: argv)
        let process = Process()
        process.executableURL = plan.executable
        process.arguments = plan.arguments
        process.currentDirectoryURL = plan.workingDirectory
        process.environment = ToolsBridge.scrubbedEnvironment()
        let log = URL(fileURLWithPath: genesisHome()).appendingPathComponent(".genesis-tools/logs/recorder-start.log")
        try? FileManager.default.createDirectory(at: log.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: log.path) {
            FileManager.default.createFile(atPath: log.path, contents: nil)
        }
        let handle = try FileHandle(forWritingTo: log)
        handle.seekToEndOfFile()
        handle.write(Data("\(Date()) tools \(argv.joined(separator: " "))\n".utf8))
        process.standardOutput = handle
        process.standardError = handle
        process.standardInput = FileHandle.nullDevice
        process.terminationHandler = { finished in
            if finished.terminationStatus != 0 {
                HubPerf.log("recorder: tools \(argv.joined(separator: " ")) exited \(finished.terminationStatus); see \(log.path)")
            }
        }
        try process.run()
    }
}
