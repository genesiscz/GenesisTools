import AppKit
import GenesisKit
import SwiftUI

// Option B of the "transcript" sketch (`--sketch transcript=b`), the hub's half; the transcript's half is GenesisKit
// Sketches/TranscriptSketchB.swift. Hook: `SessionListView` in Hub/HubWindow.swift.

/// The modes in the title bar, beside the traffic lights (C1-later, Opus's toolbar and Grok's icon fallback): a compact
/// segmented control where the selected mode shows its symbol and name and the others their symbol, each with its
/// name and ⌘ key in a tooltip. The sidebar loses the mode row, so its list starts one row higher. A sidebar too narrow
/// for the selected name shows symbols only; a folded sidebar keeps today's rail.
struct TranscriptSketchModeBar: View {
    var model: HubModel
    @ObservedObject var inbox: HubInboxModel

    @Environment(\.titlebarMetrics) private var metrics
    /// The traffic lights' right edge in the window. Not `.titlebarRow()`: its reserve also clears the hub's centred
    /// window title (about 1,050 pt), which pushed the whole sidebar off screen (integrator, 2026-11-10).
    @State private var buttonsEdge: CGFloat = 78

    var body: some View {
        let waiting = inbox.waitingCount
        let strip = max(metrics.height, 28)
        // A zero-height row whose overlay draws up into the strip: the bar takes no sidebar height and no width.
        Color.clear
            .frame(maxWidth: .infinity)
            .frame(height: 0)
            .overlay(alignment: .bottomLeading) {
                ViewThatFits(in: .horizontal) {
                    bar(namesSelected: true, waiting: waiting)
                    bar(namesSelected: false, waiting: waiting)
                }
                .padding(.leading, buttonsEdge + WindowTitlebar.reserveGap / 2)
                .padding(.trailing, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .frame(height: strip)
                .accessibilityElement(children: .contain)
                .accessibilityLabel(Text("Mode"))
            }
            .background(TranscriptSketchButtonsEdge { buttonsEdge = $0 })
    }

    private func bar(namesSelected: Bool, waiting: Int) -> some View {
        HStack(spacing: 2) {
            ForEach(Array(HubMode.allCases.enumerated()), id: \.element) { index, mode in
                segment(mode, index: index, named: namesSelected && model.mode == mode, waiting: waiting)
            }
        }
        .padding(2)
        .background(Capsule().fill(Color.white.opacity(0.05)))
        .fixedSize()
    }

    private func segment(_ mode: HubMode, index: Int, named: Bool, waiting: Int) -> some View {
        let selected = model.mode == mode
        return Button {
            model.setMode(mode)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: TranscriptSketchModes.symbol(mode, waiting: waiting))
                    .font(.system(size: 11.5))
                if named {
                    Text(verbatim: mode.title)
                        .font(.system(size: 11.5, weight: .semibold))
                        .lineLimit(1)
                        .fixedSize()
                }
                // The Inbox carries its count in every state, so "waiting for you" never hides behind a symbol.
                if mode == .inbox, waiting > 0 {
                    Text(verbatim: "\(waiting)")
                        .font(.system(size: 10, weight: .semibold).monospacedDigit())
                        .fixedSize()
                }
            }
            .foregroundColor(selected ? .white : Color.white.opacity(0.62))
            .padding(.horizontal, named ? 9 : 6)
            .frame(minWidth: 26)
            .frame(height: 22)
            .background(Capsule().fill(selected ? Color.white.opacity(0.16) : Color.clear))
            .contentShape(Capsule())
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip("\(mode.tooltip(waiting: waiting)) (⌘\(index + 1))")
        .accessibilityLabel(Text(mode == .inbox && waiting > 0 ? "\(mode.title), \(waiting) waiting" : mode.title))
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

/// Reads the right edge of the window's traffic lights, so the mode bar starts beside them.
private struct TranscriptSketchButtonsEdge: NSViewRepresentable {
    let onEdge: (CGFloat) -> Void

    func makeNSView(context: Context) -> EdgeView { EdgeView(onEdge: onEdge) }
    func updateNSView(_ view: EdgeView, context: Context) {}

    final class EdgeView: NSView {
        let onEdge: (CGFloat) -> Void

        init(onEdge: @escaping (CGFloat) -> Void) {
            self.onEdge = onEdge
            super.init(frame: .zero)
        }

        required init?(coder: NSCoder) { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard let window else { return }
            var edge: CGFloat = 0
            for kind: NSWindow.ButtonType in [.closeButton, .miniaturizeButton, .zoomButton] {
                guard let button = window.standardWindowButton(kind), !button.isHidden else { continue }
                edge = max(edge, button.convert(button.bounds, to: nil).maxX)
            }
            guard edge > 0 else { return }
            DispatchQueue.main.async { [onEdge] in onEdge(edge) }
        }
    }
}
