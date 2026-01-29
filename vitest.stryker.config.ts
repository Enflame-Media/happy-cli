/**
 * Vitest configuration for Stryker mutation testing
 *
 * This configuration differs from the main vitest.config.ts:
 * - No globalSetup (build step) - Stryker sandbox doesn't support full builds
 * - Uses __dirname for path resolution (sandbox compatibility)
 * - Excludes integration tests (requires daemon/server)
 */
/**
 * Vitest configuration for Stryker mutation testing
 *
 * This configuration differs from the main vitest.config.ts:
 * - No globalSetup (build step) - Stryker sandbox doesn't support full builds
 * - Uses cwd-relative path resolution (compatible with Stryker sandbox)
 * - Excludes integration tests (requires daemon/server)
 */
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

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
            // Use cwd-relative resolution for Stryker sandbox compatibility
            '@': resolve('./src'),
        },
    },
})
