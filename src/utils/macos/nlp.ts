// src/utils/macos/nlp.ts

import { getDarwinKit } from "./darwinkit";
import type {
  LanguageResult,
  SentimentResult,
  TagResult,
  EmbedResult,
  DistanceResult,
  NeighborsResult,
  NlpScheme,
  EmbedType,
  NamedEntity,
  TaggedToken,
} from "./types";

/**
 * Detect the language of a text string.
 * @example
 * const result = await detectLanguage("Bonjour le monde");
 * // → { language: "fr", confidence: 0.999 }
 */
export async function detectLanguage(text: string): Promise<LanguageResult> {
  return getDarwinKit().call<LanguageResult>("nlp.language", { text });
}

/**
 * Analyze sentiment of a text string.
 * Returns a score (-1 to 1) and a label.
 * @example
 * const result = await analyzeSentiment("I love this product!");
 * // → { score: 1.0, label: "positive" }
 */
export async function analyzeSentiment(text: string): Promise<SentimentResult> {
  return getDarwinKit().call<SentimentResult>("nlp.sentiment", { text });
}

/**
 * Tag a text string with POS tags, named entities, or lemmas.
 * @param schemes - One or more schemes to apply. Defaults to ["lexicalClass"].
 *   - "lexicalClass"   → POS tags (Noun, Verb, Adjective, ...)
 *   - "nameType"       → NER (PersonalName, OrganizationName, PlaceName)
 *   - "lemma"          → Root form of each word
 *   - "sentimentScore" → Sentiment score per token
 *   - "language"       → Per-token language
 */
export async function tagText(
  text: string,
  schemes: NlpScheme[] = ["lexicalClass"],
  language?: string,
): Promise<TagResult> {
  return getDarwinKit().call<TagResult>("nlp.tag", {
    text,
    schemes,
    ...(language ? { language } : {}),
  });
}

/**
 * Extract named entities (people, organizations, places) from text.
 * Convenience wrapper around tagText with the "nameType" scheme.
 */
export async function extractEntities(text: string): Promise<NamedEntity[]> {
  const result = await tagText(text, ["nameType"]);
  const nameTypeMap: Record<string, NamedEntity["type"]> = {
    PersonalName: "person",
    OrganizationName: "organization",
    PlaceName: "place",
  };
  return result.tokens
    .filter((t: TaggedToken) => t.tag in nameTypeMap)
    .map((t: TaggedToken) => ({
      text: t.text,
      type: nameTypeMap[t.tag] ?? "other",
    }));
}

/**
 * Compute a 512-dimensional semantic embedding vector for a text string.
 * @param language - BCP-47 language code. Default: "en"
 * @param type     - "word" or "sentence". Default: "sentence"
 */
export async function embedText(
  text: string,
  language = "en",
  type: EmbedType = "sentence",
): Promise<EmbedResult> {
  return getDarwinKit().call<EmbedResult>("nlp.embed", { text, language, type });
}

/**
 * Compute the cosine distance between two texts.
 * Returns 0 for identical texts, up to 2 for maximally different.
 */
export async function textDistance(
  text1: string,
  text2: string,
  language = "en",
  type: EmbedType = "sentence",
): Promise<DistanceResult> {
  return getDarwinKit().call<DistanceResult>("nlp.distance", { text1, text2, language, type });
}

/**
 * Quick boolean similarity check.
 * @param threshold - Cosine distance threshold. Default: 0.5
 */
export async function areSimilar(
  text1: string,
  text2: string,
  threshold = 0.5,
  language = "en",
): Promise<boolean> {
  const result = await textDistance(text1, text2, language);
  return result.distance < threshold;
}

/**
 * Find semantically similar words or sentences.
 * @param count    - Number of neighbors to return. Default: 5
 * @param language - BCP-47 code. Default: "en"
 * @param type     - "word" or "sentence". Default: "word"
 */
export async function findNeighbors(
  text: string,
  count = 5,
  language = "en",
  type: EmbedType = "word",
): Promise<NeighborsResult> {
  return getDarwinKit().call<NeighborsResult>("nlp.neighbors", { text, language, type, count });
}
