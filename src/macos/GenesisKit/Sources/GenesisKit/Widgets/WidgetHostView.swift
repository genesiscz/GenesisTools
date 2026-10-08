import AppKit
import SwiftUI

struct WidgetHostView: View {
    @ObservedObject var model: WidgetModel
    @ObservedObject var registry: WidgetModuleRegistry
    let surface: WidgetSurfaceID
    let moduleIDs: [String]
    let cutout: CGFloat
    let headerHeight: CGFloat
    let visibleHeight: CGFloat
    @State private var dragOrigin: Double?
    @State private var dragClusterHeight: CGFloat?
    @Environment(\.nativeSettingsReduceMotion) private var reduceMotion

    private var presentation: WidgetModulePresentation { model.presentation(for: surface) }
    private var selected: WidgetModuleDescriptor? {
        let preferred = model.moduleSelections[surface.key]
        return moduleIDs.first(where: { $0 == preferred }).flatMap(registry.module)
            ?? moduleIDs.first.flatMap(registry.module)
    }
    private var shape: EdgePanelShape {
        EdgePanelShape(
            placement: surface.edge,
            shoulder: presentation == .compact ? 7 : 10,
            corner: presentation == .compact ? 13 : 22)
    }

    var body: some View {
        Group {
            if surface.edge == .top {
                VStack(spacing: 0) {
                    topStrip
                    if presentation != .compact { content }
                }
            } else {
                HStack(spacing: 0) {
                    if surface.edge == .left { sideStrip }
                    if presentation != .compact { content }
                    if surface.edge == .right { sideStrip }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .nativeGlassSurface(in: shape, tint: .black.opacity(0.30), opaqueColor: Color(white: 0.09))
        .clipShape(shape)
        .overlay(shape.stroke(.white.opacity(0.12), lineWidth: 0.7))
        .foregroundStyle(.white)
        .preferredColorScheme(.dark)
        .environment(
            \.nativeSettingsTheme,
            model.snapshot?.state.preferences.glassEffect == false ? .solid : model.appearance.theme
        )
        .nativeSettingsAppearance(model.appearance)
        .widgetAccessibility(reduceMotion: model.reduceMotion, reduceTransparency: model.reduceTransparency)
        .onHover { model.hover(surface, inside: $0) }
        .animation(reduceMotion || model.effectiveReduceMotion ? nil : .smooth(duration: 0.2), value: presentation)
    }

    private var topStrip: some View {
        HStack(spacing: 8) {
            Button {
                expand()
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: selected?.symbol ?? "square.grid.2x2.fill")
                        .foregroundStyle(selected?.tint ?? .blue)
                    if cutout == 0 {
                        Text(selected?.title ?? "Widgets").font(.system(size: 12, weight: .semibold))
                    }
                }
            }
            .buttonStyle(.genHoverPlain())
            .accessibilityLabel("Open " + (selected?.title ?? "widgets"))
            if cutout > 0 { Spacer(minLength: cutout) } else { Spacer(minLength: 8) }
            ForEach(Array(moduleIDs.prefix(4)), id: \.self) { id in moduleButton(id, size: 25) }
            if moduleIDs.count > 4 {
                Button {
                    model.showSettings?()
                } label: {
                    Text("+\(moduleIDs.count - 4)").font(.caption2)
                }.buttonStyle(.genHoverPlain()).accessibilityLabel("Choose widgets")
            }
            if selected?.id == "agents" {
                Text(String(model.sessions.filter { $0.status == "waiting" }.count))
                    .font(.system(size: 10, weight: .semibold, design: .rounded))
                    .foregroundStyle(.orange).accessibilityLabel("Agents needing an answer")
            }
        }.padding(.horizontal, 16).frame(height: headerHeight)
    }

    private var sideStrip: some View {
        VStack(spacing: 7) {
            Image(systemName: "line.3.horizontal")
                .font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
                .frame(width: 40, height: 21).contentShape(Rectangle())
                .accessibilityLabel("Drag widgets vertically")
                .gesture(
                    DragGesture(minimumDistance: 4)
                        .onChanged { value in
                            if dragOrigin == nil {
                                dragOrigin = model.sidePosition
                                dragClusterHeight = model.sideClusterHeight
                            }
                            model.moveSide(
                                position: WidgetClusterGeometry.position(
                                    starting: dragOrigin ?? 0.5, translationDown: value.translation.height,
                                    clusterHeight: dragClusterHeight ?? model.sideClusterHeight,
                                    visibleHeight: visibleHeight),
                                finished: false)
                        }
                        .onEnded { value in
                            model.moveSide(
                                position: WidgetClusterGeometry.position(
                                    starting: dragOrigin ?? 0.5, translationDown: value.translation.height,
                                    clusterHeight: dragClusterHeight ?? model.sideClusterHeight,
                                    visibleHeight: visibleHeight),
                                finished: true)
                            dragOrigin = nil
                            dragClusterHeight = nil
                        })
            if moduleIDs.isEmpty {
                Button {
                    model.showSettings?()
                } label: {
                    Image(systemName: "plus").frame(width: 34, height: 30)
                }.buttonStyle(.genHoverPlain()).accessibilityLabel("Add a widget to this group")
            }
            ForEach(moduleIDs, id: \.self) { id in
                moduleButton(id, size: 32)
                if id == "agents" {
                    VStack(spacing: 6) {
                        ForEach(Array(model.sessions.prefix(4))) { session in
                            Button {
                                model.select(session.key)
                                model.openModule("agents", on: surface)
                            } label: {
                                Circle().fill(session.visualStatus.color).frame(width: 6, height: 6)
                                    .frame(width: 26, height: 13)
                            }
                            .buttonStyle(.genHoverPlain())
                            .instantTooltip(session.title + " · " + session.visualStatus.label)
                            .accessibilityLabel(session.title + ", " + session.visualStatus.label)
                        }
                    }
                }
            }
            Spacer(minLength: 2)
            Button {
                model.showSettings?()
            } label: {
                Image(systemName: "slider.horizontal.3").font(.system(size: 11))
                    .foregroundStyle(.secondary).frame(width: 32, height: 24)
            }.buttonStyle(.genHoverPlain()).accessibilityLabel("Widget settings")
        }.padding(.vertical, 4).frame(width: 44)
    }

    @ViewBuilder private var content: some View {
        if let selected {
            VStack(spacing: 0) {
                if presentation == .preview {
                    HStack {
                        Label(selected.title, systemImage: selected.symbol)
                            .font(.system(size: 12, weight: .semibold))
                        Spacer()
                        Image(systemName: "arrow.up.left.and.arrow.down.right").font(.caption2)
                            .foregroundStyle(.secondary)
                    }.padding(.horizontal, 16).padding(.top, 15)
                    selected.content(.preview).padding(16)
                    Button("Open " + selected.title) { expand() }
                        .buttonStyle(.genHover()).padding(.bottom, 14)
                } else {
                    if moduleIDs.count > 1 {
                        HStack(spacing: 6) {
                            ForEach(moduleIDs, id: \.self) { id in moduleButton(id, size: 27) }
                            Spacer()
                            Text(selected.title).font(.caption.weight(.medium)).foregroundStyle(.secondary)
                        }.padding(.horizontal, 18).padding(.top, 12)
                    }
                    selected.content(.expanded)
                }
            }
            .frame(width: presentation == .preview ? 280 : selected.expandedSize.width)
            .frame(maxHeight: .infinity)
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
            model.openModule(id, on: surface)
        } label: {
            Image(systemName: registry.module(id)?.symbol ?? "square.dashed")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(registry.module(id)?.tint ?? .secondary)
                .frame(width: size, height: size)
                .background(
                    selected?.id == id && presentation != .compact ? Color.white.opacity(0.09) : .clear,
                    in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip(registry.module(id)?.title ?? id)
        .accessibilityLabel("Open " + (registry.module(id)?.title ?? id))
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
