import GenesisKit
import SwiftUI

/// The Style tab's camera bubble: shown or not, its corner, size and shape, and mirror. Every control sends the camera
/// op (`EditorModel.changeCamera`), the same change `movie.camera(...)` makes.
struct CameraBubbleSection: View {
    @Bindable var model: EditorModel

    private static let corners: [(EditProject.CameraCorner, String, String)] = [
        (.topLeft, "↖", "Top left"), (.topRight, "↗", "Top right"),
        (.bottomLeft, "↙", "Bottom left"), (.bottomRight, "↘", "Bottom right"), (.custom, "Free", "Where you dragged it"),
    ]

    var body: some View {
        if let camera = model.project.camera {
            VStack(alignment: .leading, spacing: 10) {
                SwitchRow("Camera bubble", isOn: Binding(get: { camera.show }, set: { model.changeCamera(.init(show: $0)) }))
                    .accessibilityIdentifier("recorder.style.camera")
                Text("Drag the bubble in the preview to move it, or its handle to size it.")
                    .font(.system(size: 11.5)).foregroundStyle(RecorderPalette.dim)
                    .fixedSize(horizontal: false, vertical: true)
                SectionLabel(text: "Place")
                GenSegmentedTabs("Place", items: Self.corners.map { .init($0.0, $0.1) },
                                 selection: Binding(get: { camera.corner }, set: { model.changeCamera(.init(corner: $0)) }),
                                 minSegmentWidth: 30, identifier: "recorder.style.cameraCorner", fillsWidth: true)
                    .instantTooltip("A corner keeps the bubble the margin from two edges; Free is where you dragged it")
                SectionLabel(text: "Size", value: "\(Int((camera.size * 100).rounded()))%")
                Slider(value: Binding(get: { camera.size }, set: { model.changeCamera(.init(size: ($0 * 100).rounded() / 100)) }),
                       in: EditProject.CameraChange.sizeRange)
                    .accessibilityLabel("Camera bubble size")
                    .accessibilityIdentifier("recorder.style.cameraSize")
                    .instantTooltip("The side as a share of the movie's short side")
                SectionLabel(text: "Shape")
                GenSegmentedTabs("Shape", items: EditProject.CameraShape.allCases.map { .init($0, $0.rawValue.capitalized) },
                                 selection: Binding(get: { camera.shape }, set: { model.changeCamera(.init(shape: $0)) }),
                                 minSegmentWidth: 50, identifier: "recorder.style.cameraShape", fillsWidth: true)
                SwitchRow("Mirror", isOn: Binding(get: { camera.mirror }, set: { model.changeCamera(.init(mirror: $0)) }))
                    .instantTooltip("Flips the camera picture as a mirror does, the way you saw yourself while recording")
                    .accessibilityIdentifier("recorder.style.cameraMirror")
            }
        }
    }
}

/// The bubble on the preview while the Style tab is open: its outline where the picture draws it, a drag on it moves it,
/// and the grip on its inner corner sizes it. A drag is many camera changes and one undo step.
struct CameraBubbleHandle: View {
    @Bindable var model: EditorModel
    let clock: PlayheadClock
    @State private var grabbed: CGRect?

    var body: some View {
        GeometryReader { geometry in
            let size = geometry.size
            if let camera = model.project.camera {
                let rect = camera.rect(canvas: size)
                let radius = CameraFeed.cornerRadius(camera.shape, side: rect.width)
                let here = camera.shows(atSourceUs: TimelineMap.sourceTime(atOutput: clock.outUs, in: model.project))
                let grip = CameraPlacement.grip(camera.corner)
                ZStack(alignment: .topLeading) {
                    Color.clear.allowsHitTesting(false)
                    RoundedRectangle(cornerRadius: radius, style: .continuous)
                        .strokeBorder(Color.white.opacity(here ? 0.95 : 0.6),
                                      style: StrokeStyle(lineWidth: 1.5, dash: here ? [] : [5, 3]))
                        .background(RoundedRectangle(cornerRadius: radius, style: .continuous)
                            .fill(Color.white.opacity(here ? 0.04 : 0.1)))
                        .frame(width: rect.width, height: rect.height)
                        .contentShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
                        .offset(x: rect.minX, y: rect.minY)
                        .gesture(DragGesture(minimumDistance: 0).onChanged { value in
                            let start = grabbed ?? rect
                            grabbed = start
                            let center = CGPoint(x: start.midX + value.translation.width, y: start.midY + value.translation.height)
                            model.changeCamera(CameraPlacement.moved(camera, center: center, in: size))
                        }.onEnded { _ in grabbed = nil })
                        .instantTooltip(here ? "Camera bubble: drag to move" : "Camera bubble, hidden here: drag to move")
                        .accessibilityElement()
                        .accessibilityLabel(here ? "Camera bubble" : "Camera bubble, hidden at the playhead")
                        .accessibilityHint("Drag to move it")
                        .accessibilityAction(named: "Bigger") { model.changeCamera(.init(size: camera.size + 0.02)) }
                        .accessibilityAction(named: "Smaller") { model.changeCamera(.init(size: camera.size - 0.02)) }
                    let corner = CGPoint(x: grip.x < 0 ? rect.minX : rect.maxX, y: grip.y < 0 ? rect.minY : rect.maxY)
                    Circle().fill(Color.white)
                        .overlay(Circle().strokeBorder(Color.black.opacity(0.4), lineWidth: 1))
                        .frame(width: 11, height: 11)
                        .contentShape(Circle().inset(by: -6))
                        .offset(x: corner.x - 5.5, y: corner.y - 5.5)
                        .gesture(DragGesture(minimumDistance: 0).onChanged { value in
                            let start = grabbed ?? rect
                            grabbed = start
                            let side = CameraPlacement.side(start: start.width, translation: value.translation, corner: camera.corner)
                            model.changeCamera(CameraPlacement.resized(camera, side: side, in: size))
                        }.onEnded { _ in grabbed = nil })
                        .instantTooltip("Drag to size the bubble")
                        .accessibilityHidden(true)
                }
            }
        }
    }
}
