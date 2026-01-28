/**
 * Vitest configuration for Stryker mutation testing
 *
 * This configuration differs from the main vitest.config.ts:
 * - No globalSetup (build step) - Stryker sandbox doesn't support full builds
 * - Uses __dirname for path resolution (sandbox compatibility)
 * - Excludes integration tests (requires daemon/server)
 */
import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
    test: {
        globals: false,
        environment: 'node',
        include: ['src/**/*.test.ts'],
        // Exclude integration tests that require daemon/server
        exclude: [
            'src/**/*.integration.test.ts',
            'src/daemon/**/*.test.ts',
        ],
        // No globalSetup - Stryker sandbox can't run full builds
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
})
