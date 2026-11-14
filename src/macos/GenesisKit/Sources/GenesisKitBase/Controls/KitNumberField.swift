import AppKit
import SwiftUI

/// What stands before or after the number in a `KitNumberField`: a unit, a sign, a glyph. The reader then sees
/// "± 15 min" or "14 days" in the control and does not look for the unit in a sentence beside it.
public enum KitNumberAdornment: Sendable, Equatable {
    /// Fixed words: "min", "%", "±", "every".
    case text(String)
    /// A noun that follows the count: "1 day", "14 days". An irregular noun names its plural.
    case counted(String, plural: String? = nil)
    /// An SF Symbol.
    case symbol(String)

    /// The words for `value`; nil for a symbol.
    public func words(for value: Int) -> String? {
        switch self {
        case .text(let words): words
        case .counted(let singular, let plural): Plural.word(value, singular, plural)
        case .symbol: nil
        }
    }

    /// Every wording it can show, so the field keeps the room of the widest and never changes its width.
    package var wordings: [String] {
        switch self {
        case .text(let words): [words]
        case .counted(let singular, let plural): [singular, Plural.word(2, singular, plural)]
        case .symbol: []
        }
    }
}

/// Where the step buttons of a `KitNumberField` sit.
public enum KitNumberFieldStyle: Sendable {
    /// Minus on the left and plus on the right of the number: the largest targets. The default.
    case stepper
    /// Two small chevrons at the trailing edge: the narrow form for a dense row.
    case chevrons
    /// No buttons: the number is typed, or stepped with the Up and Down keys.
    case bare
}

/// The value rules of `KitNumberField`, kept pure for tests.
public enum KitNumberFieldMath {
    public static func clamped(_ value: Int, in range: ClosedRange<Int>) -> Int {
        min(range.upperBound, max(range.lowerBound, value))
    }

    /// The number a typed text means: the digits with an optional minus, inside the range. Text that is no number
    /// gives `fallback`, so a field left empty puts its value back.
    public static func parsed(_ text: String, fallback: Int, in range: ClosedRange<Int>) -> Int {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard let typed = Int(trimmed) else { return clamped(fallback, in: range) }
        return clamped(typed, in: range)
    }

    /// `value` moved by `count` steps. A value off the step grid lands on the grid first ("7" with a step of 5 goes
    /// up to 10 and down to 5), then moves whole steps.
    ///
    /// Every step of the sum is checked: a range or a step near the ends of `Int` trapped before the last addition
    /// (Shift with a step of `Int.max` multiplied it by ten). A sum past the end of `Int` is past the range's end in
    /// the same direction, so it lands on that limit.
    public static func stepped(_ value: Int, by count: Int, step: Int, in range: ClosedRange<Int>) -> Int {
        guard count != 0, step > 0 else { return clamped(value, in: range) }
        let limit = count > 0 ? range.upperBound : range.lowerBound
        let remainder = gridRemainder(value, from: range.lowerBound, step: step)
        var next = value
        var left = count
        if remainder != 0 {
            let (onGrid, overflow) = count > 0
                ? value.addingReportingOverflow(step - remainder)
                : value.subtractingReportingOverflow(remainder)
            guard !overflow else { return limit }
            next = onGrid
            left += count > 0 ? -1 : 1
        }
        let (distance, tooFar) = left.multipliedReportingOverflow(by: step)
        guard !tooFar else { return limit }
        let (moved, overflow) = next.addingReportingOverflow(distance)
        return clamped(overflow ? limit : moved, in: range)
    }

    /// How far `value` sits past the step grid that starts at `lowerBound`, in `0..<step`. Each side is reduced by the
    /// step first, so `value - lowerBound` (which overflows for a range across all of `Int`) is never computed.
    private static func gridRemainder(_ value: Int, from lowerBound: Int, step: Int) -> Int {
        func positive(_ number: Int) -> Int {
            let rest = number % step
            return rest < 0 ? rest + step : rest
        }
        let difference = positive(value) - positive(lowerBound)
        return difference < 0 ? difference + step : difference
    }

    /// The most characters a value of the range takes, the minus included.
    public static func digits(in range: ClosedRange<Int>) -> Int {
        max(String(range.lowerBound).count, String(range.upperBound).count)
    }
}

/// A whole number with its unit in one control: "− 48 hours +", "± 15 min", "14 days".
///
/// - The number is a text field: a click anywhere on it edits. Return and a click elsewhere commit, Escape puts the
///   value back, and a typed value outside the range lands on the nearest limit.
/// - Minus and plus step once on a press and keep stepping while held; with Shift a step is ten steps. Up and Down do
///   the same from the keyboard. A button at its limit goes dim.
/// - The binding gets ONE write for each gesture (a held button, a held key, a typed value), never one for each step,
///   so a host that saves with a file write or a call to a service saves once.
/// - The control keeps one width for every value of the range and both forms of a counted unit ("day", "days").
public struct KitNumberField: View {
    private let title: String
    @Binding private var value: Int
    private let range: ClosedRange<Int>
    private let step: Int
    private let prefix: KitNumberAdornment?
    private let suffix: KitNumberAdornment?
    private let style: KitNumberFieldStyle
    private let size: KitControlSize
    private let identifier: String?
    private let minWidth: CGFloat?
    private var previewFocused = false

    /// The text in the field: the value, the value of a hold that runs, or what the reader types.
    @State private var entry: String
    @State private var hovering = false
    /// The value this field wrote and the binding does not show yet (a host that saves through a service shows it a
    /// moment later). Until it does, an older value arriving from the host does not put the field back.
    @State private var sent: Int?
    @State private var settle: Task<Void, Never>?
    @FocusState private var editing: Bool
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.kitLook) private var look
    @Environment(\.colorScheme) private var scheme
    @GenReduceMotion private var reduceMotion

    /// How long the field waits for the host to show a value it wrote, before it shows the host's value again.
    private static let settleTime: Duration = .seconds(2)

    /// - Parameters:
    ///   - title: the accessibility label, and the placeholder of an emptied field.
    ///   - step: one press of a button or an arrow key.
    ///   - identifier: of the text field; the buttons are `<identifier>.decrement` and `<identifier>.increment`.
    ///   - minWidth: the least width of the whole control; the number stays in its middle. Fields under each other
    ///     (the rows of a settings card) take one value, so their buttons stand in two straight columns.
    public init(_ title: String, value: Binding<Int>, in range: ClosedRange<Int>, step: Int = 1,
                prefix: KitNumberAdornment? = nil, suffix: KitNumberAdornment? = nil,
                style: KitNumberFieldStyle = .stepper, size: KitControlSize = .regular, identifier: String? = nil,
                minWidth: CGFloat? = nil) {
        self.title = title
        _value = value
        self.range = range
        self.step = max(1, step)
        self.prefix = prefix
        self.suffix = suffix
        self.style = style
        self.size = size
        self.identifier = identifier
        self.minWidth = minWidth
        _entry = State(initialValue: String(value.wrappedValue))
    }

    /// Draws the field as it looks while the reader types in it. For a picture, where nothing has the keyboard.
    package func previewing(focused: Bool) -> KitNumberField {
        var copy = self
        copy.previewFocused = focused
        return copy
    }

    /// The number the field shows now.
    private var current: Int { KitNumberFieldMath.parsed(entry, fallback: value, in: range) }
    private var ink: Color { scheme == .dark ? .white : .black }
    private var inset: CGFloat { 2 }
    private var valueFont: Font {
        .system(size: size.font + 1.5, weight: .semibold, design: .rounded).monospacedDigit()
    }
    private var focused: Bool { editing || previewFocused }

    public var body: some View {
        let well = look.surface(.well, scheme: scheme)
        let radius = look.radius(.well, height: size.height, legacy: 7)
        let shape = RoundedRectangle(cornerRadius: radius, style: look.corners)
        HStack(spacing: 0) {
            if style == .stepper { stepButton(-1, radius: radius) }
            center
            if style == .stepper { stepButton(1, radius: radius) }
            if style == .chevrons {
                VStack(spacing: 0) {
                    stepButton(1, radius: radius)
                    stepButton(-1, radius: radius)
                }
            }
        }
        .padding(inset)
        .frame(minWidth: minWidth)
        .frame(height: size.height)
        .background(KitSurfaceBackground(well, radius: radius, corners: look.corners))
        .overlay { shape.fill(ink.opacity(hovering && !focused ? 0.03 : 0)).allowsHitTesting(false) }
        .overlay {
            shape.strokeBorder(focused ? Color.accentColor.opacity(0.85) : ink.opacity(hovering ? 0.2 : 0.09),
                               lineWidth: focused ? 1.5 : 0.5)
                .allowsHitTesting(false)
        }
        .opacity(isEnabled ? 1 : 0.4)
        .fixedSize()
        .onHover { inside in
            let next = inside && isEnabled
            guard next != hovering else { return }
            withAnimation(reduceMotion ? nil : KitTheme.quick) { hovering = next }
        }
        .onDisappear {
            hovering = false
            settle?.cancel()
        }
        .animation(reduceMotion ? nil : KitTheme.quick, value: editing)
        .onChange(of: value) { _, updated in
            if let sent {
                // The write before this field's last one, landing late: the last one follows.
                guard updated == sent else { return }
                self.sent = nil
                settle?.cancel()
            }
            // What the reader types is theirs until they commit or press Escape.
            guard !editing else { return }
            let text = String(updated)
            if text != entry { entry = text }
        }
        .onChange(of: editing) { _, now in
            if !now { commit() }
        }
    }

    // MARK: The number and its unit

    private var center: some View {
        ZStack {
            // The room of the widest value and wording: the control never changes its width.
            HStack(spacing: 4) {
                if let prefix { adornmentRoom(prefix) }
                Text(verbatim: String(repeating: "8", count: KitNumberFieldMath.digits(in: range)))
                    .font(valueFont).padding(.horizontal, 3)
                if let suffix { adornmentRoom(suffix) }
            }
            .hidden()
            HStack(spacing: 4) {
                if let prefix { adornment(prefix) }
                field
                if let suffix { adornment(suffix) }
            }
        }
        .padding(.horizontal, style == .stepper ? 5 : 8)
        .frame(maxWidth: minWidth == nil ? nil : .infinity, maxHeight: .infinity)
        // The whole middle edits, not only the digits.
        .contentShape(Rectangle())
        .onTapGesture { if isEnabled { editing = true } }
    }

    /// The text field, as wide as what it holds: a hidden copy of the text sizes it.
    private var field: some View {
        Text(verbatim: entry.isEmpty ? "0" : entry)
            .font(valueFont).lineLimit(1).fixedSize()
            .hidden()
            .padding(.horizontal, 3)
            .overlay {
                TextField(title, text: $entry)
                    .textFieldStyle(.plain)
                    .multilineTextAlignment(.center)
                    .font(valueFont)
                    .foregroundStyle(ink)
                    .focused($editing)
                    .onSubmit { commit() }
                    .onKeyPress(keys: [.upArrow, .downArrow], phases: [.down, .repeat]) { press in
                        nudge(press.key == .upArrow ? 1 : -1, big: press.modifiers.contains(.shift))
                        return .handled
                    }
                    .onKeyPress(keys: [.upArrow, .downArrow], phases: .up) { _ in
                        commit()
                        return .handled
                    }
                    .onKeyPress(.escape) {
                        guard editing else { return .ignored }
                        entry = String(value)
                        editing = false
                        return .handled
                    }
                    .accessibilityLabel(title)
                    .accessibilityIdentifier(identifier ?? "kit.number")
            }
    }

    @ViewBuilder
    private func adornment(_ adornment: KitNumberAdornment) -> some View {
        switch adornment {
        case .symbol(let name):
            Image(systemName: name).font(.system(size: size.font - 1, weight: .medium))
                .foregroundStyle(ink.opacity(0.5)).accessibilityHidden(true)
        case .text, .counted:
            ZStack(alignment: .leading) {
                adornmentRoom(adornment).hidden()
                Text(verbatim: adornment.words(for: current) ?? "")
                    .font(.system(size: size.font, weight: .medium)).lineLimit(1).fixedSize()
                    .foregroundStyle(ink.opacity(0.55))
            }
        }
    }

    /// Every wording of an adornment on top of each other: the width of the widest.
    @ViewBuilder
    private func adornmentRoom(_ adornment: KitNumberAdornment) -> some View {
        if case .symbol(let name) = adornment {
            Image(systemName: name).font(.system(size: size.font - 1, weight: .medium))
        } else {
            ZStack(alignment: .leading) {
                ForEach(adornment.wordings, id: \.self) { words in
                    Text(verbatim: words).font(.system(size: size.font, weight: .medium)).lineLimit(1).fixedSize()
                }
            }
        }
    }

    // MARK: Steps

    private func stepButton(_ direction: Int, radius: CGFloat) -> some View {
        let up = direction > 0
        let room = size.height - inset * 2
        let chevrons = style == .chevrons
        return KitNumberStepButton(
            symbol: chevrons ? (up ? "chevron.up" : "chevron.down") : (up ? "plus" : "minus"),
            label: up ? "Increase \(title)" : "Decrease \(title)",
            identifier: identifier.map { $0 + (up ? ".increment" : ".decrement") },
            width: chevrons ? 18 : room, height: chevrons ? room / 2 : room,
            glyph: chevrons ? 7 : size.font - 2, radius: max(3, radius - inset),
            active: up ? current < range.upperBound : current > range.lowerBound,
            step: { nudge(direction, big: NSEvent.modifierFlags.contains(.shift)) },
            done: { commit() })
            // A picture draws one button under the pointer, not both.
            .transformEnvironment(\.kitForcedInteraction) { if !up { $0 = nil } }
    }

    private func nudge(_ direction: Int, big: Bool) {
        let next = KitNumberFieldMath.stepped(current, by: direction * (big ? 10 : 1), step: step, in: range)
        let text = String(next)
        if text != entry { entry = text }
    }

    /// Ends a gesture: the field shows the value inside the range, and the binding gets it when it changed.
    private func commit() {
        let next = current
        let text = String(next)
        if text != entry { entry = text }
        guard next != value else { return }
        sent = next
        value = next
        settle?.cancel()
        if value == next {
            sent = nil
            return
        }
        // The host did not take the value at once. If it never does (a failed save), show what it holds.
        settle = Task { @MainActor in
            try? await Task.sleep(for: Self.settleTime)
            guard !Task.isCancelled else { return }
            sent = nil
            if !editing, String(value) != entry { entry = String(value) }
        }
    }
}

/// A step button of `KitNumberField`. It steps at the press, as the system's stepper does, and again while the
/// button stays down: after 0.42 s, then every 70 ms. `done` runs once when the press ends, also when the system
/// cancels it.
private struct KitNumberStepButton: View {
    let symbol: String
    let label: String
    let identifier: String?
    let width: CGFloat
    let height: CGFloat
    let glyph: CGFloat
    let radius: CGFloat
    /// False at the limit: the button is dim and takes no press.
    let active: Bool
    let step: () -> Void
    let done: () -> Void

    @State private var hovering = false
    @GestureState private var pressing = false
    @State private var repeater: Task<Void, Never>?
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.kitLook) private var look
    @Environment(\.colorScheme) private var scheme
    @Environment(\.kitForcedInteraction) private var forced
    @GenReduceMotion private var reduceMotion

    private var live: Bool { isEnabled && active }
    private var state: KitInteraction {
        guard live else { return .rest }
        if pressing || forced == .pressed { return .pressed }
        return hovering || forced == .hover ? .hover : .rest
    }

    var body: some View {
        let state = state
        let surface = look.surface(.plain, state, scheme: scheme)
        Image(systemName: symbol).font(.system(size: glyph, weight: .bold))
            .foregroundStyle(surface.label.opacity(live ? (state == .rest ? 0.6 : 1) : 0.25))
            .frame(width: width, height: height)
            .background(KitSurfaceBackground(surface, radius: radius, corners: look.corners))
            .contentShape(Rectangle())
            .pointerCursor(live)
            .onHover { inside in
                let next = inside && live
                guard next != hovering else { return }
                withAnimation(reduceMotion ? nil : KitTheme.quick) { hovering = next }
            }
            .gesture(DragGesture(minimumDistance: 0).updating($pressing) { _, down, _ in down = true },
                     including: live ? .all : .subviews)
            .onChange(of: pressing) { _, down in
                if down { start() } else { stop() }
            }
            .onChange(of: live) { _, now in
                if !now { hovering = false }
            }
            .onDisappear {
                hovering = false
                repeater?.cancel()
            }
            .animation(reduceMotion ? nil : KitTheme.quick, value: state)
            .accessibilityElement()
            .accessibilityLabel(label)
            .accessibilityAddTraits(.isButton)
            .accessibilityAction {
                guard live else { return }
                step()
                done()
            }
            .accessibilityIdentifier(identifier ?? "kit.number.step")
    }

    private func start() {
        step()
        repeater?.cancel()
        repeater = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(420))
            while !Task.isCancelled {
                step()
                try? await Task.sleep(for: .milliseconds(70))
            }
        }
    }

    private func stop() {
        repeater?.cancel()
        repeater = nil
        done()
    }
}
