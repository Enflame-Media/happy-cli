import { ApiSessionClient } from "@/api/apiSession"
import { MessageQueue2 } from "@/utils/MessageQueue2"
import { logger } from "@/ui/logger"
import { Session } from "./session"
import { claudeLocalLauncher } from "./claudeLocalLauncher"
import { claudeRemoteLauncher } from "./claudeRemoteLauncher"
import { ApiClient } from "@/lib"
import { addBreadcrumb, setTag, trackMetric } from "@/telemetry"

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

export interface EnhancedMode {
    permissionMode: PermissionMode;
    model?: string;
    fallbackModel?: string;
    customSystemPrompt?: string;
    appendSystemPrompt?: string;
    allowedTools?: string[];
    disallowedTools?: string[];
}

interface LoopOptions {
    path: string
    model?: string
    permissionMode?: PermissionMode
    startingMode?: 'local' | 'remote'
    onModeChange: (mode: 'local' | 'remote') => void
    mcpServers: Record<string, any>
    session: ApiSessionClient
    api: ApiClient,
    claudeEnvVars?: Record<string, string>
    claudeArgs?: string[]
    messageQueue: MessageQueue2<EnhancedMode>
    allowedTools?: string[]
    onSessionReady?: (session: Session) => void
}

export async function loop(opts: LoopOptions) {
    // Track session duration for performance monitoring (HAP-534)
    const sessionStart = Date.now()
    let modeChanges = 0

    // Get log path for debug display
    const logPath = logger.logFilePath;
    let session: Session | null = null;

    try {
        session = new Session({
            api: opts.api,
            client: opts.session,
            path: opts.path,
            sessionId: null,
            claudeEnvVars: opts.claudeEnvVars,
            claudeArgs: opts.claudeArgs,
            mcpServers: opts.mcpServers,
            logPath: logPath,
            messageQueue: opts.messageQueue,
            allowedTools: opts.allowedTools,
            onModeChange: opts.onModeChange
        });

        // Notify that session is ready
        if (opts.onSessionReady) {
            opts.onSessionReady(session);
        }

        // Track session creation for debugging context (HAP-522)
        addBreadcrumb({ category: 'session', message: 'Session created', level: 'info' })

        let mode: 'local' | 'remote' = opts.startingMode ?? 'local';
        setTag('session.mode', mode)
        while (true) {
            logger.debug(`[loop] Iteration with mode: ${mode}`);

            // Run local mode if applicable
            if (mode === 'local') {
                let reason = await claudeLocalLauncher(session);
                if (reason === 'exit') { // Normal exit - Exit loop
                    return;
                }

                // Non "exit" reason means we need to switch to remote mode
                mode = 'remote';
                modeChanges++

                // Track mode switch for debugging context (HAP-522)
                addBreadcrumb({ category: 'session', message: 'Mode switch: local → remote', level: 'info' })
                setTag('session.mode', mode)

                // Wait for cleanup to complete before notifying mode change
                await new Promise(resolve => setTimeout(resolve, 50));

                if (opts.onModeChange) {
                    opts.onModeChange(mode);
                }
                continue;
            }

            // Start remote mode
            if (mode === 'remote') {
                let reason = await claudeRemoteLauncher(session);
                if (reason === 'exit') { // Normal exit - Exit loop
                    return;
                }

                // Non "exit" reason means we need to switch to local mode
                mode = 'local';
                modeChanges++

                // Track mode switch for debugging context (HAP-522)
                addBreadcrumb({ category: 'session', message: 'Mode switch: remote → local', level: 'info' })
                setTag('session.mode', mode)

                // Wait for cleanup to complete before notifying mode change
                await new Promise(resolve => setTimeout(resolve, 50));

                if (opts.onModeChange) {
                    opts.onModeChange(mode);
                }
                continue;
            }
        }
    } finally {
        // Track session duration before cleanup (HAP-534)
        trackMetric('session_duration', Date.now() - sessionStart, {
            startingMode: opts.startingMode ?? 'local',
            modeChanges,
            agent: 'claude'
        })
        addBreadcrumb({ category: 'session', message: 'Session ended', level: 'info' })

        session?.destroy();
    }
}
