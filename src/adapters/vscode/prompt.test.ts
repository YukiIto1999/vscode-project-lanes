import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AbsolutePath, LaneId, UriString } from '../../foundation/model';
import type { Lane } from '../../lane/model';

const vscode = vi.hoisted(() => ({
  executeCommand: vi.fn(),
  file: vi.fn((path: string) => ({ path, toString: () => `file://${path}` })),
  showOpenDialog: vi.fn(),
  showQuickPick: vi.fn(),
  showWarningMessage: vi.fn(),
}));

vi.mock('vscode', () => ({
  commands: { executeCommand: vscode.executeCommand },
  ExtensionMode: {
    Production: 1,
    Development: 2,
    Test: 3,
  },
  Uri: { file: vscode.file },
  window: {
    showInputBox: vi.fn(),
    showOpenDialog: vscode.showOpenDialog,
    showQuickPick: vscode.showQuickPick,
    showWarningMessage: vscode.showWarningMessage,
  },
}));

import { createPromptAdapter } from './prompt';

const lane = (id: string, label: string, rootPath: string): Lane => ({
  id: id as LaneId,
  label,
  rootPath: rootPath as AbsolutePath,
  rootUri: `file://${rootPath}` as UriString,
});

describe('createPromptAdapter pickLane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('同名 label の候補だけ rootPath で曖昧さを解消する', async () => {
    const lanes = [
      lane('opaque-web', 'same', '/projects/web'),
      lane('opaque-api', 'same', '/projects/api'),
      lane('opaque-docs', 'docs', '/projects/docs'),
    ];
    vscode.showQuickPick.mockResolvedValue(undefined);

    await createPromptAdapter().pickLane(lanes);

    expect(vscode.showQuickPick.mock.calls[0]?.[0]).toEqual([
      { label: 'same', description: '/projects/web', laneId: 'opaque-web' },
      { label: 'same', description: '/projects/api', laneId: 'opaque-api' },
      { label: 'docs', laneId: 'opaque-docs' },
    ]);
  });
});

describe('createPromptAdapter confirmRemoval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('同名レーンを識別できるよう確認詳細に rootPath を含める', async () => {
    vscode.showWarningMessage.mockResolvedValue('OK');

    await expect(
      createPromptAdapter().confirmRemoval(
        lane('4a79c5d0-2bb0-4d96-8870-98ce67fe9066', 'same', '/projects/web'),
      ),
    ).resolves.toBe(true);

    expect(vscode.showWarningMessage).toHaveBeenCalledWith(
      'Remove lane "same"?',
      {
        modal: true,
        detail: expect.stringContaining('/projects/web'),
      },
      'OK',
    );
  });
});

describe('createPromptAdapter pickReplacementFolder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('親ディレクトリを初期位置として単一フォルダを選ぶ', async () => {
    vscode.showOpenDialog.mockResolvedValue([
      { toString: () => 'file:///projects/api-renamed' as UriString },
    ]);
    const prompt = createPromptAdapter();

    await expect(prompt.pickReplacementFolder('/projects' as AbsolutePath)).resolves.toBe(
      'file:///projects/api-renamed',
    );

    expect(vscode.file).toHaveBeenCalledWith('/projects');
    expect(vscode.showOpenDialog).toHaveBeenCalledWith({
      title: 'Locate Lane Folder',
      openLabel: 'Locate Folder',
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: expect.objectContaining({ path: '/projects' }),
    });
  });

  it('選択を取り消したら undefined を返す', async () => {
    vscode.showOpenDialog.mockResolvedValue(undefined);

    await expect(
      createPromptAdapter().pickReplacementFolder('/projects' as AbsolutePath),
    ).resolves.toBeUndefined();
  });

  it('Development かつ E2E payload/run marker があれば private driver command を使う', async () => {
    vscode.executeCommand.mockResolvedValue({
      toString: () => 'file:///projects/api-renamed' as UriString,
    });
    const prompt = createPromptAdapter({
      extensionMode: 2,
      environment: {
        PROJECT_LANES_E2E_PAYLOAD: JSON.stringify({ phase: 'locate-and-reconcile' }),
        PROJECT_LANES_E2E_RUN: JSON.stringify({ runId: 'e2e-1' }),
      },
    });

    await expect(prompt.pickReplacementFolder('/projects' as AbsolutePath)).resolves.toBe(
      'file:///projects/api-renamed',
    );

    expect(vscode.executeCommand).toHaveBeenCalledWith('projectLanes.e2e.pickReplacementFolder', {
      title: 'Locate Lane Folder',
      openLabel: 'Locate Folder',
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: expect.objectContaining({ path: '/projects' }),
    });
    expect(vscode.showOpenDialog).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'Production',
      extensionMode: 1,
      environment: {
        PROJECT_LANES_E2E_PAYLOAD: '{}',
        PROJECT_LANES_E2E_RUN: '{}',
      },
    },
    {
      name: 'Test',
      extensionMode: 3,
      environment: {
        PROJECT_LANES_E2E_PAYLOAD: '{}',
        PROJECT_LANES_E2E_RUN: '{}',
      },
    },
    {
      name: 'payload marker なし',
      extensionMode: 2,
      environment: { PROJECT_LANES_E2E_RUN: '{}' },
    },
    {
      name: 'run marker なし',
      extensionMode: 2,
      environment: { PROJECT_LANES_E2E_PAYLOAD: '{}' },
    },
  ])('$name では native open dialog を使う', async ({ extensionMode, environment }) => {
    vscode.showOpenDialog.mockResolvedValue([
      { toString: () => 'file:///projects/api-renamed' as UriString },
    ]);
    const prompt = createPromptAdapter({ extensionMode, environment });

    await expect(prompt.pickReplacementFolder('/projects' as AbsolutePath)).resolves.toBe(
      'file:///projects/api-renamed',
    );

    expect(vscode.showOpenDialog).toHaveBeenCalledOnce();
    expect(vscode.executeCommand).not.toHaveBeenCalled();
  });
});
