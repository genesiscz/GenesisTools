// src/automate/lib/steps/nlp.ts

import { registerStepHandler, registerStepCatalog } from "@app/automate/lib/registry";
import type { StepContext } from "@app/automate/lib/registry";
import type { NlpStepParams, PresetStep, StepResult } from "@app/automate/lib/types";
import { makeResult } from "./helpers";
import {
  analyzeSentiment,
  detectLanguage,
  tagText,
  textDistance,
  embedText,
  closeDarwinKit,
} from "@app/utils/macos";

async function nlpHandler(step: PresetStep, ctx: StepContext): Promise<StepResult> {
  const start = performance.now();
  const params = step.params as unknown as NlpStepParams;
  const subAction = step.action.split(".")[1];

  const text = ctx.interpolate(params.text ?? "");
  const language = params.language ?? "en";

  try {
    switch (subAction) {
      case "sentiment": {
        if (!text) return makeResult("error", null, start, "nlp.sentiment requires params.text");
        const result = await analyzeSentiment(text);
        return makeResult("success", result, start);
      }

      case "language": {
        if (!text) return makeResult("error", null, start, "nlp.language requires params.text");
        const result = await detectLanguage(text);
        return makeResult("success", result, start);
      }

      case "tag": {
        if (!text) return makeResult("error", null, start, "nlp.tag requires params.text");
        const schemes = params.schemes ?? ["lexicalClass"];
        const result = await tagText(text, schemes, language);
        return makeResult("success", result, start);
      }

      case "distance": {
        const text2 = ctx.interpolate(params.text2 ?? "");
        if (!text || !text2) {
          return makeResult("error", null, start, "nlp.distance requires params.text and params.text2");
        }
        const type = params.type ?? "sentence";
        const result = await textDistance(text, text2, language, type);
        return makeResult("success", result, start);
      }

      case "embed": {
        if (!text) return makeResult("error", null, start, "nlp.embed requires params.text");
        const type = params.type ?? "sentence";
        const result = await embedText(text, language, type);
        return makeResult("success", result, start);
      }

      default:
        return makeResult(
          "error",
          null,
          start,
          `Unknown nlp action: ${subAction}. Valid: sentiment, language, tag, distance, embed`,
        );
    }
  } catch (error) {
    return makeResult(
      "error",
      null,
      start,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    closeDarwinKit();
  }
}

registerStepHandler("nlp", nlpHandler);
registerStepCatalog({
  prefix: "nlp",
  description: "Natural language processing (macOS NaturalLanguage)",
  actions: [
    { action: "nlp.sentiment", description: "Analyze text sentiment (-1 to 1)", params: [
      { name: "text", required: true, description: "Text to analyze" },
    ]},
    { action: "nlp.language", description: "Detect text language", params: [
      { name: "text", required: true, description: "Text to analyze" },
    ]},
    { action: "nlp.tag", description: "Tag text (POS, named entities, etc.)", params: [
      { name: "text", required: true, description: "Text to tag" },
      { name: "schemes", description: "Tag schemes (default: ['lexicalClass'])" },
      { name: "language", description: "BCP-47 code (default: 'en')" },
    ]},
    { action: "nlp.distance", description: "Semantic distance between two texts", params: [
      { name: "text", required: true, description: "First text" },
      { name: "text2", required: true, description: "Second text" },
      { name: "type", description: "'word' or 'sentence' (default: 'sentence')" },
    ]},
    { action: "nlp.embed", description: "Get text embedding vector", params: [
      { name: "text", required: true, description: "Text to embed" },
      { name: "type", description: "'word' or 'sentence' (default: 'sentence')" },
    ]},
  ],
});
