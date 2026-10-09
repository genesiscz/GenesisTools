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

private struct WidgetActivityRingLayout: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let text = subviews.first?.sizeThatFits(.unspecified) ?? .zero
        let diameter = max(28, max(text.width, text.height) + 10)
        return CGSize(width: diameter, height: diameter)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: CGPoint(x: bounds.midX, y: bounds.midY), anchor: .center, proposal: .unspecified)
    }
}

struct WidgetSessionActivity: View {
    let status: AgentWidgetStatus
    let count: Int
    let needsAnswer: Bool
    let animate: Bool
    var complete = true

    var body: some View {
        Group {
            if count > 0, status == .working {
                WidgetActivityRingLayout {
                    Text(verbatim: count > 99 ? "99+" : String(count) + (complete ? "" : "+"))
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .monospacedDigit().foregroundStyle(needsAnswer ? Color.orange : status.color)
                }.overlay {
                    SpinningArc(color: status.color, lineWidth: 1.7, spinning: animate)
                        .allowsHitTesting(false)
                }
            } else if count > 0 {
                WidgetInboxCount(count: count, needsAnswer: needsAnswer, pulse: 0, reduceMotion: !animate,
                    complete: complete)
            } else if status == .working {
                SpinningArc(color: status.color, lineWidth: 1.7, spinning: animate)
                    .frame(width: 14, height: 14).padding(5)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(status.label + ", \(max(0, count)) inbox notifications")
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
                if model.inbox.needsAnswer > 0 {
                    Button { model.openInboxNotification(on: surface, needsAnswer: true) } label: {
                        HStack(spacing: 4) {
                            WidgetInboxCount(count: model.inbox.needsAnswer, needsAnswer: true,
                                pulse: model.inboxPulse, reduceMotion: model.effectiveReduceMotion, complete: model.inbox.complete)
                            Text("need you").font(.system(size: 10))
                        }
                    }.buttonStyle(.genHoverPlain()).instantTooltip("Open need you inbox items")
                }
                if model.inbox.unread > 0 {
                    Button { model.openInboxNotification(on: surface, needsAnswer: false) } label: {
                        HStack(spacing: 4) {
                            WidgetInboxCount(count: model.inbox.unread, needsAnswer: false,
                                pulse: model.inboxPulse, reduceMotion: model.effectiveReduceMotion, complete: model.inbox.complete)
                            Text("unread").font(.system(size: 10))
                        }
                    }.buttonStyle(.genHoverPlain()).instantTooltip("Open unread inbox items")
                }
                if model.inboxCount == 0 {
                    Text(model.inbox.complete ? "All caught up" : "Inbox status unavailable")
                        .font(.system(size: 10)).foregroundStyle(.secondary)
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
                        model.openInboxNotification(on: surface, key: session.key)
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
                            if let inbox = model.inboxFor(session.key), inbox.unread + inbox.needsAnswer > 0 {
                                WidgetInboxCount(count: inbox.unread + inbox.needsAnswer, needsAnswer: inbox.needsAnswer > 0,
                                    pulse: model.inboxPulse, reduceMotion: model.effectiveReduceMotion, complete: model.inbox.complete)
                            } else {
                            WidgetActivityIndicator(status: session.visualStatus, animate: !model.effectiveReduceMotion)
                                .frame(width: 12, height: 12)
                            }
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
