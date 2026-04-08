import type { AbsolutePath } from '../../foundation/model';
import type { AgentSource, ClaudeSessionPort } from '../ports';
import { createClaudeSource } from './claude-source';
import { createProcessNameSource } from './process-name-source';

/** 既定のエージェント検出ソース群の構築 */
export const createDefaultSources = (
  homePath: AbsolutePath,
  claudeSessionPort: ClaudeSessionPort,
): readonly AgentSource[] => [
  createClaudeSource(homePath, claudeSessionPort),
  createProcessNameSource({ kind: 'codex-cli', commNames: ['codex'] }),
  createProcessNameSource({ kind: 'copilot-cli', commNames: ['github-copilot'] }),
  createProcessNameSource({ kind: 'gemini-cli', commNames: ['gemini'] }),
];
