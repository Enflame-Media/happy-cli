#!/usr/bin/env node

import { execFileSync, spawnSync } from 'child_process';

/**
 * Generate release notes using Claude Code by analyzing git commits
 * Usage: node .release-it.notes.js <to-version>
 *
 * Security: Uses execFileSync for git commands and spawnSync with stdin
 * for Claude prompt, preventing command injection.
 */

/**
 * @returns {string | null}
 */
function getLatestStableTag() {
  const tagsRaw = execFileSync('git', ['tag', '--list', 'v*', '--sort=-v:refname'], {
    encoding: "utf8",
  });

  const tags = tagsRaw
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  // Only accept stable semver tags like v1.2.3 (no hyphen prerelease suffix).
  const stableTag = tags.find((t) => /^v\d+\.\d+\.\d+$/.test(t));
  return stableTag ?? null;
}

const [, , toVersion] = process.argv;

if (!toVersion) {
  console.error("Usage: node .release-it.notes.js <to-version>");
  process.exit(1);
}

async function generateReleaseNotes() {
  try {
    const fromTag = getLatestStableTag();

    // Get git log for the commits using execFileSync (secure, no shell injection)
    let gitLog;
    const logFormat = '%h - %s (%an, %ar)';

    try {
      if (!fromTag) {
        // Get all commits
        gitLog = execFileSync('git', [
          'log',
          '--all',
          `--pretty=format:${logFormat}`,
          '--no-merges'
        ], { encoding: 'utf8' });
      } else {
        // Get commits since tag
        gitLog = execFileSync('git', [
          'log',
          `${fromTag}..HEAD`,
          `--pretty=format:${logFormat}`,
          '--no-merges'
        ], { encoding: 'utf8' });
      }
    } catch (error) {
      // Fallback to recent commits if tag doesn't exist
      console.error(
        `Tag ${fromTag ?? "(none)"} not found, using recent commits instead`
      );
      gitLog = execFileSync('git', [
        'log',
        '-10',
        `--pretty=format:${logFormat}`,
        '--no-merges'
      ], { encoding: 'utf8' });
    }

    if (!gitLog.trim()) {
      console.error("No commits found for release notes generation");
      process.exit(1);
    }

    // Create a prompt for Claude to analyze commits and generate release notes
    const prompt = `Please analyze these git commits and generate professional release notes for version ${toVersion} of the Happy CLI tool (a Claude Code session sharing CLI).

The release should cover commits since the latest stable tag (vX.Y.Z): ${
      fromTag ?? "(none)"
    }.

Git commits:
${gitLog}

If the previous version was a beta version - like x.y.z-a
You should look back in the commit history until the previous non-beta version tag. These are really the changes that will go into this non-beta release.

Please format the output as markdown with:
- A brief summary of the release
- Organized sections for:
  - New Features
  - Bug Fixes
  - Refactoring
  - Other Changes
- Use bullet points for each change
- Keep descriptions concise but informative
- Focus on user-facing changes
- New line after each section

Do not include any preamble or explanations, just return the markdown release notes.`;

    // Call Claude Code to generate release notes
    // Use spawnSync with stdin to avoid command injection from prompt content
    console.error('Generating release notes with Claude Code...');

    const result = spawnSync('claude', [
      '--add-dir', '.',
      '--print',
      '-'  // Read prompt from stdin
    ], {
      input: prompt,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit'],
      maxBuffer: 1024 * 1024 * 10 // 10MB buffer
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      console.error('Claude Code exited with non-zero status:', result.status);
      process.exit(1);
    }

    // Output release notes to stdout for release-it to use
    console.log(result.stdout.trim());

  } catch (error) {
    console.error('Error generating release notes:', error.message);
    process.exit(1);
  }
}

generateReleaseNotes();
