import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AbsolutePath, UriString } from '../../foundation/model';

const vscode = vi.hoisted(() => ({
  executeCommand: vi.fn(),
  file: vi.fn((path: string) => ({ path, toString: () => `file://${path}` })),
  showOpenDialog: vi.fn(),
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
    showQuickPick: vi.fn(),
    showWarningMessage: vi.fn(),
  },
}));

import { createPromptAdapter } from './prompt';

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
