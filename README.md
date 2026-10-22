# Gleeok

A browser workspace organised by project. Each project gets two or three browser panes side by
side, each with its own tabs; a sidebar switches projects. Inspired by
[Paseo](https://paseo.sh), and built to sit next to it: projects can be imported from a Paseo
daemon, with a pane that always opens the project's most recently used Paseo workspace.

- Per-project panes and tabs; 2/3-pane layouts; focus-expand; drag tabs between panes
- Projects keep running in the background; idle ones hibernate overnight; start/sleep/archive by hand
- Project links (new-tab page, entry page); a pasted URL or ☆ saves the current page as a link
- Command palette for projects, links, open tabs and commands
- Multiple windows/monitors: move a pane into its own window; every window follows the project
- Optional: a sync server for several machines (projects, links, open tabs handed between devices)
- Optional: password autofill from a Bitwarden or Vaultwarden vault

Electron + React. Runs on macOS, Linux (X11/Wayland, incl. niri) and Windows.

## Install and run (local mode)

Without any configuration Gleeok runs in **local mode**: everything is stored on this machine.

Needs Node.js 22+ and Git.

```sh
git clone https://github.com/Suchun-sv/Gleeok.git ~/github/gleeok
cd ~/github/gleeok/app
npm install
npm run build
npm start
```

Update later with `git pull && npm install && npm run build`, then restart.

- **Linux**: `deploy/gleeok-linux.sh` starts it with Wayland input-method support (fcitx5 etc.);
  `ln -sf ~/github/gleeok/deploy/gleeok-linux.sh ~/.local/bin/gleeok` and copy
  `deploy/gleeok.desktop` to `~/.local/share/applications/` for a launcher entry.
- **Windows**: `winget install OpenJS.NodeJS.LTS Git.Git`, then the steps above in PowerShell
  (if PowerShell refuses to run `npm`, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`
  once, or use `npm.cmd`). `deploy\gleeok-windows.cmd` starts it.
- **macOS**: `npm start` works as is. For a packaged `Gleeok.app` signed with a stable local
  certificate (so keychain access survives rebuilds): `../dev/mac-selfsign.sh` once, then
  `npm run dist:mac`.

Running from the checkout avoids code-signing prompts: npm's Electron binary is already signed.

## Paseo

If a Paseo daemon runs on the same machine, the "从 Paseo 导入" (import from Paseo) page lists
its projects; imported projects get a link to their most recently used workspace (and to an
open terminal there, if any). Before Paseo pages work inside Gleeok, pair once: paste the
daemon's pairing link (`paseo daemon pair`) into the box at the top of that page.

`PASEO_URL` (default `http://127.0.0.1:6767`) and `PASEO_PASSWORD` point Gleeok at another daemon.

## Optional: sync server for several machines

Run the server somewhere all your machines can reach (a Tailscale tailnet works well):

```sh
cd ~/github/gleeok/server && npm install
GLEEOK_TOKEN=<long random string> GLEEOK_HOST=<address to listen on> npm start   # port 7420
```

`deploy/gleeok-server.service` is a systemd user unit for it (settings in
`~/.config/gleeok/server.env`). `GLEEOK_VAULT_URL` tells clients which password vault to use.

On each machine, create `~/.config/gleeok/client.json`:

```json
{ "serverUrl": "http://<server>:7420", "token": "<the same token>" }
```

With this file Gleeok uses the server instead of local storage. Paseo projects then reach the
server through `paseo-sync/sync.mjs`, run on each machine with a Paseo daemon
(`deploy/gleeok-paseo-sync.{service,timer}` runs it every 2 minutes).

Open tabs are kept per device; opening a project hands over the tabs from whichever device
changed them last (a sleeping project takes them, a running one offers to switch).

`deploy/backup-pull.sh` (+ `gleeok-backup.{service,timer}`) pulls a daily backup of the server's
database from another machine.

## Optional: password vault

Ctrl/Cmd+Shift+L fills the current site's login from a Bitwarden-compatible vault; the palette
can also open or copy saved entries. The first unlock asks for the server (default: Bitwarden's
cloud), email and master password. The Bitwarden CLI ships with Gleeok, so nothing else needs
installing. A self-hosted [Vaultwarden](https://github.com/dani-garcia/vaultwarden) works too:
`deploy/vaultwarden.service` and `vaultwarden.env.example` run it as a user service behind
`tailscale serve`.

## Shortcuts

Prefix = Ctrl+Alt on Linux/Windows, Cmd+Opt on macOS.

| Keys | Action |
|---|---|
| Cmd+1..9 (macOS), Prefix+1..9 | switch project |
| Cmd+[ / ] (macOS), Prefix+↑/↓ or K/J | previous / next project |
| Prefix+←/→ or H/L | focus previous/next pane |
| Prefix+Shift+2 / 3 | two / three panes |
| Prefix+F | toggle focus-expand |
| Prefix+E | project entry page |
| Prefix+B | collapse / expand the sidebar |
| Prefix+D | move the focused pane to its own window / back |
| Ctrl/Cmd+Shift+K | command palette |
| Ctrl/Cmd+Shift+L | fill the login from the password vault |
| Ctrl/Cmd+T, W | new / close tab |
| Ctrl+Tab, Ctrl+Shift+Tab | next / previous tab |
| Ctrl/Cmd+Shift+T | reopen closed tab |
| Ctrl/Cmd+L | address bar |
| Ctrl/Cmd+D | save the page as a project link |
| Ctrl/Cmd+F | find in page |
| Ctrl/Cmd+R | reload |
| Ctrl/Cmd + = / - / 0 | zoom |
| Alt+←/→, Cmd+Opt+[ / ] (macOS) | back / forward |

## Multiple monitors

⧉ on a pane (or Prefix+D) moves it into its own window; ⇱ or closing that window puts it back.
Placement is remembered (macOS: display and bounds; niri: output, via `niri msg`). Satellite
windows have stable titles such as `Gleeok · 第3栏`, so a niri window rule can pin them.

## Layout

- `app/` — Electron client (main process, preload, React renderer)
- `server/` — API (Hono + node:sqlite); served over HTTP by the server, in-process in local mode
- `shared/` — data model shared by both
- `paseo-sync/` — pushes a Paseo daemon's projects to a sync server
- `deploy/` — launchers and systemd units
- `dev/` — headless capture scripts (`dev/capture.sh dev/smoke.json /tmp/out`)

## License

Apache License 2.0 — see [LICENSE](LICENSE). Copyright 2026 Suchun-sv.
