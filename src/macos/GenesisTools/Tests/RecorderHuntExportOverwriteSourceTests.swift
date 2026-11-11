import Foundation
import XCTest
@testable import GenesisToolsRecorder

/// Round 2 hunt (r2-export-overwrite-source): the export refused only a target whose standardized path was the source
/// movie's, so a symlink to the movie, or the movie through /private, passed the check and was written over.
final class RecorderHuntExportOverwriteSourceTests: XCTestCase {
    private func refusesAsInput(_ project: EditProject, _ target: URL, file: StaticString = #filePath, line: UInt = #line) async {
        do {
            _ = try await EditExporter.export(project: project, to: target) { _ in }
            XCTFail("the export into \(target.path) was not refused", file: file, line: line)
        } catch let error as EditExporter.ExportError {
            guard case .overwritesInput = error else {
                return XCTFail("refused for another reason: \(error)", file: file, line: line)
            }
        } catch {
            XCTFail("refused for another reason: \(error)", file: file, line: line)
        }
    }

    func testAnExportIntoTheSourceMovieThroughASymlinkOrPrivateIsRefused() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("overwrite-source-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let movie = folder.appendingPathComponent("screen.mp4")
        try Data("original".utf8).write(to: movie)
        let project = EditProject.whole(video: movie.path, durationUs: 2_000_000, width: 320, height: 200, cursor: nil, recording: nil)

        await refusesAsInput(project, movie)
        let link = folder.appendingPathComponent("link.mp4")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: movie)
        await refusesAsInput(project, link)
        await refusesAsInput(project, movie.resolvingSymlinksInPath())
        XCTAssertEqual(try String(contentsOf: movie, encoding: .utf8), "original", "the source movie keeps its bytes")
    }
}
