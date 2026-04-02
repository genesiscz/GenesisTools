# Wakeup

Tiny Wake-on-LAN helper with an HTTP relay that can be kept alive by the `tools daemon` scheduler.

## Usage

### Send a magic packet

```bash
tools wakeup send --mac AA:BB:CC:DD:EE:FF --broadcast 192.168.1.255 --port 9
```

### Run HTTP relay

```bash
tools wakeup server --port 8787 --broadcast 192.168.1.255 --wol-port 9 --default-mac AA:BB:CC:DD:EE:FF --token secret
```

Endpoints:

- `GET /health` — returns `{ "status": "ok" }`
- `POST /wake` — body: `{ "mac": "...", "broadcast": "...", "port": 9, "password": "..." }`
  - Provide bearer token via `Authorization: Bearer <token>` or `?token=` query parameter when `--token` is set.

### Keep relay always running (daemon)

Register the relay with the shared daemon (launchd-backed):

```bash
tools wakeup daemon register --port 8787 --broadcast 192.168.1.255 --mac AA:BB:CC:DD:EE:FF --token secret
tools daemon install   # ensure daemon is installed and running
```

Check status / remove:

```bash
tools wakeup daemon status
tools wakeup daemon unregister
```

## Notes

- Works best when the target Mac has "Wake for network access" enabled and is on a network that forwards broadcast packets to the interface.
- SecureOn passwords are supported via `--password`/`password` field (6-byte hex).
