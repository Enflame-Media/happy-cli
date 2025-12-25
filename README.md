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
- `happy completion` – Generate shell completion scripts

## Options

- `-h, --help` - Show help
- `-v, --version` - Show version
- `-m, --model <model>` - Claude model to use (default: sonnet)
- `-p, --permission-mode <mode>` - Permission mode: auto, default, or plan
- `--claude-env KEY=VALUE` - Set environment variable for Claude Code (e.g., for [claude-code-router](https://github.com/musistudio/claude-code-router))
- `--claude-arg ARG` - Pass additional argument to Claude CLI

## Shell Completion

Happy CLI supports shell completion for bash, zsh, and fish.

### Bash

```bash
# System-wide (requires sudo)
happy completion bash | sudo tee /etc/bash_completion.d/happy > /dev/null

# User-only
mkdir -p ~/.local/share/bash-completion/completions
happy completion bash > ~/.local/share/bash-completion/completions/happy
```

### Zsh

```bash
# Add to your ~/.zshrc before compinit:
mkdir -p ~/.zfunc
happy completion zsh > ~/.zfunc/_happy
# Then add to ~/.zshrc: fpath=(~/.zfunc $fpath)
```

### Fish

```bash
happy completion fish > ~/.config/fish/completions/happy.fish
```

## Environment Variables

- `HAPPY_SERVER_URL` - Custom server URL (default: https://happy-api.enflamemedia.com)
- `HAPPY_WEBAPP_URL` - Custom web app URL (default: https://happy.enflamemedia.com)
- `HAPPY_HOME_DIR` - Custom home directory for Happy data (default: ~/.enfm-happy)
- `HAPPY_DISABLE_CAFFEINATE` - Disable macOS sleep prevention (set to `true`, `1`, or `yes`)
- `HAPPY_EXPERIMENTAL` - Enable experimental features (set to `true`, `1`, or `yes`)

## Exit Codes

Happy CLI uses standard exit codes to indicate command status:

| Code | Meaning | When |
|------|---------|------|
| 0 | Success | Command completed without errors |
| 1 | Error | Command failed, daemon not running, or invalid input |
| 2 | Unhealthy | Daemon is degraded or stale (daemon health/status only) |

### Command-Specific Exit Codes

**`happy daemon status --json`**
- `0` - Daemon is running
- `1` - Daemon is not running
- `2` - Daemon state is stale (process not found)

**`happy daemon health`**
- `0` - Daemon is healthy
- `1` - Daemon is degraded
- `2` - Daemon is unhealthy

## Error Handling

Happy CLI provides structured error handling with:

### Error Categories

| Category | Codes | Description |
|----------|-------|-------------|
| Authentication | `AUTH_FAILED`, `TOKEN_EXPIRED` | Login/session issues |
| Connection | `CONNECT_FAILED`, `NO_RESPONSE` | Network problems |
| Daemon | `DAEMON_START_FAILED`, `PROCESS_TIMEOUT` | Background service issues |
| Session | `SESSION_NOT_FOUND` | Session management errors |

### Automatic Retry Behavior

- **Network errors**: Auto-retry with exponential backoff (3 attempts)
- **Server 5xx errors**: Auto-retry with 1-second delay
- **Authentication errors**: No retry - requires user action
- **Rate limiting (429)**: Respects `Retry-After` header

### Error Messages

All errors include:
- A correlation ID for support (e.g., `ref: abc12345`)
- Link to relevant documentation when available
- Suggested next steps

Example:
```
Error: Failed to connect to server (ref: abc12345)
  For more information, see: https://github.com/Enflame-Media/happy-shared/blob/main/docs/errors/CONNECTION.md#connect-failed
```

For detailed error documentation, see the [Error Reference](https://github.com/Enflame-Media/happy-shared/blob/main/docs/errors/).

## Troubleshooting

### Quick Diagnostics

```bash
# Run full system diagnostics
happy doctor

# Check daemon health
happy daemon health

# View daemon logs
cat "$(happy daemon logs)"

# Enable verbose output for debugging
happy --verbose
```

### Common Issues

#### Daemon Won't Start

```bash
# Kill stuck processes and restart
happy doctor clean
happy daemon start
```

#### Authentication Issues

```bash
# Force re-authentication (clears credentials)
happy auth login --force
```

#### Connection Problems

1. Check your internet connection
2. Verify the server is reachable: `curl -I https://happy-api.enflamemedia.com/health`
3. Check for proxy/firewall issues
4. Enable verbose mode for detailed logs: `happy --verbose`

#### Session Not Syncing

```bash
# Check daemon status
happy daemon status

# List active sessions
happy daemon list

# Restart the daemon
happy daemon stop && happy daemon start
```

### Getting Help

- Run `happy --help` for command documentation
- Run `happy <command> --help` for command-specific help
- Check the [Error Reference](https://github.com/Enflame-Media/happy-shared/blob/main/docs/errors/) for detailed error solutions
- Report issues at [GitHub Issues](https://github.com/Enflame-Media/happy-shared/issues)

## Requirements

See [Prerequisites](#prerequisites) for the full requirements. In summary:

- Node.js >= 20.0.0 (required by `eventsource-parser` for MCP permission forwarding)
- Claude Code installed globally and logged in (`claude` command available in PATH)

## License

MIT
