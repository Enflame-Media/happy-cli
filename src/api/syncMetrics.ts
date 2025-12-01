/**
 * Sync Metrics Collection for ApiSessionClient
 *
 * Provides telemetry for state synchronization operations including:
 * - Sync frequency (total syncs, reconnection-triggered syncs)
 * - Sync outcomes (version mismatches, success/failure rates)
 * - Sync latency (individual and average duration)
 * - Network partition detection (disconnection duration, frequency)
 *
 * Designed to be zero-cost when metrics are not consumed - uses simple counters
 * and only computes expensive derived values on-demand via getMetrics().
 *
 * @see HAP-166 for requirements
 * @see HAP-151 for future telemetry framework integration
 */

/**
 * Outcome of a sync operation
 */
export type SyncOutcome =
    | 'success'           // Sync completed successfully, states in sync
    | 'version-mismatch'  // Version mismatch detected and reconciled
    | 'error'             // Sync failed with error
    | 'aborted';          // Sync aborted (e.g., socket disconnected during sync)

/**
 * Record of a disconnection event for pattern analysis
 */
export interface DisconnectionRecord {
    /** Timestamp when disconnection occurred */
    disconnectedAt: number;
    /** Timestamp when reconnection occurred (null if still disconnected) */
    reconnectedAt: number | null;
    /** Duration in milliseconds (null if still disconnected) */
    durationMs: number | null;
}

/**
 * Error type tracking for sync failures
 */
export interface SyncErrorRecord {
    /** Error type/code */
    type: string;
    /** Number of occurrences */
    count: number;
    /** Timestamp of last occurrence */
    lastOccurrence: number;
}

/**
 * Comprehensive sync metrics snapshot
 *
 * This interface matches the proposed solution in HAP-166 with extensions
 * for network partition detection and error type tracking.
 */
export interface SyncMetrics {
    // === Sync Frequency Metrics ===
    /** Total number of state syncs triggered (per session lifetime) */
    totalSyncs: number;
    /** Count of syncs triggered by reconnection events */
    reconnectionSyncs: number;
    /** Time since last sync in milliseconds (null if never synced) */
    timeSinceLastSyncMs: number | null;

    // === Sync Outcome Metrics ===
    /** Number of agent state version mismatches detected */
    agentStateVersionMismatches: number;
    /** Number of metadata version mismatches detected */
    metadataVersionMismatches: number;
    /** Number of successful syncs */
    syncSuccesses: number;
    /** Number of failed syncs */
    syncFailures: number;
    /** Breakdown of sync failures by error type */
    syncErrorsByType: Record<string, number>;

    // === Sync Latency Metrics ===
    /** Duration of the last sync operation in milliseconds */
    lastSyncDurationMs: number | null;
    /** Average sync duration across all syncs in milliseconds */
    averageSyncDurationMs: number | null;
    /** Minimum sync duration observed */
    minSyncDurationMs: number | null;
    /** Maximum sync duration observed */
    maxSyncDurationMs: number | null;

    // === Network Partition Detection ===
    /** Total number of disconnection events */
    disconnectionCount: number;
    /** Duration of current disconnection in ms (null if connected) */
    currentDisconnectionDurationMs: number | null;
    /** Average disconnection duration in milliseconds */
    averageDisconnectionDurationMs: number | null;
    /** Longest disconnection duration observed */
    maxDisconnectionDurationMs: number | null;
    /** Whether currently disconnected */
    isDisconnected: boolean;
}

/**
 * Internal state for tracking sync timing
 */
interface SyncTimingState {
    startTime: number;
    isReconnectionSync: boolean;
}

/**
 * Extract a safe error type string from an unknown error
 * @param error - The error to extract type from
 * @param fallback - Fallback type if error is not recognizable
 * @returns Error type string suitable for metrics tracking
 */
export function extractErrorType(error: unknown, fallback: string): string {
    if (error instanceof Error) {
        return error.name;
    }
    if (typeof error === 'string') {
        return error;
    }
    return fallback;
}

/**
 * Collects and manages sync metrics for ApiSessionClient
 *
 * Zero-cost design principles:
 * - Simple counters for most metrics (O(1) increment)
 * - Derived metrics computed lazily in getMetrics()
 * - No external dependencies or heavy computation during recording
 * - Memory bounded by limiting disconnection history
 */
export class SyncMetricsCollector {
    // Sync frequency counters
    private totalSyncs = 0;
    private reconnectionSyncs = 0;
    private lastSyncTimestamp: number | null = null;

    // Sync outcome counters
    private agentStateVersionMismatches = 0;
    private metadataVersionMismatches = 0;
    private syncSuccesses = 0;
    private syncFailures = 0;
    private errorCounts = new Map<string, SyncErrorRecord>();

    // Sync latency tracking
    private syncDurations: number[] = [];
    private currentSyncState: SyncTimingState | null = null;

    // Network partition tracking
    private disconnectionRecords: DisconnectionRecord[] = [];
    private currentDisconnectTimestamp: number | null = null;
    private isCurrentlyDisconnected = false;

    // Configuration
    private readonly maxDisconnectionRecords: number;
    private readonly maxSyncDurations: number;

    /**
     * Create a new SyncMetricsCollector
     *
     * @param options Configuration options
     * @param options.maxDisconnectionRecords Maximum disconnection records to keep (default: 100)
     * @param options.maxSyncDurations Maximum sync duration samples to keep for averaging (default: 100)
     */
    constructor(options: {
        maxDisconnectionRecords?: number;
        maxSyncDurations?: number;
    } = {}) {
        this.maxDisconnectionRecords = options.maxDisconnectionRecords ?? 100;
        this.maxSyncDurations = options.maxSyncDurations ?? 100;
    }

    /**
     * Record the start of a sync operation
     * Call this at the beginning of requestStateSync()
     *
     * @param isReconnectionSync Whether this sync was triggered by a reconnection event
     */
    recordSyncStart(isReconnectionSync: boolean): void {
        this.currentSyncState = {
            startTime: performance.now(),
            isReconnectionSync
        };
    }

    /**
     * Record the completion of a sync operation
     * Call this at the end of requestStateSync()
     *
     * @param outcome The outcome of the sync operation
     * @param agentStateMismatch Whether an agent state version mismatch was detected
     * @param metadataMismatch Whether a metadata version mismatch was detected
     * @param errorType Optional error type if outcome is 'error'
     */
    recordSyncComplete(
        outcome: SyncOutcome,
        agentStateMismatch: boolean,
        metadataMismatch: boolean,
        errorType?: string
    ): void {
        this.totalSyncs++;
        this.lastSyncTimestamp = Date.now();

        // Track reconnection syncs
        if (this.currentSyncState?.isReconnectionSync) {
            this.reconnectionSyncs++;
        }

        // Track version mismatches
        if (agentStateMismatch) {
            this.agentStateVersionMismatches++;
        }
        if (metadataMismatch) {
            this.metadataVersionMismatches++;
        }

        // Track outcomes
        if (outcome === 'success' || outcome === 'version-mismatch') {
            this.syncSuccesses++;
        } else {
            this.syncFailures++;
            if (errorType) {
                this.recordError(errorType);
            }
        }

        // Track duration
        if (this.currentSyncState) {
            const duration = performance.now() - this.currentSyncState.startTime;
            this.syncDurations.push(duration);

            // Bound memory usage
            if (this.syncDurations.length > this.maxSyncDurations) {
                this.syncDurations.shift();
            }
        }

        this.currentSyncState = null;
    }

    /**
     * Record a disconnection event
     * Call this from the socket 'disconnect' handler
     */
    recordDisconnect(): void {
        if (!this.isCurrentlyDisconnected) {
            this.isCurrentlyDisconnected = true;
            this.currentDisconnectTimestamp = Date.now();
        }
    }

    /**
     * Record a reconnection event
     * Call this from the socket 'connect' handler when hasConnectedBefore is true
     */
    recordReconnect(): void {
        if (this.isCurrentlyDisconnected && this.currentDisconnectTimestamp !== null) {
            const reconnectedAt = Date.now();
            const durationMs = reconnectedAt - this.currentDisconnectTimestamp;

            this.disconnectionRecords.push({
                disconnectedAt: this.currentDisconnectTimestamp,
                reconnectedAt,
                durationMs
            });

            // Bound memory usage
            if (this.disconnectionRecords.length > this.maxDisconnectionRecords) {
                this.disconnectionRecords.shift();
            }
        }

        this.isCurrentlyDisconnected = false;
        this.currentDisconnectTimestamp = null;
    }

    /**
     * Get a snapshot of current metrics
     * Computes derived values like averages on-demand
     */
    getMetrics(): SyncMetrics {
        const now = Date.now();

        // Compute sync duration statistics
        let averageSyncDurationMs: number | null = null;
        let minSyncDurationMs: number | null = null;
        let maxSyncDurationMs: number | null = null;
        let lastSyncDurationMs: number | null = null;

        if (this.syncDurations.length > 0) {
            const lastDuration = this.syncDurations[this.syncDurations.length - 1];
            lastSyncDurationMs = lastDuration ?? null; // Explicit fallback (should never be undefined)

            const sum = this.syncDurations.reduce((a, b) => a + b, 0);
            averageSyncDurationMs = sum / this.syncDurations.length;

            // Safe spread: length check guarantees non-empty array
            // Performance: Array size bounded by maxSyncDurations (default 100)
            minSyncDurationMs = Math.min(...this.syncDurations);
            maxSyncDurationMs = Math.max(...this.syncDurations);
        }

        // Compute disconnection statistics
        let averageDisconnectionDurationMs: number | null = null;
        let maxDisconnectionDurationMs: number | null = null;

        const completedDisconnections = this.disconnectionRecords.filter(r => r.durationMs !== null);
        if (completedDisconnections.length > 0) {
            // Type refinement: filter guarantees durationMs is not null
            const durations = completedDisconnections.map(r => r.durationMs as number);
            averageDisconnectionDurationMs = durations.reduce((a, b) => a + b, 0) / durations.length;
            maxDisconnectionDurationMs = Math.max(...durations);
        }

        // Current disconnection duration
        let currentDisconnectionDurationMs: number | null = null;
        if (this.isCurrentlyDisconnected && this.currentDisconnectTimestamp !== null) {
            currentDisconnectionDurationMs = now - this.currentDisconnectTimestamp;
        }

        // Build error counts object
        const syncErrorsByType: Record<string, number> = {};
        for (const [type, record] of this.errorCounts) {
            syncErrorsByType[type] = record.count;
        }

        return {
            // Sync frequency
            totalSyncs: this.totalSyncs,
            reconnectionSyncs: this.reconnectionSyncs,
            timeSinceLastSyncMs: this.lastSyncTimestamp !== null ? now - this.lastSyncTimestamp : null,

            // Sync outcomes
            agentStateVersionMismatches: this.agentStateVersionMismatches,
            metadataVersionMismatches: this.metadataVersionMismatches,
            syncSuccesses: this.syncSuccesses,
            syncFailures: this.syncFailures,
            syncErrorsByType,

            // Sync latency
            lastSyncDurationMs,
            averageSyncDurationMs,
            minSyncDurationMs,
            maxSyncDurationMs,

            // Network partition detection
            disconnectionCount: this.disconnectionRecords.length + (this.isCurrentlyDisconnected ? 1 : 0),
            currentDisconnectionDurationMs,
            averageDisconnectionDurationMs,
            maxDisconnectionDurationMs,
            isDisconnected: this.isCurrentlyDisconnected
        };
    }

    /**
     * Reset all metrics to initial state
     * Useful for testing or when starting a new session
     */
    reset(): void {
        this.totalSyncs = 0;
        this.reconnectionSyncs = 0;
        this.lastSyncTimestamp = null;
        this.agentStateVersionMismatches = 0;
        this.metadataVersionMismatches = 0;
        this.syncSuccesses = 0;
        this.syncFailures = 0;
        this.errorCounts.clear();
        this.syncDurations = [];
        this.currentSyncState = null;
        this.disconnectionRecords = [];
        this.currentDisconnectTimestamp = null;
        this.isCurrentlyDisconnected = false;
    }

    /**
     * Record an error occurrence
     */
    private recordError(errorType: string): void {
        const existing = this.errorCounts.get(errorType);
        if (existing) {
            existing.count++;
            existing.lastOccurrence = Date.now();
        } else {
            this.errorCounts.set(errorType, {
                type: errorType,
                count: 1,
                lastOccurrence: Date.now()
            });
        }
    }
}
