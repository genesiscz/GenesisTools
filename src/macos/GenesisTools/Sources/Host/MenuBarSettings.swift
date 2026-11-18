import Foundation

package enum MenuBarSettings {
    package static let appKey = "app.menuBar.showItem"
    package static let recorderKey = "recorder.menuBar.separateItem"

    package static func showsApp(in defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: appKey) as? Bool ?? true
    }

    package static func separateRecorder(in defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: recorderKey) as? Bool ?? true
    }

    package static var changed: Notification.Name { .init(NativePreview.namespace + ".menuBar.changed") }

    package static func postChanged() {
        DistributedNotificationCenter.default().postNotificationName(
            changed, object: NativePreview.namespace, userInfo: nil, deliverImmediately: true)
    }
}
