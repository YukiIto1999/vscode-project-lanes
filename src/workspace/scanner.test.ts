import { describe, expect, it } from 'vitest';
import type { AbsolutePath, UriString } from '../foundation/model';
import type { WorkspaceFolder } from './model';
import type { DirectoryPort, WorkspaceHostPort } from './ports';
import { bootstrapWorkspace, detectAnchor } from './scanner';

describe('detectAnchor', () => {
  it('.lanes-root が先頭にあればアンカー検出', () => {
    const folders: WorkspaceFolder[] = [
      { uri: 'file:///home/user/.lanes-root' as UriString, name: '.lanes-root' },
      { uri: 'file:///home/user/web' as UriString, name: 'web' },
    ];
    const anchor = detectAnchor(folders);
    expect(anchor).toBeDefined();
    expect(anchor!.name).toBe('.lanes-root');
    expect(anchor!.parentPath).toBe('/home/user');
  });

  it('先頭が .lanes-root でなければ undefined', () => {
    const folders: WorkspaceFolder[] = [{ uri: 'file:///home/user/web' as UriString, name: 'web' }];
    expect(detectAnchor(folders)).toBeUndefined();
  });

  it('空配列なら undefined', () => {
    expect(detectAnchor([])).toBeUndefined();
  });
});

describe('bootstrapWorkspace', () => {
  const mockDirectory: DirectoryPort = {
    listDirectories: () => [
      { name: '.lanes-root', path: '/home/user/.lanes-root' as AbsolutePath },
      { name: 'web', path: '/home/user/web' as AbsolutePath },
      { name: 'api', path: '/home/user/api' as AbsolutePath },
      { name: '.hidden', path: '/home/user/.hidden' as AbsolutePath },
    ],
    ensureDirectory: () => true,
  };

  const toUri = (path: string) => `file://${path}` as UriString;

  const makeHost = (folders: WorkspaceFolder[]): WorkspaceHostPort => ({
    readFolders: () => folders,
    applyMutation: () => {},
  });

  it('.lanes-root が先頭にあれば ready', () => {
    const folders: WorkspaceFolder[] = [
      { uri: 'file:///home/user/.lanes-root' as UriString, name: '.lanes-root' },
    ];
    const result = bootstrapWorkspace(makeHost(folders), mockDirectory, toUri);
    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') {
      expect(result.context.catalog.lanes).toHaveLength(2);
      expect(result.context.catalog.lanes.map((l) => l.label)).toEqual(['web', 'api']);
    }
  });

  it('空ワークスペースで disabled', () => {
    const result = bootstrapWorkspace(makeHost([]), mockDirectory, toUri);
    expect(result).toEqual({ kind: 'disabled', reason: 'no-workspace' });
  });

  it('.lanes-root がなければ自動作成して ready', () => {
    const folders: WorkspaceFolder[] = [{ uri: 'file:///home/user/web' as UriString, name: 'web' }];
    const inserted: WorkspaceFolder[] = [
      { uri: 'file:///home/user/.lanes-root' as UriString, name: '.lanes-root' },
      ...folders,
    ];
    let current = folders;
    const host: WorkspaceHostPort = {
      readFolders: () => current,
      applyMutation: () => {
        current = inserted;
      },
    };
    const result = bootstrapWorkspace(host, mockDirectory, toUri);
    expect(result.kind).toBe('ready');
  });

  it('.lanes-root の作成に失敗したら disabled', () => {
    const folders: WorkspaceFolder[] = [{ uri: 'file:///home/user/web' as UriString, name: 'web' }];
    const failDir: DirectoryPort = { ...mockDirectory, ensureDirectory: () => false };
    const result = bootstrapWorkspace(makeHost(folders), failDir, toUri);
    expect(result).toEqual({ kind: 'disabled', reason: 'missing-anchor' });
  });
});
