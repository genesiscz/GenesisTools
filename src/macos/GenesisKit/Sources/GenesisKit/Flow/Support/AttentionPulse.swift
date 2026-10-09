// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Components/AttentionPulse.swift at 2026-10-08T05:10:39+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import SwiftUI

/// How an attention pulse looks and moves. Two presets cover the cases so far; every field
/// is tunable for the next one.
///
/// A pulse is a coloured border, optionally with a tinted fill, that fades in and out a few
/// times over `duration` and then leaves nothing behind. It is an opacity change only: no
/// shadow, no scale, so it costs nothing at rest (see `PulseGlow` in Theme.swift for why an
/// animated shadow is banned here).
struct AttentionPulseStyle: Equatable {
    var color: Color
    var cornerRadius: CGFloat
    var lineWidth: CGFloat = 3
    /// Border opacity at the top of each blink.
    var borderOpacity: Double = 0.95
    /// Fill opacity at the top of each blink. 0 draws the border only.
    var fillOpacity: Double = 0
    /// Total length of the pulse, in seconds.
    var duration: TimeInterval = 4
    /// One blink: the "on" half, then the "off" half.
    var period: TimeInterval = 1
    /// How long each blink takes to fade in and to fade out. Equal to half the period gives a
    /// smooth breathing blink; shorter values give a sharper flash that holds.
    var fadeIn: TimeInterval = 0.5
    var fadeOut: TimeInterval = 0.5

    /// Number of blinks. Never zero, and a zero period cannot divide by zero.
    var cycles: Int { max(1, Int((duration / max(period, 0.05)).rounded())) }

    /// Three quick flashes of border and fill over about 1.4 s. Reads as "look here, now".
    static func flash(color: Color, cornerRadius: CGFloat) -> Self {
        Self(color: color, cornerRadius: cornerRadius, fillOpacity: 0.30,
             duration: 1.44, period: 0.48, fadeIn: 0.12, fadeOut: 0.2)
    }

    /// Four slow blinks of the border only, over 4 s. Asks for attention without alarm.
    static func slowBorder(color: Color, cornerRadius: CGFloat) -> Self {
        Self(color: color, cornerRadius: cornerRadius)
    }
}

/// Plays one `AttentionPulseStyle` over the view each time `trigger` changes. A new trigger
/// while a pulse runs restarts it rather than stacking a second one on top.
struct AttentionPulse<Trigger: Equatable>: ViewModifier {
    let trigger: Trigger
    let style: AttentionPulseStyle

    @State private var isOn = false
    @State private var running: Task<Void, Never>?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// One step of a pulse: show or hide the border, animated or not, then wait.
    struct Step: Equatable {
        var on: Bool
        var animation: TimeInterval?
        var waitNanoseconds: UInt64
    }

    /// Reduce Motion gets a static indication: the border shows, without fading, for the pulse's duration.
    static func steps(style: AttentionPulseStyle, reduceMotion: Bool) -> [Step] {
        if reduceMotion {
            return [Step(on: true, animation: nil, waitNanoseconds: UInt64(max(style.duration, 0) * 1_000_000_000)),
                    Step(on: false, animation: nil, waitNanoseconds: 0)]
        }
        let half = UInt64(max(style.period, 0.05) / 2 * 1_000_000_000)
        return (0 ..< style.cycles).flatMap { _ in
            [Step(on: true, animation: style.fadeIn, waitNanoseconds: half),
             Step(on: false, animation: style.fadeOut, waitNanoseconds: half)]
        }
    }

    func body(content: Content) -> some View {
        content
            // Drawn over everything and never hit-testable: a pulse must not eat the next click.
            .overlay {
                ZStack {
                    RoundedRectangle(cornerRadius: style.cornerRadius, style: .continuous)
                        .fill(style.color.opacity(isOn ? style.fillOpacity : 0))
                    RoundedRectangle(cornerRadius: style.cornerRadius, style: .continuous)
                        .strokeBorder(style.color.opacity(isOn ? style.borderOpacity : 0),
                                      lineWidth: style.lineWidth)
                }
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
            .onChange(of: trigger) { _, _ in play() }
            // Turning Reduce Motion on mid-pulse replaces the blinking with the static border at once.
            .onChange(of: reduceMotion) { _, _ in if running != nil { play() } }
            .onDisappear { running?.cancel() }
    }

    private func play() {
        running?.cancel()
        let steps = Self.steps(style: style, reduceMotion: reduceMotion)
        running = Task { @MainActor in
            for step in steps {
                if let duration = step.animation {
                    withAnimation(.easeInOut(duration: duration)) { isOn = step.on }
                } else {
                    isOn = step.on
                }
                if step.waitNanoseconds > 0 { try? await Task.sleep(nanoseconds: step.waitNanoseconds) }
                if Task.isCancelled { return }
            }
            running = nil
        }
    }
}

extension View {
    /// Blinks this view for attention each time `trigger` changes. Pass a counter you bump.
    func attentionPulse<Trigger: Equatable>(trigger: Trigger, style: AttentionPulseStyle) -> some View {
        modifier(AttentionPulse(trigger: trigger, style: style))
    }
}
