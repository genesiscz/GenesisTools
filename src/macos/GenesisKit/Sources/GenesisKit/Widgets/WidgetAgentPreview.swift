import SwiftUI

struct WidgetActivityIndicator: View {
    let status: AgentWidgetStatus
    let animate: Bool

    var body: some View {
        if status == .working {
            SpinningArc(color: status.color, lineWidth: 1.7, period: 1.65, spinning: animate)
                .frame(width: 9, height: 9)
        } else {
            Circle().fill(status.color).frame(width: 6, height: 6)
                .shadow(color: status == .waiting ? status.color.opacity(0.35) : .clear, radius: 4)
        }
    }
}

struct AgentWidgetPreview: View {
    @ObservedObject var model: WidgetModel
    let surface: WidgetSurfaceID
    private var waiting: Int { model.waitingSessionCount }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "tray").font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.white.opacity(0.65))
                Text("Inbox").font(.system(size: 12, weight: .semibold))
                Spacer()
                if waiting > 0 {
                    HStack(spacing: 4) {
                        Circle().fill(.orange).frame(width: 4, height: 4)
                        Text("\(waiting) need you")
                    }.font(.system(size: 10, weight: .medium))
                        .foregroundStyle(Color.orange.opacity(0.95))
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(.orange.opacity(0.10), in: Capsule())
                } else {
                    Text("All caught up").font(.system(size: 10)).foregroundStyle(.secondary)
                }
            }.padding(.horizontal, 5).padding(.bottom, 5)

            if model.previewSessions.isEmpty {
                HStack(spacing: 12) {
                    GenesisWidgetMark()
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Nothing needs you.").font(.system(size: 13, weight: .medium))
                        Text("New questions and finished work appear here.")
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading).padding(.horizontal, 5)
            } else {
                ForEach(model.previewSessions) { session in
                    Button {
                        model.select(session.key)
                        model.section = "Inbox"
                        model.openModule("agents", on: surface)
                    } label: {
                        HStack(spacing: 9) {
                            AIProviderGlyph(meta: AIProviders.meta(for: session.target.provider), size: 21)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(session.title).font(.system(size: 11.5, weight: .medium)).lineLimit(1)
                                HStack(spacing: 5) {
                                    Text(
                                        session.project.isEmpty ? session.target.provider.capitalized : session.project
                                    )
                                    .lineLimit(1)
                                    Text("·")
                                    Text(session.visualStatus.label).lineLimit(1)
                                }.font(.system(size: 9.5)).foregroundStyle(.white.opacity(0.45))
                            }
                            Spacer(minLength: 2)
                            WidgetActivityIndicator(status: session.visualStatus, animate: !model.effectiveReduceMotion)
                                .frame(width: 12, height: 12)
                        }
                        .padding(.horizontal, 9).padding(.vertical, 9)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            session.status == "waiting" ? Color.orange.opacity(0.065) : .white.opacity(0.025),
                            in: RoundedRectangle(cornerRadius: 10))
                    }
                    .buttonStyle(.genHoverRow())
                    .accessibilityLabel("Open " + session.title + ", " + session.visualStatus.label)
                }
            }
            Spacer(minLength: 0)
            Button {
                model.section = "Sessions"
                model.openModule("agents", on: surface)
            } label: {
                HStack {
                    Image(systemName: "rectangle.stack").font(.system(size: 10))
                    Text("Projects & sessions").font(.system(size: 10, weight: .medium))
                    Spacer()
                    Text(String(model.sessions.count)).font(.system(size: 9, design: .monospaced))
                    Image(systemName: "chevron.right").font(.system(size: 8, weight: .semibold))
                }.foregroundStyle(.white.opacity(0.5)).padding(.horizontal, 5).padding(.top, 5)
            }.buttonStyle(.genHoverPlain()).accessibilityLabel("Browse all projects and sessions")
        }.padding(.horizontal, 13).padding(.vertical, 18)
    }
}
