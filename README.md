<p align="center">
	<img src="./.screens/logo.png" alt="ClaudeWebUI Logo">
</p>

A self-hosted browser IDE that wraps the [Claude Code](https://claude.com/claude-code) CLI inside a real editor, file explorer, and git viewer, so you don't have to give up the IDE feel just because you want an agent in the loop.

The industry is leaning hard into pure CLI agents, which to me feels impersonal and more of a "trust me bro / vibe code it" experience. For some projects that's fine. For others I still want the intimate overview of my files, directory tree, and manual edits / touch-ups while keeping Claude Code baked in next to me. So I built this.

It's also easy to put behind something like Tailscale and run on a dedicated dev box, so I can pop into a serious dev environment from anywhere without exposing anything publicly.

I think this project is mostly to the point of what it is based on the description and the previews below. No fancy emojis, no over-inflated and fluffed up readme. Use it if you want. This was more for personal usage, but I can productionalize it if it gains traction. Anyways, cheers, enjoy.

## Previews
![](./.screens/login.png)
![](./.screens/browse.png)
![](./.screens/claude1.png)
![](./.screens/claude2.png)
![](./.screens/terminal.png)
![](./.screens/editor.png)
![](./.screens/git.png)

## Setup

Requires **Python 3.10+**, [`claude`](https://docs.claude.com/en/docs/claude-code/setup) on your `PATH`, and [`ripgrep`](https://github.com/BurntSushi/ripgrep) for the search panel.

```bash
git clone https://github.com/acidvegas/claudewebui.git
cd claudewebui

echo "WEBUI_PASSWORD=changeme" > .env

./start.sh
```

`start.sh` will create a `.venv/`, install `flask` and `flask-socketio` from `requirements.txt`, and launch the server on `http://localhost:5000` (override with `PORT=8080 ./start.sh`).

To restart after code changes:

```bash
./restart.sh
```

Behind a reverse proxy, just forward port 5000. Socket.IO works over plain HTTP/HTTPS as long as websocket upgrades are passed through.
