import { describe, expect, it } from 'vitest';
import type { AbsolutePath, UriString } from '../foundation/model';
import type { WorkspaceFileInfo, WorkspaceFolder } from './model';
import { classifyWorkspaceFolder, deriveWorkspaceAnchor } from './anchor';

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

  it('別 workspace の namespaced active link は現在 workspace の lane として扱う', () => {
    const beta = deriveWorkspaceAnchor(workspaceFile('beta'));

    expect(classifyWorkspaceFolder(folder(beta.activeLinkPath), anchor)).toBe('lane');
  });
});
