import Foundation

/// Why the camera cannot watch.
public enum PostureCameraIssue: Equatable, Sendable {
    /// The user has not allowed the camera (or has not been asked yet).
    case unauthorized
    /// The chosen camera is not connected.
    case noDevice
    /// macOS stopped the session (another app took the camera, or the system did) and it did not restart.
    case interrupted
    case failed(String)
}
