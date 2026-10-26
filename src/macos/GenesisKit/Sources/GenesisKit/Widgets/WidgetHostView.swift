import AppKit
import SwiftUI

struct WidgetHostView: View {
    @ObservedObject var model: WidgetModel
    @ObservedObject var registry: WidgetModuleRegistry
    /// What this panel shows. It follows the model's presentation, except that a shrinking panel keeps its content
    /// until its outline is small (EdgePanelController), so closing never shows an empty card.
    @ObservedObject var motion = EdgePanelMotion()
    let surface: WidgetSurfaceID
    let moduleIDs: [String]
    let cutout: CGFloat
    let headerHeight: CGFloat
    var headerMinimumHeight: CGFloat = 36
    let visibleHeight: CGFloat
    var railScreenCenterY: () -> CGFloat? = { nil }
    var expandedContentWidth: (String) -> CGFloat? = { _ in nil }
    /// The window height this surface will have when expanded, so a pane built ahead of time needs no new layout.
    var expandedWindowHeight: () -> CGFloat? = { nil }
    var topSizeChanged: (CGSize) -> Void = { _ in }
    @State private var measuredHeaderHeight: CGFloat = 0
    @State private var dragOrigin: Double?
    @State private var dragClusterHeight: CGFloat?
    /// Set while the pointer is on this panel (`motion.pointerInside`): the expanded Agents pane is built then, hidden,
    /// so a click opens it without a 40-170 ms build before the first frame (A2). Released a few seconds after the
    /// panel is compact again and the pointer has left.
    @State private var warm = false
    @Environment(\.nativeSettingsReduceMotion) private var reduceMotion

    private var presentation: WidgetModulePresentation { motion.presentation }
    private var selected: WidgetModuleDescriptor? {
        let preferred = model.moduleSelections[surface.key]
        return moduleIDs.first(where: { $0 == preferred }).flatMap(registry.module)
            ?? moduleIDs.first.flatMap(registry.module)
    }
    private var classicSide: Bool {
        surface.edge != .top && model.snapshot?.state.preferences.sideStyle == "classic"
    }

    private var sideMetrics: WidgetSideStripMetrics {
        WidgetSideStripMetrics(classic: classicSide, moduleIDs: moduleIDs,
            visibleSessionCount: model.railActivitySessions.count, hasInboxBadge: model.waitingCount > 0)
    }

    private var shape: EdgePanelShape {
        Self.panelShape(edge: surface.edge, presentation: presentation, classic: classicSide,
            joined: model.snapshot?.state.preferences.joinedEdges ?? true)
    }

    /// The outline of a panel; EdgePanelController animates its mask between these, so both must agree.
    static func panelShape(
        edge: EdgePanelPlacement, presentation: WidgetModulePresentation, classic: Bool, joined: Bool
    ) -> EdgePanelShape {
        EdgePanelShape(
            placement: edge,
            shoulder: presentation == .compact ? 7 : 10,
            corner: presentation == .compact ? (classic ? 21 : 13) : 22,
            joined: joined)
    }

    /// Side panels pin their content to the top: content taller than its window (a measurement still on its way, a
    /// screen too short) then loses its footer, never its header. Centred, the hover list opened with its header and
    /// its last row both cut off (Martin's screenshot, 2026-10-23).
    private var edgeAlignment: Alignment {
        surface.edge == .top ? .top : (surface.edge == .right ? .topTrailing : .topLeading)
    }

    private var topPadding: CGFloat {
        surface.edge == .top ? max(headerMinimumHeight, measuredHeaderHeight > 0 ? measuredHeaderHeight : headerHeight) : 0
    }

    private var keepsExpandedPane: Bool { warm && selected?.id == "agents" }

    var body: some View {
        let _ = RenderProbe.hit("widget.host")
        Color.clear
            .overlay(alignment: .topLeading) { panelLayers }
            // The side rail anchors itself to the screen (ScreenAnchoredWidgetRail), so it needs the whole window
            // rather than the moving content frame; in it the rail never falls back to its scrolling layout mid-motion.
            .overlay(alignment: surface.edge == .right ? .trailing : .leading) {
                if surface.edge != .top { sideStrip }
            }
        .nativeGlassSurface(in: shape, opaqueColor: Color(white: 0.09))
        .clipShape(shape)
        .overlay(shape.stroke(.white.opacity(0.035), lineWidth: 0.5))
        .foregroundStyle(.white)
        .preferredColorScheme(.dark)
        .environment(
            \.nativeSettingsTheme, model.panelTheme
        )
        .nativeSettingsAppearance(model.appearance)
        .widgetAccessibility(reduceMotion: model.reduceMotion, reduceTransparency: model.reduceTransparency)
        // The panel's window tracks the pointer (EdgePanelController.pointerChanged); this only logs a disagreement.
        .onHover { model.swiftUIHoverChanged?(surface, $0) }
        .onChange(of: motion.pointerInside) { _, inside in
            if inside { warm = true }
        }
        .task(id: motion.pointerInside || presentation != .compact) {
            guard !motion.pointerInside, presentation == .compact, warm else { return }
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
            warm = false
        }
    }

    /// The pane and the top strip. They fill the window, except while the outline changes size around the same
    /// content (`EdgePanelMotion.contentFrame`): then they follow the outline's edges, so the composer stays at the
    /// bottom edge and the top strip's wings at the side edges.
    private var panelLayers: some View {
        let frame = motion.contentFrame
        return Color.clear
            .overlay(alignment: edgeAlignment) {
                if presentation != .compact || keepsExpandedPane {
                    content
                        .padding(.top, topPadding)
                        .padding(surface.edge == .right ? .trailing : .leading,
                            surface.edge == .top ? 0 : WidgetSideStripMetrics.width)
                        .environment(\.edgePanelMoving, frame != nil)
                }
            }
            .overlay(alignment: .top) {
                if surface.edge == .top { topStrip }
            }
            .frame(width: frame?.width, height: frame?.height)
            .offset(x: frame?.minX ?? 0, y: frame?.minY ?? 0)
    }

    private var topStrip: some View {
        WidgetTopBarLayout(cutout: cutout, intrinsicSizeChanged: { size in
            let measured = CGSize(width: ceil(size.width + 36), height: max(headerMinimumHeight, ceil(size.height + 24)))
            DispatchQueue.main.async {
                measuredHeaderHeight = measured.height
                topSizeChanged(measured)
            }
        }) {
            Button {
                if selected?.id == "agents" { model.toggleInboxOverview(on: surface) }
                else { expand() }
            } label: {
                HStack(spacing: 7) {
                    if selected?.id == "agents" {
                        Image(systemName: "tray.fill")
                            .font(.system(size: 14, weight: .semibold)).frame(width: 20, height: 20)
                    } else {
                        Image(systemName: selected?.symbol ?? "square.grid.2x2.fill")
                            .foregroundStyle(selected?.tint ?? .blue)
                    }
                    if cutout == 0 {
                        Text(selected?.id == "agents" ? "Agents" : selected?.title ?? "Widgets")
                            .font(.system(size: 12, weight: .semibold))
                    }
                    if selected?.id == "agents", model.waitingCount > 0 {
                        WidgetInboxCount(count: model.waitingCount, needsAnswer: true,
                            pulse: model.waitingPulse, reduceMotion: model.effectiveReduceMotion, complete: model.inbox.complete)
                    }
                }.fixedSize()
            }
            .buttonStyle(.genHoverPlain())
            .accessibilityLabel("Open " + (selected?.title ?? "widgets"))
            .accessibilityValue(selected?.id == "agents" ? Self.waitingValue(model.waitingCount) : "")
            .accessibilityIdentifier("widget.primary." + surface.key)
            .instantTooltip(Self.moduleTooltip(id: selected?.id, title: selected?.title ?? "Widgets", inbox: model.inbox))
            HStack(spacing: 8) {
                if selected?.id == "agents" {
                    // No spacing between the buttons: each bubble takes half the 5 pt gap as its own target (R2).
                    HStack(spacing: 0) {
                        ForEach(Array(model.railActivitySessions.prefix(3))) { session in
                            Button {
                                model.toggleSession(session.key, on: surface)
                            } label: {
                                sessionActivity(session)
                                    .frame(minWidth: 30, minHeight: 30).fixedSize()
                                    .modifier(bubbleChrome(session, hitPadding: EdgeInsets(
                                        top: 0, leading: Self.topBubbleGap / 2, bottom: 0, trailing: Self.topBubbleGap / 2)))
                            }.buttonStyle(.plain)
                                .instantTooltip(model.bubbleTooltip(sessionTooltip(session)))
                                .accessibilityLabel(sessionSummary(session))
                                .accessibilityIdentifier("widget.agent." + session.key)
                                .onHover { model.hoverSession(session.key, on: surface, inside: $0) }
                        }
                    }
                    // The outer bubbles' halves of the gap reach past the row; the row keeps its old width.
                    .padding(.horizontal, -Self.topBubbleGap / 2)
                }
                ForEach(Array(moduleIDs.filter { $0 != selected?.id }.prefix(4)), id: \.self) { id in
                    moduleButton(id, size: 25, location: "strip")
                }
                if moduleIDs.count > 5 {
                    Button {
                        model.showSettings?()
                    } label: {
                        Text("+\(moduleIDs.count - 5)").font(.caption2)
                    }.buttonStyle(.genHoverPlain()).instantTooltip("\(moduleIDs.count - 5) more widgets: choose them in Settings")
                        .accessibilityLabel("Choose widgets")
                }
            }.fixedSize()
        }
        .padding(.horizontal, 18).padding(.vertical, 12)
        .frame(minHeight: headerMinimumHeight).fixedSize(horizontal: false, vertical: true)
    }

    private var dragHandle: some View {
        Image(systemName: "line.3.horizontal")
                .font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
                .frame(width: WidgetSideStripMetrics.dragWidth, height: WidgetSideStripMetrics.dragHeight)
                .contentShape(Rectangle())
                .accessibilityLabel("Drag widgets vertically")
                .overlay {
                    ScreenVerticalDragArea { translation, finished in
                        if dragOrigin == nil {
                            dragOrigin = model.sidePosition
                            dragClusterHeight = model.sideClusterHeight
                        }
                        model.moveSide(
                            position: WidgetClusterGeometry.position(
                                starting: dragOrigin ?? 0.5, translationDown: translation,
                                clusterHeight: dragClusterHeight ?? model.sideClusterHeight,
                                visibleHeight: visibleHeight),
                            finished: finished)
                        if finished {
                            dragOrigin = nil
                            dragClusterHeight = nil
                        }
                    }
                }
    }

    private var sideStrip: some View {
        GeometryReader { geometry in
            if geometry.size.height + 0.5 >= sideMetrics.minimumHeight {
                ScreenAnchoredWidgetRail(screenCenterY: railScreenCenterY(), height: sideMetrics.minimumHeight) {
                    sideStripContents.foregroundStyle(.white).environment(\.colorScheme, .dark)
                }
            } else if geometry.size.height >= sideMetrics.fixedOverflowChromeHeight + sideMetrics.moduleSize {
                VStack(spacing: sideMetrics.spacing) {
                    if !classicSide { dragHandle }
                    OverlayScrollViewport(width: WidgetSideStripMetrics.width) {
                        VStack(spacing: sideMetrics.spacing) { sideModuleControls }
                    }
                    .accessibilityLabel("Scrollable widgets and sessions")
                    sideSettingsButton
                    if classicSide { dragHandle }
                }
                .padding(.vertical, WidgetSideStripMetrics.verticalPadding)
            } else {
                OverlayScrollViewport(width: WidgetSideStripMetrics.width) {
                    sideStripContents.fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityLabel("Scrollable widget controls")
            }
        }
        .frame(idealHeight: sideMetrics.minimumHeight)
        .frame(width: WidgetSideStripMetrics.width)
    }

    var sideStripContents: some View {
        VStack(spacing: sideMetrics.spacing) {
            if !classicSide { dragHandle }
            sideModuleControls
            Spacer(minLength: WidgetSideStripMetrics.minimumSpacer)
            sideSettingsButton
            if classicSide { dragHandle }
        }.padding(.vertical, WidgetSideStripMetrics.verticalPadding).frame(width: WidgetSideStripMetrics.width)
    }

    @ViewBuilder private var sideModuleControls: some View {
        if moduleIDs.isEmpty {
            Button {
                model.showSettings?()
            } label: {
                Image(systemName: "plus")
                    .frame(width: WidgetSideStripMetrics.addWidth, height: WidgetSideStripMetrics.addHeight)
            }.buttonStyle(.genHoverPlain()).accessibilityLabel("Add a widget to this group")
        }
        ForEach(moduleIDs, id: \.self) { id in
            moduleButton(id, size: sideMetrics.moduleSize, location: "rail")
            if id == "agents", sideMetrics.sessionCount > 0 {
                // No spacing between the buttons: each bubble takes half the gap above and below it, and the rail's
                // spare width beside it, as its own target, so no click between two bubbles is lost (R2).
                VStack(spacing: 0) {
                    ForEach(Array(model.railActivitySessions.prefix(sideMetrics.sessionCount))) { session in
                        Button {
                            model.toggleSession(session.key, on: surface)
                        } label: {
                            sessionActivity(session)
                                .frame(width: WidgetSideStripMetrics.sessionWidth, height: WidgetSideStripMetrics.sessionHeight)
                                .modifier(bubbleChrome(session, hitPadding: WidgetSideStripMetrics.sessionHitPadding))
                                .overlay(alignment: .bottomTrailing) {
                                    // Which agent the count belongs to, at a glance; the tooltip names the session.
                                    // Inset by the hit padding, so it sits on the bubble's corner as before.
                                    AIProviderGlyph(meta: AIProviders.meta(for: session.target.provider), size: 11)
                                        .opacity(0.85).allowsHitTesting(false)
                                        .padding(.bottom, WidgetSideStripMetrics.sessionHitPadding.bottom)
                                        .padding(.trailing, WidgetSideStripMetrics.sessionHitPadding.trailing)
                                }
                        }
                        .buttonStyle(.plain)
                        .instantTooltip(model.bubbleTooltip(sessionTooltip(session)))
                        .accessibilityLabel(sessionSummary(session))
                        .accessibilityIdentifier("widget.agent." + session.key)
                        .onHover { model.hoverSession(session.key, on: surface, inside: $0) }
                    }
                }
                // The first and last bubbles' halves of the gap reach into the stack's neighbours' spacing, so the
                // stack keeps the height `WidgetSideStripMetrics.minimumHeight` counts.
                .padding(.vertical, -WidgetSideStripMetrics.sessionSpacing / 2)
            }
        }
    }

    private var sideSettingsButton: some View {
        Button {
            model.showSettings?()
        } label: {
            Image(systemName: "slider.horizontal.3").font(.system(size: 11))
                .foregroundStyle(.secondary)
                .frame(width: WidgetSideStripMetrics.settingsWidth, height: WidgetSideStripMetrics.settingsHeight)
        }.buttonStyle(.genHoverPlain()).accessibilityLabel("Widget settings")
    }

    @ViewBuilder private var content: some View {
        if let selected {
            ZStack(alignment: edgeAlignment) {
                if presentation == .expanded || keepsExpandedPane {
                    expandedPane(selected)
                        .modifier(WarmPaneVisibility(shown: presentation == .expanded, alignment: edgeAlignment))
                }
                if presentation == .preview {
                    previewPane(selected)
                }
            }
        } else if presentation != .compact {
            VStack(spacing: 12) {
                Image(systemName: "square.grid.2x2").font(.title2).foregroundStyle(.secondary)
                Text("Choose what lives here").font(.headline)
                Button("Widget settings") { model.showSettings?() }.buttonStyle(.genHover())
            }.frame(width: 280).frame(maxHeight: .infinity)
        }
    }

    /// The top edge's module row above the expanded content: 27 pt buttons and 12 pt padding above and below.
    static let topModuleRowHeight: CGFloat = 51

    private func expandedPane(_ selected: WidgetModuleDescriptor) -> some View {
        let hiddenHeight = presentation == .expanded ? nil : expandedWindowHeight().map { max(0, $0 - topPadding) }
        return VStack(spacing: 0) {
            // The side strip already lists the modules; only the top edge needs this row.
            if moduleIDs.count > 1 && surface.edge == .top {
                HStack(spacing: 6) {
                    ForEach(moduleIDs, id: \.self) { id in moduleButton(id, size: 27) }
                    Spacer()
                    Text(selected.title).font(.caption.weight(.medium)).foregroundStyle(.secondary)
                }.padding(.horizontal, 18).padding(.vertical, 12)
            }
            selected.content(.expanded)
        }
        // Reveal a fully sized pane; reflowing long messages through a near-zero opening width stalls AppKit.
        .frame(width: expandedContentWidth(selected.id) ?? selected.expandedSize.width)
        .frame(height: hiddenHeight)
        .frame(maxHeight: hiddenHeight == nil ? .infinity : nil)
    }

    private func previewPane(_ selected: WidgetModuleDescriptor) -> some View {
        VStack(spacing: 0) {
            if selected.id == "agents", let item = model.peekItem {
                // The alert popup (`showPeek`): one item, a click answers it, × or Esc closes it. Measured like the
                // hover list, so the panel takes the popup's own height.
                // The panel is never shorter than the rail beside it, so the card fills the pane: one inset on every
                // side, the panel's 18 pt corner minus that inset, and the alert flash on the card's own edge. Only the
                // content is measured, so the fill cannot feed its own height back (Martin's screenshot, 2026-10-25:
                // a short card over an empty pane, its flash border hugging the text).
                WidgetPeekView(model: model, item: item) { model.reportPreviewFit($0 + 2 * WidgetPeekView.inset) }
                    .padding(WidgetPeekView.inset)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            } else if selected.id == "agents" {
                AgentWidgetPreview(model: model, surface: surface)
            } else {
                Button(action: expand) {
                    HStack {
                        Spacer()
                        Label("Expand", systemImage: "arrow.up.left.and.arrow.down.right")
                            .font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
                    }.padding(.horizontal, 18).padding(.vertical, 14)
                        .contentShape(Rectangle())
                }.buttonStyle(.genHoverPlain())
                    .accessibilityLabel("Expand " + selected.title)
                    .accessibilityIdentifier("widget.expand." + selected.id)
                ScrollView {
                    selected.content(.preview).frame(maxWidth: .infinity, alignment: .leading)
                        .scrollOverflowContent()
                }
                .scrollOverflowHints()
                Button("Open " + selected.title) { expand() }
                    .buttonStyle(.genHover()).padding(.vertical, 14)
            }
        }
        .frame(width: selected.previewSize.width)
        // Pinned to the top: while the window still has the last measured height, an overflow hides the footer, never
        // the header (the hover list opened on its middle rows, 2026-10-23).
        .frame(maxHeight: .infinity, alignment: .top)
    }

    /// Inbox counts describe only the Agents module; every other module button names its module. The badge counts
    /// what waits for your answer (the hub's Inbox count); unread answers are only named here.
    static func moduleTooltip(id: String?, title: String, inbox: WidgetInboxSummary) -> String {
        guard id == "agents" else { return title }
        let waiting = max(0, inbox.needsAnswer), unread = max(0, inbox.unread)
        return "Inbox: \(waiting) waiting for your answer, \(unread) unread"
    }

    /// The badge's count for VoiceOver, which the button's own label would otherwise hide.
    static func waitingValue(_ count: Int) -> String {
        count > 0 ? "\(count) waiting for your answer" : "Nothing waits for you"
    }

    private func moduleButton(_ id: String, size: CGFloat, location: String = "content") -> some View {
        Button {
            if id == "agents" { model.toggleInboxOverview(on: surface) }
            else { model.openModule(id, on: surface) }
        } label: {
            let layout = surface.edge == .top ? AnyLayout(HStackLayout(spacing: 3)) : AnyLayout(VStackLayout(spacing: 4))
            layout {
                Image(systemName: classicSide && id == "agents" ? "tray" : registry.module(id)?.symbol ?? "square.dashed")
                    .font(.system(size: 13, weight: .medium))
                    .frame(height: 16)
                    .foregroundStyle(classicSide ? Color.white : registry.module(id)?.tint ?? .secondary)
                if id == "agents", model.waitingCount > 0 {
                    WidgetInboxCount(count: model.waitingCount, needsAnswer: true,
                        pulse: model.waitingPulse, reduceMotion: model.effectiveReduceMotion,
                        complete: model.inbox.complete, compact: true)
                }
            }
                .frame(minWidth: size, minHeight: surface.edge != .top && id == "agents" && model.waitingCount > 0
                    ? WidgetSideStripMetrics.badgedModuleHeight : size)
                .background(
                    selected?.id == id && presentation != .compact ? Color.white.opacity(0.09) : .clear,
                    in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip(Self.moduleTooltip(id: id, title: registry.module(id)?.title ?? id, inbox: model.inbox))
        .accessibilityLabel("Open " + (registry.module(id)?.title ?? id))
        .accessibilityValue(id == "agents" ? Self.waitingValue(model.waitingCount) : "")
        .accessibilityIdentifier("widget." + location + "." + surface.key + "." + id)
    }

    /// The top strip's gap between two session bubbles, which the bubbles split as hit padding.
    static let topBubbleGap: CGFloat = 5

    /// The bubble's hover ring and the alert flash, in place of the rectangular hover plate of `.genHoverPlain`.
    private func bubbleChrome(_ session: WidgetSession, hitPadding: EdgeInsets = EdgeInsets()) -> WidgetBubbleChrome {
        var style = model.attentionStyle
        style.cornerRadius = 17
        return WidgetBubbleChrome(trigger: model.attentionTrigger(session.key), attention: style,
            reduceMotion: model.effectiveReduceMotion, since: model.attentionStart(session.key), hitPadding: hitPadding)
    }

    private func sessionActivity(_ session: WidgetSession) -> some View {
        let inbox = model.inboxFor(session.key)
        return WidgetSessionActivity(status: session.visualStatus,
            count: (inbox?.unread ?? 0) + (inbox?.needsAnswer ?? 0),
            needsAnswer: (inbox?.needsAnswer ?? 0) > 0,
            animate: !model.effectiveReduceMotion, complete: model.inbox.complete,
            pulse: model.inboxPulseFor(session.key))
            .allowsHitTesting(false)
    }

    /// What a session badge means: the session, its agent and state, and what its count is made of.
    private func sessionTooltip(_ session: WidgetSession) -> TooltipContent {
        var lines = [AIProviders.meta(for: session.target.provider).displayName + " · " + session.visualStatus.label]
        if let inbox = model.inboxFor(session.key) {
            if inbox.needsAnswer > 0 { lines.append("\(inbox.needsAnswer) waiting for your answer") }
            if inbox.unread > 0 { lines.append("\(inbox.unread) unread") }
        }
        lines.append("Click to open its inbox, again to hide it")
        return TooltipContent(title: session.title, bullets: lines)
    }

    private func sessionSummary(_ session: WidgetSession) -> String {
        var parts = [session.title, session.visualStatus.label]
        if let inbox = model.inboxFor(session.key) {
            if inbox.unread > 0 { parts.append("\(inbox.unread) unread") }
            if inbox.needsAnswer > 0 { parts.append("\(inbox.needsAnswer) waiting for your answer") }
        }
        return parts.joined(separator: ", ")
    }

    private func expand() {
        if let selected { model.openModule(selected.id, on: surface) } else { model.showSettings?() }
    }
}

/// The warm expanded pane while hidden: it stays built, so opening it is instant, but it takes no clicks, no
/// keyboard focus and no accessibility focus. Disabled, its composer cannot keep the first responder and type into
/// an invisible draft after the panel collapsed. Flipping the enabled state rebuilds nothing.
struct WarmPaneVisibility: ViewModifier {
    let shown: Bool
    let alignment: Alignment

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .allowsHitTesting(shown)
            .disabled(!shown)
            .accessibilityHidden(!shown)
            // Hidden, the warm pane keeps its full size but takes no room: at its ~875 pt it made this stack taller
            // than the preview window, the edge overlay centred it, and the preview lost its header above the window
            // (Martin, 2026-10-10 22:17).
            .frame(height: shown ? nil : 0, alignment: alignment)
    }
}

/// The alert popup: what arrived and from which session. A click opens it in the inbox; the close button, Esc while the
/// widget has the keyboard, and VoiceOver's escape gesture close it without opening anything.
struct WidgetPeekView: View {
    @ObservedObject var model: WidgetModel
    let item: WidgetInboxItem
    /// The card's natural height, before it stretches to fill the pane.
    var measured: (CGFloat) -> Void = { _ in }

    /// The gap between the card and the panel edge on every side.
    static let inset: CGFloat = 8
    /// The panel's corner (EdgePanelShape's 18) minus the inset, so the card's corner runs parallel to the panel's.
    static let cornerRadius: CGFloat = 18 - inset

    /// The kicker names the decision ("Decision 4"), so the title under it does not repeat the number.
    private var title: String {
        let plain = item.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return plain.isEmpty ? "Open the inbox to see it." : plain
    }

    var body: some View {
        Button {
            guard let surface = model.hoveredSurface else { return }
            model.openInboxNotification(on: surface, key: item.key, needsAnswer: item.needsAnswer)
        } label: {
            VStack(alignment: .leading, spacing: 0) {
                header
                    .fixedSize(horizontal: false, vertical: true)
                    .onGeometryChange(for: CGFloat.self, of: \.size.height) { headerHeight = $0; report() }
                Spacer(minLength: Self.footerGap)
                footer
                    .onGeometryChange(for: CGFloat.self, of: \.size.height) { footerHeight = $0; report() }
            }
            .padding(Self.padding)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous)
                .fill(Color.primary.opacity(0.05)))
            .overlay(RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.08), lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(RowButtonStyle(cornerRadius: Self.cornerRadius))
        .attentionPulse(trigger: model.attentionTrigger(item.key), style: popupAttention, since: model.attentionStart(item.key))
        .accessibilityLabel(WidgetAlerts.kicker(item) + ": " + title)
        .accessibilityAction(.escape) { model.dismissPeek() }
        .accessibilityAction(named: "Close") { model.dismissPeek() }
        .overlay(alignment: .topTrailing) {
            IconButton(systemName: "xmark", tooltip: "Close without opening it", size: 10) { model.dismissPeek() }
                .accessibilityLabel("Close the alert")
                .accessibilityIdentifier("widget.peek.close")
                .padding(.top, 5).padding(.trailing, 5)
        }
    }

    @State private var headerHeight: CGFloat = 0
    @State private var footerHeight: CGFloat = 0
    private static let padding: CGFloat = 10
    private static let footerGap: CGFloat = 10

    /// The card's natural height: header, gap and footer, without the stretch that fills the pane.
    private func report() {
        guard headerHeight > 0, footerHeight > 0 else { return }
        measured(headerHeight + Self.footerGap + footerHeight + 2 * Self.padding)
    }

    private var footer: some View {
        HStack(spacing: 3) {
            Text(item.needsAnswer ? "Click to answer" : "Click to read")
            Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold))
        }
        .font(.system(size: 11)).foregroundStyle(.secondary)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: item.needsAnswer ? "questionmark.bubble.fill" : "text.bubble.fill")
                    .foregroundStyle(item.needsAnswer ? Color.orange : SessionPalette.blue)
                Text(WidgetAlerts.kicker(item)).font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(item.needsAnswer ? Color.orange : .secondary)
                Spacer(minLength: 0)
                LiveAgo(date: Date(timeIntervalSince1970: item.at / 1000), style: .brief)
                    .font(.system(size: 10)).foregroundStyle(.secondary)
                // Room for the close button, which sits over this corner outside the row button.
                Color.clear.frame(width: 18, height: 1)
            }
            Text(title).font(.system(size: 12.5, weight: .medium))
                .lineLimit(3).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
            if let session = model.session(forKey: item.key) {
                Text([session.title, session.project].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
            }
            // The pane is never shorter than the rail beside it; the decision's options fill it with what the click
            // will ask, instead of an empty card (Martin, 2026-10-25: "this is now quite ugly").
            if item.needsAnswer, let options = item.options, !options.isEmpty {
                WidgetPeekOptions(options: options, recommended: item.recommended).padding(.top, 4)
            }
        }
    }

    private var popupAttention: AttentionPulseStyle {
        var style = model.attentionStyle
        style.cornerRadius = Self.cornerRadius
        return style
    }
}

/// A decision's options in the alert card, up to four, the recommended one marked; read-only, the card's click answers.
struct WidgetPeekOptions: View {
    let options: [String]
    let recommended: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(options.prefix(4).enumerated()), id: \.offset) { index, option in
                let picked = Self.isRecommended(option, at: index, recommended)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: picked ? "star.fill" : "circle")
                        .font(.system(size: picked ? 8 : 6, weight: .semibold))
                        .foregroundStyle(picked ? Color.green : Color.secondary)
                        .frame(width: 10)
                    Text(option).font(.system(size: 11.5)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                        .foregroundStyle(picked ? .primary : .secondary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(option + (picked ? ", recommended" : ""))
            }
            if options.count > 4 {
                Text("\(options.count - 4) more").font(.system(size: 10.5)).foregroundStyle(.secondary).padding(.leading, 16)
            }
        }
    }

    /// The hub names the recommended option by its letter ("b") or its whole text.
    static func isRecommended(_ option: String, at index: Int, _ recommended: String?) -> Bool {
        guard let recommended = recommended?.trimmingCharacters(in: .whitespaces).lowercased(), !recommended.isEmpty
        else { return false }
        let lower = option.lowercased()
        let letter = String(UnicodeScalar(97 + index)!)
        return recommended == letter || lower == recommended
            || lower.hasPrefix(recommended + ")") || lower.hasPrefix(recommended + ".")
    }
}

struct AgentWidgetModuleView: View {
    @ObservedObject var model: WidgetModel
    let presentation: WidgetModulePresentation

    var body: some View {
        if presentation == .expanded {
            LiveWidgetView(model: model, edge: model.expanded ?? model.side, embedded: true)
        } else if presentation == .preview, let item = model.peekItem {
            WidgetPeekView(model: model, item: item)
        } else {
            VStack(alignment: .leading, spacing: 10) {
                Text(model.selected?.title ?? "Your agent inbox").font(.system(size: 13, weight: .semibold))
                    .lineLimit(2)
                if let card = model.card {
                    Text(card.numberedTitle).font(.system(size: 12)).lineLimit(3)
                    if !card.body.isEmpty {
                        Text(card.body).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(3)
                    }
                } else {
                    Text("Questions, screenshots and finished work are collected here.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Divider()
                HStack {
                    Label(
                        "\(model.sessions.filter { $0.status == "waiting" }.count) waiting", systemImage: "bubble.left")
                    Spacer()
                    Text("\(model.sessions.filter { $0.status == "working" }.count) working")
                }.font(.caption2).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
