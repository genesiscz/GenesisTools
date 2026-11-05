import AVFoundation
import Foundation
import GenesisKit

/// The camera grant, read and requested straight through `AVCaptureDevice`. It is deliberately not a
/// `PermissionKind` case: a new case changes every exhaustive switch in the apps' permission code.
public enum CameraAuthorizationStatus: String, Sendable {
    case notDetermined, restricted, denied, authorized
}

public enum CameraAuthorization {
    public static var status: CameraAuthorizationStatus {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: .authorized
        case .denied: .denied
        case .restricted: .restricted
        case .notDetermined: .notDetermined
        @unknown default: .denied
        }
    }

    /// Whether the running bundle declares `NSCameraUsageDescription`. Without it, macOS ends the
    /// process at the first camera request, so `request()` refuses to ask. macOS judges the
    /// responsible process, not this bundle: a tool started from a terminal (`swift test`, `swift run`)
    /// is ended even when its own Info.plist has the key, so never request from such a process.
    public static var hasUsageDescription: Bool {
        Bundle.main.object(forInfoDictionaryKey: "NSCameraUsageDescription") != nil
    }

    /// Asks macOS for the camera when the user has not answered yet, and returns whether it is allowed.
    /// The prompt shows only once per app; after a denial the answer is `false` until the user changes
    /// it in System Settings (`settingsURL`). Returns `false` without asking when the bundle has no
    /// usage description.
    public static func request() async -> Bool {
        await request(status: status, hasUsageDescription: hasUsageDescription) {
            await withCheckedContinuation { continuation in
                AVCaptureDevice.requestAccess(for: .video) { continuation.resume(returning: $0) }
            }
        }
    }

    /// The decision behind `request()`, with the system prompt passed in (tests pass a spy).
    static func request(status: CameraAuthorizationStatus, hasUsageDescription: Bool,
                        ask: () async -> Bool) async -> Bool {
        switch status {
        case .authorized: return true
        case .denied, .restricted: return false
        case .notDetermined:
            guard hasUsageDescription else { return false }
            return await ask()
        }
    }

    /// Privacy & Security → Camera.
    public static var settingsURL: URL { PermissionKind.settingsURL(anchor: "Privacy_Camera") }
}

/// A camera the user can pick.
public struct CameraDevice: Identifiable, Hashable, Sendable {
    public enum Kind: String, Sendable {
        case builtIn, external, continuity, other
    }

    /// `AVCaptureDevice.uniqueID`, stable across launches for the same camera.
    public var id: String
    public var name: String
    public var kind: Kind

    public init(id: String, name: String, kind: Kind) {
        self.id = id
        self.name = name
        self.kind = kind
    }

    /// Built-in, external (USB) and Continuity cameras. Desk View is left out: it shows the desk, not
    /// the user. A Continuity camera is reported as its own kind only when the app's Info.plist sets
    /// `NSCameraUseContinuityCameraDeviceType`; otherwise macOS reports it as a built-in camera.
    public static func available() -> [CameraDevice] {
        AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .external, .continuityCamera],
            mediaType: .video, position: .unspecified
        ).devices.map(CameraDevice.init(device:))
    }

    init(device: AVCaptureDevice) {
        let kind: Kind = switch device.deviceType {
        case .builtInWideAngleCamera: .builtIn
        case .external: .external
        case .continuityCamera: .continuity
        default: .other
        }
        self.init(id: device.uniqueID, name: device.localizedName, kind: kind)
    }
}

/// Which camera to use: the system default, or one camera by id.
public enum CameraSelection: Hashable, Codable, Sendable {
    /// The camera the user prefers system-wide (`systemPreferredCamera`, so an external webcam they chose wins), except
    /// a Continuity iPhone, which macOS makes preferred by itself when the phone comes near (PoseEngines research):
    /// then the built-in camera, else the default video device.
    case systemDefault
    case device(id: String)

    /// The stored form: `"default"` or the device's unique id.
    public var storageValue: String {
        switch self {
        case .systemDefault: "default"
        case let .device(id): id
        }
    }

    public init(storageValue: String?) {
        guard let storageValue, !storageValue.isEmpty, storageValue != "default" else {
            self = .systemDefault
            return
        }
        self = .device(id: storageValue)
    }

    private static func preferredUnlessContinuity() -> AVCaptureDevice? {
        guard let preferred = AVCaptureDevice.systemPreferredCamera, preferred.deviceType != .continuityCamera else {
            return nil
        }
        return preferred
    }

    /// The device this selection names now, nil when that camera is not connected.
    public func resolve() -> AVCaptureDevice? {
        switch self {
        case .systemDefault:
            Self.preferredUnlessContinuity()
                ?? AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .unspecified)
                ?? AVCaptureDevice.default(for: .video)
        case let .device(id):
            AVCaptureDevice(uniqueID: id)
        }
    }
}
