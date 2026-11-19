import AppKit
import SwiftUI
import Vision
import XCTest
@testable import GenesisKitBase
@testable import GenesisKit

@MainActor
private final class WorkRemovalPictureSource: WorkSource {
    var value = WorkSnapshotValue(project: "Orchard", containers: [
        .init(ref: "h_open_evidence", type: "handoff", state: "active", title: "Open container evidence",
              open: 1, total: 1, members: [
                .init(ref: "w_member_evidence", state: "open", type: "task", title: "Expanded member retained"),
              ]),
    ], triage: [
        .init(ref: "w_kept_evidence", group: "reopened-no-worker", type: "bug", state: "reopened",
              title: "A row that stays"),
        .init(ref: "w_removed_evidence", group: "reopened-no-worker", type: "bug", state: "reopened",
              title: "Fading evidence row"),
    ])
    var reads = 0
    private var continuation: AsyncStream<Void>.Continuation?
    func projects() async throws -> [String] { ["Orchard"] }
    func snapshot(project: String) async throws -> WorkSnapshotValue { reads += 1; return value }
    func detail(ref: String) async throws -> WorkItemDetail { throw WorkSourceError("No detail in this fixture") }
    func notify(project: String) async throws -> [WorkNotifyRow] { [] }
    func perform(_ action: WorkScreenAction, project: String) async throws -> WorkActionOutcome {
        throw WorkSourceError("This evidence fixture never writes")
    }
    func changes() -> AsyncStream<Void> { AsyncStream { continuation = $0 } }
    func tick() { continuation?.yield(()) }
}

private struct WorkRemovalPictureView: View {
    @ObservedObject var screen: WorkScreenModel
    var body: some View {
        if let snapshot = screen.snapshot {
            // This is the same modifier as WorkMain. No second withAnimation/transition implementation.
            // One persistent WorkItemsView identity also preserves the container's own @State expansion.
            WorkItemsView(snapshot: snapshot, pending: screen.pending, expandAll: snapshot.triage.count == 2) { _ in }
                .workRowUpdates(screen: screen)
                .padding(16)
        }
    }
}

@MainActor
final class WorkScreenTestsRemoval: XCTestCase {
    func testTheProductionLastRowFadesWhenTheSnapshotRemovesIt() async throws {
        let samples = try await capture(reduceMotion: false)
        let middle = samples.filter { $0.oldInk > 0.08 && $0.oldInk < 0.92 && $0.residual < 0.2 }
        XCTAssertGreaterThanOrEqual(Set(middle.map { Int(($0.oldInk * 100).rounded()) }).count, 2,
            "Production disappearance must contain at least two measured opacity frames, not just distinct images")
    }

    func testTheProductionLastRowLeavesInstantlyUnderReduceMotion() async throws {
        let samples = try await capture(reduceMotion: true)
        let middle = samples.filter { $0.oldInk > 0.08 && $0.oldInk < 0.92 && $0.residual < 0.2 }
        XCTAssertEqual(middle.count, 0)
        XCTAssertLessThan(try XCTUnwrap(samples.last?.oldInk), 0.01)
    }

    private func capture(reduceMotion: Bool) async throws -> [(time: Double, oldInk: Double, residual: Double)] {
        let source = WorkRemovalPictureSource()
        let screen = WorkScreenModel(source: source, reloadInterval: 0.02, settle: 0.005)
        screen.activate()
        defer { screen.deactivate() }
        let deadline = ContinuousClock.now + .seconds(2)
        while screen.snapshot == nil && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(1))
        }
        XCTAssertNotNil(screen.snapshot)
        let reads = source.reads
        let frames = try await WorkMotionPictureEvidence.recordLive(
            WorkRemovalPictureView(screen: screen)
                .environment(\.nativeSettingsReduceMotion, reduceMotion),
            size: CGSize(width: 760, height: 420), mutate: {
                source.value.triage.removeLast()
                source.tick()
            })
        XCTAssertGreaterThan(source.reads, reads, "a real store-stream tick must trigger a real model reload")
        XCTAssertEqual(screen.project, "Orchard")
        XCTAssertEqual(screen.snapshot?.triage.count, 1)
        XCTAssertFalse(screen.isLoading, "background reload stays quiet")
        let before = try XCTUnwrap(frames.first?.image)
        let after = try XCTUnwrap(frames.last?.image)
        XCTAssertTrue(try recognizedText(before).contains("Expanded member retained"), "container starts expanded")
        XCTAssertTrue(try recognizedText(after).contains("Expanded member retained"),
                      "the same container stays expanded after the model replaces the project snapshot")
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: before).perform([request])
        let text = try XCTUnwrap(request.results?.first {
            $0.topCandidates(1).first?.string.contains("Fading evidence row") == true
        }, "The removed row must really be drawn before the mutation")
        let box = text.boundingBox
        let crop = CGRect(x: box.minX * CGFloat(before.width),
                          y: (1 - box.maxY) * CGFloat(before.height),
                          width: box.width * CGFloat(before.width),
                          height: box.height * CGFloat(before.height)).integral
        let samples = try WorkMotionPictureEvidence.fadeSamples(frames, crop: crop)
        if let folder = ProcessInfo.processInfo.environment["WIDGET_SHOTS"] {
            let stem = reduceMotion ? "work-removed-row-reduced" : "work-removed-row"
            try WorkMotionPictureEvidence.write(frames, folder: folder, stem: stem)
            let values = samples.map { ["elapsedMS": $0.time, "oldInk": $0.oldInk, "residual": $0.residual] }
            try JSONSerialization.data(withJSONObject: values, options: [.prettyPrinted, .sortedKeys])
                .write(to: URL(fileURLWithPath: folder).appendingPathComponent(stem + "-samples.json"))
        }
        return samples
    }

    private func recognizedText(_ image: CGImage) throws -> String {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }
}
