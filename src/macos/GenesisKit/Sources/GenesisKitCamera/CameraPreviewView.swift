import AppKit
import AVFoundation
import SwiftUI
import GenesisKit

/// The live camera image of a running `CameraFrameSource`, through an `AVCaptureVideoPreviewLayer` on the
/// source's own session, so no second session opens the camera. Mirrored like a mirror by default,
/// aspect fill, continuous rounded corners with a white hairline on the inside edge.
///
/// The layer draws frames only while the session runs; between interval bursts it keeps the last
/// frame. Remove the view when its window hides, so the layer stops consuming frames.
public struct CameraPreviewView: View {
    public let session: AVCaptureSession
    public var mirrored: Bool
    public var cornerRadius: CGFloat

    public init(session: AVCaptureSession, mirrored: Bool = true, cornerRadius: CGFloat = 16) {
        self.session = session
        self.mirrored = mirrored
        self.cornerRadius = cornerRadius
    }

    public init(source: CameraFrameSource, mirrored: Bool = true, cornerRadius: CGFloat = 16) {
        self.init(session: source.session, mirrored: mirrored, cornerRadius: cornerRadius)
    }

    public var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        CameraPreviewLayerView(session: session, mirrored: mirrored)
            .clipShape(shape)
            .overlay(shape.strokeBorder(Color.white.opacity(0.1), lineWidth: 1))
            .accessibilityElement()
            .accessibilityLabel("Camera preview")
            .accessibilityIdentifier("camera.preview")
    }
}

struct CameraPreviewLayerView: NSViewRepresentable {
    let session: AVCaptureSession
    let mirrored: Bool

    func makeNSView(context: Context) -> PreviewLayerHostView {
        PreviewLayerHostView(session: session, mirrored: mirrored)
    }

    func updateNSView(_ view: PreviewLayerHostView, context: Context) {
        view.update(session: session, mirrored: mirrored)
    }

    static func dismantleNSView(_ view: PreviewLayerHostView, coordinator: ()) {
        view.detach()
    }
}

/// A layer-hosting view: the preview layer is its root layer, so AppKit sizes it with the view.
final class PreviewLayerHostView: NSView {
    private let previewLayer: AVCaptureVideoPreviewLayer
    private var mirrored: Bool
    private var startObserver: NSObjectProtocol?

    init(session: AVCaptureSession, mirrored: Bool) {
        previewLayer = AVCaptureVideoPreviewLayer(session: session)
        self.mirrored = mirrored
        super.init(frame: .zero)
        previewLayer.videoGravity = .resizeAspectFill
        previewLayer.backgroundColor = KitPalette.background.cgColor
        layer = previewLayer
        wantsLayer = true
        observe(session)
        applyMirroring()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func update(session: AVCaptureSession, mirrored: Bool) {
        if previewLayer.session !== session {
            previewLayer.session = session
            observe(session)
        }
        if self.mirrored != mirrored {
            self.mirrored = mirrored
            applyMirroring()
        }
    }

    func detach() {
        if let startObserver { NotificationCenter.default.removeObserver(startObserver) }
        startObserver = nil
        previewLayer.session = nil
    }

    override func layout() {
        super.layout()
        applyMirroring()
    }

    /// The layer's connection appears only once the session has a camera input, so mirroring is applied
    /// again when the session starts.
    private func observe(_ session: AVCaptureSession) {
        if let startObserver { NotificationCenter.default.removeObserver(startObserver) }
        startObserver = NotificationCenter.default.addObserver(
            forName: AVCaptureSession.didStartRunningNotification, object: session, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.applyMirroring() }
        }
    }

    private func applyMirroring() {
        guard let connection = previewLayer.connection, connection.isVideoMirroringSupported else { return }
        if connection.automaticallyAdjustsVideoMirroring { connection.automaticallyAdjustsVideoMirroring = false }
        if connection.isVideoMirrored != mirrored { connection.isVideoMirrored = mirrored }
    }

    deinit {
        if let startObserver { NotificationCenter.default.removeObserver(startObserver) }
    }
}
