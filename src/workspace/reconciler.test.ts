import { describe, expect, it } from 'vitest';
import type { AbsolutePath, UriString } from '../foundation/model';
import type { WorkspaceFolder } from './model';
import { reconcileUserChange } from './reconciler';

const linkPath = '/ws/.lanes-root/active' as AbsolutePath;
const linkUri = `file://${linkPath}` as UriString;
const toUri = (p: string) => `file://${p}` as UriString;
const mkFolder = (name: string, path: string): WorkspaceFolder => ({ name, uri: toUri(path) });

const baseInput = {
  linkPath,
  activeLabel: 'web',
  linkUri,
};

describe('reconcileUserChange', () => {
  it('workspaceFolders が symlink folder 1 件なら noop', () => {
    const result = reconcileUserChange({
      ...baseInput,
      rawFolders: [{ name: 'web', uri: linkUri }],
      currentLanes: [mkFolder('web', '/p/web')],
    });
    expect(result).toEqual({ kind: 'noop' });
  });

  it('ユーザーが未知フォルダを追加 → absorb に additions', () => {
    const result = reconcileUserChange({
      ...baseInput,
      rawFolders: [{ name: 'web', uri: linkUri }, mkFolder('new', '/p/new')],
      currentLanes: [mkFolder('web', '/p/web')],
    });
    expect(result.kind).toBe('absorb');
    if (result.kind !== 'absorb') return;
    expect(result.additions.map((f) => f.name)).toEqual(['new']);
    expect(result.collapsedFolder).toEqual({ uri: linkUri, name: 'web' });
  });

  it('既知レーンを追加しても additions は空', () => {
    const result = reconcileUserChange({
      ...baseInput,
      rawFolders: [{ name: 'web', uri: linkUri }, mkFolder('api', '/p/api')],
      currentLanes: [mkFolder('web', '/p/web'), mkFolder('api', '/p/api')],
    });
    expect(result.kind).toBe('absorb');
    if (result.kind !== 'absorb') return;
    expect(result.additions).toEqual([]);
  });

  it('旧アンカーが紛れ込んでも除外される', () => {
    const result = reconcileUserChange({
      ...baseInput,
      rawFolders: [
        mkFolder('.lanes-root', '/ws/.lanes-root'),
        { name: 'web', uri: linkUri },
        mkFolder('new', '/p/new'),
      ],
      currentLanes: [],
    });
    expect(result.kind).toBe('absorb');
    if (result.kind !== 'absorb') return;
    expect(result.additions.map((f) => f.name)).toEqual(['new']);
  });
});
