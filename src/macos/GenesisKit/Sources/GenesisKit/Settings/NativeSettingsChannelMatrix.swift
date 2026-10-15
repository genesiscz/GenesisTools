import SwiftUI

/// A tier of a `NativeSettingsChannelMatrix` (a row): "Warning", "Critical", "Emergency".
public struct NativeSettingsMatrixTier: Identifiable, Hashable {
    public let id: String
    public let title: String
    public let detail: String?
    public let tint: Color

    public init(id: String, title: String, detail: String? = nil, tint: Color) {
        self.id = id
        self.title = title
        self.detail = detail
        self.tint = tint
    }
}

/// A channel of a `NativeSettingsChannelMatrix` (a column): "Banner", "Sound", "Voice", "Edge glow".
public struct NativeSettingsMatrixChannel: Identifiable, Hashable {
    public let id: String
    public let title: String
    public let symbol: String
    /// One short word under the symbol ("Banner"), so the column reads without a hover; nil shows the symbol alone.
    public let caption: String?

    public init(id: String, title: String, symbol: String, caption: String? = nil) {
        self.id = id
        self.title = title
        self.symbol = symbol
        self.caption = caption
    }
}

/// Which channels each tier uses: tiers down the left, channels across the top as symbols (each names itself in an
/// instant tooltip), one switch per cell. A cell that is on fills with its tier's colour. A click on a channel's
/// symbol turns that channel on for every tier (off when all already had it); a click on a tier's name does the same
/// across its row. `selection` maps a tier id to its channel ids; a tier missing from it has none. To edit an
/// `AlertChannelMatrix`, where a missing tier uses the matrix's `fallback`, use `init(identifier:tiers:channels:matrix:)`:
/// it shows the fallback channels as on and writes every tier's channels on a change.
///
/// Identifiers: `<identifier>.<tier>.<channel>` per cell, `<identifier>.channel.<channel>` and
/// `<identifier>.tier.<tier>` for the headers, each id spelled by `GenAccessibilityID.suffix`.
public struct NativeSettingsChannelMatrix: View {
    private let identifier: String
    private let tiers: [NativeSettingsMatrixTier]
    private let channels: [NativeSettingsMatrixChannel]
    @Binding private var selection: [String: Set<String>]
    private let isAvailable: (String, String) -> Bool
    private let onCommit: (([String: Set<String>]) -> Void)?
    @GenReduceMotion private var reduceMotion

    private static let cell: CGFloat = 46

    /// - Parameters:
    ///   - isAvailable: false for a cell that cannot be used (the channel needs a grant, or makes no sense for the
    ///     tier); it draws dimmed and does not switch.
    ///   - onCommit: runs with the new map after each click.
    public init(
        identifier: String, tiers: [NativeSettingsMatrixTier], channels: [NativeSettingsMatrixChannel],
        selection: Binding<[String: Set<String>]>,
        isAvailable: @escaping (_ tier: String, _ channel: String) -> Bool = { _, _ in true },
        onCommit: (([String: Set<String>]) -> Void)? = nil
    ) {
        self.identifier = identifier
        self.tiers = tiers
        self.channels = channels
        _selection = selection
        self.isAvailable = isAvailable
        self.onCommit = onCommit
    }

    /// A matrix over an `AlertChannelMatrix`: a tier missing from its `routes` shows the `fallback` channels, and a
    /// change writes the tiers' channels into `routes` (the fallback stays as it is). `onCommit` gets the new matrix.
    public init(
        identifier: String, tiers: [NativeSettingsMatrixTier], channels: [NativeSettingsMatrixChannel],
        matrix: Binding<AlertChannelMatrix>,
        isAvailable: @escaping (_ tier: String, _ channel: String) -> Bool = { _, _ in true },
        onCommit: ((AlertChannelMatrix) -> Void)? = nil
    ) {
        let tierIDs = tiers.map(\.id)
        let selection = Binding<[String: Set<String>]>(
            get: { Self.materialised(matrix.wrappedValue, tiers: tierIDs) },
            set: { matrix.wrappedValue = Self.applying($0, to: matrix.wrappedValue) })
        self.init(
            identifier: identifier, tiers: tiers, channels: channels, selection: selection, isAvailable: isAvailable,
            onCommit: onCommit.map { commit in { _ in commit(matrix.wrappedValue) } })
    }

    public var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
            GridRow {
                Color.clear.frame(height: 1).gridCellUnsizedAxes(.vertical)
                ForEach(channels) { channel in
                    header(channel)
                }
            }
            ForEach(tiers) { tier in
                // Outside a GridRow, a view spans every column.
                Rectangle().fill(Color.white.opacity(0.06)).frame(height: 0.5)
                GridRow {
                    tierLabel(tier)
                    ForEach(channels) { channel in
                        cell(tier: tier, channel: channel)
                    }
                }
            }
        }
        .animation(reduceMotion ? nil : KitTheme.quick, value: selection)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }

    private func header(_ channel: NativeSettingsMatrixChannel) -> some View {
        Button {
            toggleColumn(channel.id)
        } label: {
            VStack(spacing: 2) {
                Image(systemName: channel.symbol)
                    .font(.system(size: 13, weight: .medium))
                    .frame(height: 18)
                if let caption = channel.caption {
                    Text(verbatim: caption)
                        .font(.system(size: 9.5, weight: .medium))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
            }
            .foregroundStyle(.secondary)
            .frame(width: Self.cell - 2, height: channel.caption == nil ? 28 : 38)
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHover(cornerRadius: 7, padding: EdgeInsets(), scale: 1))
        .frame(width: Self.cell)
        .instantTooltip(TooltipContent(title: channel.title, lines: [.text("Click to switch it for every tier.")]))
        .accessibilityLabel(channel.title)
        .accessibilityHint("Switches this channel for every tier")
        .accessibilityIdentifier("\(identifier).channel.\(GenAccessibilityID.suffix(channel.id))")
        .padding(.bottom, 4)
    }

    private func tierLabel(_ tier: NativeSettingsMatrixTier) -> some View {
        Button {
            toggleRow(tier.id)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Circle().fill(tier.tint).frame(width: 7, height: 7)
                    .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: tier.title).font(.system(size: 13, weight: .medium))
                    if let detail = tier.detail {
                        Text(verbatim: detail).font(.system(size: 11)).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 12)
            }
            .padding(.vertical, 9)
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain(brighten: 0.12))
        .accessibilityLabel(tier.title)
        .accessibilityHint("Switches every channel for this tier")
        .accessibilityIdentifier("\(identifier).tier.\(GenAccessibilityID.suffix(tier.id))")
    }

    private func cell(tier: NativeSettingsMatrixTier, channel: NativeSettingsMatrixChannel) -> some View {
        let on = selection[tier.id, default: []].contains(channel.id)
        let available = isAvailable(tier.id, channel.id)
        return Button {
            toggle(tier: tier.id, channel: channel.id)
        } label: {
            ZStack {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(on ? AnyShapeStyle(tier.tint.gradient) : AnyShapeStyle(Color.white.opacity(0.06)))
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .strokeBorder(on ? Color.white.opacity(0.22) : Color.white.opacity(0.10), lineWidth: 0.5)
                Image(systemName: "checkmark")
                    .font(.system(size: 10, weight: .heavy))
                    .foregroundStyle(.white)
                    .opacity(on ? 1 : 0)
                    .scaleEffect(on || reduceMotion ? 1 : 0.6)
            }
            .frame(width: 22, height: 22)
            .frame(width: Self.cell, height: 34)
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain(scale: 1, brighten: 0.15))
        .disabled(!available)
        .instantTooltip("\(channel.title) for \(tier.title): \(on ? "on" : "off")")
        .accessibilityLabel("\(tier.title), \(channel.title)")
        .accessibilityValue(on ? "On" : "Off")
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier(
            "\(identifier).\(GenAccessibilityID.suffix(tier.id)).\(GenAccessibilityID.suffix(channel.id))")
    }

    private func toggle(tier: String, channel: String) {
        commit(Self.toggling(selection, tier: tier, channel: channel))
    }

    private func toggleColumn(_ channel: String) {
        let usable = tiers.map(\.id).filter { isAvailable($0, channel) }
        commit(Self.togglingColumn(selection, channel: channel, tiers: usable))
    }

    private func toggleRow(_ tier: String) {
        let usable = channels.map(\.id).filter { isAvailable(tier, $0) }
        commit(Self.togglingRow(selection, tier: tier, channels: usable))
    }

    private func commit(_ next: [String: Set<String>]) {
        guard next != selection else { return }
        selection = next
        onCommit?(next)
    }

    // MARK: - Pure helpers (tested)

    /// Every tier's channels as the matrix routes them (a missing tier gets the fallback).
    static func materialised(_ matrix: AlertChannelMatrix, tiers: [String]) -> [String: Set<String>] {
        Dictionary(uniqueKeysWithValues: tiers.map { ($0, matrix.channels(for: $0)) })
    }

    /// `matrix` with the tiers of `selection` written into its routes.
    static func applying(_ selection: [String: Set<String>], to matrix: AlertChannelMatrix) -> AlertChannelMatrix {
        var next = matrix
        for (tier, channels) in selection { next.routes[tier] = channels }
        return next
    }

    static func toggling(_ map: [String: Set<String>], tier: String, channel: String) -> [String: Set<String>] {
        var next = map
        var set = next[tier, default: []]
        if set.contains(channel) { set.remove(channel) } else { set.insert(channel) }
        next[tier] = set
        return next
    }

    /// Every tier gets the channel, unless every tier already has it: then none does.
    static func togglingColumn(_ map: [String: Set<String>], channel: String, tiers: [String]) -> [String: Set<String>] {
        let allOn = tiers.allSatisfy { map[$0, default: []].contains(channel) }
        var next = map
        for tier in tiers {
            var set = next[tier, default: []]
            if allOn { set.remove(channel) } else { set.insert(channel) }
            next[tier] = set
        }
        return next
    }

    /// The tier gets every channel, unless it already has them all: then it gets none.
    static func togglingRow(_ map: [String: Set<String>], tier: String, channels: [String]) -> [String: Set<String>] {
        var next = map
        let current = next[tier, default: []]
        let allOn = channels.allSatisfy { current.contains($0) }
        next[tier] = allOn ? current.subtracting(channels) : current.union(channels)
        return next
    }
}
