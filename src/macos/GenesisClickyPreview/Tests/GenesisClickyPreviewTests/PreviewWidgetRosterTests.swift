import XCTest
@testable import GenesisClickyPreview

final class PreviewWidgetRosterTests: XCTestCase {
    private func run(script: String, in folder: URL) throws -> String {
        let tools = folder.appendingPathComponent("tools-\(UUID().uuidString)")
        try script.write(to: tools, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tools.path)
        let process = Process()
        process.executableURL = tools
        process.arguments = ["hub", "widget", "snapshot", "--json"]
        process.currentDirectoryURL = folder
        let output = Pipe()
        process.standardOutput = output
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(decoding: data, as: UTF8.self)
    }

    func testTheStandInToolsPrintsTheSnapshotWhateverItsFileNameHolds() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("clicky-roster-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let content = #"{"version":1,"sessions":[]}"#
        let names = [
            "plain.json",
            "it's mine.json",
            "a'; touch injected-marker; echo '.json",
            "$(touch injected-marker) \"quoted\" `x`.json",
        ]

        for name in names {
            let snapshot = folder.appendingPathComponent(name)
            try Data(content.utf8).write(to: snapshot)
            let printed = try run(script: PreviewWidgetRoster.toolsScript(snapshot: snapshot), in: folder)
            XCTAssertEqual(printed, content, "the snapshot named \(name) is printed as it is")
        }
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: folder.appendingPathComponent("injected-marker").path),
            "a file name is data: nothing in it runs as shell")
    }
}
