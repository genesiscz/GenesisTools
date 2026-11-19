import AVFoundation
import GenesisKit
import ImageIO
import SwiftUI

/// Shared between Style and Layers. The layer inspector uses layer ops for properties the stack exposes.
struct CameraBubbleSection: View {
    @Bindable var model: EditorModel
    var layerControls = false

    private static let corners: [(EditProject.CameraCorner, String, String)] = [
        (.topLeft, "↖", "Top left"), (.topRight, "↗", "Top right"),
        (.bottomLeft, "↙", "Bottom left"), (.bottomRight, "↘", "Bottom right"), (.custom, "Free", "Where you dragged it"),
    ]

    var body: some View {
        if let camera = model.project.camera {
            VStack(alignment: .leading, spacing: 10) {
                SwitchRow("Camera bubble", isOn: Binding(get: { camera.show }, set: { on in
                    if layerControls { model.edit([.layer(.init(id: EditProject.cameraLayerID, hidden: !on))]) }
                    else { model.changeCamera(.init(show: on)) }
                }))
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
                Slider(value: Binding(get: { camera.size }, set: { value in
                    let size = (value * 100).rounded() / 100
                    let width = EditProject.layerWidth(forCameraSize: size, canvas: model.layerCanvasSize)
                    if layerControls && (0.05...1).contains(width) {
                        model.continuous("layer:camera:width", [.layer(.init(id: EditProject.cameraLayerID, width: width))])
                    } else { model.changeCamera(.init(size: size)) }
                }),
                       in: EditProject.CameraChange.sizeRange)
                    .accessibilityLabel("Camera bubble size")
                    .accessibilityIdentifier("recorder.style.cameraSize")
                    .instantTooltip("The side as a share of the canvas's short side")
                SectionLabel(text: "Shape")
                GenSegmentedTabs("Shape", items: EditProject.CameraShape.allCases.map { .init($0, $0.rawValue.capitalized) },
                                 selection: Binding(get: { camera.shape }, set: { shape in
                                     if layerControls { model.edit([.layer(.init(id: EditProject.cameraLayerID, shape: .some(shape)))]) }
                                     else { model.changeCamera(.init(shape: shape)) }
                                 }),
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
    @State private var grabbedCorner: EditProject.CameraCorner?

    var body: some View {
        GeometryReader { geometry in
            let size = geometry.size
            if let camera = model.project.camera {
                let rect = camera.rect(canvas: size)
                let radius = CameraFeed.cornerRadius(camera.shape, side: rect.width)
                let here = camera.shows(atSourceUs: TimelineMap.sourceTime(atOutput: clock.outUs, in: model.project))
                let grip = CameraPlacement.grip(grabbedCorner ?? camera.corner)
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
                        .gesture(DragGesture(minimumDistance: 1, coordinateSpace: .named("recorder.cameraCanvas")).onChanged { value in
                            let start = grabbed ?? rect
                            grabbed = start
                            let center = CGPoint(x: start.midX + value.translation.width, y: start.midY + value.translation.height)
                            model.changeCamera(CameraPlacement.moved(camera, center: center, in: size))
                        }.onEnded { _ in grabbed = nil; model.finishGesture() })
                        .instantTooltip(here ? "Camera bubble: drag to move" : "Camera bubble, hidden here: drag to move")
                        .accessibilityElement()
                        .accessibilityLabel(here ? "Camera bubble" : "Camera bubble, hidden at the playhead")
                        .accessibilityHint("Drag to move it")
                        .accessibilityAction(named: "Bigger") { model.changeCamera(.init(size: camera.size + 0.02)) }
                        .accessibilityAction(named: "Smaller") { model.changeCamera(.init(size: camera.size - 0.02)) }
                    let corner = CGPoint(x: grip.x < 0 ? rect.minX : rect.maxX, y: grip.y < 0 ? rect.minY : rect.maxY)
                    LayerResizeGrip()
                        .position(corner)
                        .gesture(DragGesture(minimumDistance: 1, coordinateSpace: .named("recorder.cameraCanvas")).onChanged { value in
                            let start = grabbed ?? rect
                            grabbed = start
                            let side = CameraPlacement.side(start: start.width, translation: value.translation, corner: camera.corner)
                            model.changeCamera(CameraPlacement.resized(camera, side: side, in: size))
                        }.onEnded { _ in grabbed = nil; model.finishGesture() })
                        .instantTooltip("Drag to size the bubble")
                        .accessibilityHidden(true)
                    if model.inspectedLayer != nil {
                        ForEach(0..<4, id: \.self) { index in
                            let right = !index.isMultiple(of: 2), bottom = index >= 2
                            let point = CGPoint(x: right ? rect.maxX : rect.minX, y: bottom ? rect.maxY : rect.minY)
                            if point != corner {
                                LayerResizeGrip()
                                    .position(point)
                                    .gesture(DragGesture(minimumDistance: 1, coordinateSpace: .named("recorder.cameraCanvas"))
                                        .onChanged { value in
                                            let base = grabbed ?? rect
                                            grabbed = base
                                            if grabbedCorner == nil { grabbedCorner = camera.corner }
                                            let delta = ((right ? 1.0 : -1.0) * value.translation.width
                                                + (bottom ? 1.0 : -1.0) * value.translation.height) / 2
                                            let resized = CameraPlacement.resized(camera, side: base.width + delta, in: size)
                                            guard let fraction = resized.size else { return }
                                            let half = fraction * min(size.width, size.height) / 2
                                            let x = right ? base.minX + half : base.maxX - half
                                            let y = bottom ? base.minY + half : base.maxY - half
                                            model.changeCamera(.init(x: min(1, max(0, x / size.width)),
                                                                     y: min(1, max(0, y / size.height)), size: fraction))
                                        }.onEnded { _ in grabbed = nil; grabbedCorner = nil; model.finishGesture() })
                                    .instantTooltip("Drag to size the bubble")
                                    .accessibilityHidden(true)
                            }
                        }
                    }
                }
                .coordinateSpace(name: "recorder.cameraCanvas")
            }
        }
    }
}

/// The visible dot stays small while the pointer can grab a full 26-point square.
private struct LayerResizeGrip: View {
    var body: some View {
        Circle().fill(.white)
            .overlay(Circle().strokeBorder(.black.opacity(0.5), lineWidth: 1))
            .frame(width: 10, height: 10)
            .frame(width: 26, height: 26)
            .contentShape(Rectangle())
    }
}

struct MediaLayerHandle: View {
    let model: EditorModel
    let layer: EditProject.MediaLayer
    let clock: PlayheadClock
    @State private var aspect: CGFloat?
    @State private var start: CGRect?
    @State private var draft: CGRect?

    var body: some View {
        GeometryReader { geometry in
            let size = geometry.size
            let time = TimelineMap.sourceTime(atOutput: clock.outUs, in: model.project)
            if !layer.hidden, layer.startUs <= time, time < layer.endUs,
               let ratio = layer.shape == nil ? aspect : 1, ratio > 0, size.width > 0, size.height > 0 {
                let width = layer.width * size.width
                let height = width / ratio
                let saved = CGRect(x: layer.x * size.width - width / 2, y: layer.y * size.height - height / 2,
                                   width: width, height: height)
                let rect = draft ?? saved
                let radius = layer.shape.map { CameraFeed.cornerRadius($0, side: rect.width) } ?? 0
                ZStack(alignment: .topLeading) {
                    Color.clear.allowsHitTesting(false)
                    RoundedRectangle(cornerRadius: radius)
                        .strokeBorder(.white, lineWidth: 1.5)
                        .frame(width: rect.width, height: rect.height)
                        .contentShape(Rectangle())
                        .position(x: rect.midX, y: rect.midY)
                        .gesture(drag(saved: saved, size: size))
                        .instantTooltip("Drag \(layer.displayName) to move it")
                        .accessibilityLabel("Move \(layer.displayName)")
                    ForEach(0..<4, id: \.self) { corner in
                        LayerResizeGrip()
                            .position(x: corner.isMultiple(of: 2) ? rect.minX : rect.maxX,
                                      y: corner < 2 ? rect.minY : rect.maxY)
                            .gesture(drag(saved: saved, size: size, corner: corner))
                            .instantTooltip("Drag to resize \(layer.displayName)")
                            .accessibilityHidden(true)
                    }
                }
                .coordinateSpace(name: "recorder.layerCanvas")
            }
        }
        .task(id: layer.file) {
            aspect = nil
            let folder = URL(fileURLWithPath: model.project.source.video).deletingLastPathComponent()
            let url = URL(fileURLWithPath: layer.file, relativeTo: folder)
            let result = await Self.aspect(of: url, kind: layer.kind)
            if !Task.isCancelled { aspect = result }
        }
    }

    private func drag(saved: CGRect, size: CGSize, corner: Int? = nil) -> some Gesture {
        DragGesture(minimumDistance: 1, coordinateSpace: .named("recorder.layerCanvas"))
            .onChanged { value in
                let origin = start ?? saved
                start = origin
                let dx = value.translation.width, dy = value.translation.height
                if let corner {
                    let right = !corner.isMultiple(of: 2), bottom = corner >= 2
                    let slope = origin.height / origin.width
                    let grow = ((right ? dx : -dx) + (bottom ? dy : -dy) * slope) / (1 + slope * slope)
                    let width = min(size.width, max(size.width * 0.05, origin.width + grow))
                    let height = width * slope
                    draft = CGRect(x: right ? origin.minX : origin.maxX - width, y: bottom ? origin.minY : origin.maxY - height,
                                   width: width, height: height)
                } else {
                    draft = origin.offsetBy(dx: dx, dy: dy)
                }
                if let rect = draft {
                    let cx = min(size.width, max(0, rect.midX)), cy = min(size.height, max(0, rect.midY))
                    draft = rect.offsetBy(dx: cx - rect.midX, dy: cy - rect.midY)
                }
            }
            .onEnded { _ in
                defer { start = nil; draft = nil }
                guard let rect = draft, rect != saved else { return }
                model.edit([.layer(.init(id: layer.id, x: rect.midX / size.width,
                                         y: rect.midY / size.height, width: corner == nil ? nil : rect.width / size.width))])
            }
    }

    private nonisolated static func aspect(of url: URL, kind: EditProject.MediaLayer.Kind) async -> CGFloat? {
        switch kind {
        case .image:
            guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
                  let info = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                  let w = info[kCGImagePropertyPixelWidth] as? NSNumber, let h = info[kCGImagePropertyPixelHeight] as? NSNumber,
                  w.doubleValue > 0, h.doubleValue > 0 else { return nil }
            let turned = (5...8).contains((info[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1)
            return turned ? h.doubleValue / w.doubleValue : w.doubleValue / h.doubleValue
        case .video:
            guard let track = try? await AVURLAsset(url: url).loadTracks(withMediaType: .video).first,
                  let (natural, transform) = try? await track.load(.naturalSize, .preferredTransform) else { return nil }
            let size = EditRenderer.displaySize(natural, transform: transform)
            return size.width > 0 && size.height > 0 ? size.width / size.height : nil
        }
    }
}
