import SwiftUI

/// A health meter (SlouchSniper's "health 98%" row): the title on the left in the bar's colour, a rounded bar that
/// drains from green through amber to red, an optional marker for a threshold, and the percentage on the right. Any
/// accessory (a help button) can follow, as its own control. A change of `value` glides (at once under Reduce
/// Motion); changes under half a percent apply without an animation, so a host may feed raw values often.
///
/// With no value (`value: nil`, nothing measured yet) the title and the dash are muted and the track is empty.
///
/// Identifier: `identifier` on the meter, which reads as its title with the percentage as value.
public struct HealthBar<Accessory: View>: View {
    private let title: String
    private let value: Double?
    private let threshold: Double?
    private let identifier: String?
    private let accessory: Accessory
    @GenReduceMotion private var reduceMotion

    /// - Parameters:
    ///   - value: 0...1; values outside are clamped.
    ///   - threshold: 0...1, marked on the track (where an alert starts); nil draws no marker.
    public init(
        _ title: String = "Health", value: Double, threshold: Double? = nil, identifier: String? = nil,
        @ViewBuilder accessory: () -> Accessory
    ) {
        self.init(title, measured: value, threshold: threshold, identifier: identifier, accessory: accessory)
    }

    /// A meter that may have nothing to show yet: nil draws a muted title, an empty track and "—", and reads as
    /// "Not measured" to accessibility. The accessory still shows.
    public init(
        _ title: String = "Health", value: Double?, threshold: Double? = nil, identifier: String? = nil,
        @ViewBuilder accessory: () -> Accessory
    ) {
        self.init(title, measured: value, threshold: threshold, identifier: identifier, accessory: accessory)
    }

    private init(
        _ title: String, measured: Double?, threshold: Double?, identifier: String?, accessory: () -> Accessory
    ) {
        self.title = title
        self.value = measured.map { $0.isFinite ? min(1, max(0, $0)) : 0 }
        self.threshold = threshold.map { min(1, max(0, $0)) }
        self.identifier = identifier
        self.accessory = accessory()
    }

    public var body: some View {
        HStack(spacing: 16) {
            meter
            accessory
        }
    }

    private var meter: some View {
        let shown = value ?? 0
        let tint = value.map(ChartPalette.ramp) ?? KitPalette.faint
        return HStack(spacing: 16) {
            Text(verbatim: title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(value == nil ? KitPalette.dim : tint)
                .frame(minWidth: 56, alignment: .leading)
            GeometryReader { proxy in
                let width = proxy.size.width
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color.white.opacity(value == nil ? 0.06 : 0.08))
                        .overlay(Capsule().strokeBorder(Color.black.opacity(0.3), lineWidth: 0.5))
                    if value != nil {
                        Capsule()
                            .fill(LinearGradient(
                                colors: [tint.opacity(0.78), tint], startPoint: .leading, endPoint: .trailing))
                            .overlay(
                                Capsule()
                                    .fill(LinearGradient(
                                        colors: [.white.opacity(0.22), .clear], startPoint: .top, endPoint: .center))
                                    .padding(.horizontal, 2).padding(.top, 1))
                            .frame(width: max(shown > 0 ? 10 : 0, width * shown))
                    }
                    if let threshold {
                        RoundedRectangle(cornerRadius: 1)
                            .fill(Color.white.opacity(value == nil ? 0.35 : 0.75))
                            .frame(width: 2, height: 16)
                            .offset(x: min(width - 2, max(0, width * threshold - 1)))
                    }
                }
                .frame(height: 10)
                .frame(maxHeight: .infinity)
            }
            .frame(height: 18)
            Text(verbatim: value.map { "\(Int(($0 * 100).rounded()))%" } ?? "—")
                .font(.system(size: 15, weight: .semibold, design: .rounded)).monospacedDigit()
                .foregroundStyle(value == nil ? KitPalette.dim : tint)
                .frame(minWidth: 46, alignment: .trailing)
        }
        // Keyed by the shown half-percent: a host that feeds raw values at frame rate does not start an animation
        // per frame.
        .animation(
            GenMotion.animation(expanding: true, reduceMotion: reduceMotion, scale: 1.5),
            value: value.map { Int(($0 * 200).rounded()) })
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue(value.map { "\(Int(($0 * 100).rounded())) percent" } ?? "Not measured")
        .chartAccessibilityIdentifier(identifier)
    }
}

public extension HealthBar where Accessory == EmptyView {
    init(_ title: String = "Health", value: Double, threshold: Double? = nil, identifier: String? = nil) {
        self.init(title, value: value, threshold: threshold, identifier: identifier) { EmptyView() }
    }

    init(_ title: String = "Health", value: Double?, threshold: Double? = nil, identifier: String? = nil) {
        self.init(title, value: value, threshold: threshold, identifier: identifier) { EmptyView() }
    }
}
