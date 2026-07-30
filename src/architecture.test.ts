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

  const registeredCommandIds = (() => {
    const src = readSource(bootstrapPath);
    const re = /registerCommand\(\s*['"]([^'"]+)['"]/g;
    const ids: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = re.exec(src)) !== null) ids.push(match[1]!);
    return ids;
  })();
  const registeredCommands = new Set(registeredCommandIds);

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

  it('公開 command は一度だけ登録される', () => {
    for (const command of declaredCommands) {
      expect(
        registeredCommandIds.filter((id) => id === command),
        command,
      ).toHaveLength(1);
    }
  });

  it('公開 command は初期化方針の適用前に登録される', () => {
    const src = readSource(bootstrapPath);
    const activationIndex = src.indexOf('coordinator.activate(');
    expect(activationIndex).toBeGreaterThan(-1);

    for (const command of declaredCommands) {
      const registrationIndex = src.search(
        new RegExp(
          `registerCommand\\(\\s*['"]${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`,
        ),
      );
      expect(registrationIndex, command).toBeGreaterThan(-1);
      expect(registrationIndex, command).toBeLessThan(activationIndex);
    }
  });

  it('coordinator の状態を projectLanes.workspaceStatus へ公開する', () => {
    const src = readSource(bootstrapPath);
    expect(src).toMatch(
      /executeCommand\(\s*['"]setContext['"]\s*,\s*['"]projectLanes\.workspaceStatus['"]/,
    );
  });
});

describe('managed runtime の共通 operation queue', () => {
  const bootstrapPath = nodePath.join(SRC_ROOT, 'app/bootstrap.ts');
  const bootstrap = readSource(bootstrapPath);
  const managedRuntime = bootstrap.slice(
    bootstrap.indexOf('const createManagedRuntime'),
    bootstrap.indexOf('export const bootstrapRuntime'),
  );

  it('runtime ごとに queue を一つ生成して lane service へ渡す', () => {
    expect(managedRuntime.match(/\bcreateOperationQueue\(\)/g) ?? []).toHaveLength(1);
    expect(managedRuntime).toMatch(/const operationQueue = createOperationQueue\(\);/);
    expect(managedRuntime).toMatch(/createLaneService\(\{[\s\S]*?\boperationQueue,\s*\}\);/);
  });

  it('workspace folder reconciliation を runtime 共通 queue へ載せる', () => {
    const listener = managedRuntime.slice(
      managedRuntime.indexOf('vscode.workspace.onDidChangeWorkspaceFolders'),
      managedRuntime.indexOf('vscode.window.registerTerminalProfileProvider'),
    );

    expect(listener).toMatch(/operationQueue\.enqueue\(async \(\) => \{/);
    expect(listener).toMatch(
      /operationQueue\.enqueue\(async \(\) => \{\s*await laneService\.finalizePendingOperations\(\);/,
    );
  });

  it('Reload は lane service 自身が管理する queue 境界を一度だけ通す', () => {
    const reload = managedRuntime.slice(
      managedRuntime.indexOf("'projectLanes.reloadLanes'"),
      managedRuntime.indexOf("'projectLanes.switchLane'"),
    );

    expect(reload).toMatch(/await laneService\.reconcileActiveLane\(\)/);
    expect(reload).not.toMatch(/operationQueue\.enqueue/);
    expect(reload).not.toMatch(/laneService\.finalizePendingOperations/);
    expect(reload).not.toMatch(/collectLaneCandidates/);
    expect(reload).not.toMatch(/catalogStore\.load/);
    expect(reload).not.toMatch(/registry\.replace/);
  });

  it('active lane 再整合の完了を待って runtime を公開する', () => {
    expect(managedRuntime).toMatch(/const createManagedRuntime = async/);
    expect(managedRuntime).toMatch(/await laneService\.reconcileActiveLane\(\);/);
    expect(managedRuntime).not.toMatch(/laneService\.initialize\(\)/);
  });

  it('post-commit cache failure を通知しても startup と Reload の描画を継続する', () => {
    const startup = managedRuntime.slice(
      managedRuntime.indexOf('const laneService = createLaneService'),
      managedRuntime.indexOf('const laneSearchService'),
    );
    const reload = managedRuntime.slice(
      managedRuntime.indexOf("'projectLanes.reloadLanes'"),
      managedRuntime.indexOf("'projectLanes.switchLane'"),
    );

    expect(startup).toMatch(/cache === 'pending'/);
    expect(startup).toMatch(/await reportAsyncFailure\(/);
    expect(reload).toMatch(/cache === 'pending'/);
    expect(reload).toMatch(/finally\s*\{[\s\S]*?render\(\);[\s\S]*?\}/);
  });

  it('公開 switch の transition failure を共通失敗境界へ渡す', () => {
    const switchCommand = managedRuntime.slice(
      managedRuntime.indexOf("'projectLanes.switchLane'"),
      managedRuntime.indexOf("'projectLanes.closeTerminals'"),
    );

    expect(switchCommand).toMatch(/runAsyncBoundary\(/);
    expect(switchCommand).toMatch(/if \(result\.kind === 'failed'\) throw result\.error;/);
    expect(switchCommand).toMatch(/reportAsyncFailure/);
  });

  it('横断検索の transition failure を共通失敗境界へ渡す', () => {
    const searchCommands = managedRuntime.slice(
      managedRuntime.indexOf("'projectLanes.findInLanes'"),
      managedRuntime.indexOf('return { commands'),
    );

    expect(searchCommands).toMatch(
      /'projectLanes\.findInLanes': \(\) =>\s*runAsyncBoundary\(\(\) => laneSearchService\.findInLanes\(\), reportAsyncFailure\)/,
    );
    expect(searchCommands).toMatch(
      /'projectLanes\.goToFileInLanes': \(\) =>\s*runAsyncBoundary\(\(\) => laneSearchService\.goToFileInLanes\(\), reportAsyncFailure\)/,
    );
  });
});

describe('未管理 workspace の公開初期化契約', () => {
  const repoRoot = nodePath.resolve(SRC_ROOT, '..');
  const packageJsonPath = nodePath.join(repoRoot, 'package.json');
  const pkg = JSON.parse(readSource(packageJsonPath)) as {
    contributes?: {
      commands?: ReadonlyArray<{ command?: string; title?: string }>;
      configuration?: {
        properties?: Record<
          string,
          {
            type?: string;
            enum?: readonly string[];
            default?: string;
            scope?: string;
          }
        >;
      };
      viewsWelcome?: ReadonlyArray<{ contents?: string; when?: string }>;
    };
  };

  it('initializationMode は全利用者へ manual 既定の window 設定として公開する', () => {
    expect(pkg.contributes?.configuration?.properties?.['projectLanes.initializationMode']).toEqual(
      expect.objectContaining({
        type: 'string',
        enum: ['manual', 'automatic'],
        default: 'manual',
        scope: 'window',
      }),
    );
  });

  it('Initialize Workspace command を公開する', () => {
    expect(pkg.contributes?.commands).toContainEqual(
      expect.objectContaining({
        command: 'projectLanes.initializeWorkspace',
        title: 'Initialize Workspace',
      }),
    );
  });

  it('unmanaged の welcome から Initialize Workspace command を実行できる', () => {
    const welcome = pkg.contributes?.viewsWelcome?.find((entry) =>
      entry.contents?.includes('(command:projectLanes.initializeWorkspace)'),
    );
    expect(welcome?.when).toContain('projectLanes.workspaceStatus');
    expect(welcome?.when).toContain('unmanaged');
  });
});

describe('LaneId への変換は toLaneId 経由に限定', () => {
  const productionFiles = collectTsFiles(SRC_ROOT).filter((f) => !f.endsWith('lane/model.ts'));

  it.each(productionFiles)('%s は `as LaneId` を直接書かない (toLaneId 経由)', (file) => {
    const content = readSource(file);
    expect(content).not.toMatch(/\bas\s+LaneId\b/);
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
