import { ensurePackage } from "@app/utils/packages";

export async function ensureHuggingFaceTransformers(): Promise<boolean> {
    try {
        await ensurePackage("@huggingface/transformers", {
            label: "HuggingFace Transformers (ML models)",
            interactive: true,
            reason: "Required for local AI inference (transcription, translation, embeddings)",
        });
        return true;
    } catch {
        return false;
    }
}
