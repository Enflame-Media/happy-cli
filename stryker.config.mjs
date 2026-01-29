/**
 * Stryker Mutator Configuration
 *
 * Mutation testing configuration for happy-cli.
 * Validates test quality by introducing mutations and verifying tests catch them.
 *
 * @see https://stryker-mutator.io/docs/stryker-js/configuration
 * @type {import('@stryker-mutator/api/core').StrykerOptions}
 */
export default {
    // Package manager (matches monorepo)
    packageManager: 'yarn',

    // Files to mutate (production code only)
    // Exclusions match vitest.config.ts coverage.exclude
    mutate: [
        'src/**/*.ts',
        // Exclude test files
        '!src/**/*.spec.ts',
        '!src/**/*.test.ts',
        // Test utilities and setup - not production code
        '!src/test-setup.ts',
        // Server-dependent modules - tested via integration tests
        // These require a running happy-server to test properly
        '!src/daemon/**',
        '!src/codex/**',
        '!src/api/api.ts',
        '!src/api/apiSession.ts',
        '!src/api/apiMachine.ts',
        '!src/api/rpc/**',
        '!src/api/notifications.ts',
        '!src/api/socketUtils.ts',
        '!src/api/webAuth.ts',
        // UI modules that require Ink/React rendering context
        '!src/ui/ink/**',
        '!src/ui/auth.ts',
        // Entry points and CLI-specific modules
        '!src/index.ts',
        '!src/lib.ts',
        // RPC handler registration - requires session context (RpcHandlerManager)
        // Note: pathSecurity.ts in this directory is a standalone utility and IS mutation tested
        '!src/modules/common/registerCommonHandlers.ts',
        '!src/claude/sessionHandler.ts',
        '!src/claude/utils/sendToHappyServer.ts',
        // Mock data - not production code
        '!src/**/mockData/**',
        // Config files
        '!src/**/*.config.*',
    ],

    // Test runner configuration
    // Uses Stryker-specific vitest config (no globalSetup build step)
    // NOTE: Run `yarn build` before mutation testing
    testRunner: 'vitest',
    vitest: {
        configFile: 'vitest.stryker.config.ts',
    },

    // TypeScript validation - filters out type-invalid mutants
    checkers: ['typescript'],
    tsconfigFile: 'tsconfig.json',

    // Coverage analysis - maps mutants to specific tests
    coverageAnalysis: 'perTest',

    // Output reporters
    reporters: ['clear-text', 'progress', 'html', 'json'],
    htmlReporter: {
        fileName: 'reports/mutation/html/index.html',
    },
    jsonReporter: {
        fileName: 'reports/mutation/mutation.json',
    },

    // Performance settings
    // concurrency: omitted to use Stryker's default (cpus - 1)
    timeoutMS: 10000,
    timeoutFactor: 2.5,
    dryRunTimeoutMinutes: 10,

    // Incremental mode - speeds up subsequent runs
    incremental: true,
    incrementalFile: 'reports/mutation/stryker-incremental.json',

    // Thresholds (advisory only - no break threshold)
    thresholds: {
        high: 80, // Green: mutation score >= 80%
        low: 60, // Yellow: mutation score >= 60%
        break: null, // Don't fail build based on score
    },

    // Optimization
    // Note: ignoreStatic requires perTest coverage analysis
    maxTestRunnerReuse: 50,

    // Disable symlinkNodeModules to avoid Vite resolution issues with package.json exports
    symlinkNodeModules: false,

    // Cleanup
    tempDirName: '.stryker-tmp',
    cleanTempDir: true,

    // Files to ignore when copying to sandbox
    // Note: dist and tools are NOT ignored - required for tests
    // The CLI must be built before running mutation tests
    ignorePatterns: [
        'coverage',
        'reports',
        '*.log',
    ],
};
