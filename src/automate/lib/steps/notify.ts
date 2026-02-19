import clipboardy from "clipboardy";
import { registerStepHandler } from "../registry";
import type { StepContext } from "../registry";
import type { NotifyStepParams, PresetStep, StepResult } from "../types";
import { makeResult } from "./helpers";

async function notifyHandler(step: PresetStep, ctx: StepContext): Promise<StepResult> {
  const start = performance.now();
  const params = step.params as unknown as NotifyStepParams;
  const subAction = step.action.split(".")[1];

  try {
    switch (subAction) {
      case "desktop": {
        const title = ctx.interpolate(params.title ?? "GenesisTools Automate");
        const message = ctx.interpolate(params.message ?? "");
        const escapedTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const escapedMsg = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const proc = Bun.spawn({
          cmd: [
            "osascript",
            "-e",
            `display notification "${escapedMsg}" with title "${escapedTitle}"`,
          ],
          stdio: ["ignore", "pipe", "pipe"],
        });
        await proc.exited;
        return makeResult("success", { title, message }, start);
      }

      case "clipboard": {
        const content = ctx.interpolate(params.content ?? params.message ?? "");
        await clipboardy.write(content);
        return makeResult("success", { copied: true, length: content.length }, start);
      }

      case "sound": {
        const sound = params.sound ?? "Glass";
        const soundPath = `/System/Library/Sounds/${sound}.aiff`;
        const proc = Bun.spawn({
          cmd: ["afplay", soundPath],
          stdio: ["ignore", "pipe", "pipe"],
        });
        await proc.exited;
        return makeResult("success", { sound }, start);
      }

      case "telegram": {
        const { loadTelegramConfig } = await import("@app/telegram-bot/lib/config");
        const { createApi, sendMessage } = await import("@app/telegram-bot/lib/api");

        const config = await loadTelegramConfig();
        if (!config) {
          ctx.log("warn", "Telegram not configured. Run: tools telegram-bot configure");
          return makeResult("skipped", { reason: "not_configured" }, start);
        }

        const api = createApi(config.botToken);
        const message = ctx.interpolate(params.message ?? "");
        const parseMode = params.parse_mode;

        const sent = await sendMessage(api, config.chatId, message, parseMode as "MarkdownV2" | "HTML" | undefined);

        return makeResult("success", { messageId: sent.message_id, chatId: config.chatId }, start);
      }

      default:
        return makeResult("error", null, start, `Unknown notify action: ${subAction}`);
    }
  } catch (error) {
    return makeResult("error", null, start, error instanceof Error ? error.message : String(error));
  }
}

registerStepHandler("notify", notifyHandler);
