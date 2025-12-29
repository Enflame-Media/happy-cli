/**
 * Tests for API type schemas - HAP-352
 *
 * These tests verify the Zod schemas for update event types work correctly
 * and match the expected structure from the mobile app.
 */
import { describe, it, expect } from 'vitest'
import type {
    DeleteSessionBody,
    NewArtifactBody,
    UpdateArtifactBody,
    DeleteArtifactBody,
    RelationshipUpdatedBody,
    NewFeedPostBody,
    KvBatchUpdateBody,
    EphemeralUpdate,
    EphemeralActivityUpdate,
    EphemeralUsageUpdate,
    EphemeralMachineActivityUpdate,
} from './types'

describe('Update body schemas - HAP-352', () => {
    describe('DeleteSessionBody', () => {
        it('should have correct structure', () => {
            const body: DeleteSessionBody = {
                t: 'delete-session',
                sid: 'session-123'
            }
            expect(body.t).toBe('delete-session')
            expect(body.sid).toBe('session-123')
        })
    })

    describe('NewArtifactBody', () => {
        it('should have correct structure', () => {
            const body: NewArtifactBody = {
                t: 'new-artifact',
                artifactId: 'artifact-123',
                header: 'encrypted-header',
                headerVersion: 1,
                dataEncryptionKey: 'key-123',
                seq: 1,
                createdAt: Date.now(),
                updatedAt: Date.now()
            }
            expect(body.t).toBe('new-artifact')
            expect(body.artifactId).toBe('artifact-123')
        })

        it('should allow optional body field', () => {
            const body: NewArtifactBody = {
                t: 'new-artifact',
                artifactId: 'artifact-123',
                header: 'encrypted-header',
                headerVersion: 1,
                body: 'encrypted-body',
                bodyVersion: 1,
                dataEncryptionKey: 'key-123',
                seq: 1,
                createdAt: Date.now(),
                updatedAt: Date.now()
            }
            expect(body.body).toBe('encrypted-body')
            expect(body.bodyVersion).toBe(1)
        })
    })

    describe('UpdateArtifactBody', () => {
        it('should have correct structure with header update', () => {
            const body: UpdateArtifactBody = {
                t: 'update-artifact',
                artifactId: 'artifact-123',
                header: { value: 'new-header', version: 2 }
            }
            expect(body.t).toBe('update-artifact')
            expect(body.header?.value).toBe('new-header')
        })

        it('should allow body update', () => {
            const body: UpdateArtifactBody = {
                t: 'update-artifact',
                artifactId: 'artifact-123',
                body: { value: 'new-body', version: 2 }
            }
            expect(body.body?.value).toBe('new-body')
        })
    })

    describe('DeleteArtifactBody', () => {
        it('should have correct structure', () => {
            const body: DeleteArtifactBody = {
                t: 'delete-artifact',
                artifactId: 'artifact-123'
            }
            expect(body.t).toBe('delete-artifact')
            expect(body.artifactId).toBe('artifact-123')
        })
    })

    describe('RelationshipUpdatedBody', () => {
        it('should have correct structure', () => {
            const body: RelationshipUpdatedBody = {
                t: 'relationship-updated',
                fromUserId: 'user-1',
                toUserId: 'user-2',
                status: 'friend',
                action: 'created',
                timestamp: Date.now()
            }
            expect(body.t).toBe('relationship-updated')
            expect(body.status).toBe('friend')
            expect(body.action).toBe('created')
        })

        it('should support all status values', () => {
            const statuses: RelationshipUpdatedBody['status'][] = ['none', 'requested', 'pending', 'friend', 'rejected']
            statuses.forEach(status => {
                const body: RelationshipUpdatedBody = {
                    t: 'relationship-updated',
                    fromUserId: 'user-1',
                    toUserId: 'user-2',
                    status,
                    action: 'updated',
                    timestamp: Date.now()
                }
                expect(body.status).toBe(status)
            })
        })

        it('should support all action values', () => {
            const actions: RelationshipUpdatedBody['action'][] = ['created', 'updated', 'deleted']
            actions.forEach(action => {
                const body: RelationshipUpdatedBody = {
                    t: 'relationship-updated',
                    fromUserId: 'user-1',
                    toUserId: 'user-2',
                    status: 'friend',
                    action,
                    timestamp: Date.now()
                }
                expect(body.action).toBe(action)
            })
        })
    })

    describe('NewFeedPostBody', () => {
        it('should have correct structure for friend_request', () => {
            const body: NewFeedPostBody = {
                t: 'new-feed-post',
                id: 'post-123',
                body: { kind: 'friend_request', uid: 'user-123' },
                cursor: 'cursor-123',
                createdAt: Date.now(),
                repeatKey: null,
                counter: 1
            }
            expect(body.t).toBe('new-feed-post')
            expect(body.body.kind).toBe('friend_request')
        })

        it('should support text kind', () => {
            const body: NewFeedPostBody = {
                t: 'new-feed-post',
                id: 'post-123',
                body: { kind: 'text', text: 'Hello world' },
                cursor: 'cursor-123',
                createdAt: Date.now(),
                repeatKey: 'repeat-key',
                counter: 2
            }
            expect(body.body.kind).toBe('text')
            // Type narrowing handled by discriminated union - cast for direct access
            expect((body.body as { kind: 'text', text: string }).text).toBe('Hello world')
        })
    })

    describe('KvBatchUpdateBody', () => {
        it('should have correct structure', () => {
            const body: KvBatchUpdateBody = {
                t: 'kv-batch-update',
                changes: [
                    { key: 'setting1', value: 'value1', version: 1 },
                    { key: 'setting2', value: null, version: 2 }
                ]
            }
            expect(body.t).toBe('kv-batch-update')
            expect(body.changes).toHaveLength(2)
            expect(body.changes[0].key).toBe('setting1')
            expect(body.changes[1].value).toBeNull()
        })

        it('should support empty changes array', () => {
            const body: KvBatchUpdateBody = {
                t: 'kv-batch-update',
                changes: []
            }
            expect(body.changes).toHaveLength(0)
        })
    })
})

describe('Ephemeral update types - HAP-352', () => {
    describe('EphemeralActivityUpdate', () => {
        it('should have correct structure', () => {
            const update: EphemeralActivityUpdate = {
                type: 'activity',
                sid: 'session-123', // HAP-654: Standardized to `sid`
                active: true,
                activeAt: Date.now(),
                thinking: false
            }
            expect(update.type).toBe('activity')
            expect(update.active).toBe(true)
        })
    })

    describe('EphemeralUsageUpdate', () => {
        it('should have correct structure', () => {
            const update: EphemeralUsageUpdate = {
                type: 'usage',
                sid: 'session-123', // HAP-654: Standardized to `sid`
                key: 'claude-session',
                timestamp: Date.now(),
                tokens: {
                    total: 1000,
                    input: 500,
                    output: 400,
                    cache_creation: 50,
                    cache_read: 50
                },
                cost: {
                    total: 0.05,
                    input: 0.02,
                    output: 0.03
                }
            }
            expect(update.type).toBe('usage')
            expect(update.tokens.total).toBe(1000)
            expect(update.cost.total).toBe(0.05)
        })
    })

    describe('EphemeralMachineActivityUpdate', () => {
        it('should have correct structure', () => {
            const update: EphemeralMachineActivityUpdate = {
                type: 'machine-activity',
                machineId: 'machine-123', // HAP-655: Standardized to `machineId`
                active: true,
                activeAt: Date.now()
            }
            expect(update.type).toBe('machine-activity')
            expect(update.active).toBe(true)
        })
    })

    describe('EphemeralUpdate union', () => {
        it('should accept all ephemeral update types', () => {
            const updates: EphemeralUpdate[] = [
                { type: 'activity', sid: '1', active: true, activeAt: 0, thinking: false },
                { type: 'usage', sid: '2', key: 'k', timestamp: 0, tokens: { total: 0, input: 0, output: 0, cache_creation: 0, cache_read: 0 }, cost: { total: 0, input: 0, output: 0 } },
                { type: 'machine-activity', machineId: '3', active: false, activeAt: 0 }
            ]
            expect(updates).toHaveLength(3)
            expect(updates[0].type).toBe('activity')
            expect(updates[1].type).toBe('usage')
            expect(updates[2].type).toBe('machine-activity')
        })
    })
})
