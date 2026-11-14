import AVFoundation

extension AVAssetWriterInput {
    struct NotReady: Error {}

    /// Waits until a fixture movie's writer takes its next sample, with a deadline: a writer that failed is never ready
    /// again, and the test then fails instead of hanging the run.
    func waitUntilReady(seconds: TimeInterval = 30) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while !isReadyForMoreMediaData {
            guard Date() < deadline else { throw NotReady() }
            try await Task.sleep(for: .milliseconds(5))
        }
    }
}
