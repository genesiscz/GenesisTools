import AppKit
import SwiftUI

struct WidgetHostView: View {
    @ObservedObject var model: WidgetModel
    @ObservedObject var registry: WidgetModuleRegistry
    let surface: WidgetSurfaceID
    let moduleIDs: [String]
    let cutout: CGFloat
    let headerHeight: CGFloat
    var headerMinimumHeight: CGFloat = 36
    let visibleHeight: CGFloat
    var topSizeChanged: (CGSize) -> Void = { _ in }
    @State private var measuredHeaderHeight: CGFloat = 0
    @State private var dragOrigin: Double?
    @State private var dragClusterHeight: CGFloat?
    @Environment(\.nativeSettingsReduceMotion) private var reduceMotion

    private var presentation: WidgetModulePresentation { model.presentation(for: surface) }
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
        EdgePanelShape(
            placement: surface.edge,
            shoulder: presentation == .compact ? 7 : 10,
            corner: presentation == .compact ? (classicSide ? 21 : 13) : 22,
            joined: model.snapshot?.state.preferences.joinedEdges ?? true)
    }

    var body: some View {
        Color.clear
            .overlay(alignment: surface.edge == .top ? .top : (surface.edge == .right ? .trailing : .leading)) {
                if presentation != .compact {
                    content
                        .padding(.top, surface.edge == .top ? max(headerMinimumHeight, measuredHeaderHeight > 0 ? measuredHeaderHeight : headerHeight) : 0)
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
            .instantTooltip("Inbox: \(model.inbox.unread) unread, \(model.inbox.needsAnswer) need an answer")
            HStack(spacing: 8) {
                if selected?.id == "agents" {
                    HStack(spacing: 5) {
                        ForEach(Array(model.railActivitySessions.prefix(3))) { session in
                            Button {
                                model.openInboxNotification(on: surface, key: session.key)
                            } label: {
                                sessionActivity(session)
                                    .frame(minWidth: 24, minHeight: 30).fixedSize()
                            }.buttonStyle(.genHoverPlain()).accessibilityLabel(
                                session.title + ", " + session.visualStatus.label)
                                .accessibilityIdentifier("widget.agent." + session.key)
                                .onHover { model.hoverSession(session.key, on: surface, inside: $0) }
                        }
                    }
                }
                ForEach(Array(moduleIDs.filter { $0 != selected?.id }.prefix(4)), id: \.self) { id in
                    moduleButton(id, size: 25)
                }
                if moduleIDs.count > 5 {
                    Button {
                        model.showSettings?()
                    } label: {
                        Text("+\(moduleIDs.count - 5)").font(.caption2)
                    }.buttonStyle(.genHoverPlain()).accessibilityLabel("Choose widgets")
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
                sideStripContents.frame(height: sideMetrics.minimumHeight)
                    .frame(maxHeight: .infinity, alignment: .center)
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
            moduleButton(id, size: sideMetrics.moduleSize)
            if id == "agents", sideMetrics.sessionCount > 0 {
                VStack(spacing: WidgetSideStripMetrics.sessionSpacing) {
                    ForEach(Array(model.railActivitySessions.prefix(sideMetrics.sessionCount))) { session in
                        Button {
                            model.openInboxNotification(on: surface, key: session.key)
                        } label: {
                            sessionActivity(session)
                            .frame(width: WidgetSideStripMetrics.sessionWidth, height: WidgetSideStripMetrics.sessionHeight)
                        }
                        .buttonStyle(.genHoverPlain())
                        .instantTooltip(sessionSummary(session))
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
            VStack(spacing: 0) {
                if presentation == .preview {
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
                        ScrollView { selected.content(.preview).frame(maxWidth: .infinity, alignment: .leading) }
                            .scrollIndicators(.hidden)
                        Button("Open " + selected.title) { expand() }
                            .buttonStyle(.genHover()).padding(.vertical, 14)
                    }
                } else {
                    if moduleIDs.count > 1 {
                        HStack(spacing: 6) {
                            ForEach(moduleIDs, id: \.self) { id in moduleButton(id, size: 27) }
                            Spacer()
                            Text(selected.title).font(.caption.weight(.medium)).foregroundStyle(.secondary)
                        }.padding(.horizontal, 18).padding(.vertical, 12)
                    }
                    selected.content(.expanded)
                }
            }
            .frame(maxWidth: presentation == .preview ? selected.previewSize.width : .infinity, maxHeight: .infinity)
            .transition(.opacity)
        } else {
            VStack(spacing: 12) {
                Image(systemName: "square.grid.2x2").font(.title2).foregroundStyle(.secondary)
                Text("Choose what lives here").font(.headline)
                Button("Widget settings") { model.showSettings?() }.buttonStyle(.genHover())
            }.frame(width: 280).frame(maxHeight: .infinity)
        }
    }

    private func moduleButton(_ id: String, size: CGFloat) -> some View {
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
        .instantTooltip(id == "agents" ? "Inbox: \(model.inbox.unread) unread, \(model.inbox.needsAnswer) need an answer" : registry.module(id)?.title ?? id)
        .accessibilityLabel("Open " + (registry.module(id)?.title ?? id))
    }

    private func sessionActivity(_ session: WidgetSession) -> some View {
        let inbox = model.inboxFor(session.key)
        return WidgetSessionActivity(status: session.visualStatus,
            count: (inbox?.unread ?? 0) + (inbox?.needsAnswer ?? 0),
            needsAnswer: (inbox?.needsAnswer ?? 0) > 0,
            animate: !model.effectiveReduceMotion, complete: model.inbox.complete)
            .allowsHitTesting(false)
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
