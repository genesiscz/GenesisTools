import AppKit
import UserNotifications

@MainActor
public struct NativeNotificationClient {
    public var status: () async -> UNAuthorizationStatus
    public var request: () async throws -> Bool
    public var openSettings: () -> Bool

    public init(
        status: @escaping () async -> UNAuthorizationStatus,
        request: @escaping () async throws -> Bool,
        openSettings: @escaping () -> Bool
    ) {
        self.status = status
        self.request = request
        self.openSettings = openSettings
    }

    public static var system: Self {
        Self(
            status: { await UNUserNotificationCenter.current().notificationSettings().authorizationStatus },
            request: { try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) },
            openSettings: {
                guard let bundleID = Bundle.main.bundleIdentifier,
                    let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(bundleID)")
                else { return false }
                return NSWorkspace.shared.open(url)
            })
    }
}
