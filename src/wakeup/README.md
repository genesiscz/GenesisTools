# tools wakeup

A Wake-on-LAN helper with guided prompts and a small HTTP relay. Run the relay on an always-on machine on your
home or office network, register the Mac you want to wake, and wake it later from any machine that can reach the
relay, or send a magic packet yourself when you are on the same network.

## Quick start

```bash
# On the always-on machine: answer a few prompts, save them, and start the relay (runs until Ctrl+C)
tools wakeup server

# On the Mac you want to wake, while it is awake: send its MAC and broadcast address to the relay
tools wakeup register

# On the machine you wake it from: save the relay address and the device login
tools wakeup login

# Wake the device through the relay (now, or after a delay)
tools wakeup wake

# No relay: send a magic packet from this machine to a MAC on this network
tools wakeup send

# The menu: wake, configuration, or a raw packet (the first run asks for this machine's role)
tools wakeup
```

Every command except `daemon` is a guided flow and needs a terminal. All prompts use `@clack/prompts`, and the
defaults come from your network interface and the saved config.

## Commands

Only `daemon register` takes flags; the other commands ask for what they need. Every command also takes
`-h, --help`, and the tool takes `-v, --verbose`, `-V, --version` and `--readme`.

| Command | What it does |
|---|---|
| `tools wakeup` | The menu: Wake a device, Configuration, Send raw magic packet |
| `config` | Pick this machine's role, then set up the relay, register or log in |
| `server` | Ask for the relay settings, save them, start the relay in the foreground |
| `register` | Register this machine (its MAC and broadcast) with a relay |
| `login` | Check a device name and password with a relay and save them |
| `wake` | Ask the relay to wake the saved device, now or after a delay |
| `send` | Send a magic packet from this machine, without a relay |
| `daemon register` | Register the relay as the daemon task `wakeup-server` |
| `daemon unregister` | Remove the `wakeup-server` task |
| `daemon status` | Show whether the task is registered and the daemon runs |

### `tools wakeup` and `config`

With no subcommand, the tool opens a menu (Wake a device is the default). When no role is saved yet, it first runs
the configuration menu.

`config` asks what this machine is: Server (runs the relay), Client (sends wake requests) or Both. Then it offers
the next step: set up and start the server, register this device, log in, or Done. A role never narrows: when a
client picks Server, the saved role becomes `both`. The role only decides whether the first run shows the
configuration menu; every command works on every machine.

### `server`

Asks for these settings, saves them under `server` in the config, and starts the relay. It runs in the foreground
until Ctrl+C or SIGTERM and prints `server listening on http://<host>:<port>`.

| Prompt | Default |
|---|---|
| Bind host | `0.0.0.0` (every interface, reachable from the LAN) |
| HTTP port | `8787` |
| Default broadcast address | the detected interface's broadcast, else `255.255.255.255` |
| UDP port for magic packet | `9` |
| Default target MAC (optional) | this machine's own MAC |
| Shared token (optional) | none |
| Log wakeup requests? | yes |

The default MAC is used when a `/wake` or `/register` request names no MAC. The prompt fills in the relay's own MAC,
which is no use as a target because the relay is awake: replace it with a target's MAC or clear it. A saved value
is the default the next time you run `server`.

### `register`

Run it on the machine you want to wake later. It asks for the relay as `host:port` (default: the saved relay, else
`localhost:8787`), a device name, a device password, and the network interface to register. Each interface shows
its address, MAC and broadcast; pick the one the relay can reach. Choose "Enter values manually" to type a MAC and
a broadcast address instead.

The UDP port is not asked: it is the saved client port, else the saved server port, else `9`. The relay stores the
password as a SHA-256 digest. This machine saves the name, the password, the MAC and the relay address under
`client`, and the relay address under `server.host` and `server.port`.

Registering a name that already exists replaces that device on the relay, password included.

### `login`

Run it on the machine you wake from. It asks for the relay as `host:port`, the device name and its password, and
calls `POST /login`. The relay answers with the device's MAC, broadcast and UDP port. This machine saves them with
the login, so `send` can use them later.

### `wake`

Asks when to wake: Now (the default), in 10 seconds, in 30 seconds, in 1 minute, or a custom number of seconds.
Then it offers the saved login or a different one; with no saved relay or device name it runs `login` first. The
delay runs on this machine, so keep the terminal open until it ends. Then it calls `POST /wake` and prints `Server
acknowledged wake for <mac>`. That message means the relay sent the packet, not that the target woke up.

### `send`

Sends one magic packet from this machine, so the target must be on the same network. It asks for the target MAC,
the broadcast address, the UDP port and an optional SecureOn password (6 bytes as hex, for example
`AABBCCDDEE00`). The defaults are the saved client values, then the detected interface (whose MAC is this
machine's own), then `255.255.255.255` and port `9`.

### `daemon`

`daemon register` writes the task `wakeup-server` into the launchd-backed [`tools daemon`](../daemon/README.md): it runs every minute
with no retries, and running it again updates the task. It warns when the daemon is not running.

> **Known problem: the task cannot start the relay.** The task runs `bun run <checkout>/src/wakeup/index.ts server`
> with the flags below (`--port`, `--broadcast`, `--wol-port`, `--bind` and, when set, `--default-mac`, `--token` and
> `--log-requests`), but `server` takes no flags since commit `07c67ba04b` made it a guided command, and a
> daemon run has no terminal. Each run exits 1. Until this is fixed, keep `tools wakeup server` running in a
> terminal that stays open. See [Troubleshooting](#troubleshooting).

| Flag | Default | Meaning |
|---|---|---|
| `-p, --port <port>` | `8787` | HTTP port to listen on |
| `--bind <host>` | `0.0.0.0` | Bind host |
| `-b, --broadcast <addr>` | `255.255.255.255` | Broadcast address to target |
| `-m, --mac <mac>` | none | Default target MAC |
| `-t, --token <token>` | none | Shared token for HTTP requests |
| `--wol-port <port>` | `9` | UDP port for the magic packet |
| `--log-requests` | off | Log incoming wake attempts |

```bash
tools wakeup daemon register \
    --port 8787 \
    --broadcast 192.168.1.255 \
    --mac AA:BB:CC:DD:EE:FF \
    --token secret
tools daemon install          # make sure the daemon is installed and running
tools wakeup daemon status    # is the task registered, and does the daemon run?
tools wakeup daemon unregister
```

## How it works

```text
tools wakeup wake  --HTTP POST /wake-->  relay (tools wakeup server)  --UDP broadcast-->  target's network card
```

- **The magic packet** is 6 bytes of `0xFF` and the target MAC 16 times: 102 bytes, or 108 with a SecureOn
  password at the end. It goes out over IPv4 UDP to the broadcast address with broadcast enabled, from a random
  local port. A MAC may use any separators (`aa:bb:cc:dd:ee:ff`, `AA-BB-CC-DD-EE-FF`, `aabbccddeeff`), but it must
  have exactly 12 hex characters.
- **Network defaults** come from the first IPv4 interface that is not loopback. The broadcast address is computed
  from its address and netmask; when that fails it is `255.255.255.255`.
- **The relay** is a Bun HTTP server that speaks plain HTTP. It reads the registered devices from the config when it
  starts and writes each new registration back. It must be on the same network segment as the target, because the
  packet is a broadcast. If the relay runs on the Mac you want to wake, it sleeps with that Mac: run it on a
  machine that stays on.
- **The target** needs Wake-on-LAN turned on (on a Mac, "Wake for network access") and a network that delivers
  broadcast packets to its interface.
- **Data**: the settings, the logins and the registered devices are in `~/.genesis-tools/wakeup/config.json` (see
  [Configuration](#configuration)). The relay
  writes registrations, logins, sent packets, failed sends and refused tokens to the day log
  `~/.genesis-tools/logs/<date>.log`. With request logging on, it also prints them to its console.
- **Needs**: no accounts, no internet, and nothing costs money. macOS asks "Allow GenesisTools to find devices on
  local networks?" the first time a command or
  the relay reaches the LAN (the UDP broadcast, or an HTTP call to a LAN relay). Answer Allow, and check it with
  `tools macos permissions`.

### HTTP API

| Endpoint | Body | Answer |
|---|---|---|
| `GET /health` | none | `{ "status": "ok" }` |
| `POST /register` | `name`, `password`, `mac`, `broadcast?`, `port?` | `{ ok, client }` |
| `POST /login` | `name`, `password` | `{ ok, client }` |
| `POST /wake` | `name`, `password` | `/wake` answer (below) |
| `POST /wake` | `mac`, `broadcast?`, `port?`, `password?` | `/wake` answer |

The `/wake` answer is `{ ok, mac, broadcast, port, bytesSent }`. The first row wakes a registered device.

- **The token**: when the relay has one, every request except `/health` needs `Authorization: Bearer <token>` or a
  `?token=` query parameter. Without it, the relay answers 401 `unauthorized`.
- **Fields** may come as JSON, as a form (`application/x-www-form-urlencoded`), or, for `/login` and `/wake`, as
  query parameters, so they also answer a `GET`. `/register` needs a body.
- **Defaults**: a missing `mac` takes the relay's default MAC, a missing `broadcast` and `port` take the relay's
  defaults. `port` is the UDP port for the packet, not the HTTP port.
- **`password` means two things**. With `name`, it is the device password, and the relay sends the registered MAC,
  broadcast and port without a SecureOn password. Without `name`, it is the SecureOn password, 6 bytes as hex.
- **The `client` object** in an answer has `name`, `mac`, `broadcast` and `wolPort`, never the password.
- **Errors** are JSON `{ "error": "<message>" }`: 400 for a missing body, name or MAC, an invalid MAC, port or
  SecureOn password, or a failed send (the OS message); 401 for a wrong token, or a wrong or missing device password
  on `/wake`; 404 for an unknown device or path; 500 for an unexpected relay error. `/register` stores the MAC
  unchecked; a bad MAC shows only at wake time.

```bash
# Is the relay up? (no token needed)
curl http://relay.local:8787/health

# Wake a registered device
curl -X POST http://relay.local:8787/wake \
    -H "Authorization: Bearer $WAKEUP_TOKEN" \
    -H "content-type: application/json" \
    -d '{"name":"desk-mac","password":"example-password"}'

# Wake any MAC on the relay's network
curl -X POST http://relay.local:8787/wake \
    -H "Authorization: Bearer $WAKEUP_TOKEN" \
    -H "content-type: application/json" \
    -d '{"mac":"01:23:45:67:89:ab","broadcast":"192.168.1.255"}'
```

### Security

- Without a token, anyone who can reach the relay's port can wake any MAC on its network, and can register a device
  under an existing name, which replaces it and its password. Set a token when the relay binds to `0.0.0.0`.
- The relay checks the token and the passwords with a timing-safe compare, and it stores device passwords as
  SHA-256 digests.
- The relay speaks plain HTTP, so the token and the passwords cross the network unencrypted.
- The config file holds the token and this machine's device password in plain text. The tool does not restrict its
  file mode, so a new file gets your umask default, which other local users can usually read. Run
  `chmod 600 ~/.genesis-tools/wakeup/config.json` once; later writes keep the mode.

## Configuration

One file, `~/.genesis-tools/wakeup/config.json`, written by the commands. The `GENESIS_TOOLS_HOME` environment
variable moves the root: the file is then `$GENESIS_TOOLS_HOME/.genesis-tools/wakeup/config.json`.

```json
{
  "role": "both",
  "server": {
    "host": "0.0.0.0",
    "port": 8787,
    "token": "example-token",
    "broadcast": "192.168.1.255",
    "wolPort": 9,
    "defaultMac": "01:23:45:67:89:ab",
    "logRequests": true,
    "clients": [
      {
        "name": "desk-mac",
        "password": "<sha256 hex digest>",
        "mac": "01:23:45:67:89:ab",
        "broadcast": "192.168.1.255",
        "wolPort": 9
      }
    ]
  },
  "client": {
    "name": "desk-mac",
    "password": "example-password",
    "mac": "01:23:45:67:89:ab",
    "broadcast": "192.168.1.255",
    "wolPort": 9,
    "serverHost": "relay.local",
    "serverPort": 8787
  }
}
```

- `role`: `server`, `client` or `both`.
- `server`: the relay's settings from `tools wakeup server`, and `clients`, the devices registered with this relay.
- `client`: the device login from `register` or `login`, the device's MAC, broadcast and UDP port, and the relay
  address.

Two keys under `server` are shared with the client commands:

- `register`, `login` and `wake` write the relay address you type into `server.host` and `server.port`. On a
  machine with the role `both`, `tools wakeup server` then offers that address as its bind host: check it.
- The other direction: `tools wakeup server` (and each registration the running relay saves) writes its bind host
  into `server.host`. `wake` and `login` read `server.host` before `client.serverHost`, so on a `both` machine they
  can aim at this Mac (for example `http://0.0.0.0:8787`) instead of the remote relay. When the relay you wake through
  is another machine, run `tools wakeup login` again before `wake`.
- The client commands send `server.token` as the bearer token, but they never ask for it. On a machine that only
  wakes, add `"token"` under `"server"` in the file by hand when the relay has one.

## For agents and scripts

- There is no `--json` output and no MCP tool. Without a terminal (stdin is not a TTY), every command except
  `daemon` prints `Interactive mode required: …` (with the suggested `tools wakeup …` command; the command name can
  appear twice, a known quirk) and exits 1.
- To wake a machine from a script, call the relay's [HTTP API](#http-api) with `curl`.
- Exit codes: 0 on success and when you cancel a prompt; 1 on a failed request, a missing value or no terminal; 130
  when you stop the relay with Ctrl+C.
- [`tools hub wake`](../hub/README.md) reads this config and shows the relay this Mac is registered with, for the
  phone's Wake my Mac screen. Its `--json` output includes the device name, the password and the token.

## Troubleshooting

- **The daemon task runs, but the relay never answers.** The `wakeup-server` task calls `server` with flags it no
  longer accepts, and a daemon run has no terminal, so each run exits 1. Read a run with
  `tools daemon logs --task wakeup-server`. Remove the task with `tools wakeup daemon unregister` and keep
  `tools wakeup server` running in a terminal. The task also has the daemon's default 10-minute timeout, which
  would stop a long-running relay.
- **`unauthorized` from `register`, `login` or `wake`.** The relay has a token and this machine's config has none
  under `server.token`. Add it by hand (see [Configuration](#configuration)).
- **`client not found` or `invalid password`.** The relay has no device with that name, or the password differs.
  Run `tools wakeup register` on the target again, then `tools wakeup login` with the same name and password.
- **`Invalid MAC address "…". Expected 6 bytes (12 hex chars).`** The MAC has fewer or more than 12 hex characters.
  The same check applies to a SecureOn password. A MAC typed by hand at `register` is checked only at wake time, so
  run `tools wakeup register` again with the right MAC.
- **A send or request fails on the LAN (for example "No route to host").** macOS may have the Local Network grant
  denied for GenesisTools. Allow it in System Settings, Privacy & Security, Local Network.
- **"Server acknowledged wake", but the target stays asleep.** The relay sent the packet, but it did not reach the
  card. Check that Wake-on-LAN ("Wake for network access") is on, that the relay is on the target's network, and
  that the broadcast address and MAC belong to the interface the target listens on.
- **The relay stops answering when the target sleeps.** The relay runs on the target. Run it on a machine that
  stays on.
- **`Interactive mode required`.** The command ran without a terminal. Run it in a terminal, or use the HTTP API.

## Related

- [`tools daemon`](../daemon/README.md): the scheduler that `tools wakeup daemon` registers its task with.
- [`tools hub`](../hub/README.md): `tools hub wake` shows the saved relay login for the phone.
