import { describe, expect, it } from 'vitest';
import type { AbsolutePath, UriString } from '../foundation/model';
import type { WorkspaceFileInfo, WorkspaceFolder } from './model';
import type {
  CatalogStorePort,
  DirectoryPort,
  WorkspaceFilePort,
  WorkspaceHostPort,
} from './ports';
import { bootstrapWorkspace, isAnchor, resolveCanonicalLanes } from './scanner';

const toUri = (path: string) => `file://${path}` as UriString;

const mkFolder = (name: string, path: string): WorkspaceFolder => ({
  name,
  uri: toUri(path),
});

const fileInfo: WorkspaceFileInfo = {
  uri: toUri('/home/user/workspace.code-workspace'),
  directoryPath: '/home/user' as AbsolutePath,
};

describe('isAnchor', () => {
  it('.lanes-root の名前で true', () => {
    expect(isAnchor(mkFolder('.lanes-root', '/home/user/.lanes-root'))).toBe(true);
  });

  it('他の名前で false', () => {
    expect(isAnchor(mkFolder('web', '/home/user/web'))).toBe(false);
  });
});

describe('resolveCanonicalLanes', () => {
  const stored: readonly WorkspaceFolder[] = [
    mkFolder('web', '/home/user/web'),
    mkFolder('api', '/home/user/api'),
  ];

  it('stored 未保存なら nonAnchor を返す', () => {
    const raw = [
      mkFolder('.lanes-root', '/home/user/.lanes-root'),
      mkFolder('web', '/home/user/web'),
    ];
    expect(resolveCanonicalLanes(raw, undefined)).toEqual([mkFolder('web', '/home/user/web')]);
  });

  it('unfocused（nonAnchor ≥ 2）なら nonAnchor で refresh', () => {
    const raw = [
      mkFolder('.lanes-root', '/home/user/.lanes-root'),
      mkFolder('web', '/home/user/web'),
      mkFolder('api', '/home/user/api'),
      mkFolder('docs', '/home/user/docs'),
    ];
    expect(resolveCanonicalLanes(raw, stored)).toHaveLength(3);
  });

  it('focused（nonAnchor 1 件 + stored あり）なら stored を返す', () => {
    const raw = [
      mkFolder('.lanes-root', '/home/user/.lanes-root'),
      mkFolder('web', '/home/user/web'),
    ];
    expect(resolveCanonicalLanes(raw, stored)).toEqual(stored);
  });

  it('アンカーしか無く stored あれば stored を保持', () => {
    const raw = [mkFolder('.lanes-root', '/home/user/.lanes-root')];
    expect(resolveCanonicalLanes(raw, stored)).toEqual(stored);
  });
});

describe('bootstrapWorkspace', () => {
  const makeHost = (folders: WorkspaceFolder[]): WorkspaceHostPort => {
    let current = folders;
    return {
      readFolders: () => current,
      applyMutation: (m) => {
        const next = [...current];
        next.splice(m.start, m.deleteCount, ...m.folders);
        current = next;
      },
    };
  };

  const makeWorkspaceFile = (info: WorkspaceFileInfo | undefined): WorkspaceFilePort => ({
    read: () => info,
  });

  const makeCatalogStore = (
    initial: readonly WorkspaceFolder[] | undefined,
  ): CatalogStorePort & { readonly saved: () => readonly WorkspaceFolder[] | undefined } => {
    let stored: readonly WorkspaceFolder[] | undefined = initial;
    return {
      load: () => stored,
      save: (folders) => {
        stored = folders;
      },
      saved: () => stored,
    };
  };

  const mockDirectory: DirectoryPort = { ensureDirectory: () => true };

  it('workspace ファイル無しなら disabled', () => {
    const host = makeHost([mkFolder('web', '/home/user/web')]);
    const result = bootstrapWorkspace(
      host,
      makeWorkspaceFile(undefined),
      makeCatalogStore(undefined),
      mockDirectory,
      toUri,
    );
    expect(result).toEqual({ kind: 'disabled', reason: 'no-workspace-file' });
  });

  it('レーンが 0 件でも ready（空 catalog の初期状態）', () => {
    const host = makeHost([mkFolder('.lanes-root', '/home/user/.lanes-root')]);
    const result = bootstrapWorkspace(
      host,
      makeWorkspaceFile(fileInfo),
      makeCatalogStore(undefined),
      mockDirectory,
      toUri,
    );
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(result.context.canonicalLanes).toEqual([]);
  });

  it('アンカー作成失敗で missing-anchor', () => {
    const host = makeHost([mkFolder('web', '/home/user/web')]);
    const failDir: DirectoryPort = { ensureDirectory: () => false };
    const result = bootstrapWorkspace(
      host,
      makeWorkspaceFile(fileInfo),
      makeCatalogStore(undefined),
      failDir,
      toUri,
    );
    expect(result).toEqual({ kind: 'disabled', reason: 'missing-anchor' });
  });

  it('初回起動: workspaceFolders 2件 → canonicalLanes 保存 + アンカー挿入', () => {
    const host = makeHost([mkFolder('web', '/home/user/web'), mkFolder('api', '/home/user/api')]);
    const store = makeCatalogStore(undefined);
    const result = bootstrapWorkspace(
      host,
      makeWorkspaceFile(fileInfo),
      store,
      mockDirectory,
      toUri,
    );
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(result.context.canonicalLanes.map((f) => f.name)).toEqual(['web', 'api']);
    expect(store.saved()).toHaveLength(2);
    expect(host.readFolders()[0]!.name).toBe('.lanes-root');
  });

  it('focused 再起動: stored catalog を復元しフォルダ縮退を無視', () => {
    const host = makeHost([
      mkFolder('.lanes-root', '/home/user/.lanes-root'),
      mkFolder('web', '/home/user/web'),
    ]);
    const stored = [
      mkFolder('web', '/home/user/web'),
      mkFolder('api', '/home/user/api'),
      mkFolder('docs', '/home/user/docs'),
    ];
    const store = makeCatalogStore(stored);
    const result = bootstrapWorkspace(
      host,
      makeWorkspaceFile(fileInfo),
      store,
      mockDirectory,
      toUri,
    );
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(result.context.canonicalLanes.map((f) => f.name)).toEqual(['web', 'api', 'docs']);
  });

  it('unfocused で workspaceFolders が増えていれば stored を refresh', () => {
    const host = makeHost([
      mkFolder('.lanes-root', '/home/user/.lanes-root'),
      mkFolder('web', '/home/user/web'),
      mkFolder('api', '/home/user/api'),
      mkFolder('new-project', '/home/user/new-project'),
    ]);
    const stored = [mkFolder('web', '/home/user/web'), mkFolder('api', '/home/user/api')];
    const store = makeCatalogStore(stored);
    bootstrapWorkspace(host, makeWorkspaceFile(fileInfo), store, mockDirectory, toUri);
    expect(store.saved()?.map((f) => f.name)).toEqual(['web', 'api', 'new-project']);
  });
});
