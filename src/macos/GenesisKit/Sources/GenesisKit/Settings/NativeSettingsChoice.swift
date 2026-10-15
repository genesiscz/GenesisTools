import SwiftUI

/// One choice of a `NativeSettingsSegmented` or a `NativeSettingsPicker`: a value, its title, and optionally a sentence
/// that says what it does and a symbol. The selected option's `detail` shows under the row.
public struct NativeSettingsOption<Value: Hashable>: Identifiable {
    public let value: Value
    public let title: String
    public let detail: String?
    public let symbol: String?
    public var id: Value { value }

    public init(_ value: Value, _ title: String, detail: String? = nil, symbol: String? = nil) {
        self.value = value
        self.title = title
        self.detail = detail
        self.symbol = symbol
    }
}

/// A settings row whose choice is a few short words side by side: the kit's segmented tabs (accent pill in every
/// window, hover fill, pointer) on the right of the title. Each segment's identifier is `<identifier>.<value>`.
public struct NativeSettingsSegmented<Value: Hashable>: View {
    private let title: String
    private let detail: String?
    private let identifier: String
    private let options: [NativeSettingsOption<Value>]
    @Binding private var selection: Value
    private let minSegmentWidth: CGFloat

    public init(
        _ title: String, detail: String? = nil, identifier: String, options: [NativeSettingsOption<Value>],
        selection: Binding<Value>, minSegmentWidth: CGFloat = 64
    ) {
        self.title = title
        self.detail = detail
        self.identifier = identifier
        self.options = options
        _selection = selection
        self.minSegmentWidth = minSegmentWidth
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            NativeSettingsRow(title, detail: detail) {
                GenSegmentedTabs(
                    title, items: options.map { GenSegmentedTabs.Item($0.value, $0.title) }, selection: $selection,
                    minSegmentWidth: minSegmentWidth, identifier: identifier
                )
                .nativeSettingsDisabledLook()
            }
            if let selected = options.first(where: { $0.value == selection }), let note = selected.detail {
                NativeSettingsOptionNote(text: note, symbol: selected.symbol, identifier: identifier)
            }
        }
    }
}

/// A settings row that picks one of several options, each with a title and a sentence that says what it does: the
/// button shows the selected title, a click opens a list of every option with its description (built only while it
/// is open), and the selected option's description stays under the row. Up and Down move in the open list, Return
/// picks, Escape closes. Each option's identifier is `<identifier>.option.<value>`.
public struct NativeSettingsPicker<Value: Hashable>: View {
    private let title: String
    private let detail: String?
    private let identifier: String
    private let options: [NativeSettingsOption<Value>]
    @Binding private var selection: Value
    private let width: CGFloat
    @State private var open = false

    public init(
        _ title: String, detail: String? = nil, identifier: String, options: [NativeSettingsOption<Value>],
        selection: Binding<Value>, width: CGFloat = 220
    ) {
        self.title = title
        self.detail = detail
        self.identifier = identifier
        self.options = options
        _selection = selection
        self.width = width
    }

    private var selected: NativeSettingsOption<Value>? { options.first { $0.value == selection } }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            NativeSettingsRow(title, detail: detail) {
                Button {
                    open.toggle()
                } label: {
                    HStack(spacing: 7) {
                        if let symbol = selected?.symbol {
                            Image(systemName: symbol).font(.system(size: 11, weight: .medium))
                                .foregroundStyle(.secondary)
                        }
                        Text(verbatim: selected?.title ?? "Choose…")
                            .font(.system(size: 12, weight: .medium))
                            .lineLimit(1).truncationMode(.tail)
                        Spacer(minLength: 4)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 10)
                    .frame(width: width, height: 28)
                    .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 7, style: .continuous)
                            .strokeBorder(Color.white.opacity(open ? 0.24 : 0.09), lineWidth: 0.5))
                    .contentShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                }
                .buttonStyle(.genHoverPlain(brighten: 0.12))
                .accessibilityLabel(title)
                .accessibilityValue(selected?.title ?? "")
                .accessibilityIdentifier(identifier)
                .popover(isPresented: $open, arrowEdge: .bottom) {
                    NativeSettingsPickerList(options: options, selection: selection, identifier: identifier) { value in
                        if selection != value { selection = value }
                        open = false
                    }
                }
            }
            if let selected, let note = selected.detail {
                NativeSettingsOptionNote(text: note, symbol: selected.symbol, identifier: identifier)
            }
        }
    }
}

/// The open list of a `NativeSettingsPicker`.
struct NativeSettingsPickerList<Value: Hashable>: View {
    let options: [NativeSettingsOption<Value>]
    let selection: Value
    let identifier: String
    let choose: (Value) -> Void
    @State private var highlighted: Value?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(options) { option in
                row(option)
            }
        }
        .padding(6)
        .frame(width: 320)
        .focusable()
        .focused($focused)
        .focusEffectDisabled()
        .onAppear {
            highlighted = selection
            focused = true
        }
        .onKeyPress(.downArrow) {
            move(1)
            return .handled
        }
        .onKeyPress(.upArrow) {
            move(-1)
            return .handled
        }
        .onKeyPress(.return) {
            choose(highlighted ?? selection)
            return .handled
        }
    }

    private func move(_ delta: Int) {
        guard !options.isEmpty else { return }
        let current = options.firstIndex { $0.value == (highlighted ?? selection) } ?? 0
        let next = min(options.count - 1, max(0, current + delta))
        highlighted = options[next].value
    }

    private func row(_ option: NativeSettingsOption<Value>) -> some View {
        let isSelected = option.value == selection
        return Button {
            choose(option.value)
        } label: {
            HStack(alignment: .top, spacing: 9) {
                Image(systemName: "checkmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(Color.accentColor)
                    .opacity(isSelected ? 1 : 0)
                    .frame(width: 12)
                    .padding(.top, 2)
                if let symbol = option.symbol {
                    Image(systemName: symbol).font(.system(size: 13))
                        .foregroundStyle(.secondary)
                        .frame(width: 18)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: option.title)
                        .font(.system(size: 13, weight: isSelected ? .semibold : .medium))
                    if let detail = option.detail {
                        Text(verbatim: detail)
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10).padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(Color.white.opacity(highlighted == option.value && !isSelected ? 0.06 : 0)))
            .contentShape(Rectangle())
        }
        .buttonStyle(RowButtonStyle(cornerRadius: 7))
        .accessibilityLabel(option.title)
        .accessibilityHint(option.detail ?? "")
        .accessibilityIdentifier("\(identifier).option.\(GenAccessibilityID.suffix(option.value))")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// The selected option's description under a choice row.
struct NativeSettingsOptionNote: View {
    let text: String
    let symbol: String?
    let identifier: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Image(systemName: symbol ?? "info.circle")
                .font(.system(size: 10.5, weight: .medium))
                .foregroundStyle(Color.accentColor.opacity(0.9))
            Text(verbatim: text)
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(Color.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(Color.white.opacity(0.06), lineWidth: 0.5))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("\(identifier).note")
    }
}
