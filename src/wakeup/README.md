# Wakeup

Tiny Wake-on-LAN helper with a guided CLI and HTTP relay.

## Quick start

- `tools wakeup` — opens an interactive menu (Configuration or Wake). The first run asks whether this machine is a server, client, or both and saves to `~/.genesis-tools/wakeup/config.json`.
- `tools wakeup server` — guided setup that auto-fills broadcast/MAC from your active interface, saves config, and starts the relay.
- `tools wakeup register` — grabs your MAC/broadcast automatically, asks for name/password, and registers with the configured server.
- `tools wakeup login` — prompts for server, name, password; confirms with the server, then saves credentials.
- `tools wakeup wake` — picks a saved device (or lets you login), asks when to wake (default now), and waits for the server acknowledgement.
- `tools wakeup send` — prompt-driven raw Wake-on-LAN packet sender.

All prompts use `@clack/prompts`; sensible defaults come from your network interface and saved config.

## Server endpoints

- `GET /health` — `{ "status": "ok" }`
- `POST /register` — `{ name, password, mac, broadcast?, port? }`
- `POST /login` — `{ name, password }` → confirms the client exists
- `POST /wake` — `{ name, password }` (uses registered client) or `{ mac, broadcast?, port?, password? }`

If a server token is configured, requests must include `Authorization: Bearer <token>` (or `?token=` for GET).

## Keep the relay running (daemon)

Register the relay with the shared daemon (launchd-backed):

```bash
tools wakeup daemon register --port 8787 --broadcast 192.168.1.255 --mac AA:BB:CC:DD:EE:FF --token secret
tools daemon install   # ensure daemon is installed and running
```

Status / remove:

```bash
tools wakeup daemon status
tools wakeup daemon unregister
```

## Notes

- Works best when the target Mac has "Wake for network access" enabled and is on a network that forwards broadcast packets to the interface.
- SecureOn passwords are supported in `tools wakeup send` and `/wake` via the optional `password` field (6-byte hex).
