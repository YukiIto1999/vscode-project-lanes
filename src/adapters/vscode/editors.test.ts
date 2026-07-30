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
  return {
    close: vi.fn(),
    groups: [] as Array<{ viewColumn: number; tabs: unknown[] }>,
    TabInputText,
  };
});

vi.mock('vscode', () => ({
  TabInputText: vscodeMock.TabInputText,
  window: {
    tabGroups: {
      get all() {
        return vscodeMock.groups;
      },
      close: vscodeMock.close,
    },
  },
}));

import { createEditorAdapter } from './editors';

describe('createEditorAdapter', () => {
  beforeEach(() => {
    vscodeMock.close.mockReset();
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
});
