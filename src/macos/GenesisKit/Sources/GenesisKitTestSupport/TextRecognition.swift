import CoreGraphics
import Vision

/// Reads the text of a rendered picture for a test (the GenesisKit tests and the app's tests share it). Vision's accurate recognizer can fail to initialize its E5RT model
/// on a busy Mac (`e5rt_execution_stream_operation_create_precompiled_compute_operation_with_options`, error 13). The
/// same pixels are then read by the accurate recognizer on the CPU, and only if that fails too by the fast one, so
/// every visible-word assertion still runs and a real widget regression is not hidden among runtime failures. The fast
/// recognizer misreads small text ("O tasks", "2of3open"), so it is the last resort.
public func recognizeText(in image: CGImage, with request: VNRecognizeTextRequest) throws {
    do {
        try VNImageRequestHandler(cgImage: image).perform([request])
    } catch {
        try onCPU(request)
        do {
            try VNImageRequestHandler(cgImage: image).perform([request])
        } catch {
            request.recognitionLevel = .fast
            try onCPU(request)
            try VNImageRequestHandler(cgImage: image).perform([request])
        }
    }
}

private func onCPU(_ request: VNRecognizeTextRequest) throws {
    for (stage, devices) in try request.supportedComputeStageDevices {
        if let cpu = devices.first(where: { if case .cpu = $0 { return true }; return false }) {
            request.setComputeDevice(cpu, for: stage)
        }
    }
}
