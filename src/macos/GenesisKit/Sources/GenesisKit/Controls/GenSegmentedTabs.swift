import SwiftUI

/// A segmented choice that looks the same in every window.
///
/// The native segmented `Picker` draws its selected segment in the accent colour only while its window is
/// key, and grey otherwise. The widget's top and side panels are separate non-activating panels, so the
/// same tabs showed blue in one and grey in the other. Here the selected segment always draws the same.
/// Each segment is a real button with a hover fill and the pointing-hand cursor.
///
/// One pill marks the selection. When the selection changes, the pill slides to the new segment and takes its width
/// on the `GenMotion` curve; under Reduce Motion it moves at once. The titles are drawn twice, in the colours of a
/// segment outside the pill and in the colours of the pill inside it, so a title changes exactly where the pill
/// covers it while the pill moves. Only the pill and the segment widths animate: what the selection switches belongs
/// to the caller and changes at once.
///
/// The surfaces come from the window's `KitLook`. A segment may carry a glyph, a count and a hue: the hue colours
/// the glyph and the count ("Questions 9" in the colour of a question).
public struct GenSegmentedTabs<ID: Hashable>: View {
    public struct Item {
        public let id: ID
        public let title: String
        public let symbol: String?
        public let count: Int?
        public let hue: KitHue
        /// False: the segment shows dimmed and takes no click (a view that has nothing to show now).
        public let isEnabled: Bool

        public init(_ id: ID, _ title: String, symbol: String? = nil, count: Int? = nil, hue: KitHue = .neutral,
                    isEnabled: Bool = true) {
            self.id = id
            self.title = title
            self.symbol = symbol
            self.count = count
            self.hue = hue
            self.isEnabled = isEnabled
        }
    }

    private let items: [Item]
    @Binding private var selection: ID
    private let label: String
    private let minSegmentWidth: CGFloat
    private let identifier: String?
    /// Equal segments over the width it is given (an inspector column), instead of its own width.
    private let fillsWidth: Bool
    private let size: KitControlSize
    /// Light text on the dark panels it was made for, dark text in a light window (the markdown viewer's light theme).
    @Environment(\.colorScheme) private var scheme
    @Environment(\.kitLook) private var look
    @GenReduceMotion private var reduceMotion

    /// `identifier` names the group for UI automation; each segment is then `<identifier>.<id>`, the id as
    /// `GenAccessibilityID.suffix` spells it (an enum case's name, a string as it is).
    public init(_ label: String, items: [Item], selection: Binding<ID>, minSegmentWidth: CGFloat = 72,
                identifier: String? = nil, fillsWidth: Bool = false, size: KitControlSize = .regular) {
        self.label = label
        self.items = items
        _selection = selection
        self.minSegmentWidth = minSegmentWidth
        self.identifier = identifier
        self.fillsWidth = fillsWidth
        self.size = size
    }

    /// What a title is drawn for: the button's own (clear, it only gives the size), outside the pill, inside it.
    private enum Layer { case sizing, segment, thumb }

    /// How the titles take their width.
    private enum Fit {
        /// The strip has its own width: each title with the size's padding.
        case natural
        /// Over a given width, every title whole with 8 pt on each side.
        case roomy
        /// Over a given width that `roomy` does not fit: one text size down, 5 pt on each side.
        case compact
        /// The same text with 3 pt on each side: the last step that keeps every title whole.
        case tight
        /// The titles alone, one text size down with 6 pt on each side, each as wide as its words: a glyph or a count of
        /// three digits took the room a title needed, and a cut title is worse than a count the bar below repeats.
        case bare
        /// The last step: the titles alone in equal segments; they scale down to 85 % and then cut.
        case scaled

        /// Draws a segment's glyph and count.
        var showsExtras: Bool { self != .bare && self != .scaled }
        /// Every title keeps its own width.
        var keepsTitles: Bool { self == .roomy || self == .compact || self == .tight || self == .bare }

        var fills: Bool { self != .natural }

        func padding(_ size: KitControlSize) -> CGFloat {
            switch self {
            case .natural: size.padding
            case .roomy: 8
            case .compact: 5
            case .tight: 3
            case .bare: 6
            case .scaled: 4
            }
        }
    }

    private var segmentHeight: CGFloat { size.height - 2 }
    private var inset: CGFloat { look.wellInset }
    private var thumbRadius: CGFloat { look.radius(.thumb, height: segmentHeight, legacy: 6) }
    private var wellRadius: CGFloat { look.radius(.well, height: segmentHeight + 2 * inset, legacy: 8) }
    private var selectedHue: KitHue { items.first { $0.id == selection }?.hue ?? .neutral }

    public var body: some View {
        if fillsWidth {
            // Every title at its full size while they fit the width with room around them: a long title takes the
            // room it needs from the short ones. In a narrower column every title steps down one size together
            // (equal segments shrank only the long titles, so one strip drew two text sizes). Only then they scale.
            ViewThatFits(in: .horizontal) {
                strip(.roomy)
                strip(.compact)
                strip(.tight)
                strip(.bare)
                strip(.scaled)
            }
        } else {
            strip(.natural)
        }
    }

    private func strip(_ fit: Fit) -> some View {
        // The buttons: hit areas, hover fills and the frames the pill and the titles follow. Their own titles are
        // clear; the visible ones are the two layers above.
        HStack(spacing: 2) {
            ForEach(items, id: \.id) { item in
                segment(item, fit)
            }
        }
        .padding(inset)
        // One pill behind the segments, placed on the selected one's frame. A change of selection moves its frame,
        // and the animation below carries it there: it slides and reshapes rather than fading out and in.
        .backgroundPreferenceValue(GenSegmentFrames.self) { frames in
            thumb(frames)
        }
        .overlayPreferenceValue(GenSegmentFrames.self) { frames in
            ZStack {
                titles(.segment, fit)
                    .mask {
                        Rectangle()
                            .overlay { thumbShape(frames).blendMode(.destinationOut) }
                            .compositingGroup()
                    }
                titles(.thumb, fit)
                    .mask { thumbShape(frames) }
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
        .background(KitSurfaceBackground(look.surface(.well, scheme: scheme), radius: wellRadius, corners: look.corners))
        .animation(GenMotion.animation(expanding: true, reduceMotion: reduceMotion), value: selection)
        .fixedSize(horizontal: !fillsWidth, vertical: true)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
        .chartAccessibilityIdentifier(identifier)
    }

    private func segment(_ item: Item, _ fit: Fit) -> some View {
        let selected = item.id == selection
        return Button {
            selection = item.id
        } label: {
            title(item, .sizing, fit)
                .contentShape(RoundedRectangle(cornerRadius: thumbRadius, style: look.corners))
        }
        .buttonStyle(GenSegmentStyle(selected: selected, radius: thumbRadius))
        .disabled(!item.isEnabled)
        .anchorPreference(key: GenSegmentFrames.self, value: .bounds) { [AnyHashable(item.id): $0] }
        .accessibilityLabel(item.count.map { "\(item.title), \($0)" } ?? item.title)
        .chartAccessibilityIdentifier(identifier.map { "\($0).\(GenAccessibilityID.suffix(item.id))" })
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// Every title in one layer's colours, laid out exactly as the buttons are.
    private func titles(_ layer: Layer, _ fit: Fit) -> some View {
        HStack(spacing: 2) {
            ForEach(items, id: \.id) { item in
                title(item, layer, fit)
            }
        }
        .padding(inset)
    }

    private func title(_ item: Item, _ layer: Layer, _ fit: Fit) -> some View {
        let surface = layer == .thumb
            ? look.surface(.thumb, hue: item.hue, scheme: scheme, selected: true)
            : look.surface(.segment, hue: item.hue, scheme: scheme)
        let step: CGFloat = fit == .compact || fit == .tight || fit == .bare ? 1 : 0
        return HStack(spacing: 5) {
            if let symbol = item.symbol, fit.showsExtras {
                Image(systemName: symbol)
                    .font(.system(size: size.glyph - step, weight: .medium))
                    .foregroundStyle(layer == .sizing ? Color.clear : surface.glyph)
            }
            Text(item.title)
                .font(.system(size: size.font - step, weight: item.id == selection ? .semibold : .medium))
                .lineLimit(1)
                .minimumScaleFactor(fit == .scaled ? 0.85 : 1)
                .fixedSize(horizontal: fit.keepsTitles, vertical: false)
                .foregroundStyle(layer == .sizing ? Color.clear : surface.label)
            if let count = item.count, fit.showsExtras {
                countPill(count, item, layer)
            }
        }
        .opacity(item.isEnabled ? 1 : 0.4)
        .padding(.horizontal, fit.padding(size))
        .frame(minWidth: fit.fills ? 0 : minSegmentWidth, maxWidth: fit.fills ? .infinity : nil, minHeight: segmentHeight)
    }

    /// The count beside a title, in the item's hue.
    private func countPill(_ count: Int, _ item: Item, _ layer: Layer) -> some View {
        let surface = look.surface(.badge, hue: item.hue, scheme: scheme, selected: layer == .thumb)
        return Text(verbatim: "\(count)")
            .font(.system(size: size.font - 1.5, weight: .semibold))
            .monospacedDigit()
            .foregroundStyle(surface.label)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 5)
            .frame(minWidth: 17, minHeight: 15)
            .background(Capsule().fill(surface.fill))
            .opacity(layer == .sizing ? 0 : 1)
    }

    /// The pill on the selected segment's frame, in the space of the view it decorates.
    private func thumb(_ frames: [AnyHashable: Anchor<CGRect>]) -> some View {
        GeometryReader { proxy in
            if let anchor = frames[AnyHashable(selection)] {
                let frame = proxy[anchor]
                let surface = look.surface(.thumb, hue: selectedHue, scheme: scheme, selected: true)
                KitSurfaceBackground(surface, radius: thumbRadius, corners: look.corners)
                    .overlay(alignment: .bottom) {
                        if let indicator = surface.indicator {
                            Capsule().fill(indicator).frame(width: max(10, frame.width - 22), height: 2).padding(.bottom, 2)
                        }
                    }
                    .frame(width: frame.width, height: frame.height)
                    .offset(x: frame.minX, y: frame.minY)
            }
        }
    }

    /// The pill's shape alone, for the masks that split the two title layers.
    private func thumbShape(_ frames: [AnyHashable: Anchor<CGRect>]) -> some View {
        GeometryReader { proxy in
            if let anchor = frames[AnyHashable(selection)] {
                let frame = proxy[anchor]
                RoundedRectangle(cornerRadius: thumbRadius, style: look.corners)
                    .fill(.black)
                    .frame(width: frame.width, height: frame.height)
                    .offset(x: frame.minX, y: frame.minY)
            }
        }
    }
}

/// Each segment's frame, for the one pill.
private struct GenSegmentFrames: PreferenceKey {
    static var defaultValue: [AnyHashable: Anchor<CGRect>] { [:] }

    static func reduce(value: inout [AnyHashable: Anchor<CGRect>], nextValue: () -> [AnyHashable: Anchor<CGRect>]) {
        value.merge(nextValue()) { $1 }
    }
}

/// A segment: the look's hover fill and pressed fill on an unselected segment (in the window's ink, so a light
/// window shows it too), none on the selected one, which the pill marks.
private struct GenSegmentStyle: ButtonStyle {
    let selected: Bool
    let radius: CGFloat

    func makeBody(configuration: Configuration) -> some View {
        GenSegmentBody(configuration: configuration, selected: selected, radius: radius)
    }
}

private struct GenSegmentBody: View {
    let configuration: ButtonStyleConfiguration
    let selected: Bool
    let radius: CGFloat
    @State private var hovering = false
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.kitForcedInteraction) private var forced
    @Environment(\.kitLook) private var look
    @Environment(\.colorScheme) private var scheme
    @GenReduceMotion private var reduceMotion

    var body: some View {
        configuration.label
            .background {
                if !selected {
                    RoundedRectangle(cornerRadius: radius, style: look.corners)
                        .fill(look.surface(.segment, state, scheme: scheme).fill)
                }
            }
            .pointerCursor(isEnabled)
            .onHover { inside in
                let next = isEnabled && inside
                guard next != hovering else { return }
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.12)) { hovering = next }
            }
            // A segment that leaves the screen under a still pointer gets no exit event.
            .onDisappear { hovering = false }
    }

    private var state: KitInteraction {
        if configuration.isPressed || forced == .pressed { return .pressed }
        return hovering || forced == .hover ? .hover : .rest
    }
}
