import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => {
  class TabInputText {
    constructor(
      readonly uri: {
        readonly scheme: string;
        readonly toString: () => string;
      },
    ) {}
  }
  class Range {
    constructor(
      readonly startLine: number,
      readonly startCharacter: number,
      readonly endLine: number,
      readonly endCharacter: number,
    ) {}
  }
  return {
    close: vi.fn(),
    executeCommand: vi.fn(),
    openTextDocument: vi.fn(),
    showTextDocument: vi.fn(),
    groups: [] as Array<{ viewColumn: number; tabs: unknown[] }>,
    Range,
    TabInputText,
  };
});

vi.mock('vscode', () => ({
  Range: vscodeMock.Range,
  TabInputText: vscodeMock.TabInputText,
  Uri: {
    file: (path: string) => ({ scheme: 'file', fsPath: path }),
  },
  commands: {
    executeCommand: vscodeMock.executeCommand,
  },
  workspace: {
    openTextDocument: vscodeMock.openTextDocument,
  },
  window: {
    showTextDocument: vscodeMock.showTextDocument,
    tabGroups: {
      get all() {
        return vscodeMock.groups;
      },
      close: vscodeMock.close,
    },
  },
}));

import type { AbsolutePath } from '../../foundation/model';
import { createEditorAdapter } from './editors';

describe('createEditorAdapter', () => {
  beforeEach(() => {
    vscodeMock.close.mockReset();
    vscodeMock.executeCommand.mockReset();
    vscodeMock.openTextDocument.mockReset();
    vscodeMock.showTextDocument.mockReset();
    vscodeMock.groups.splice(
      0,
      vscodeMock.groups.length,
      { viewColumn: 1, tabs: [{ id: 'a' }, { id: 'b' }] },
      { viewColumn: 2, tabs: [{ id: 'c' }] },
    );
  });

  it('file text tab だけを snapshot に取り込む', () => {
    vscodeMock.groups.splice(0, vscodeMock.groups.length, {
      viewColumn: 2,
      tabs: [
        {
          input: new vscodeMock.TabInputText({
            scheme: 'file',
            toString: () => 'file:///repo/source.ts',
          }),
        },
        {
          input: new vscodeMock.TabInputText({
            scheme: 'vscode-userdata',
            toString: () => 'vscode-userdata:/User/settings.json',
          }),
        },
        { input: { kind: 'non-text' } },
      ],
    });

    expect(createEditorAdapter().captureSnapshot()).toEqual({
      tabs: [{ uri: 'file:///repo/source.ts', viewColumn: 2 }],
    });
  });

  it('全 tab を TabGroups API で閉じ、拒否結果を返す', async () => {
    vscodeMock.close.mockResolvedValue(false);

    await expect(createEditorAdapter().closeAll()).resolves.toBe(false);

    expect(vscodeMock.close).toHaveBeenCalledWith(
      [vscodeMock.groups[0]!.tabs[0], vscodeMock.groups[0]!.tabs[1], vscodeMock.groups[1]!.tabs[0]],
      true,
    );
  });

  it('tab が無ければ API を呼ばず成功する', async () => {
    vscodeMock.groups.splice(0, vscodeMock.groups.length);

    await expect(createEditorAdapter().closeAll()).resolves.toBe(true);
    expect(vscodeMock.close).not.toHaveBeenCalled();
  });

  it('openAt は document 参照を拡張側に残さない vscode.open で 0 始まりの位置へ開く', async () => {
    vscodeMock.executeCommand.mockResolvedValue(undefined);

    await createEditorAdapter().openAt('/workspace/active/src/a.ts' as AbsolutePath, {
      line: 3,
      column: 5,
    });

    expect(vscodeMock.executeCommand).toHaveBeenCalledWith(
      'vscode.open',
      { scheme: 'file', fsPath: '/workspace/active/src/a.ts' },
      { selection: new vscodeMock.Range(2, 4, 2, 4) },
    );
    expect(vscodeMock.openTextDocument).not.toHaveBeenCalled();
    expect(vscodeMock.showTextDocument).not.toHaveBeenCalled();
  });

  it('openAt は位置未指定のとき選択範囲を渡さずに開く', async () => {
    vscodeMock.executeCommand.mockResolvedValue(undefined);

    await createEditorAdapter().openAt('/workspace/active/a.ts' as AbsolutePath);

    expect(vscodeMock.executeCommand).toHaveBeenCalledWith(
      'vscode.open',
      { scheme: 'file', fsPath: '/workspace/active/a.ts' },
      {},
    );
  });
});
