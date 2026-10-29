/**
 * @fileoverview Pins the `.mcpb` agent-doc selector shared by
 * `scripts/clean-mcpb.ts` (strip) and `scripts/lint-packaging.ts` (check 8):
 * agent directories at an installed package's root are stripped, while a
 * `skills/` nested inside a package — the MCP SDK's runtime `dist/ext/skills/`
 * modules — ships, or the bundle fails at boot with `ERR_MODULE_NOT_FOUND`.
 * @module tests/scripts/bundle-agent-docs.test
 */

import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY, filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

interface LintPackagingModule {
  AGENT_DOC_ENTRY: RegExp;
  checkBundleEntries(entries: string[], bundleLabel: string): string[];
}

/**
 * Loaded by URL at run time: the script's repo-only fallback import of
 * `../src/mcp-server/skills.js` does not resolve in a server, and a literal
 * specifier would pull the script into the typecheck program.
 */
const lintPackagingUrl = new URL('../../scripts/lint-packaging.ts', import.meta.url).href;
const lintPackaging = (await import(lintPackagingUrl)) as LintPackagingModule;

const RUNTIME_ENTRIES = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/node.cjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.d.mts',
  'node_modules/some-dep/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/some-dep/node_modules/other/lib/skills/loader.js',
  'node_modules/@scope/skills/index.js',
  'node_modules/skills/index.js',
  'dist/index.js',
  'skills/oecd-guide/SKILL.md',
];

const AGENT_DOC_ENTRIES = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/dotenv/skills/dotenv/SKILL.md',
  'node_modules/thread-stream/.claude/settings.local.json',
  'node_modules/some-dep/.agents/skills/x/SKILL.md',
  'node_modules/some-dep/SKILL.md',
  'node_modules/some-dep/node_modules/@scope/pkg/skills/guide/SKILL.md',
  'node_modules/some-dep/node_modules/other/.claude/commands/x.md',
];

describe('bundle agent-doc selector', () => {
  it('keeps runtime skills/ modules nested inside a package', () => {
    expect(filterAgentDocEntries(RUNTIME_ENTRIES)).toEqual([]);
  });

  it('strips agent directories and SKILL.md at a package root, scoped and nested', () => {
    expect(filterAgentDocEntries(AGENT_DOC_ENTRIES)).toEqual(AGENT_DOC_ENTRIES);
  });

  it('lint-packaging selects exactly what clean-mcpb strips', () => {
    expect(lintPackaging.AGENT_DOC_ENTRY.source).toBe(AGENT_DOC_ENTRY.source);
    const all = [...RUNTIME_ENTRIES, ...AGENT_DOC_ENTRIES];
    expect(all.filter((entry) => lintPackaging.AGENT_DOC_ENTRY.test(entry))).toEqual(
      filterAgentDocEntries(all),
    );
  });

  it('check 8 passes a cleaned bundle that still holds the SDK runtime skills/ modules', () => {
    expect(lintPackaging.checkBundleEntries(RUNTIME_ENTRIES, 'dist/x.mcpb')).toEqual([]);
  });

  it('check 8 reports package-root agent docs left in a bundle', () => {
    const errors = lintPackaging.checkBundleEntries(AGENT_DOC_ENTRIES, 'dist/x.mcpb');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`${AGENT_DOC_ENTRIES.length} node_modules agent-doc entries`);
  });
});
