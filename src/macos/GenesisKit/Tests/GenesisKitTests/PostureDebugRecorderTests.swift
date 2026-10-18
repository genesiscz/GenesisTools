import AVFoundation
import Foundation
import XCTest
@testable import GenesisKitBase
@testable import GenesisKit
@testable import GenesisKitPosture

/// Dev mode's debug recording: a movie of the analyzed frames and one NDJSON line per reading.
final class PostureDebugRecorderTests: XCTestCase {
    private func folder() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("posture-debug-\(UUID().uuidString)")
    }

    private func frame(at time: TimeInterval) throws -> CameraFrame {
        let base = try VisionPoseBenchTests.frame()
        return CameraFrame(pixelBuffer: base.pixelBuffer, time: time, meanLuma: base.meanLuma)
    }

    func testItWritesTheMovieAndOneLogLinePerFrame() throws {
        let dir = folder()
        defer { try? FileManager.default.removeItem(at: dir) }
        let done = expectation(description: "finished")
        let box = ResultBox()
        let recorder = PostureDebugRecorder(folder: dir, maxDuration: 10) { result in
            box.result = result
            done.fulfill()
        }
        let base = try XCTUnwrap(PostureBaseline.calibrate(upright: (0..<4).map { _ in PostureMetrics(sample: postureSample()) }))
        recorder.writeStart(baseline: base, scorer: PostureScorer(), engine: .visionBody)
        let score = PostureScorer().score(PostureMetrics(sample: postureSample(noseY: 0.6)), against: base)
        for index in 0..<5 {
            XCTAssertTrue(recorder.append(frame: try frame(at: 100 + Double(index) * 0.25),
                                          sample: postureSample(noseY: 0.6), score: score, state: .slouching))
        }
        recorder.stop()
        wait(for: [done], timeout: 20)

        let result = try XCTUnwrap(box.result)
        XCTAssertNil(result.error)
        XCTAssertEqual(result.frames, 5)
        XCTAssertEqual(result.duration, 1, accuracy: 1e-6)
        let movie = try XCTUnwrap(result.movie)
        let size = try XCTUnwrap(try FileManager.default.attributesOfItem(atPath: movie.path)[.size] as? Int)
        XCTAssertGreaterThan(size, 0)

        let lines = try String(contentsOf: result.log, encoding: .utf8).split(separator: "\n")
        XCTAssertEqual(lines.count, 6, "a start line, then one per frame")
        let start = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(lines[0].utf8)) as? [String: Any])
        XCTAssertEqual(start["type"] as? String, "start")
        XCTAssertNotNil(start["baseline"])
        let last = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(lines[5].utf8)) as? [String: Any])
        XCTAssertEqual(last["state"] as? String, "slouching")
        XCTAssertEqual(last["t"] as? Double, 1)
        let lastScore = try XCTUnwrap(last["score"] as? [String: Any])
        XCTAssertEqual(lastScore["isBad"] as? Bool, true)
        XCTAssertNotNil((last["metrics"] as? [String: Any])?["headHeight"])
    }

    func testItStopsByItselfAfterTheLongestDuration() throws {
        let dir = folder()
        defer { try? FileManager.default.removeItem(at: dir) }
        let done = expectation(description: "finished")
        let box = ResultBox()
        let recorder = PostureDebugRecorder(folder: dir, maxDuration: 0.5) { result in
            box.result = result
            done.fulfill()
        }
        XCTAssertTrue(recorder.append(frame: try frame(at: 0), sample: nil, score: nil, state: .monitoring))
        XCTAssertTrue(recorder.append(frame: try frame(at: 0.25), sample: nil, score: nil, state: .monitoring))
        XCTAssertFalse(recorder.append(frame: try frame(at: 0.5), sample: nil, score: nil, state: .monitoring),
                       "time is up at the third frame")
        XCTAssertFalse(recorder.append(frame: try frame(at: 0.75), sample: nil, score: nil, state: .monitoring))
        wait(for: [done], timeout: 20)
        XCTAssertEqual(box.result?.frames, 3)
    }

    /// Review of #514: a log that could not be made was ignored, and the result still read as error-free.
    func testAnUnwritableLogIsReportedAsAnError() throws {
        let dir = folder()
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: dir.appendingPathComponent("log.ndjson").path)
            try? FileManager.default.removeItem(at: dir)
        }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let log = dir.appendingPathComponent("log.ndjson")
        try Data().write(to: log)
        try FileManager.default.setAttributes([.posixPermissions: 0o444], ofItemAtPath: log.path)

        let done = expectation(description: "finished")
        let box = ResultBox()
        let recorder = PostureDebugRecorder(folder: dir, maxDuration: 10) { result in
            box.result = result
            done.fulfill()
        }
        recorder.stop()
        wait(for: [done], timeout: 20)
        let error = try XCTUnwrap(box.result?.error, "a log that was never written is an error")
        XCTAssertTrue(error.contains("log"), error)
    }
}

private final class ResultBox: @unchecked Sendable {
    var result: PostureDebugRecording?
}
