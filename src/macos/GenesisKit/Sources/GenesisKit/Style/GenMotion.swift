import AppKit
import SwiftUI

/// The one motion family for expanding and collapsing: disclosures, inbox cards and the panels that fit them.
///
/// The curve is the drawer curve the edge panels open with: it starts fast and settles without overshoot. Opening
/// is a deliberate action and gets a little longer; closing is a response and gets out of the way. Both stay under
/// 300 ms. Under Reduce Motion every change is instant.
public enum GenMotion {
    /// Cubic Bézier control points, shared with the Core Animation outline of the edge panels.
    public static let curve: (Float, Float, Float, Float) = (0.32, 0.72, 0, 1)
    public static let expandDuration: Double = 0.24
    public static let collapseDuration: Double = 0.2
    /// Removed content fades faster than its container closes, so it never sits on the rows moving up over it.
    public static let removalFadeDuration: Double = 0.1
    /// The most rows one change may add to or take from a non-lazy stack with an animation. Every row of an animated
    /// insert is built and animated at once: a whole list of PR threads inserted that way stalled the main thread for
    /// 1.4 s (swift skill, performance.md). A longer "Show N more" appears at once.
    public static let maxAnimatedRows = 24

    public static func duration(expanding: Bool) -> Double {
        expanding ? expandDuration : collapseDuration
    }

    /// The SwiftUI animation for one expand or collapse, or nil for an instant change.
    public static func animation(expanding: Bool, reduceMotion: Bool, scale: Double = 1) -> Animation? {
        guard !reduceMotion else { return nil }
        return .timingCurve(
            Double(curve.0), Double(curve.1), Double(curve.2), Double(curve.3),
            duration: duration(expanding: expanding) * scale)
    }

    /// Runs `change` inside one expand or collapse animation (none under Reduce Motion).
    public static func perform(expanding: Bool, reduceMotion: Bool, _ change: () -> Void) {
        if let animation = animation(expanding: expanding, reduceMotion: reduceMotion) {
            withAnimation(animation, change)
        } else {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction, change)
        }
    }

    /// The system's Reduce Motion, for code that has no SwiftUI environment (window controllers).
    @MainActor public static var systemReduceMotion: Bool {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }
}

public extension AnyTransition {
    /// Content that a disclosure or a card reveals: it fades in a few points above its place while the container
    /// makes room, and fades out quickly while the container closes over it. Pair it with a clipped container.
    static var genReveal: AnyTransition {
        .asymmetric(
            insertion: .opacity.combined(with: .offset(y: -4)),
            removal: .opacity.animation(.easeOut(duration: GenMotion.removalFadeDuration)))
    }
}

/// Reduce Motion as every GenesisKit surface reads it: the system setting, the app's own setting (settings window,
/// hub) or the widget's. `@GenReduceMotion private var reduceMotion`.
@propertyWrapper
public struct GenReduceMotion: DynamicProperty {
    @Environment(\.accessibilityReduceMotion) private var system
    @Environment(\.nativeSettingsReduceMotion) private var app
    @Environment(\.widgetReduceMotion) private var widget

    public init() {}

    public var wrappedValue: Bool { system || app || widget }
}

/// What a container that fits its content learns from a disclosure inside it: that the content is about to open
/// (true) or close (false), just before the change runs inside its `GenMotion` animation. A container whose height
/// is a measured value (`FittedScroll`) animates its next height change with it; a typed character or new data does
/// not announce itself, so those changes stay instant.
@MainActor
public final class GenExpansionHost {
    var action: (Bool) -> Void = { _ in }
    weak var parent: GenExpansionHost?

    public init() {}

    /// Tells this container and every fitted container around it.
    public func willChange(_ expanding: Bool) {
        action(expanding)
        parent?.willChange(expanding)
    }
}

private struct GenExpansionHostKey: EnvironmentKey {
    static let defaultValue: GenExpansionHost? = nil
}

public extension EnvironmentValues {
    /// The nearest fitted container around this view, if any (`onGenExpansion`).
    var genExpansionHost: GenExpansionHost? {
        get { self[GenExpansionHostKey.self] }
        set { self[GenExpansionHostKey.self] = newValue }
    }
}

private struct GenExpansionHostModifier: ViewModifier {
    let action: (Bool) -> Void
    @Environment(\.genExpansionHost) private var parent
    /// One object for the view's lifetime, so the environment value below never changes identity and no disclosure
    /// renders again because its container did.
    @State private var host = GenExpansionHost()

    func body(content: Content) -> some View {
        host.action = action
        host.parent = parent
        return content.environment(\.genExpansionHost, host)
    }
}

public extension View {
    /// Runs `action` when a `GenDisclosure` (or another expanding view) inside is about to open or close.
    func onGenExpansion(_ action: @escaping (Bool) -> Void) -> some View {
        modifier(GenExpansionHostModifier(action: action))
    }
}
