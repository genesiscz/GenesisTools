import AppKit
import SwiftUI

/// A settings row with a slider: the title and detail on the left, the track and its formatted value on the right
/// ("1.00×", "45 s"). The value applies live while the knob moves; `onCommit` runs once when a drag that changed the
/// value ends (also when the system cancels it), on each arrow-key step and on each accessibility increment, so a
/// host that persists with a synchronous file write does it once per gesture, never per drag tick or plain click.
///
/// The track is drawn here rather than by `NSSlider`: the system slider greys its fill outside the key window and has
/// no hover state. This one keeps the accent fill, grows the knob under the pointer, shows the pointing hand, takes
/// the arrow keys when focused (Shift for ten steps) and adjusts through VoiceOver and UI automation (AXIncrement).
public struct NativeSettingsSlider: View {
    private let title: String
    private let detail: String?
    private let identifier: String
    @Binding private var value: Double
    private let range: ClosedRange<Double>
    private let step: Double?
    private let ticks: [Double]
    private let width: CGFloat
    private let format: (Double) -> String
    private let onCommit: ((Double) -> Void)?

    /// - Parameters:
    ///   - step: snap to multiples of `step` from the range's lower bound; `nil` is continuous (arrow keys then move
    ///     a twentieth of the range).
    ///   - ticks: values marked under the track (`[0.5, 1, 1.5, 2]`); empty draws none.
    ///   - format: the value label, also the accessibility value.
    ///   - onCommit: runs with the final value at the end of each gesture.
    public init(
        _ title: String, detail: String? = nil, identifier: String, value: Binding<Double>,
        in range: ClosedRange<Double>, step: Double? = nil, ticks: [Double] = [], width: CGFloat = 200,
        format: @escaping (Double) -> String, onCommit: ((Double) -> Void)? = nil
    ) {
        self.title = title
        self.detail = detail
        self.identifier = identifier
        _value = value
        self.range = range
        self.step = step
        self.ticks = ticks
        self.width = width
        self.format = format
        self.onCommit = onCommit
    }

    public var body: some View {
        NativeSettingsRow(title, detail: detail) {
            HStack(spacing: 12) {
                NativeSettingsSliderTrack(
                    value: $value, range: range, step: step, ticks: ticks, label: title, identifier: identifier,
                    valueText: format, onCommit: onCommit
                )
                .frame(width: width)
                Text(verbatim: format(value))
                    .font(.system(size: 12, weight: .semibold, design: .rounded)).monospacedDigit()
                    .lineLimit(1)
                    .frame(minWidth: 44, alignment: .trailing)
                    .fixedSize()
                    .accessibilityHidden(true)
            }
            .nativeSettingsDisabledLook()
        }
    }
}

/// The value math of `NativeSettingsSlider`, kept pure for tests.
enum NativeSettingsSliderMath {
    static func clamped(_ raw: Double, in range: ClosedRange<Double>) -> Double {
        min(max(raw, range.lowerBound), range.upperBound)
    }

    /// The value nearest `raw` that the slider can hold: inside the range and on a step.
    static func snapped(_ raw: Double, in range: ClosedRange<Double>, step: Double?) -> Double {
        let value = clamped(raw, in: range)
        guard let step, step > 0 else { return value }
        let steps = ((value - range.lowerBound) / step).rounded()
        // A step that does not divide the range leaves the upper bound reachable only by clamping.
        return clamped(range.lowerBound + steps * step, in: range)
    }

    /// 0...1 along the track.
    static func fraction(_ value: Double, in range: ClosedRange<Double>) -> Double {
        let span = range.upperBound - range.lowerBound
        guard span > 0 else { return 0 }
        return (clamped(value, in: range) - range.lowerBound) / span
    }

    /// One keyboard or accessibility step.
    static func nudge(_ value: Double, by count: Int, in range: ClosedRange<Double>, step: Double?) -> Double {
        let unit = step.flatMap { $0 > 0 ? $0 : nil } ?? (range.upperBound - range.lowerBound) / 20
        return snapped(value + Double(count) * unit, in: range, step: step)
    }
}

struct NativeSettingsSliderTrack: View {
    @Binding var value: Double
    let range: ClosedRange<Double>
    let step: Double?
    let ticks: [Double]
    let label: String
    let identifier: String
    let valueText: (Double) -> String
    let onCommit: ((Double) -> Void)?

    @Environment(\.isEnabled) private var isEnabled
    @GenReduceMotion private var reduceMotion
    @State private var hovering = false
    /// True while a drag runs; resets by itself when the system cancels the gesture, which `onEnded` never hears.
    @GestureState private var dragging = false
    /// The value when the drag started, so a drag that changed nothing commits nothing.
    @State private var dragStart: Double?
    @FocusState private var focused: Bool

    private static let knob: CGFloat = 16
    private static let trackHeight: CGFloat = 4

    var body: some View {
        GeometryReader { proxy in
            let usable = max(1, proxy.size.width - Self.knob)
            let fraction = NativeSettingsSliderMath.fraction(value, in: range)
            let knobX = Self.knob / 2 + usable * fraction
            let midY = Self.knob / 2 + 3
            ZStack(alignment: .topLeading) {
                Capsule()
                    .fill(Color.white.opacity(0.11))
                    .overlay(Capsule().strokeBorder(Color.black.opacity(0.25), lineWidth: 0.5))
                    .frame(width: proxy.size.width - Self.knob, height: Self.trackHeight)
                    .position(x: proxy.size.width / 2, y: midY)
                Capsule()
                    .fill(LinearGradient(
                        colors: [Color.accentColor.opacity(0.72), Color.accentColor],
                        startPoint: .leading, endPoint: .trailing))
                    .frame(width: max(Self.trackHeight, knobX - Self.knob / 2), height: Self.trackHeight)
                    .position(x: Self.knob / 2 + max(Self.trackHeight, knobX - Self.knob / 2) / 2, y: midY)
                ForEach(Array(ticks.enumerated()), id: \.offset) { _, tick in
                    let tickX = Self.knob / 2 + usable * NativeSettingsSliderMath.fraction(tick, in: range)
                    Capsule()
                        .fill(Color.white.opacity(tick <= value ? 0.55 : 0.26))
                        .frame(width: 1.5, height: 4)
                        .position(x: tickX, y: midY + 9)
                }
                Circle()
                    .fill(Color.white)
                    .overlay(Circle().strokeBorder(Color.black.opacity(0.18), lineWidth: 0.5))
                    .shadow(color: .black.opacity(0.35), radius: 1.5, y: 1)
                    .overlay {
                        if focused {
                            Circle().strokeBorder(Color.accentColor.opacity(0.75), lineWidth: 2).padding(-3)
                        }
                    }
                    .frame(width: Self.knob, height: Self.knob)
                    .scaleEffect(reduceMotion ? 1 : (dragging ? 1.16 : (hovering ? 1.08 : 1)))
                    .position(x: knobX, y: midY)
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0, coordinateSpace: .local)
                    .updating($dragging) { _, state, _ in state = true }
                    .onChanged { drag in
                        if dragStart == nil { dragStart = value }
                        let raw = range.lowerBound
                            + Double((drag.location.x - Self.knob / 2) / usable) * (range.upperBound - range.lowerBound)
                        set(NativeSettingsSliderMath.snapped(raw, in: range, step: step))
                    }
            )
        }
        // One place for the end of a drag, ended or cancelled: the knob shrinks back and a changed value commits.
        .onChange(of: dragging) { _, active in
            guard !active else { return }
            let start = dragStart
            dragStart = nil
            if let start, start != value { onCommit?(value) }
        }
        .frame(height: ticks.isEmpty ? 22 : 28)
        .animation(reduceMotion ? nil : KitTheme.quick, value: hovering)
        .animation(reduceMotion ? nil : KitTheme.quick, value: dragging)
        .pointerCursor(isEnabled)
        .onHover { inside in
            let next = inside && isEnabled
            if hovering != next { hovering = next }
        }
        // Keyboard focus only through keyboard navigation (Tab with Full Keyboard Access), like a system control: a
        // plain focusable view took the window's first focus and drew its ring on a page that was just opened.
        .focusable(isEnabled, interactions: .activate)
        .focused($focused)
        .focusEffectDisabled()
        .onKeyPress(keys: [.leftArrow, .rightArrow, .downArrow, .upArrow]) { press in
            let direction = press.key == .leftArrow || press.key == .downArrow ? -1 : 1
            step(by: direction * (press.modifiers.contains(.shift) ? 10 : 1))
            return .handled
        }
        .accessibilityElement()
        .accessibilityLabel(label)
        .accessibilityValue(valueText(value))
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: step(by: 1)
            case .decrement: step(by: -1)
            @unknown default: break
            }
        }
        .accessibilityIdentifier(identifier)
    }

    private func set(_ next: Double) {
        if next != value { value = next }
    }

    private func step(by count: Int) {
        let next = NativeSettingsSliderMath.nudge(value, by: count, in: range, step: step)
        guard next != value else { return }
        value = next
        onCommit?(next)
    }
}
