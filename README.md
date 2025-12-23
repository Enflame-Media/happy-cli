# Happy

Code on the go controlling claude code from your mobile device.

Free. Open source. Code anywhere.

## Prerequisites

Before installing Happy CLI, ensure you have:

- **Node.js 20+** (required for eventsource-parser dependency)
- **Claude Code** installed globally via one of:
  - `npm install -g @anthropic-ai/claude-code` (recommended)
  - `brew install claude-code` (macOS/Linux)
  - Native installer: https://claude.ai/install

Verify Claude Code is installed and accessible:
```bash
claude --version
```

## Installation

```bash
npm install -g happy-coder
```

## Usage

```bash
happy
```

This will:
1. Start a Claude Code session
2. Display a QR code to connect from your mobile device
3. Allow real-time session sharing between Claude Code and your mobile app

## Commands

- `happy auth` – Manage authentication
- `happy codex` – Start Codex mode
- `happy connect` – Store AI vendor API keys in Happy cloud
- `happy notify` – Send a push notification to your devices
- `happy daemon` – Manage background service
- `happy doctor` – System diagnostics & troubleshooting

## Options

- `-h, --help` - Show help
- `-v, --version` - Show version
- `-m, --model <model>` - Claude model to use (default: sonnet)
- `-p, --permission-mode <mode>` - Permission mode: auto, default, or plan
- `--claude-env KEY=VALUE` - Set environment variable for Claude Code (e.g., for [claude-code-router](https://github.com/musistudio/claude-code-router))
- `--claude-arg ARG` - Pass additional argument to Claude CLI

## Environment Variables

- `HAPPY_SERVER_URL` - Custom server URL (default: https://happy-api.enflamemedia.com)
- `HAPPY_WEBAPP_URL` - Custom web app URL (default: https://happy.enflamemedia.com)
- `HAPPY_HOME_DIR` - Custom home directory for Happy data (default: ~/.enfm-happy)
- `HAPPY_DISABLE_CAFFEINATE` - Disable macOS sleep prevention (set to `true`, `1`, or `yes`)
- `HAPPY_EXPERIMENTAL` - Enable experimental features (set to `true`, `1`, or `yes`)

## Requirements

See [Prerequisites](#prerequisites) for the full requirements. In summary:

- Node.js >= 20.0.0 (required by `eventsource-parser` for MCP permission forwarding)
- Claude Code installed globally and logged in (`claude` command available in PATH)

## License

MIT
