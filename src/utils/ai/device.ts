import logger from "@app/logger";

/**
 * Supported ONNX Runtime execution providers, ordered by preference per platform.
 *
 * macOS:  CoreML (Neural Engine + GPU) → CPU
 * Linux:  CUDA (if available) → CPU
 * Windows: DirectML (GPU) → CPU
 */

export type OnnxDevice = "coreml" | "cuda" | "dml" | "webgpu" | "cpu" | "wasm";

interface DeviceResult {
    device: OnnxDevice;
    label: string;
}

/**
 * Detect the best available ONNX Runtime device for the current platform.
 * Falls back to CPU if accelerated execution isn't available.
 */
export function detectDevice(): DeviceResult {
    switch (process.platform) {
        case "darwin":
            return { device: "coreml", label: "CoreML (Neural Engine + GPU)" };

        case "linux":
            if (process.arch === "x64") {
                return { device: "cuda", label: "CUDA GPU" };
            }

            return { device: "cpu", label: "CPU" };

        case "win32":
            return { device: "dml", label: "DirectML GPU" };

        default:
            return { device: "cpu", label: "CPU" };
    }
}

/**
 * Try the preferred device, fall back to CPU if the execution provider isn't available.
 * Returns the device string to pass to transformers.js `pipeline({ device })`.
 */
export async function resolveDevice(): Promise<DeviceResult> {
    const preferred = detectDevice();

    if (preferred.device === "cpu") {
        return preferred;
    }

    // Verify the execution provider is actually available at runtime
    try {
        const onnx = await import("onnxruntime-node");
        const backends = onnx.default?.listSupportedBackends?.() as Array<{ name: string }> | undefined;

        if (backends) {
            const names = backends.map((b) => b.name);

            if (!names.includes(preferred.device)) {
                logger.info(
                    `[device] ${preferred.label} not available (have: ${names.join(", ")}), falling back to CPU`
                );
                return { device: "cpu", label: "CPU (fallback)" };
            }
        }
    } catch {
        // Can't verify — try the preferred device anyway, pipeline() will
        // fall back to CPU internally if the EP isn't loaded
    }

    logger.debug(`[device] Using ${preferred.label}`);
    return preferred;
}
