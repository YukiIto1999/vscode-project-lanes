import { describe, expect, it } from 'vitest';
import type { AbsolutePath, UriString } from '../foundation/model';
import type { WorkspaceFileInfo, WorkspaceFolder } from './model';
import type { AnchorTargetPort } from './ports';
import { classifyWorkspaceFolder, deriveWorkspaceAnchor, resolveLaneCandidate } from './anchor';

const toUri = (path: string) => `file://${path}` as UriString;
const workspaceFile = (name: string): WorkspaceFileInfo => ({
  uri: toUri(`/home/user/${name}.code-workspace`),
  directoryPath: '/home/user' as AbsolutePath,
});
const folder = (path: string): WorkspaceFolder => ({
  name: 'any-label',
  uri: toUri(path),
});

describe('deriveWorkspaceAnchor', () => {
  it('公開 workspace key を変えず、versioned preimage の SHA-256 全桁を namespace に使う', () => {
    const anchor = deriveWorkspaceAnchor(workspaceFile('alpha'));

    expect(anchor).toEqual({
      workspaceKey: 'workspace:file:///home/user/alpha.code-workspace',
      hash: 'ad335bb29886abca6747ee3f51c4544eb54a2c84694a2cf29f80faa01a1d1f84',
      rootDirectoryPath: '/home/user/.lanes-root',
      namespaceDirectoryPath:
        '/home/user/.lanes-root/ad335bb29886abca6747ee3f51c4544eb54a2c84694a2cf29f80faa01a1d1f84',
      activeLinkPath:
        '/home/user/.lanes-root/ad335bb29886abca6747ee3f51c4544eb54a2c84694a2cf29f80faa01a1d1f84/active',
      legacyActiveLinkPath: '/home/user/.lanes-root/active',
    });
  });

  it('同じ directory の異なる workspace file に異なる namespace を割り当てる', () => {
    const alpha = deriveWorkspaceAnchor(workspaceFile('alpha'));
    const beta = deriveWorkspaceAnchor(workspaceFile('beta'));

    expect(alpha.workspaceKey).not.toBe(beta.workspaceKey);
    expect(alpha.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(beta.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(alpha.namespaceDirectoryPath).not.toBe(beta.namespaceDirectoryPath);
    expect(alpha.activeLinkPath).not.toBe(beta.activeLinkPath);
    expect(alpha.rootDirectoryPath).toBe(beta.rootDirectoryPath);
    expect(alpha.legacyActiveLinkPath).toBe(beta.legacyActiveLinkPath);
  });
});

describe('classifyWorkspaceFolder', () => {
  const anchor = deriveWorkspaceAnchor(workspaceFile('alpha'));

  it.each([
    ['active-link', anchor.activeLinkPath],
    ['legacy-active-link', anchor.legacyActiveLinkPath],
    ['legacy-anchor', anchor.rootDirectoryPath],
    ['lane', '/home/user/project'],
  ] as const)('%s は表示名に依存せず絶対 path で分類する', (expected, path) => {
    expect(classifyWorkspaceFolder(folder(path), anchor)).toBe(expected);
  });

  it('別 workspace の namespaced active link は現在 workspace の lane にしない', () => {
    const beta = deriveWorkspaceAnchor(workspaceFile('beta'));

    expect(classifyWorkspaceFolder(folder(beta.activeLinkPath), anchor)).toBe('foreign-anchor');
  });

  it.each([
    ['現 workspace の namespace directory', anchor.namespaceDirectoryPath],
    ['`.lanes-root` 配下の任意 path', '/home/user/.lanes-root/unexpected/nested'],
    [
      '別 directory の namespaced active link',
      `/srv/other/.lanes-root/${'0123456789abcdef'.repeat(4)}/active`,
    ],
  ])('%s は anchor 由来の system folder として分類する', (_case, path) => {
    expect(classifyWorkspaceFolder(folder(path), anchor)).toBe('foreign-anchor');
  });

  it.each([
    ['`.lanes-root` を接頭辞に持つ別 directory', '/home/user/.lanes-root-backup/project'],
    ['別 directory の `.lanes-root` 自体', '/home/user/projects/.lanes-root'],
    ['hash でない namespace の active', '/srv/other/.lanes-root/not-a-hash/active'],
  ])('%s は lane として分類する', (_case, path) => {
    expect(classifyWorkspaceFolder(folder(path), anchor)).toBe('lane');
  });
});

describe('resolveLaneCandidate', () => {
  const anchor = deriveWorkspaceAnchor(workspaceFile('alpha'));
  const beta = deriveWorkspaceAnchor(workspaceFile('beta'));
  const targetResolver = (targets: Readonly<Record<string, string>>) => {
    const resolved: string[] = [];
    const anchorTarget: AnchorTargetPort = {
      resolve: (path) => {
        resolved.push(path);
        const target = targets[path];
        return target === undefined ? undefined : toUri(target);
      },
    };
    return { anchorTarget, resolved };
  };

  it('lane はそのまま返し参照先を解決しない', () => {
    const lane = folder('/home/user/project');
    const h = targetResolver({});

    expect(resolveLaneCandidate(lane, anchor, h.anchorTarget)).toBe(lane);
    expect(h.resolved).toEqual([]);
  });

  it.each([
    ['active-link', anchor.activeLinkPath],
    ['legacy-active-link', anchor.legacyActiveLinkPath],
    ['legacy-anchor', anchor.rootDirectoryPath],
  ])('%s は参照先を解決せず候補から外す', (_role, path) => {
    const h = targetResolver({ [path]: '/home/user/project' });

    expect(resolveLaneCandidate(folder(path), anchor, h.anchorTarget)).toBeUndefined();
    expect(h.resolved).toEqual([]);
  });

  it('別 workspace の active link は表示名と付加情報を保って参照先 root へ置換する', () => {
    const entry = { id: 'lane-id', name: 'web', uri: toUri(beta.activeLinkPath) };
    const h = targetResolver({ [beta.activeLinkPath]: '/home/user/web' });

    expect(resolveLaneCandidate(entry, anchor, h.anchorTarget)).toEqual({
      id: 'lane-id',
      name: 'web',
      uri: toUri('/home/user/web'),
    });
    expect(h.resolved).toEqual([beta.activeLinkPath]);
  });

  it.each([
    ['参照先を解決できない', {}],
    ['参照先が別の anchor folder', { [beta.activeLinkPath]: anchor.namespaceDirectoryPath }],
  ])('%s anchor folder は候補から外す', (_case, targets) => {
    const h = targetResolver(targets);

    expect(
      resolveLaneCandidate(folder(beta.activeLinkPath), anchor, h.anchorTarget),
    ).toBeUndefined();
  });
});
