export interface WorldConfig {
  kind: "local" | "postgres";
  world: string | undefined;
  queueNamespace: string | undefined;
}

/**
 * Select the Workflow SDK world from environment.
 * - local (default): eve's built-in filesystem world (JSON under .workflow-data/), zero infra.
 * - postgres: @workflow/world-postgres; requires WORKFLOW_POSTGRES_URL. The queue
 *   namespace MUST equal the agent name ("genesis-eve") or every turn dies "Unhandled queue".
 */
export function resolveWorldConfig(env: Record<string, string | undefined>): WorldConfig {
  const kind = (env.EVE_WORLD ?? "local").trim().toLowerCase();

  if (kind === "postgres") {
    const url = env.WORKFLOW_POSTGRES_URL;

    if (!url) {
      throw new Error("EVE_WORLD=postgres requires WORKFLOW_POSTGRES_URL");
    }

    return {
      kind: "postgres",
      world: "@workflow/world-postgres",
      queueNamespace: env.WORKFLOW_QUEUE_NAMESPACE ?? "genesis-eve",
    };
  }

  if (kind === "local") {
    return { kind: "local", world: undefined, queueNamespace: undefined };
  }

  throw new Error(`Unknown EVE_WORLD="${kind}" (expected "local" or "postgres")`);
}
