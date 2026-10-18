import Foundation

/// The window a plain launch opens: a Finder double-click, a Dock click with nothing running,
/// `open -a GenesisTools`. Set in the settings window's Settings tab (Martin, 2026-10-01).
///
/// `--window` (`tools macos permissions ui`, the hub's lock button, ⌘, in the hub) always opens the
/// permissions window, so it stays one click away when the hub is the main window.
enum AppMainWindow: String, CaseIterable, Identifiable {
    case permissions
    case hub

    static let key = "app.mainWindow"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .permissions: return "Permissions and settings"
        case .hub: return "Hub"
        }
    }

    static var current: AppMainWindow {
        UserDefaults.standard.string(forKey: key).flatMap(AppMainWindow.init(rawValue:)) ?? .permissions
    }
}
