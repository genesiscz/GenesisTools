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
            visibleSessionCount: model.railActivitySessions.count, hasInboxBadge: model.inboxCount > 0)
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

    private var edgeAlignment: Alignment {
        surface.edge == .top ? .top : (surface.edge == .right ? .trailing : .leading)
    }

    private var topPadding: CGFloat {
        surface.edge == .top ? max(headerMinimumHeight, measuredHeaderHeight > 0 ? measuredHeaderHeight : headerHeight) : 0
    }

    private var keepsExpandedPane: Bool { warm && selected?.id == "agents" }

    var body: some View {
        Color.clear
            .overlay(alignment: edgeAlignment) {
                if presentation != .compact || keepsExpandedPane {
                    content
                        .padding(.top, topPadding)
                        .padding(surface.edge == .right ? .trailing : .leading,
                            surface.edge == .top ? 0 : WidgetSideStripMetrics.width)
                }
            }
            .overlay(alignment: surface.edge == .top ? .top : (surface.edge == .right ? .trailing : .leading)) {
                if surface.edge == .top { topStrip } else { sideStrip }
            }
        .nativeGlassSurface(in: shape, tint: .black.opacity(0.30), opaqueColor: Color(white: 0.09))
        .clipShape(shape)
        .overlay(shape.stroke(.white.opacity(0.035), lineWidth: 0.5))
        .foregroundStyle(.white)
        .preferredColorScheme(.dark)
        .environment(
            \.nativeSettingsTheme,
            model.snapshot?.state.preferences.glassEffect == false ? .solid : model.appearance.theme
        )
        .nativeSettingsAppearance(model.appearance)
        .widgetAccessibility(reduceMotion: model.reduceMotion, reduceTransparency: model.reduceTransparency)
        .onHover { model.hover(surface, inside: $0) }
        .onChange(of: motion.pointerInside) { _, inside in
            if inside { warm = true }
        }
        .task(id: motion.pointerInside || presentation != .compact) {
            guard !motion.pointerInside, presentation == .compact, warm else { return }
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
            warm = false
        }
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
                if selected?.id == "agents", model.inboxCount > 0 { model.openInboxNotification(on: surface) }
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
                    if selected?.id == "agents", model.inboxCount > 0 {
                        WidgetInboxCount(count: model.inboxCount, needsAnswer: model.inbox.needsAnswer > 0,
                            pulse: model.inboxPulse, reduceMotion: model.effectiveReduceMotion, complete: model.inbox.complete)
                    }
                }.fixedSize()
            }
            .buttonStyle(.genHoverPlain())
            .accessibilityLabel("Open " + (selected?.title ?? "widgets"))
            .accessibilityIdentifier("widget.primary." + surface.key)
            .instantTooltip(Self.moduleTooltip(id: selected?.id, title: selected?.title ?? "Widgets", inbox: model.inbox))
            HStack(spacing: 8) {
                if selected?.id == "agents" {
                    HStack(spacing: 5) {
                        ForEach(Array(model.railActivitySessions.prefix(3))) { session in
                            Button {
                                model.openInboxNotification(on: surface, key: session.key)
                            } label: {
                                sessionActivity(session)
                                    .frame(minWidth: 24, minHeight: 30).fixedSize()
                            }.buttonStyle(.genHoverPlain())
                                .instantTooltip(sessionTooltip(session))
                                .accessibilityLabel(sessionSummary(session))
                                .accessibilityIdentifier("widget.agent." + session.key)
                                .onHover { model.hoverSession(session.key, on: surface, inside: $0) }
                        }
                    }
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
                VStack(spacing: WidgetSideStripMetrics.sessionSpacing) {
                    ForEach(Array(model.railActivitySessions.prefix(sideMetrics.sessionCount))) { session in
                        Button {
                            model.openInboxNotification(on: surface, key: session.key)
                        } label: {
                            sessionActivity(session)
                                .frame(width: WidgetSideStripMetrics.sessionWidth, height: WidgetSideStripMetrics.sessionHeight)
                                .overlay(alignment: .bottomTrailing) {
                                    // Which agent the count belongs to, at a glance; the tooltip names the session.
                                    AIProviderGlyph(meta: AIProviders.meta(for: session.target.provider), size: 11)
                                        .opacity(0.85).allowsHitTesting(false)
                                }
                        }
                        .buttonStyle(.genHoverPlain())
                        .instantTooltip(sessionTooltip(session))
                        .accessibilityLabel(sessionSummary(session))
                        .accessibilityIdentifier("widget.agent." + session.key)
                        .onHover { model.hoverSession(session.key, on: surface, inside: $0) }
                    }
                }
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
                        .opacity(presentation == .expanded ? 1 : 0)
                        .allowsHitTesting(presentation == .expanded)
                        .accessibilityHidden(presentation != .expanded)
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
            if selected.id == "agents" {
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
        .frame(maxHeight: .infinity)
    }

    /// Inbox counts describe only the Agents module; every other module button names its module.
    static func moduleTooltip(id: String?, title: String, inbox: WidgetInboxSummary) -> String {
        id == "agents" ? "Inbox: \(inbox.unread) unread, \(inbox.needsAnswer) need an answer" : title
    }

    private func moduleButton(_ id: String, size: CGFloat, location: String = "content") -> some View {
        Button {
            if id == "agents", model.inboxCount > 0 { model.openInboxNotification(on: surface) }
            else { model.openModule(id, on: surface) }
        } label: {
            let layout = surface.edge == .top ? AnyLayout(HStackLayout(spacing: 3)) : AnyLayout(VStackLayout(spacing: 4))
            layout {
                Image(systemName: classicSide && id == "agents" ? "tray" : registry.module(id)?.symbol ?? "square.dashed")
                    .font(.system(size: 13, weight: .medium))
                    .frame(height: 16)
                    .foregroundStyle(classicSide ? Color.white : registry.module(id)?.tint ?? .secondary)
                if id == "agents", model.inboxCount > 0 {
                    WidgetInboxCount(count: model.inboxCount, needsAnswer: model.inbox.needsAnswer > 0,
                        pulse: model.inboxPulse, reduceMotion: model.effectiveReduceMotion,
                        complete: model.inbox.complete, compact: true)
                }
            }
                .frame(minWidth: size, minHeight: surface.edge != .top && id == "agents" && model.inboxCount > 0
                    ? WidgetSideStripMetrics.badgedModuleHeight : size)
                .background(
                    selected?.id == id && presentation != .compact ? Color.white.opacity(0.09) : .clear,
                    in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip(Self.moduleTooltip(id: id, title: registry.module(id)?.title ?? id, inbox: model.inbox))
        .accessibilityLabel("Open " + (registry.module(id)?.title ?? id))
        .accessibilityIdentifier("widget." + location + "." + surface.key + "." + id)
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
        lines.append("Click to open its inbox")
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

struct AgentWidgetModuleView: View {
    @ObservedObject var model: WidgetModel
    let presentation: WidgetModulePresentation

    var body: some View {
        if presentation == .expanded {
            LiveWidgetView(model: model, edge: model.expanded ?? model.side, embedded: true)
        } else {
            VStack(alignment: .leading, spacing: 10) {
                Text(model.selected?.title ?? "Your agent inbox").font(.system(size: 13, weight: .semibold))
                    .lineLimit(2)
                if let card = model.card {
                    Text(card.title).font(.system(size: 12)).lineLimit(3)
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
