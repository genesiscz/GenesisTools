import SwiftUI

/// How the kit's controls draw their surfaces. A control never chooses a fill, a stroke or a radius by itself: it
/// names the surface it is (`KitSurfaceRole`) and its state, and the look answers. So a look is one table, every
/// control follows it, and a window can try another look with `.kitLook(_:)` on its root.
///
/// `classic` is what the kit drew before looks existed, value for value. A new look is a new case here and one file
/// with its table; the compiler then names every switch that must answer for it.
public enum KitLook: String, CaseIterable, Sendable, Identifiable {
    case classic
    /// Raised dark surfaces, a hue per meaning, a soft glow under the one main action.
    case aurora
    /// Capsules, saturated gradients for what is selected or primary, counts as bright chips.
    case candy
    /// Top-lit translucent surfaces and hairlines; colour shows state only.
    case glass

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .classic: "Classic"
        case .aurora: "Aurora"
        case .candy: "Candy"
        case .glass: "Glass"
        }
    }

    /// The fill, stroke, shadow and label colours of one surface in one state.
    /// `tint` is a colour the caller insists on (a destructive red on a hover disc); it wins over the hue.
    public func surface(_ role: KitSurfaceRole, _ state: KitInteraction = .rest, hue: KitHue = .neutral,
                        scheme: ColorScheme = .dark, selected: Bool = false, tint: Color? = nil) -> KitSurface {
        let ask = KitSurfaceAsk(role: role, state: state, hue: hue, ink: scheme == .dark ? .white : .black,
                                dark: scheme == .dark, selected: selected, tint: tint)
        switch self {
        case .classic: return KitClassicLook.surface(ask)
        case .aurora: return KitAuroraLook.surface(ask)
        case .candy: return KitCandyLook.surface(ask)
        case .glass: return KitGlassLook.surface(ask)
        }
    }

    /// The corner radius of a surface `height` points high. `legacy` is the radius the control had before looks
    /// existed; `classic` answers it, so the old drawing stays exact.
    public func radius(_ role: KitSurfaceRole, height: CGFloat, legacy: CGFloat) -> CGFloat {
        switch self {
        case .classic: return legacy
        case .aurora:
            switch role {
            case .well: return 9
            case .thumb, .segment: return 6.5
            case .badge: return height / 2
            default: return height <= 24 ? 7 : (height <= 28 ? 8 : 9)
            }
        case .candy: return height / 2
        case .glass:
            switch role {
            case .well: return 8
            case .thumb, .segment: return 6
            case .badge: return height / 2
            default: return 7
            }
        }
    }

    /// The curve of a corner. A capsule needs the circular one: the continuous curve at half the height draws a kink.
    public var corners: RoundedCornerStyle {
        self == .candy ? .circular : .continuous
    }

    /// The gap between a segmented group's edge and its segments.
    public var wellInset: CGFloat {
        switch self {
        case .classic, .glass: 2
        case .aurora, .candy: 3
        }
    }
}

/// What a surface is, whatever control draws it.
public enum KitSurfaceRole: Sendable {
    /// The ground of a segmented group.
    case well
    /// The pill on the selected segment.
    case thumb
    /// A segment that is not selected.
    case segment
    /// The one filled main action.
    case primary
    /// A secondary action or a switched-on toggle in a hue.
    case tinted
    /// A quiet filled action: a skip button, a choice chip.
    case soft
    /// An outlined action.
    case ghost
    /// Words only.
    case plain
    /// A count beside a title.
    case badge
    /// A control that draws nothing at rest and a wash under the pointer: an icon button, a link row.
    case wash
}

/// One question to a look's table.
public struct KitSurfaceAsk {
    public let role: KitSurfaceRole
    public let state: KitInteraction
    public let hue: KitHue
    /// White in a dark window, black in a light one.
    public let ink: Color
    public let dark: Bool
    /// The segment under the thumb, or a badge on it.
    public let selected: Bool
    public let tint: Color?

    /// The hue's ink, or the caller's own colour.
    public var colour: Color { tint ?? hue.ink }

    /// One of three values by state.
    public func by<Value>(_ rest: Value, _ hover: Value, _ pressed: Value) -> Value {
        switch state {
        case .rest: rest
        case .hover: hover
        case .pressed: pressed
        }
    }
}

public struct KitShadow {
    public var color: Color
    public var radius: CGFloat
    public var y: CGFloat

    public init(_ color: Color, radius: CGFloat, y: CGFloat) {
        self.color = color
        self.radius = radius
        self.y = y
    }
}

/// How one surface draws.
public struct KitSurface {
    public var fill: AnyShapeStyle
    public var stroke: AnyShapeStyle?
    public var strokeWidth: CGFloat
    public var shadow: KitShadow?
    public var label: Color
    public var glyph: Color
    /// Added to the whole control (label and ground), as the filled button always did on hover and press.
    public var brightness: Double
    /// A short bar under the label: a look that marks the selected segment with a line and not with a fill.
    public var indicator: Color?

    public init(fill: some ShapeStyle = Color.clear, stroke: AnyShapeStyle? = nil, strokeWidth: CGFloat = 1,
                shadow: KitShadow? = nil, label: Color, glyph: Color? = nil, brightness: Double = 0, indicator: Color? = nil) {
        self.fill = AnyShapeStyle(fill)
        self.stroke = stroke
        self.strokeWidth = strokeWidth
        self.shadow = shadow
        self.label = label
        self.glyph = glyph ?? label
        self.brightness = brightness
        self.indicator = indicator
    }

    /// A stroke in one colour.
    public static func line(_ color: Color) -> AnyShapeStyle { AnyShapeStyle(color) }

    /// A stroke lit from above: strong at the top edge, weak at the bottom.
    public static func lit(_ top: Color, _ bottom: Color) -> AnyShapeStyle {
        AnyShapeStyle(LinearGradient(colors: [top, bottom], startPoint: .top, endPoint: .bottom))
    }

    /// A fill from a light top to a deeper bottom.
    public static func fall(_ top: Color, _ bottom: Color) -> LinearGradient {
        LinearGradient(colors: [top, bottom], startPoint: .top, endPoint: .bottom)
    }
}

/// A surface as a background: the fill in a rounded shape, its stroke and its shadow.
public struct KitSurfaceBackground: View {
    private let surface: KitSurface
    private let radius: CGFloat
    private let corners: RoundedCornerStyle

    public init(_ surface: KitSurface, radius: CGFloat, corners: RoundedCornerStyle = .continuous) {
        self.surface = surface
        self.radius = radius
        self.corners = corners
    }

    public var body: some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: corners)
        ground(shape)
            .overlay {
                if let stroke = surface.stroke {
                    shape.strokeBorder(stroke, lineWidth: surface.strokeWidth)
                }
            }
    }

    @ViewBuilder
    private func ground(_ shape: RoundedRectangle) -> some View {
        if let shadow = surface.shadow {
            // A shadow that never changes with the state of its control: nothing animates it.
            shape.fill(surface.fill).shadow(color: shadow.color, radius: shadow.radius, y: shadow.y)
        } else {
            shape.fill(surface.fill)
        }
    }
}

private struct KitLookKey: EnvironmentKey {
    static let defaultValue = KitLook.classic
}

public extension EnvironmentValues {
    /// The look the kit's controls draw in. A window sets it once on its root.
    var kitLook: KitLook {
        get { self[KitLookKey.self] }
        set { self[KitLookKey.self] = newValue }
    }
}

public extension View {
    /// Draws every kit control inside in `look`.
    func kitLook(_ look: KitLook) -> some View {
        environment(\.kitLook, look)
    }
}

/// The three sizes of a kit control. A bar uses one size for everything in it.
public enum KitControlSize: Sendable {
    /// Inside a dense row.
    case small
    /// A toolbar or a panel: the size the kit's controls always had.
    case regular
    /// The main controls of a window: its tabs, the buttons of its player.
    case large

    public var height: CGFloat {
        switch self {
        case .small: 22
        case .regular: 26
        case .large: 30
        }
    }

    public var font: CGFloat {
        switch self {
        case .small: 11
        case .regular: 12
        case .large: 13
        }
    }

    public var glyph: CGFloat { font - 1 }

    public var padding: CGFloat {
        switch self {
        case .small: 8
        case .regular: 10
        case .large: 13
        }
    }
}
