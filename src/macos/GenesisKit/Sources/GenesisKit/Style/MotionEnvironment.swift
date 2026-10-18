import SwiftUI

// The two Reduce Motion settings GenMotion reads, beside it, so a base-only build has them without the settings
// window and the widget.
private struct NativeReduceMotionKey: EnvironmentKey { static let defaultValue = false }
private struct WidgetReduceMotionKey: EnvironmentKey { static let defaultValue = false }

extension EnvironmentValues {
    public var nativeSettingsReduceMotion: Bool {
        get { self[NativeReduceMotionKey.self] }
        set { self[NativeReduceMotionKey.self] = newValue }
    }

    public var widgetReduceMotion: Bool {
        get { self[WidgetReduceMotionKey.self] }
        set { self[WidgetReduceMotionKey.self] = newValue }
    }
}
