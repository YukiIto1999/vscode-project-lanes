import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 構造制約の機械検証。
 * 規約・依存方向・観測単位の用語は人の記憶ではなくテストで固定する。
 */

const SRC_ROOT = nodePath.resolve(__dirname);

/**
 * ディレクトリ配下の .ts ファイルを再帰収集 (テストファイル除外可)
 */
const collectTsFiles = (
  dir: string,
  options: { excludeTests: boolean } = { excludeTests: true },
): string[] => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const full = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectTsFiles(full, options));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (options.excludeTests && entry.name.endsWith('.test.ts')) continue;
    if (entry.name === 'architecture.test.ts') continue;
    result.push(full);
  }
  return result;
};

const readSource = (path: string): string => fs.readFileSync(path, 'utf8');

describe('lane-activity の依存方向', () => {
  const files = collectTsFiles(nodePath.join(SRC_ROOT, 'lane-activity'));

  it.each(files)('%s は vscode に依存しない', (file) => {
    const content = readSource(file);
    expect(content).not.toMatch(/from\s+['"]vscode['"]/);
    expect(content).not.toMatch(/require\(['"]vscode['"]\)/);
  });

  it.each(files)('%s は node-pty に依存しない', (file) => {
    const content = readSource(file);
    expect(content).not.toMatch(/from\s+['"]node-pty['"]/);
  });

  it.each(files)('%s は src/adapters/ に依存しない', (file) => {
    const content = readSource(file);
    expect(content).not.toMatch(/from\s+['"][^'"]*\/adapters\//);
  });
});

describe('lane-activity の用語', () => {
  const files = collectTsFiles(nodePath.join(SRC_ROOT, 'lane-activity'));

  it.each(files)('%s は TerminalId 型を import しない', (file) => {
    const content = readSource(file);
    expect(content).not.toMatch(/\bTerminalId\b/);
  });
});

describe('lane-activity の副作用境界', () => {
  const files = collectTsFiles(nodePath.join(SRC_ROOT, 'lane-activity'));

  it.each(files)('%s は Date.now / performance.now を直接呼ばない (clock 経由のみ)', (file) => {
    const content = readSource(file);
    expect(content).not.toMatch(/\bDate\.now\s*\(/);
    expect(content).not.toMatch(/\bperformance\.now\s*\(/);
  });
});

describe('VS Code Shell Integration の旧 API は再混入しない', () => {
  const files = collectTsFiles(SRC_ROOT, { excludeTests: false });

  it.each(files)('%s は onDidStartTerminalShellExecution を参照しない', (file) => {
    const content = readSource(file);
    expect(content).not.toMatch(/onDidStartTerminalShellExecution/);
  });

  it.each(files)('%s は onDidEndTerminalShellExecution を参照しない', (file) => {
    const content = readSource(file);
    expect(content).not.toMatch(/onDidEndTerminalShellExecution/);
  });
});
