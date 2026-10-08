import SwiftUI

private enum WidgetInk {
    static let shell = Color(red: 0.045, green: 0.047, blue: 0.052)
    static let row = Color.white.opacity(0.065)
    static let muted = Color.white.opacity(0.46)
    static let blue = Color(red: 0.23, green: 0.62, blue: 1)
}

struct WidgetInboxCount: View {
    let count: Int
    let needsAnswer: Bool
    let pulse: Int
    let reduceMotion: Bool
    var complete = true
    var compact = false
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    var body: some View {
        HStack(spacing: 2) {
            if !compact, reduceMotion || systemReduceMotion {
                Image(systemName: needsAnswer ? "questionmark.bubble.fill" : "tray.fill")
                    .font(.system(size: 7, weight: .bold))
            } else if !compact {
                Image(systemName: needsAnswer ? "questionmark.bubble.fill" : "tray.fill")
                    .font(.system(size: 7, weight: .bold))
                    .symbolEffect(.bounce, options: .nonRepeating, value: pulse)
            }
            Text(verbatim: count > 99 ? "99+" : String(max(0, count)) + (complete ? "" : "+"))
                .font(.system(size: compact ? 8 : 9, weight: .bold, design: .monospaced))
        }.foregroundStyle(compact ? (needsAnswer ? Color.orange : WidgetInk.blue) : .white)
            .frame(width: compact ? 20 : 29, height: compact ? 13 : 15)
            .background((needsAnswer ? Color.orange : WidgetInk.blue).opacity(compact ? 0.14 : 1), in: Capsule())
            .accessibilityLabel((complete ? "" : "At least ") + "\(count) inbox notifications")
    }
}

public struct GenesisWidgetMark: View {
    public init() {}
    public var body: some View {
        Canvas { context, size in
            context.addFilter(.alphaThreshold(min: 0.45, color: .white))
            context.addFilter(.blur(radius: 2))
            context.drawLayer { layer in
                for center in [
                    CGPoint(x: 0.34, y: 0.4), CGPoint(x: 0.63, y: 0.38), CGPoint(x: 0.5, y: 0.65),
                ] {
                    let rect = CGRect(
                        x: size.width * center.x - 4, y: size.height * center.y - 4, width: 8, height: 8)
                    layer.fill(Path(ellipseIn: rect), with: .color(.white))
                }
            }
        }.frame(width: 23, height: 23).accessibilityHidden(true)
    }
}

private struct WidgetWorkingRing: View {
    let color: Color
    let animated: Bool

    var body: some View {
        // A layer animation: a SwiftUI repeatForever laid the widget out on every frame (23% CPU).
        SpinningArc(color: color, lineWidth: 2, trim: 0.12...0.78, period: 1.65, spinning: animated)
            .frame(width: 9, height: 9)
    }
}

private struct WidgetStatusDot: View {
    let status: AgentWidgetStatus
    var selected = false
    let namespace: Namespace.ID
    let animationsActive: Bool
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.widgetReduceMotion) private var requestedReduceMotion
    private var reduceMotion: Bool { systemReduceMotion || requestedReduceMotion }
    var body: some View {
        ZStack {
            if selected {
                Circle().stroke(status.color.opacity(0.2), lineWidth: 5).frame(width: 15, height: 15)
                    .matchedGeometryEffect(id: "selected-agent", in: namespace)
            }
            if status == .working {
                WidgetWorkingRing(color: status.color, animated: animationsActive && !reduceMotion)
            } else {
                Circle().fill(status.color).frame(width: 7, height: 7)
            }
        }
        .frame(width: 22, height: 22)
        .accessibilityLabel(status.label)
    }
}

private struct WidgetChoiceRow: View {
    let choice: AgentWidgetChoice
    let number: Int
    let selected: Bool
    let disabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 8) {
                Text(selected ? "✓" : String(number))
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .frame(width: 18, height: 18)
                    .background(Color.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 4))
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(choice.title).font(.system(size: 12, weight: .medium))
                        if choice.recommended {
                            Text("Recommended").font(.system(size: 9)).foregroundStyle(WidgetInk.muted)
                        }
                    }
                    if !choice.detail.isEmpty {
                        Text(choice.detail).font(.system(size: 10)).foregroundStyle(WidgetInk.muted)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 9).padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                selected ? Color.green.opacity(0.19) : WidgetInk.row,
                in: RoundedRectangle(cornerRadius: 9))
        }
        .buttonStyle(.genHoverPlain())
        .disabled(disabled)
        .accessibilityLabel("Choice " + String(number) + ": " + choice.title)
    }
}

public struct AgentWidgetView: View {
    public let placement: EdgePanelPlacement
    public let items: [AgentWidgetItem]
    public let selectedID: String
    public let expanded: Bool
    public let isPreview: Bool
    public let animationsActive: Bool
    public let cutoutWidth: CGFloat
    public let compactHeight: CGFloat
    public let receipt: String?
    public let sending: Bool
    public let selectedChoice: String?
    public let actions: AgentWidgetActions
    private let liveContent: AnyView?
    @Binding private var draft: String
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.widgetReduceMotion) private var requestedReduceMotion
    private var reduceMotion: Bool { systemReduceMotion || requestedReduceMotion }
    @Environment(\.accessibilityReduceTransparency) private var systemReduceTransparency
    @Environment(\.widgetReduceTransparency) private var requestedReduceTransparency
    private var reduceTransparency: Bool { systemReduceTransparency || requestedReduceTransparency }
    @FocusState private var composerFocused: Bool
    @Namespace private var dotSelection

    public init(
        placement: EdgePanelPlacement, items: [AgentWidgetItem], selectedID: String, expanded: Bool,
        isPreview: Bool = false, animationsActive: Bool = true, cutoutWidth: CGFloat = 0,
        compactHeight: CGFloat = 36,
        receipt: String? = nil, sending: Bool = false,
        selectedChoice: String? = nil, draft: Binding<String>, actions: AgentWidgetActions,
        liveContent: AnyView? = nil
    ) {
        self.placement = placement
        self.items = items
        self.selectedID = selectedID
        self.expanded = expanded
        self.isPreview = isPreview
        self.animationsActive = animationsActive
        self.cutoutWidth = cutoutWidth
        self.compactHeight = compactHeight
        self.receipt = receipt
        self.sending = sending
        self.selectedChoice = selectedChoice
        self._draft = draft
        self.actions = actions
        self.liveContent = liveContent
    }

    private var current: AgentWidgetItem? { items.first { $0.id == selectedID } }

    public var body: some View {
        Group {
            if placement == .top {
                VStack(spacing: 0) {
                    topStrip
                    if expanded {
                        card.transition(.opacity.combined(with: .offset(y: reduceMotion ? 0 : -6)))
                    }
                }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            } else {
                HStack(spacing: 0) {
                    if placement == .left {
                        rail
                    }
                    if expanded {
                        card.transition(.opacity)
                    }
                    if placement == .right {
                        rail
                    }
                }.frame(
                    maxWidth: .infinity, maxHeight: .infinity,
                    alignment: placement == .right ? .trailing : .leading)
            }
        }
        .background {
            if reduceTransparency {
                WidgetInk.shell
            } else {
                WidgetInk.shell.opacity(0.97)
            }
        }
        .clipShape(
            EdgePanelShape(placement: placement, shoulder: expanded ? 10 : 7, corner: expanded ? 20 : 12)
        )
        .overlay(
            EdgePanelShape(placement: placement, shoulder: expanded ? 10 : 7, corner: expanded ? 20 : 12)
                .stroke(
                    .white.opacity(0.10), lineWidth: 0.7)
        )
        .foregroundStyle(.white)
        .preferredColorScheme(.dark)
        .clipped()
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: expanded)
        .animation(
            reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.78), value: selectedID)
    }

    private var topStrip: some View {
        HStack(spacing: 10) {
            Button(action: actions.expand) {
                HStack(spacing: 6) {
                    GenesisWidgetMark()
                    if cutoutWidth == 0 {
                        Text("Agents").font(.system(size: 12, weight: .semibold))
                    }
                }
            }.buttonStyle(.genHoverPlain()).instantTooltip("Open agent inbox")
                .accessibilityLabel("Open agent inbox")
            if cutoutWidth > 0 {
                Spacer(minLength: cutoutWidth)
            } else {
                Spacer(minLength: 8)
            }
            HStack(spacing: 4) {
                HStack(spacing: 4) {
                    ForEach(Array(items.prefix(3))) { item in dotButton(item) }
                }.background(
                    WidgetBubbleField(
                        position: CGFloat(min(2, items.firstIndex { $0.id == selectedID } ?? 0)),
                        count: min(3, items.count), horizontal: true, enabled: expanded && !reduceMotion))
                if items.count > 3 {
                    Button("+\(items.count - 3)", action: actions.settings)
                        .font(.system(size: 10)).buttonStyle(.plain).accessibilityLabel("Show all agents")
                }
            }
        }
        .padding(.horizontal, 14)
        .frame(height: compactHeight)
    }

    private var rail: some View {
        VStack(spacing: 9) {
            IconButton(
                systemName: "tray", tooltip: "Open agent inbox", size: 13, tint: .white,
                action: actions.expand
            )
            .padding(.top, 13)
            Rectangle().fill(.white.opacity(0.08)).frame(width: 15, height: 1)
            if expanded || items.contains(where: { $0.status == .working || $0.status == .waiting }) {
                VStack(spacing: 9) {
                    ForEach(Array(items.prefix(6))) { item in dotButton(item) }
                }.background(
                    WidgetBubbleField(
                        position: CGFloat(min(5, items.firstIndex { $0.id == selectedID } ?? 0)),
                        count: min(6, items.count), horizontal: false, enabled: expanded && !reduceMotion))
            }
            if items.count > 6
                && (expanded || items.contains(where: { $0.status == .working || $0.status == .waiting }))
            {
                Button("+\(items.count - 6)", action: actions.settings)
                    .font(.system(size: 9)).buttonStyle(.plain).accessibilityLabel("Show all agents")
            }
            Rectangle().fill(.white.opacity(0.08)).frame(width: 15, height: 1)
            IconButton(
                systemName: "slider.horizontal.3", tooltip: "Widget settings", size: 12,
                tint: WidgetInk.muted, action: actions.settings)
            Spacer(minLength: 10)
        }
        .frame(width: 38)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(.black.opacity(0.20))
    }

    private func dotButton(_ item: AgentWidgetItem) -> some View {
        Button {
            actions.select(item.id)
        } label: {
            WidgetStatusDot(
                status: item.status, selected: expanded && selectedID == item.id,
                namespace: dotSelection, animationsActive: animationsActive)
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip(item.provider + " · " + item.title + " · " + item.status.label)
        .accessibilityLabel(item.title + ", " + item.status.label)
    }

    @ViewBuilder private var card: some View {
        if let liveContent {
            liveContent
        } else if let item = current {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    Text(item.provider.lowercased()).font(.system(size: 11, weight: .semibold))
                    Text("·").foregroundStyle(WidgetInk.muted)
                    Text(item.project).font(.system(size: 11)).foregroundStyle(WidgetInk.muted).lineLimit(1)
                    Spacer()
                    if isPreview {
                        Text("Preview").font(.system(size: 9, weight: .medium)).foregroundStyle(WidgetInk.muted)
                            .padding(.horizontal, 6).padding(.vertical, 3).background(
                                .white.opacity(0.05), in: Capsule())
                    }
                    if placement == .top {
                        IconButton(
                            systemName: "slider.horizontal.3", tooltip: "Widget settings", size: 10,
                            tint: WidgetInk.muted, action: actions.settings)
                    }
                    IconButton(
                        systemName: "chevron.right", tooltip: "Next agent", size: 10, tint: WidgetInk.muted,
                        action: actions.next)
                    IconButton(
                        systemName: "xmark", tooltip: "Collapse widget", size: 10, tint: WidgetInk.muted,
                        action: actions.collapse)
                }
                .padding(.bottom, 10)
                HStack(spacing: 5) {
                    Circle().fill(item.status.color).frame(width: 5, height: 5)
                    Text(sending ? (isPreview ? "Saving preview answer…" : "Sending…") : item.status.label)
                        .font(.system(size: 10)).foregroundStyle(WidgetInk.muted)
                    Spacer()
                    Text(item.title).font(.system(size: 10)).foregroundStyle(WidgetInk.muted).lineLimit(1)
                }
                .padding(.bottom, 16)

                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            Spacer(minLength: 45)
                            Text(item.request).font(.system(size: 12))
                                .padding(.horizontal, 11).padding(.vertical, 8)
                                .background(WidgetInk.blue.opacity(0.28), in: RoundedRectangle(cornerRadius: 11))
                        }
                        Text(item.context).font(.system(size: 12)).foregroundStyle(.white.opacity(0.78))
                            .padding(11).frame(maxWidth: .infinity, alignment: .leading)
                            .background(WidgetInk.row, in: RoundedRectangle(cornerRadius: 10))
                        Text(item.question).font(.system(size: 14, weight: .semibold)).fixedSize(
                            horizontal: false, vertical: true
                        )
                        .padding(.top, 3)
                        VStack(spacing: 6) {
                            ForEach(Array(item.choices.enumerated()), id: \.element.id) { index, choice in
                                WidgetChoiceRow(
                                    choice: choice, number: index + 1,
                                    selected: selectedChoice == choice.id, disabled: sending
                                ) {
                                    actions.choose(choice.id)
                                }
                            }
                        }
                    }
                }
                .scrollIndicators(.hidden)
                Spacer(minLength: 12)

                HStack(alignment: .bottom, spacing: 8) {
                    TextField("Reply to " + item.provider + "…", text: $draft, axis: .vertical)
                        .textFieldStyle(.plain).font(.system(size: 12))
                        .lineLimit(1...3).focused($composerFocused)
                        .onSubmit(actions.submit)
                        .accessibilityLabel("Reply to selected agent")
                    IconButton(
                        systemName: "arrow.up", tooltip: isPreview ? "Save preview reply" : "Send reply",
                        size: 12,
                        tint: draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            ? WidgetInk.muted : WidgetInk.blue,
                        action: actions.submit)
                }
                .padding(11).background(.white.opacity(0.065), in: RoundedRectangle(cornerRadius: 12))
                HStack(spacing: 6) {
                    if sending {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: receipt == nil ? "keyboard" : "checkmark.circle.fill")
                            .foregroundStyle(receipt == nil ? WidgetInk.muted : Color.green)
                    }
                    Text(receipt ?? "1–3 answer · J/K switch · Esc close")
                        .font(.system(size: 10)).foregroundStyle(WidgetInk.muted)
                        .lineLimit(2)
                    Spacer(minLength: 0)
                }
                .frame(minHeight: 24).padding(.top, 7)
            }
            .padding(18)
            .frame(width: 402)
            .frame(maxHeight: .infinity)
        }
    }
}
