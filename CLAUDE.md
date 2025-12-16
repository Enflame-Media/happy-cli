# Happy CLI Codebase Overview

## Project Overview

Happy CLI (`handy-cli`) is a command-line tool that wraps Claude Code to enable remote control and session sharing. It's part of a three-component system:

1. **handy-cli** (this project) - CLI wrapper for Claude Code
2. **handy** - React Native mobile client
3. **handy-server** - Node.js server with Prisma (hosted at https://api.happy-servers.com/)

## Code Style Preferences

### TypeScript Conventions
- **Strict typing**: No untyped code ("I despise untyped code")
- **Clean function signatures**: Explicit parameter and return types
- **As little as possible classes**
- **Comprehensive JSDoc comments**: Each file includes header comments explaining responsibilities.
- **Import style**: Uses `@/` alias for src imports, e.g., `import { logger } from '@/ui/logger'`
- **File extensions**: Uses `.ts` for TypeScript files
- **Export style**: Named exports preferred, with occasional default exports for main functions

### DO NOT

- Create stupid small functions / getters / setters
- Excessive use of `if` statements - especially if you can avoid control flow changes with a better design
- **NEVER import modules mid-code** - ALL imports must be at the top of the file

### Error Handling
- Graceful error handling with proper error messages
- Use of `try-catch` blocks with specific error logging
- Abort controllers for cancellable operations
- Careful handling of process lifecycle and cleanup

### Process Lifecycle Management

Functions that register `process.on()` handlers must follow established patterns to prevent handler accumulation bugs. See HAP-52, HAP-75, HAP-132 for historical context.

#### Per-Call Pattern (Functions Called Multiple Times)

Functions invoked multiple times during the process lifecycle **MUST** remove handlers after use:

```typescript
// Store handler reference for removal
const exitHandler = () => cleanup()
process.on('exit', exitHandler)

// In cleanup or finally block:
process.removeListener('exit', exitHandler)
```

**Examples in codebase:**
- `query.ts` - Removes exit handlers after each query completes
- `runClaude.ts` - Removes SIGINT/SIGTERM handlers after each session

#### Singleton Pattern (One-Time Setup)

Utilities that run once per process lifetime do NOT need handler removal:

```typescript
let setupComplete = false
function setupGlobalHandlers() {
    if (setupComplete) return
    setupComplete = true
    process.on('exit', cleanup)  // Intentionally never removed
}
```

**Examples in codebase:**
- `caffeinate.ts` - Singleton process, handlers persist until exit
- `daemon/run.ts` - Global daemon handlers, run until process termination

#### Reference Equality Requirement

Handlers can only be removed if you store the function reference:

```typescript
// ❌ WRONG - Anonymous functions cannot be removed
process.on('exit', () => cleanup())

// ✅ CORRECT - Store reference for removal
const handler = () => cleanup()
process.on('exit', handler)
process.removeListener('exit', handler)
```

### Testing
- Unit tests using Vitest
- No mocking - tests make real API calls
- Test files colocated with source files (`.test.ts`)
- Descriptive test names and proper async handling

### Logging
- All debugging through file logs to avoid disturbing Claude sessions
- Console output only for user-facing messages
- Special handling for large JSON objects with truncation

## Architecture & Key Components

### 1. API Module (`/src/api/`)
Handles server communication and encryption.

- **`api.ts`**: Main API client class for session management
- **`apiSession.ts`**: WebSocket-based real-time session client with RPC support
- **`auth.ts`**: Authentication flow using TweetNaCl for cryptographic signatures
- **`encryption.ts`**: End-to-end encryption utilities using TweetNaCl
- **`types.ts`**: Zod schemas for type-safe API communication

**Key Features:**
- End-to-end encryption for all communications
- Socket.IO for real-time messaging
- Optimistic concurrency control for state updates
- RPC handler registration for remote procedure calls

### 2. Claude Integration (`/src/claude/`)
Core Claude Code integration layer.

- **`loop.ts`**: Main control loop managing interactive/remote modes
- **`types.ts`**: Claude message type definitions with parsers

- **`claudeSdk.ts`**: Direct SDK integration using `@anthropic-ai/claude-code`
- **`interactive.ts`**: **LIKELY WILL BE DEPRECATED in favor of running through SDK** PTY-based interactive Claude sessions
- **`watcher.ts`**: File system watcher for Claude session files (for interactive mode snooping)

- **`mcp/startPermissionServer.ts`**: MCP (Model Context Protocol) permission server

**Key Features:**
- Dual mode operation: interactive (terminal) and remote (mobile control)
- Session persistence and resumption
- Real-time message streaming
- Permission intercepting via MCP [Permission checking not implemented yet]

### 3. UI Module (`/src/ui/`)
User interface components.

- **`logger.ts`**: Centralized logging system with file output
- **`qrcode.ts`**: QR code generation for mobile authentication
- **`start.ts`**: Main application startup and orchestration

**Key Features:**
- Clean console UI with chalk styling
- QR code display for easy mobile connection
- Graceful mode switching between interactive and remote

### 4. Core Files

- **`index.ts`**: CLI entry point with argument parsing
- **`persistence.ts`**: Local storage for settings and keys
- **`utils/time.ts`**: Exponential backoff utilities

## Data Flow

1. **Authentication**: 
   - Generate/load secret key → Create signature challenge → Get auth token

2. **Session Creation**:
   - Create encrypted session with server → Establish WebSocket connection

3. **Message Flow**:
   - Interactive mode: User input → PTY → Claude → File watcher → Server
   - Remote mode: Mobile app → Server → Claude SDK → Server → Mobile app

4. **Permission Handling**:
   - Claude requests permission → MCP server intercepts → Sends to mobile → Mobile responds → MCP approves/denies

## Key Design Decisions

1. **File-based logging**: Prevents interference with Claude's terminal UI
2. **Dual Claude integration**: Process spawning for interactive, SDK for remote
3. **End-to-end encryption**: All data encrypted before leaving the device
4. **Session persistence**: Allows resuming sessions across restarts
5. **Optimistic concurrency**: Handles distributed state updates gracefully

## Security Considerations

- Private keys stored in `~/.handy/access.key` with restricted permissions
- All communications encrypted using TweetNaCl
- Challenge-response authentication prevents replay attacks
- Session isolation through unique session IDs

## Dependencies

- Core: Node.js, TypeScript
- Claude: `@anthropic-ai/claude-code` SDK
- Networking: Socket.IO client, Axios
- Crypto: TweetNaCl
- Terminal: node-pty, chalk, qrcode-terminal
- Validation: Zod
- Testing: Vitest
- Telemetry: @sentry/node (error reporting)

## Telemetry

Happy CLI includes optional, privacy-first telemetry for error reporting and usage analytics.

### Privacy Model

- **Disabled by default**: No data is collected unless explicitly enabled
- **Opt-in only**: Users must set `HAPPY_TELEMETRY=true` to enable
- **Anonymized by default**: When enabled, all data is anonymized (no PII)
- **Category-based**: Error reporting, usage tracking, and performance metrics can be individually controlled

### Configuration

Telemetry is configured via environment variables (highest priority) or settings file:

| Variable | Description | Default |
|----------|-------------|---------|
| `HAPPY_TELEMETRY` | Master switch (true/false) | false |
| `HAPPY_TELEMETRY_ANONYMIZE` | Force anonymization | true |
| `HAPPY_SENTRY_DSN` | Sentry DSN for errors | (none) |
| `HAPPY_TELEMETRY_ENDPOINT` | Usage metrics endpoint | (none) |

### Architecture

The telemetry module (`/src/telemetry/`) follows a layered design:

1. **Configuration Layer** (`config.ts`, `types.ts`)
   - Loads config from env vars and settings file
   - Provides `TelemetryConfig` interface with categories

2. **Error Reporting** (`sentry.ts`)
   - Sentry integration for crash/error reporting
   - `beforeSend` hook for anonymization
   - Sensitive data scrubbing

3. **Usage/Performance** (`sender.ts`)
   - Batched event queue with periodic flush
   - `trackEvent()` for usage tracking
   - `trackMetric()` for performance data

4. **Initialization** (`init.ts`)
   - Single entry point: `initializeTelemetry()`
   - Process exit handling with `shutdownTelemetry()`

### Usage in Code

```typescript
import { captureException, trackEvent, trackMetric } from '@/telemetry'

// Capture errors (only sent if telemetry.categories.errors is enabled)
try {
  await riskyOperation()
} catch (error) {
  captureException(error, { context: 'operationName' })
}

// Track usage events (only sent if telemetry.categories.usage is enabled)
trackEvent('feature_used', { feature: 'daemon_start' })

// Track performance (only sent if telemetry.categories.performance is enabled)
const start = Date.now()
await operation()
trackMetric('command_duration', Date.now() - start, { command: 'start' })
```

### User Notice

On first run, users see a one-time informational notice about telemetry options.
This is controlled by the `telemetryNoticeShown` setting flag. 


# Running the Daemon

## Starting the Daemon
```bash
# From the happy-cli directory:
./bin/happy.mjs daemon start

# With custom server URL (for local development):
HAPPY_SERVER_URL=http://localhost:3005 ./bin/happy.mjs daemon start

# Stop the daemon:
./bin/happy.mjs daemon stop

# Check daemon status:
./bin/happy.mjs daemon status
```

## Daemon Logs
- Daemon logs are stored in `~/.happy-dev/logs/` (or `$HAPPY_HOME_DIR/logs/`)
- Named with format: `YYYY-MM-DD-HH-MM-SS-daemon.log`

# Session Forking `claude` and sdk behavior

## Commands Run

### Initial Session
```bash
claude --print --output-format stream-json --verbose 'list files in this directory'
```
- Original Session ID: `aada10c6-9299-4c45-abc4-91db9c0f935d`
- Created file: `~/.claude/projects/.../aada10c6-9299-4c45-abc4-91db9c0f935d.jsonl`

### Resume with --resume flag
```bash
claude --print --output-format stream-json --verbose --resume aada10c6-9299-4c45-abc4-91db9c0f935d 'what file did we just see?'
```
- New Session ID: `1433467f-ff14-4292-b5b2-2aac77a808f0`
- Created file: `~/.claude/projects/.../1433467f-ff14-4292-b5b2-2aac77a808f0.jsonl`

## Key Findings for --resume

### 1. Session File Behavior
- Creates a NEW session file with NEW session ID
- Original session file remains unchanged
- Two separate files exist after resumption

### 2. History Preservation
- The new session file contains the COMPLETE history from the original session
- History is prefixed at the beginning of the new file
- Includes a summary line at the very top

### 3. Session ID Rewriting
- **CRITICAL FINDING**: All historical messages have their sessionId field UPDATED to the new session ID
- Original messages from session `aada10c6-9299-4c45-abc4-91db9c0f935d` now show `sessionId: "1433467f-ff14-4292-b5b2-2aac77a808f0"`
- This creates a unified session history under the new ID

### 4. Message Structure in New File
```
Line 1: Summary of previous conversation
Lines 2-6: Complete history from original session (with updated session IDs)
Lines 7-8: New messages from current interaction
```

### 5. Context Preservation
- Claude successfully maintains full context
- Can answer questions about previous interactions
- Behaves as if it's a continuous conversation

## Technical Details

### Original Session File Structure
- Contains only messages from the original session
- All messages have original session ID
- Remains untouched after resume

### New Session File Structure After Resume
```json
{"type":"summary","summary":"Listing directory files in current location","leafUuid":"..."}
{"parentUuid":null,"sessionId":"1433467f-ff14-4292-b5b2-2aac77a808f0","message":{"role":"user","content":[{"type":"text","text":"list files in this directory"}]},...}
// ... all historical messages with NEW session ID ...
{"parentUuid":"...","sessionId":"1433467f-ff14-4292-b5b2-2aac77a808f0","message":{"role":"user","content":"what file did we just see?"},...}
```

## Implications for handy-cli

When using --resume:
1. Must handle new session ID in responses
2. Original session remains as historical record
3. All context preserved but under new session identity
4. Session ID in stream-json output will be the new one, not the resumed one