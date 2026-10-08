import SwiftUI

struct WidgetBubbleField: View, Animatable {
    var position: CGFloat
    let count: Int
    let horizontal: Bool
    let enabled: Bool
    var animatableData: CGFloat {
        get { position }
        set { position = newValue }
    }
    var body: some View {
        Canvas { context, size in
            guard enabled, count > 0 else { return }
            context.addFilter(.alphaThreshold(min: 0.45, color: .blue.opacity(0.22)))
            context.addFilter(.blur(radius: 3))
            context.drawLayer { layer in
                let step: CGFloat = horizontal ? 26 : 31
                for index in 0..<count {
                    let center =
                        horizontal
                        ? CGPoint(x: 11 + CGFloat(index) * step, y: size.height / 2)
                        : CGPoint(x: size.width / 2, y: 11 + CGFloat(index) * step)
                    layer.fill(
                        Path(ellipseIn: CGRect(x: center.x - 4, y: center.y - 4, width: 8, height: 8)),
                        with: .color(.white))
                }
                let center =
                    horizontal
                    ? CGPoint(x: 11 + position * step, y: size.height / 2)
                    : CGPoint(x: size.width / 2, y: 11 + position * step)
                layer.fill(
                    Path(ellipseIn: CGRect(x: center.x - 10, y: center.y - 10, width: 20, height: 20)),
                    with: .color(.white))
            }
        }.allowsHitTesting(false).accessibilityHidden(true)
    }
}

struct WidgetGlassControl: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var systemOpaque
    @Environment(\.widgetReduceTransparency) private var requestedOpaque
    func body(content: Content) -> some View {
        if systemOpaque || requestedOpaque {
            content.background(Color(white: 0.16), in: Capsule())
        } else if #available(macOS 26.0, *) {
            content.glassEffect(.regular.tint(.black.opacity(0.4)).interactive(), in: Capsule())
        } else {
            content.background(.ultraThinMaterial, in: Capsule())
        }
    }
}
