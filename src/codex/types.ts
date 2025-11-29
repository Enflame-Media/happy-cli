/**
 * Type definitions for Codex MCP integration
 */

/**
 * Supported Codex model identifiers.
 * Keep in sync with OpenAI Codex CLI documentation.
 * @see https://developers.openai.com/codex/models/
 * // Last updated: Nov 2025
 */
export const SUPPORTED_CODEX_MODELS = [
    // Current recommended models
    'gpt-5.1-codex-max',
    'gpt-5.1-codex-mini',
    'gpt-5.1',
    // Legacy models
    'gpt-5.1-codex',
    'gpt-5-codex',
    'gpt-5-codex-mini',
    'gpt-5',
    // Older Codex models (may still be used)
    'codex-1',
    'codex-mini-latest',
] as const;

export type CodexModel = (typeof SUPPORTED_CODEX_MODELS)[number];

/**
 * Validates a model name against supported Codex models.
 * @param model - The model name to validate
 * @returns The validated model name if valid
 * @throws Error with list of supported models if invalid
 */
export function validateCodexModel(model: string): CodexModel {
    if (!SUPPORTED_CODEX_MODELS.includes(model as CodexModel)) {
        throw new Error(
            `Unsupported Codex model: "${model}". ` +
            `Supported models: ${SUPPORTED_CODEX_MODELS.join(', ')}`
        );
    }
    return model as CodexModel;
}

export interface CodexSessionConfig {
    prompt: string;
    'approval-policy'?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
    'base-instructions'?: string;
    config?: Record<string, any>;
    cwd?: string;
    'include-plan-tool'?: boolean;
    model?: CodexModel;
    profile?: string;
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
}

export interface CodexToolResponse {
    content: Array<{
        type: 'text' | 'image' | 'resource';
        text?: string;
        data?: any;
        mimeType?: string;
    }>;
    isError?: boolean;
}
