// src/automate/commands/credentials.ts

import * as p from "@clack/prompts";
import pc from "picocolors";
import { Command } from "commander";
import {
  saveCredential,
  loadCredential,
  listCredentials,
  deleteCredential,
} from "@app/automate/lib/credentials";
import type { CredentialType, StoredCredential } from "@app/automate/lib/types";

export function registerCredentialsCommand(program: Command): void {
  const cmd = program
    .command("credentials")
    .alias("creds")
    .description("Manage stored credentials");

  cmd
    .command("add <name>")
    .description("Add or update a credential")
    .action(async (name: string) => {
      p.intro(pc.bgCyan(pc.black(" credentials add ")));

      const type = await p.select({
        message: "Credential type:",
        options: [
          { value: "bearer" as const, label: "Bearer token" },
          { value: "basic" as const, label: "Basic auth (username/password)" },
          { value: "apikey" as const, label: "API key (custom header)" },
          { value: "custom" as const, label: "Custom headers" },
        ],
      });
      if (p.isCancel(type)) { p.cancel("Cancelled"); process.exit(0); }

      const credential: StoredCredential = { name, type: type as CredentialType };

      switch (type) {
        case "bearer": {
          const token = await p.text({
            message: "Token (or {{ env.VAR }} expression):",
            placeholder: "{{ env.GITHUB_TOKEN }}",
          });
          if (p.isCancel(token)) { p.cancel("Cancelled"); process.exit(0); }
          credential.token = token;
          break;
        }
        case "basic": {
          const username = await p.text({ message: "Username:" });
          if (p.isCancel(username)) { p.cancel("Cancelled"); process.exit(0); }
          const password = await p.text({ message: "Password (or {{ env.VAR }}):" });
          if (p.isCancel(password)) { p.cancel("Cancelled"); process.exit(0); }
          credential.username = username;
          credential.password = password;
          break;
        }
        case "apikey": {
          const headerName = await p.text({
            message: "Header name:",
            placeholder: "X-API-Key",
            defaultValue: "X-API-Key",
          });
          if (p.isCancel(headerName)) { p.cancel("Cancelled"); process.exit(0); }
          const key = await p.text({ message: "Key value (or {{ env.VAR }}):" });
          if (p.isCancel(key)) { p.cancel("Cancelled"); process.exit(0); }
          credential.headerName = headerName;
          credential.key = key;
          break;
        }
        case "custom": {
          p.log.info(pc.dim("Enter headers as key=value pairs. Empty line to finish."));
          const headers: Record<string, string> = {};
          let addMore = true;
          while (addMore) {
            const header = await p.text({
              message: "Header (key=value):",
              placeholder: "X-Custom-Header={{ env.MY_SECRET }}",
            });
            if (p.isCancel(header)) { p.cancel("Cancelled"); process.exit(0); }
            if (!header) break;
            const eqIdx = header.indexOf("=");
            if (eqIdx > 0) {
              headers[header.substring(0, eqIdx)] = header.substring(eqIdx + 1);
            }
            const cont = await p.confirm({ message: "Add another header?", initialValue: false });
            if (p.isCancel(cont)) { p.cancel("Cancelled"); process.exit(0); }
            addMore = cont;
          }
          credential.headers = headers;
          break;
        }
      }

      await saveCredential(credential);
      p.outro(pc.green(`Credential "${name}" saved (0600 permissions)`));
    });

  cmd
    .command("list")
    .alias("ls")
    .description("List all stored credentials")
    .action(() => {
      const names = listCredentials();
      if (names.length === 0) {
        console.log(pc.dim("No credentials stored."));
        return;
      }
      for (const name of names) {
        console.log(`  ${pc.cyan(name)}`);
      }
      console.log(pc.dim(`\n${names.length} credential(s) at ~/.genesis-tools/automate/credentials/`));
    });

  cmd
    .command("show <name>")
    .description("Show credential details (values masked)")
    .action(async (name: string) => {
      const cred = await loadCredential(name);
      if (!cred) {
        console.log(pc.red(`Credential "${name}" not found`));
        process.exit(1);
      }
      console.log(`  ${pc.bold("Name:")} ${cred.name}`);
      console.log(`  ${pc.bold("Type:")} ${cred.type}`);
      // Mask sensitive values
      for (const [key, value] of Object.entries(cred)) {
        if (key === "name" || key === "type") continue;
        if (typeof value === "string") {
          const masked = value.startsWith("{{")
            ? value
            : value.length <= 4
              ? "*".repeat(value.length)
              : `${value.substring(0, 4)}${"*".repeat(value.length - 4)}`;
          console.log(`  ${pc.bold(`${key}:`)} ${pc.dim(masked)}`);
        }
      }
    });

  cmd
    .command("delete <name>")
    .description("Delete a credential")
    .action((name: string) => {
      const deleted = deleteCredential(name);
      if (deleted) {
        console.log(pc.green(`Credential "${name}" deleted`));
      } else {
        console.log(pc.red(`Credential "${name}" not found`));
      }
    });
}
