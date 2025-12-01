import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

import dotenv from 'dotenv'

const testEnv = dotenv.config({
    path: '.env.integration-test'
}).parsed

export default defineConfig({
    test: {
        globals: false,
        environment: 'node',
        include: ['src/**/*.test.ts'],
        globalSetup: ['./src/test-setup.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            exclude: [
                'node_modules/**',
                'dist/**',
                '**/*.d.ts',
                '**/*.config.*',
                '**/mockData/**',
                '**/*.test.ts',
                // Server-dependent modules - tested via integration tests (daemon.integration.test.ts)
                // These require a running happy-server to test properly
                'src/daemon/**',
                'src/codex/**',
                'src/api/api.ts',
                'src/api/apiSession.ts',
                'src/api/apiMachine.ts',
                'src/api/rpc/**',
                'src/api/notifications.ts',
                'src/api/socketUtils.ts',
                'src/api/webAuth.ts',
                // UI modules that require Ink/React rendering context
                'src/ui/ink/**',
                'src/ui/auth.ts',
                // Entry points and CLI-specific modules
                'src/index.ts',
                'src/lib.ts',
                // Modules that depend on session handlers in interactive mode
                'src/modules/common/**',
                'src/claude/sessionHandler.ts',
                'src/claude/utils/sendToHappyServer.ts',
            ],
            thresholds: {
                lines: 60,
                functions: 60,
                branches: 50,
            },
        },
        env: {
            ...process.env,
            ...testEnv,
        }
    },
    resolve: {
        alias: {
            '@': resolve('./src'),
        },
    },
})