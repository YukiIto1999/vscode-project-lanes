import { describe, expect, it } from 'vitest';
import type { AbsolutePath, UriString } from '../foundation/model';
import type { FolderMutation, WorkspaceFileInfo, WorkspaceFolder } from './model';
import type {
  CatalogStorePort,
  DirectoryPort,
  WorkspaceFilePort,
  WorkspaceHostPort,
  WorkspaceLinkPort,
} from './ports';
import {
  bootstrapWorkspace,
  chooseActiveLane,
  collectLaneCandidates,
  isLegacyAnchor,
  isLinkFolder,
} from './scanner';

const toUri = (path: string) => `file://${path}` as UriString;
const mkFolder = (name: string, path: string): WorkspaceFolder => ({ name, uri: toUri(path) });

const fileInfo: WorkspaceFileInfo = {
  uri: toUri('/home/user/workspace.code-workspace'),
  directoryPath: '/home/user' as AbsolutePath,
};
const linkPath = '/home/user/.lanes-root/active' as AbsolutePath;
const linkFolder = mkFolder('web', linkPath);

describe('isLegacyAnchor', () => {
  it('`.lanes-root` は true', () => {
    expect(isLegacyAnchor(mkFolder('.lanes-root', '/home/user/.lanes-root'))).toBe(true);
  });
  it('他の名前は false', () => {
    expect(isLegacyAnchor(mkFolder('web', '/home/user/web'))).toBe(false);
  });
});

describe('isLinkFolder', () => {
  it('linkPath と一致するパスは true', () => {
    expect(isLinkFolder(linkFolder, linkPath)).toBe(true);
  });
  it('異なるパスは false', () => {
    expect(isLinkFolder(mkFolder('web', '/home/user/web'), linkPath)).toBe(false);
  });
});

describe('collectLaneCandidates', () => {
  const stored: readonly WorkspaceFolder[] = [
    mkFolder('web', '/home/user/web'),
    mkFolder('api', '/home/user/api'),
  ];

  it('stored 無しで rawFolders から新旧アンカー除外', () => {
    const raw = [
      mkFolder('.lanes-root', '/home/user/.lanes-root'),
      linkFolder,
      mkFolder('web', '/home/user/web'),
    ];
    expect(collectLaneCandidates(raw, undefined, linkPath)).toEqual([
      mkFolder('web', '/home/user/web'),
    ]);
  });

  it('stored あれば stored を正本とし、rawFolders の追加を吸収', () => {
    const raw = [
      linkFolder,
      mkFolder('web', '/home/user/web'),
      mkFolder('api', '/home/user/api'),
      mkFolder('new', '/home/user/new'),
    ];
    expect(collectLaneCandidates(raw, stored, linkPath).map((f) => f.name)).toEqual([
      'web',
      'api',
      'new',
    ]);
  });

  it('rawFolders が symlink folder のみなら stored そのまま', () => {
    const raw = [linkFolder];
    expect(collectLaneCandidates(raw, stored, linkPath)).toEqual(stored);
  });
});

describe('chooseActiveLane', () => {
  const lanes = [mkFolder('web', '/home/user/web'), mkFolder('api', '/home/user/api')];

  it('空 lanes なら undefined', () => {
    expect(chooseActiveLane([], undefined)).toBeUndefined();
  });
  it('currentLinkTarget が lanes 内なら一致レーンを返す', () => {
    expect(chooseActiveLane(lanes, '/home/user/api' as AbsolutePath)?.name).toBe('api');
  });
  it('currentLinkTarget が lanes 外なら先頭レーンを返す', () => {
    expect(chooseActiveLane(lanes, '/home/user/unknown' as AbsolutePath)?.name).toBe('web');
  });
  it('currentLinkTarget 無しなら先頭レーン', () => {
    expect(chooseActiveLane(lanes, undefined)?.name).toBe('web');
  });
});

describe('bootstrapWorkspace', () => {
  const makeHost = (folders: WorkspaceFolder[]) => {
    let current = folders;
    const mutations: FolderMutation[] = [];
    const port: WorkspaceHostPort = {
      readFolders: () => current,
      applyMutation: (m) => {
        mutations.push(m);
        const next = [...current];
        next.splice(m.start, m.deleteCount, ...m.folders);
        current = next;
      },
    };
    return { port, mutations, snapshot: () => current };
  };

  const makeLink = (initialTarget: AbsolutePath | undefined) => {
    let target = initialTarget;
    const swaps: AbsolutePath[] = [];
    const port: WorkspaceLinkPort = {
      linkPath,
      readTarget: () => target,
      swap: (t) => {
        swaps.push(t);
        target = t;
      },
    };
    return {
      port,
      swaps,
      get target() {
        return target;
      },
    };
  };

  const makeCatalogStore = (initial: readonly WorkspaceFolder[] | undefined) => {
    let stored: readonly WorkspaceFolder[] | undefined = initial;
    const port: CatalogStorePort = {
      load: () => stored,
      save: (folders) => {
        stored = folders;
      },
    };
    return { port, saved: () => stored };
  };

  const makeWorkspaceFile = (info: WorkspaceFileInfo | undefined): WorkspaceFilePort => ({
    read: () => info,
  });

  const okDir: DirectoryPort = { ensureDirectory: () => true };
  const failDir: DirectoryPort = { ensureDirectory: () => false };

  it('workspace ファイル無しなら disabled', () => {
    const host = makeHost([mkFolder('web', '/home/user/web')]);
    const link = makeLink(undefined);
    const store = makeCatalogStore(undefined);
    const result = bootstrapWorkspace(
      host.port,
      makeWorkspaceFile(undefined),
      store.port,
      okDir,
      link.port,
      toUri,
    );
    expect(result).toEqual({ kind: 'disabled', reason: 'no-workspace-file' });
  });

  it('アンカーディレクトリ作成失敗で missing-anchor', () => {
    const host = makeHost([mkFolder('web', '/home/user/web')]);
    const link = makeLink(undefined);
    const store = makeCatalogStore(undefined);
    const result = bootstrapWorkspace(
      host.port,
      makeWorkspaceFile(fileInfo),
      store.port,
      failDir,
      link.port,
      toUri,
    );
    expect(result).toEqual({ kind: 'disabled', reason: 'missing-anchor' });
  });

  it('初回起動（複数 folder、stored 無し）: symlink 作成 + folders 縮退', () => {
    const host = makeHost([mkFolder('web', '/home/user/web'), mkFolder('api', '/home/user/api')]);
    const link = makeLink(undefined);
    const store = makeCatalogStore(undefined);
    const result = bootstrapWorkspace(
      host.port,
      makeWorkspaceFile(fileInfo),
      store.port,
      okDir,
      link.port,
      toUri,
    );
    expect(result.kind).toBe('ready');
    expect(link.swaps).toEqual(['/home/user/web']);
    expect(host.snapshot()).toHaveLength(1);
    expect(host.snapshot()[0]!.uri).toBe(toUri(linkPath));
    expect(host.snapshot()[0]!.name).toBe('web');
    expect(store.saved()?.map((f) => f.name)).toEqual(['web', 'api']);
  });

  it('旧アンカー構造（`.lanes-root` 含み）からも同じ最終状態へ移行', () => {
    const host = makeHost([
      mkFolder('.lanes-root', '/home/user/.lanes-root'),
      mkFolder('web', '/home/user/web'),
      mkFolder('api', '/home/user/api'),
    ]);
    const link = makeLink(undefined);
    const store = makeCatalogStore(undefined);
    bootstrapWorkspace(host.port, makeWorkspaceFile(fileInfo), store.port, okDir, link.port, toUri);
    expect(host.snapshot()).toHaveLength(1);
    expect(host.snapshot()[0]!.uri).toBe(toUri(linkPath));
    expect(link.swaps).toEqual(['/home/user/web']);
  });

  it('既に新構造（symlink folder 1 件 + target 正常）なら folders 変更不要', () => {
    const host = makeHost([linkFolder]);
    const link = makeLink('/home/user/web' as AbsolutePath);
    const store = makeCatalogStore([mkFolder('web', '/home/user/web')]);
    bootstrapWorkspace(host.port, makeWorkspaceFile(fileInfo), store.port, okDir, link.port, toUri);
    expect(host.mutations).toHaveLength(0);
    expect(link.swaps).toHaveLength(0);
  });

  it('レーン 0 件なら空 catalog で ready（symlink も作らない）', () => {
    const host = makeHost([]);
    const link = makeLink(undefined);
    const store = makeCatalogStore(undefined);
    const result = bootstrapWorkspace(
      host.port,
      makeWorkspaceFile(fileInfo),
      store.port,
      okDir,
      link.port,
      toUri,
    );
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(result.context.canonicalLanes).toEqual([]);
    expect(link.swaps).toHaveLength(0);
    expect(store.saved()).toEqual([]);
  });

  it('stored target が欠落した状態では lanes[0] にフォールバック', () => {
    const host = makeHost([linkFolder]);
    const link = makeLink('/home/user/deleted' as AbsolutePath);
    const store = makeCatalogStore([
      mkFolder('web', '/home/user/web'),
      mkFolder('api', '/home/user/api'),
    ]);
    bootstrapWorkspace(host.port, makeWorkspaceFile(fileInfo), store.port, okDir, link.port, toUri);
    expect(link.swaps).toEqual(['/home/user/web']);
  });
});
