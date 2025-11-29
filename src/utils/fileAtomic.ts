/**
 * Atomic file write utility
 * Ensures file writes are atomic using temp file + rename pattern
 */

import { writeFile, rename, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import { withRetry } from '@/utils/retry';

export async function atomicFileWrite(filePath: string, content: string): Promise<void> {
  const tmpFile = `${filePath}.${randomUUID()}.tmp`;

  try {
    // Write to temp file with retry on transient errors
    await withRetry(() => writeFile(tmpFile, content));

    // Atomic rename (on POSIX systems) with retry on transient errors
    await withRetry(() => rename(tmpFile, filePath));
  } catch (error) {
    // Clean up temp file on error
    try {
      await withRetry(() => unlink(tmpFile));
    } catch {}
    throw error;
  }
}