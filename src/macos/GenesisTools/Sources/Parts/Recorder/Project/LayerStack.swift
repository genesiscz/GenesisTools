import Foundation

extension EditProject {
    static let cameraLayerID = "camera"

    struct MediaLayer: Codable, Equatable, Identifiable {
        enum Kind: String, Codable { case image, video }

        var id: String
        var kind: Kind
        var file: String
        var startUs: Int64
        var endUs: Int64
        var x = 0.5, y = 0.5, width = 0.35, opacity = 1.0
        var shape: CameraShape?
        var hidden = false
        var name: String?
        var videoStartMs = 0
        var videoSound = false
        var loop = false

        var displayName: String {
            if let name, !name.isEmpty { return name }
            return URL(fileURLWithPath: file).lastPathComponent
        }
    }

    struct LayerStack: Codable, Equatable {
        var order: [String] = []
        var media: [MediaLayer] = []
    }

    enum LayerRef: Equatable, Identifiable {
        case camera, media(MediaLayer)

        var id: String {
            switch self {
            case .camera: EditProject.cameraLayerID
            case let .media(layer): layer.id
            }
        }

        var displayName: String {
            switch self {
            case .camera: "Camera"
            case let .media(layer): layer.displayName
            }
        }
    }

    func layerOrder() -> [LayerRef] {
        let stack = layers ?? LayerStack()
        var byID: [String: LayerRef] = [:]
        if camera != nil { byID[Self.cameraLayerID] = .camera }
        for layer in stack.media where layer.id != Self.cameraLayerID {
            byID[layer.id] = .media(layer)
        }
        var ordered: [LayerRef] = []
        if !stack.order.contains(Self.cameraLayerID), let camera = byID.removeValue(forKey: Self.cameraLayerID) {
            ordered.append(camera)
        }
        for id in stack.order {
            if let layer = byID.removeValue(forKey: id) { ordered.append(layer) }
        }
        for layer in stack.media {
            if let remaining = byID.removeValue(forKey: layer.id) { ordered.append(remaining) }
        }
        return ordered
    }

    enum LayerMove: Equatable, Codable {
        case top, bottom, up, down, index(Int)

        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let index = try? c.decode(Int.self) {
                self = .index(index)
                return
            }
            switch try c.decode(String.self) {
            case "top": self = .top
            case "bottom": self = .bottom
            case "up": self = .up
            case "down": self = .down
            default: throw DecodingError.dataCorruptedError(in: c, debugDescription: "Expected top, bottom, up, down or a layer index")
            }
        }

        func encode(to encoder: Encoder) throws {
            var c = encoder.singleValueContainer()
            switch self {
            case .top: try c.encode("top")
            case .bottom: try c.encode("bottom")
            case .up: try c.encode("up")
            case .down: try c.encode("down")
            case let .index(index): try c.encode(index)
            }
        }
    }

    func movingLayer(_ id: String, to move: LayerMove) throws -> EditProject {
        var order = layerOrder().map(\.id)
        guard let from = order.firstIndex(of: id) else { throw LayerError("no layer \(id)") }
        let last = order.count - 1
        let to: Int
        switch move {
        case .top: to = last
        case .bottom: to = 0
        case .up: to = min(from + 1, last)
        case .down: to = max(from - 1, 0)
        case let .index(index): to = min(last, max(0, index))
        }
        guard from != to else { return self }
        order.remove(at: from)
        order.insert(id, at: to)
        var next = self
        next.layers = LayerStack(order: order, media: layers?.media ?? [])
        return next
    }

    private struct LayerError: LocalizedError {
        var errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }

    static func cameraSize(forWidth width: Double, canvas: CGSize) -> Double {
        let short = min(canvas.width, canvas.height)
        guard short > 0 else { return width }
        return width * canvas.width / short
    }

    static func layerWidth(forCameraSize size: Double, canvas: CGSize) -> Double {
        size / cameraSize(forWidth: 1, canvas: canvas)
    }
}

extension EditProject.MediaLayer {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: try c.decode(String.self, forKey: .id), kind: try c.decode(Kind.self, forKey: .kind),
                  file: try c.decode(String.self, forKey: .file), startUs: try c.decode(Int64.self, forKey: .startUs),
                  endUs: try c.decode(Int64.self, forKey: .endUs))
        x = try c.decodeIfPresent(Double.self, forKey: .x) ?? x
        y = try c.decodeIfPresent(Double.self, forKey: .y) ?? y
        width = try c.decodeIfPresent(Double.self, forKey: .width) ?? width
        opacity = try c.decodeIfPresent(Double.self, forKey: .opacity) ?? opacity
        shape = try c.decodeIfPresent(EditProject.CameraShape.self, forKey: .shape)
        hidden = try c.decodeIfPresent(Bool.self, forKey: .hidden) ?? hidden
        name = try c.decodeIfPresent(String.self, forKey: .name)
        videoStartMs = try c.decodeIfPresent(Int.self, forKey: .videoStartMs) ?? videoStartMs
        videoSound = try c.decodeIfPresent(Bool.self, forKey: .videoSound) ?? videoSound
        loop = try c.decodeIfPresent(Bool.self, forKey: .loop) ?? loop
    }
}

extension EditProject.LayerStack {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(order: try c.decodeIfPresent([String].self, forKey: .order) ?? [],
                  media: try c.decodeIfPresent([EditProject.MediaLayer].self, forKey: .media) ?? [])
    }
}
