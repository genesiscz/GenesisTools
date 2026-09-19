import { compactChapter } from "./compact";
import type { Chapter, DemoName } from "./context";
import { listenChapter, voiceChapter } from "./listen";
import { loopChapter } from "./loop";
import { observeChapter } from "./observe";
import { routeChapter } from "./route";
import { verifyChapter } from "./verify";
import { watchChapter } from "./watch";

export const CHAPTERS: Record<DemoName, Chapter> = {
    listen: listenChapter,
    voice: voiceChapter,
    watch: watchChapter,
    route: routeChapter,
    compact: compactChapter,
    observe: observeChapter,
    verify: verifyChapter,
    loop: loopChapter,
};

export {
    type Chapter,
    type ChapterContext,
    type ChapterOutcome,
    DEMO_NAMES,
    type DemoEvent,
    type DemoName,
} from "./context";
