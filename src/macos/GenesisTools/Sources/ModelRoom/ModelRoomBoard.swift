import GenesisKit
import SwiftUI

struct ModelRoomBoard: View {
    @ObservedObject var model: ModelRoomModel
    @State private var dragOrigin: ModelRoomPoint?

    private var boardSize: CGSize {
        let points = model.file?.quantities.map(\.position) ?? []
        return CGSize(width: max(1000, (points.map(\.x).max() ?? 800) + 260), height: max(560, (points.map(\.y).max() ?? 400) + 180))
    }

    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            ZStack(alignment: .topLeading) {
                Canvas { context, size in
                    var grid = Path()
                    for x in stride(from: 20.0, to: size.width, by: 24) {
                        grid.move(to: CGPoint(x: x, y: 0)); grid.addLine(to: CGPoint(x: x, y: size.height))
                    }
                    for y in stride(from: 20.0, to: size.height, by: 24) {
                        grid.move(to: CGPoint(x: 0, y: y)); grid.addLine(to: CGPoint(x: size.width, y: y))
                    }
                    context.stroke(grid, with: .color(.white.opacity(0.035)), lineWidth: 0.5)
                    for edge in model.evaluation?.relationships ?? [] {
                        guard let source = model.file?.quantities.first(where: { $0.id == edge.source }), let target = model.file?.quantities.first(where: { $0.id == edge.target }) else { continue }
                        let from = CGPoint(x: source.position.x + 200, y: source.position.y + 56)
                        let to = CGPoint(x: target.position.x, y: target.position.y + 56)
                        var path = Path()
                        path.move(to: from)
                        path.addCurve(to: to, control1: CGPoint(x: from.x + 70, y: from.y), control2: CGPoint(x: to.x - 70, y: to.y))
                        context.stroke(path, with: .color(ReviewPalette.renamed.opacity(0.42)), style: StrokeStyle(lineWidth: 1.5, dash: edge.delayed ? [5, 4] : []))
                        context.fill(Path(ellipseIn: CGRect(x: to.x - 3, y: to.y - 3, width: 6, height: 6)), with: .color(ReviewPalette.renamed))
                    }
                }
                ForEach(model.file?.quantities ?? []) { quantity in
                    node(quantity)
                        .offset(x: quantity.position.x, y: quantity.position.y)
                        .gesture(DragGesture(minimumDistance: 4)
                            .onChanged { gesture in
                                if dragOrigin == nil { dragOrigin = quantity.position; model.beginGesture() }
                                guard let origin = dragOrigin, var file = model.file, let index = file.quantities.firstIndex(where: { $0.id == quantity.id }) else { return }
                                file.quantities[index].position = ModelRoomPoint(x: min(ModelRoomLimits.maximumPosition, max(8, origin.x + gesture.translation.width)), y: min(ModelRoomLimits.maximumPosition, max(8, origin.y + gesture.translation.height)))
                                model.file = file
                            }
                            .onEnded { _ in dragOrigin = nil; model.finishGesture() })
                }
            }.frame(width: boardSize.width, height: boardSize.height)
        }
    }

    private func node(_ quantity: ModelRoomQuantity) -> some View {
        Button { model.selectedQuantity = quantity.id } label: {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(quantity.kind == "stock" ? "STOCK" : quantity.kind == "formula" ? "FORMULA" : quantity.kind == "data" ? "OBSERVATION" : "ASSUMPTION")
                        .font(.system(size: 9, weight: .semibold)).foregroundStyle(ReviewPalette.dim)
                    Spacer()
                    Image(systemName: quantity.kind == "stock" ? "tray.full" : quantity.kind == "formula" ? "function" : "slider.horizontal.3")
                        .font(.system(size: 11)).foregroundStyle(ReviewPalette.renamed)
                }
                Text(quantity.label).font(.system(size: 12, weight: .semibold)).lineLimit(2)
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text(model.frame?.values[quantity.id].map { $0.formatted(.number.precision(.fractionLength(0...2))) } ?? "—")
                        .font(.system(size: 24, weight: .medium, design: .rounded)).monospacedDigit()
                    Text(quantity.unit).font(.system(size: 10)).foregroundStyle(ReviewPalette.dim).lineLimit(1)
                }
                if !quantity.formula.isEmpty {
                    Text(quantity.formula).font(.system(size: 10, design: .monospaced)).foregroundStyle(ReviewPalette.dim).lineLimit(1)
                }
            }
            .padding(14).frame(width: 200, alignment: .leading)
            .background(Color(nsColor: ReviewPalette.background).opacity(0.98), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(model.selectedQuantity == quantity.id ? ReviewPalette.renamed : ReviewPalette.hairline, lineWidth: model.selectedQuantity == quantity.id ? 1.5 : 1))
        }
        .buttonStyle(.genHoverPlain())
        .accessibilityLabel("\(quantity.label), \(quantity.kind), \(model.frame?.values[quantity.id] ?? quantity.baseValue) \(quantity.unit)")
        .onMoveCommand { direction in
            let neighbors = model.evaluation?.relationships.filter { $0.source == quantity.id || $0.target == quantity.id } ?? []
            if let edge = (direction == .left || direction == .up) ? neighbors.first : neighbors.last {
                model.selectedQuantity = edge.source == quantity.id ? edge.target : edge.source
            }
        }
    }
}
