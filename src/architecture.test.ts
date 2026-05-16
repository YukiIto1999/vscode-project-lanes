import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = nodePath.resolve(__dirname);

/** ディレクトリ配下の .ts ファイルを再帰収集 */
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

describe('package.json の commands と bootstrap.ts の registerCommand の整合', () => {
  const repoRoot = nodePath.resolve(SRC_ROOT, '..');
  const bootstrapPath = nodePath.join(SRC_ROOT, 'app/bootstrap.ts');
  const packageJsonPath = nodePath.join(repoRoot, 'package.json');

  const declaredCommands = (() => {
    const pkg = JSON.parse(readSource(packageJsonPath)) as {
      contributes?: { commands?: ReadonlyArray<{ command?: string }> };
    };
    return new Set(
      (pkg.contributes?.commands ?? [])
        .map((c) => c.command)
        .filter((c): c is string => typeof c === 'string'),
    );
  })();

  const registeredCommands = (() => {
    const src = readSource(bootstrapPath);
    const re = /registerCommand\(\s*['"]([^'"]+)['"]/g;
    const ids: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = re.exec(src)) !== null) ids.push(match[1]!);
    return new Set(ids);
  })();

  it('package.json で宣言された command は bootstrap.ts で登録されている', () => {
    const missing = [...declaredCommands].filter((c) => !registeredCommands.has(c));
    expect(missing).toEqual([]);
  });

  it('bootstrap.ts で登録された projectLanes.* command は package.json で宣言されている', () => {
    const orphan = [...registeredCommands]
      .filter((c) => c.startsWith('projectLanes.'))
      .filter((c) => !declaredCommands.has(c));
    expect(orphan).toEqual([]);
  });
});

describe('TreeView contextValue と package.json の menus.when の整合', () => {
  const repoRoot = nodePath.resolve(SRC_ROOT, '..');
  const treeViewPath = nodePath.join(SRC_ROOT, 'adapters/vscode/tree-view.ts');
  const packageJsonPath = nodePath.join(repoRoot, 'package.json');

  it('tree-view.ts に contextValue = "projectLane" が出現する', () => {
    const treeView = readSource(treeViewPath);
    expect(treeView).toMatch(/contextValue\s*=\s*['"]projectLane['"]/);
  });

  it('package.json の view/item/context は viewItem == projectLane で when を立てる', () => {
    const pkg = JSON.parse(readSource(packageJsonPath)) as {
      contributes?: {
        menus?: { 'view/item/context'?: ReadonlyArray<{ when?: string }> };
      };
    };
    const items = pkg.contributes?.menus?.['view/item/context'] ?? [];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      if (typeof item.when === 'string' && item.when.includes('viewItem')) {
        expect(item.when).toContain('viewItem == projectLane');
      }
    }
  });
});
