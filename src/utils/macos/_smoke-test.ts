// src/utils/macos/_smoke-test.ts
// Run with: bun run src/utils/macos/_smoke-test.ts

import {
  detectLanguage,
  analyzeSentiment,
  extractEntities,
  textDistance,
  rankBySimilarity,
  batchSentiment,
  groupByLanguage,
  getDarwinKit,
  closeDarwinKit,
} from "./index";

async function main() {
  console.log("=== DarwinKit Smoke Test ===\n");

  // 1. Capabilities
  const caps = await getDarwinKit().capabilities();
  console.log("✓ Capabilities:", caps.version, "on", caps.os);
  console.log("  Methods:", caps.methods.join(", "), "\n");

  // 2. Language detection
  const lang = await detectLanguage("Bonjour le monde, comment ça va?");
  console.log("✓ Language detection:", lang);

  // 3. Sentiment
  const sentiment = await analyzeSentiment("This feature is absolutely amazing!");
  console.log("✓ Sentiment:", sentiment);

  // 4. NER
  const entities = await extractEntities("Steve Jobs and Tim Cook built Apple in Cupertino.");
  console.log("✓ Named entities:", entities);

  // 5. Semantic distance
  const dist = await textDistance("budget planning session", "financial review meeting");
  console.log("✓ Semantic distance (budget/financial):", dist.distance.toFixed(3));

  // 6. Semantic ranking
  const emails = [
    { id: "1", text: "Q4 budget review is scheduled for next Tuesday" },
    { id: "2", text: "Happy birthday! Hope you have a great day" },
    { id: "3", text: "Annual financial planning workshop - please attend" },
    { id: "4", text: "Your package has been shipped" },
  ];
  const ranked = await rankBySimilarity("finance budget planning", emails, { maxResults: 2 });
  console.log("✓ Semantic ranking (top 2 for 'finance budget planning'):");
  ranked.forEach((r, i) => console.log(`  ${i + 1}. [score: ${r.score.toFixed(3)}] ${r.item.text}`));

  // 7. Batch sentiment
  const items = emails.map((e) => ({ id: e.id, text: e.text }));
  const sentiments = await batchSentiment(items);
  console.log("\n✓ Batch sentiment:");
  sentiments.forEach((s) => {
    const email = emails.find(e => e.id === s.id);
    console.log(`  [${s.label}] ${email?.text}`);
  });

  // 8. Language grouping
  const multiLang = [
    { id: "a", text: "Hello world" },
    { id: "b", text: "Bonjour le monde" },
    { id: "c", text: "Hola mundo" },
  ];
  const groups = await groupByLanguage(multiLang);
  console.log("\n✓ Language groups:", Object.keys(groups));

  console.log("\n✓ All tests passed!");
  closeDarwinKit();
}

main().catch((err) => {
  console.error("✗ Smoke test failed:", err);
  closeDarwinKit();
  process.exit(1);
});
