// src/automate/lib/steps/git.ts

import { createGit } from "@app/utils/git/core";
import { registerStepHandler, registerStepCatalog } from "@app/automate/lib/registry";
import type { StepContext } from "@app/automate/lib/registry";
import type { GitStepParams, PresetStep, StepResult } from "@app/automate/lib/types";
import { makeResult } from "./helpers";

async function gitHandler(step: PresetStep, ctx: StepContext): Promise<StepResult> {
  const start = performance.now();
  const params = (step.params ?? {}) as unknown as GitStepParams;
  const subAction = step.action.split(".")[1];
  const cwd = params.cwd ? ctx.interpolate(params.cwd) : process.cwd();
  const git = createGit({ cwd });

  try {
    switch (subAction) {
      case "status": {
        const hasChanges = await git.hasUncommittedChanges();
        const branch = await git.getCurrentBranch();
        const result = await git.executor.exec(["status", "--porcelain"]);
        const files = result.stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => ({
            status: line.substring(0, 2).trim(),
            path: line.substring(3),
          }));
        return makeResult("success", { branch, hasChanges, files }, start);
      }

      case "commit": {
        const message = ctx.interpolate(params.message ?? "Automated commit");
        const files = params.files?.map((f) => ctx.interpolate(f));

        if (files && files.length > 0) {
          await git.executor.execOrThrow(["add", ...files]);
        } else {
          await git.executor.execOrThrow(["add", "-A"]);
        }

        const result = await git.executor.exec(["commit", "-m", message]);
        if (!result.success) {
          if (result.stdout.includes("nothing to commit")) {
            return makeResult("success", { committed: false, message: "Nothing to commit" }, start);
          }
          return makeResult("error", null, start, result.stderr);
        }

        const sha = await git.getShortSha("HEAD");
        return makeResult("success", { committed: true, sha, message }, start);
      }

      case "branch": {
        if (!params.branch) {
          return makeResult("error", null, start, "git.branch requires a 'branch' param");
        }
        const branchName = ctx.interpolate(params.branch);
        const from = params.from ? ctx.interpolate(params.from) : undefined;
        await git.createBranch(branchName, from);
        return makeResult("success", { branch: branchName }, start);
      }

      case "diff": {
        const from = params.from ? ctx.interpolate(params.from) : "HEAD~1";
        const to = params.to ? ctx.interpolate(params.to) : "HEAD";
        const result = await git.executor.exec(["diff", `${from}..${to}`]);
        return makeResult("success", { from, to, diff: result.stdout }, start);
      }

      case "log": {
        const limit = params.limit ?? 10;
        const from = params.from ? ctx.interpolate(params.from) : undefined;
        const to = params.to ? ctx.interpolate(params.to) : "HEAD";

        const logArgs = from
          ? ["log", "--oneline", `${from}..${to}`, `-${limit}`]
          : ["log", "--oneline", `-${limit}`];

        const result = await git.executor.exec(logArgs);
        const commits = result.stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const spaceIdx = line.indexOf(" ");
            return {
              sha: line.substring(0, spaceIdx),
              message: line.substring(spaceIdx + 1),
            };
          });
        return makeResult("success", { commits, count: commits.length }, start);
      }

      default:
        return makeResult("error", null, start, `Unknown git action: ${subAction}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return makeResult("error", null, start, message);
  }
}

registerStepHandler("git", gitHandler);
registerStepCatalog({
  prefix: "git",
  description: "Git operations",
  actions: [
    { action: "git.status", description: "Get repo status (branch, changed files)", params: [
      { name: "cwd", description: "Repository path" },
    ]},
    { action: "git.commit", description: "Stage and commit changes", params: [
      { name: "message", description: "Commit message (default: 'Automated commit')" },
      { name: "files", description: "Files to stage (default: all)" },
      { name: "cwd", description: "Repository path" },
    ]},
    { action: "git.branch", description: "Create a new branch", params: [
      { name: "branch", required: true, description: "Branch name" },
      { name: "from", description: "Base ref" },
    ]},
    { action: "git.diff", description: "Get diff between refs", params: [
      { name: "from", description: "From ref (default: HEAD~1)" },
      { name: "to", description: "To ref (default: HEAD)" },
    ]},
    { action: "git.log", description: "Get commit log", params: [
      { name: "limit", description: "Max commits (default: 10)" },
      { name: "from", description: "From ref" },
      { name: "to", description: "To ref (default: HEAD)" },
    ]},
  ],
});
