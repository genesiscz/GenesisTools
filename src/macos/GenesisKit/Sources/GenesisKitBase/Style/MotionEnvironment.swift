import SwiftUI

// The two "reduce motion" requests GenMotion reads besides the system's own: the widget's preview override
// (Widgets/WidgetAccessibility.swift sets it) and the settings window's (Settings/NativeGlass.swift). In the base
// library because GenMotion is; their transparency siblings stay with their views.
private struct WidgetReduceMotionKey: EnvironmentKey { static let defaultValue = false }
private struct NativeReduceMotionKey: EnvironmentKey { static let defaultValue = false }

extension EnvironmentValues {
    public var widgetReduceMotion: Bool {
        get { self[WidgetReduceMotionKey.self] }
        set { self[WidgetReduceMotionKey.self] = newValue }
    }

    public var nativeSettingsReduceMotion: Bool {
        get { self[NativeReduceMotionKey.self] }
        set { self[NativeReduceMotionKey.self] = newValue }
    }
}
