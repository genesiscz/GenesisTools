// src/utils/macos/_smoke-test.ts
// Run with: bun run src/utils/macos/_smoke-test.ts

import { out } from "@app/logger";
import {
    analyzeSentiment,
    batchSentiment,
    closeDarwinKit,
    detectLanguage,
    extractEntities,
    getDarwinKit,
    groupByLanguage,
    rankBySimilarity,
    textDistance,
} from "./index";

async function main() {
    out.print("=== DarwinKit Smoke Test ===\n");

    // 1. Capabilities
    const caps = await getDarwinKit().system.capabilities();
    out.print("✓ Capabilities:", caps.version, "on", caps.os);
    out.print("  Methods:", Object.keys(caps.methods).join(", "), "\n");

    // 2. Language detection
    const lang = await detectLanguage("Bonjour le monde, comment ça va?");
    out.print("✓ Language detection:", lang);

    // 3. Sentiment
    const sentiment = await analyzeSentiment("This feature is absolutely amazing!");
    out.print("✓ Sentiment:", sentiment);

    // 4. NER
    const entities = await extractEntities("Steve Jobs and Tim Cook built Apple in Cupertino.");
    out.print("✓ Named entities:", entities);

    // 5. Semantic distance
    const dist = await textDistance("budget planning session", "financial review meeting");
    out.print("✓ Semantic distance (budget/financial):", dist.distance.toFixed(3));

    // 6. Semantic ranking
    const emails = [
        { id: "1", text: "Q4 budget review is scheduled for next Tuesday" },
        { id: "2", text: "Happy birthday! Hope you have a great day" },
        { id: "3", text: "Annual financial planning workshop - please attend" },
        { id: "4", text: "Your package has been shipped" },
    ];
    const ranked = await rankBySimilarity("finance budget planning", emails, { maxResults: 2 });
    out.print("✓ Semantic ranking (top 2 for 'finance budget planning'):");
    ranked.forEach((r, i) => {
        out.print(`  ${i + 1}. [score: ${r.score.toFixed(3)}] ${r.item.text}`);
    });

    // 7. Batch sentiment
    const items = emails.map((e) => ({ id: e.id, text: e.text }));
    const sentiments = await batchSentiment(items);
    out.print("\n✓ Batch sentiment:");
    sentiments.forEach((s) => {
        const email = emails.find((e) => e.id === s.id);
        out.print(`  [${s.label}] ${email?.text}`);
    });

    // 8. Language grouping
    const multiLang = [
        { id: "a", text: "Hello world" },
        { id: "b", text: "Bonjour le monde" },
        { id: "c", text: "Hola mundo" },
    ];
    const groups = await groupByLanguage(multiLang);
    out.print("\n✓ Language groups:", Object.keys(groups));

    out.print("\n✓ All tests passed!");
    closeDarwinKit();
}

main().catch((err) => {
    out.error("✗ Smoke test failed:", err);
    closeDarwinKit();
    process.exit(1);
});
