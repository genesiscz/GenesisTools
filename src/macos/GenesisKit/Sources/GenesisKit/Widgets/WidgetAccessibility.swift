import SwiftUI

private struct WidgetReduceMotionKey: EnvironmentKey { static let defaultValue = false }
private struct WidgetReduceTransparencyKey: EnvironmentKey { static let defaultValue = false }

extension EnvironmentValues {
    public var widgetReduceMotion: Bool {
        get { self[WidgetReduceMotionKey.self] }
        set { self[WidgetReduceMotionKey.self] = newValue }
    }
    public var widgetReduceTransparency: Bool {
        get { self[WidgetReduceTransparencyKey.self] }
        set { self[WidgetReduceTransparencyKey.self] = newValue }
    }
}

extension View {
    /// Preview overrides can add restrictions; the system accessibility preferences still win.
    public func widgetAccessibility(reduceMotion: Bool, reduceTransparency: Bool) -> some View {
        environment(\.widgetReduceMotion, reduceMotion)
            .environment(\.widgetReduceTransparency, reduceTransparency)
    }
}
