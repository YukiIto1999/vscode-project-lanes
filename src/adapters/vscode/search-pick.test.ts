import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AbsolutePath, LaneId, UriString } from '../../foundation/model';
import type { Lane } from '../../lane/model';
import type { LaneSearchResult } from '../../search/model';

const vscode = vi.hoisted(() => ({
  showQuickPick: vi.fn(),
}));

vi.mock('vscode', () => ({
  QuickPickItemKind: { Separator: -1 },
  window: {
    showInformationMessage: vi.fn(),
    showInputBox: vi.fn(),
    showQuickPick: vscode.showQuickPick,
    showWarningMessage: vi.fn(),
  },
}));

import { createSearchUiAdapter } from './search-pick';

const lane = (id: string, label: string, rootPath: string): Lane => ({
  id: id as LaneId,
  label,
  rootPath: rootPath as AbsolutePath,
  rootUri: `file://${rootPath}` as UriString,
});

const fileResult = (laneId: string, relativePath: string): LaneSearchResult => ({
  kind: 'file',
  laneId: laneId as LaneId,
  path: `/repo/${relativePath}` as AbsolutePath,
  relativePath,
});

describe('createSearchUiAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscode.showQuickPick.mockResolvedValue(undefined);
  });

  it('検索 UI は opaque ID を表示せず、同名 label だけ rootPath で区別する', async () => {
    const lanes = [
      lane('opaque-web', 'same', '/projects/web'),
      lane('opaque-api', 'same', '/projects/api'),
      lane('opaque-docs', 'docs', '/projects/docs'),
    ];
    const ui = createSearchUiAdapter(() => lanes);

    await ui.pickFileResult([
      fileResult('opaque-web', 'src/web.ts'),
      fileResult('opaque-api', 'src/api.ts'),
      fileResult('opaque-docs', 'README.md'),
    ]);

    const items = vscode.showQuickPick.mock.calls[0]?.[0];
    expect(items).toEqual([
      expect.objectContaining({
        label: 'src/web.ts',
        description: 'same — /projects/web',
      }),
      expect.objectContaining({
        label: 'src/api.ts',
        description: 'same — /projects/api',
      }),
      expect.objectContaining({ label: 'README.md', description: 'docs' }),
    ]);
    const visibleFields = items.map(
      (item: { label: string; description?: string; detail?: string }) => ({
        label: item.label,
        description: item.description,
        detail: item.detail,
      }),
    );
    expect(JSON.stringify(visibleFields)).not.toContain('opaque-');
  });
});
