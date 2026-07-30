import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import type { AbsolutePath } from '../../foundation/model';
import type { WorkspaceAnchor } from '../../workspace/anchor';
import {
  createLegacyWorkspaceLinkReader,
  createSymlinkOps,
  createWorkspaceLinkAdapter,
} from './symlink';

describe('SymlinkOps', () => {
  const ops = createSymlinkOps();
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'proj-lanes-symlink-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const abs = (rel: string): AbsolutePath => nodePath.join(tmpDir, rel) as AbsolutePath;
  const makeAnchor = (): WorkspaceAnchor => {
    const hash = 'a'.repeat(64);
    const rootDirectoryPath = abs('.lanes-root');
    const namespaceDirectoryPath = abs(`.lanes-root/${hash}`);
    return {
      workspaceKey: 'workspace:file:///tmp/workspace.code-workspace',
      hash,
      rootDirectoryPath,
      namespaceDirectoryPath,
      activeLinkPath: abs(`.lanes-root/${hash}/active`),
      legacyActiveLinkPath: abs('.lanes-root/active'),
    };
  };

  const captureError = (action: () => void): unknown => {
    try {
      action();
    } catch (error) {
      return error;
    }
    throw new Error('例外が送出されなかった');
  };

  it('存在しない symlink の read は undefined', () => {
    expect(ops.read(abs('noexist'))).toBeUndefined();
  });

  it('symlink ではないパスの read は readlinkSync のエラーを伝播', () => {
    const regularFile = abs('file');
    fs.writeFileSync(regularFile, '');

    expect(captureError(() => ops.read(regularFile))).toMatchObject({
      code: 'EINVAL',
      syscall: 'readlink',
      path: regularFile,
    });
  });

  it('ディレクトリ向け symlink を作成し read で参照先を取得', () => {
    const target = abs('target');
    fs.mkdirSync(target);
    const link = abs('link');
    ops.replace(link, target);
    expect(ops.read(link)).toBe(target);
  });

  it('既存 symlink を別ターゲットに置き換える', () => {
    const t1 = abs('t1');
    const t2 = abs('t2');
    fs.mkdirSync(t1);
    fs.mkdirSync(t2);
    const link = abs('link');
    ops.replace(link, t1);
    expect(ops.read(link)).toBe(t1);
    ops.replace(link, t2);
    expect(ops.read(link)).toBe(t2);
  });

  it('replace は既存の通常ファイルを上書きせず拒否する', () => {
    const target = abs('target');
    const link = abs('link');
    fs.mkdirSync(target);
    fs.writeFileSync(link, 'preserve');

    expect(() => ops.replace(link, target)).toThrowError(
      `Workspace link path is not a symbolic link: ${link}`,
    );
    expect(fs.readFileSync(link, 'utf8')).toBe('preserve');
  });

  it('replace は既存のディレクトリを上書きせず拒否する', () => {
    const target = abs('target');
    const link = abs('link');
    fs.mkdirSync(target);
    fs.mkdirSync(link);

    expect(() => ops.replace(link, target)).toThrowError(
      `Workspace link path is not a symbolic link: ${link}`,
    );
    expect(fs.lstatSync(link).isDirectory()).toBe(true);
  });

  it('置換後に tmp リンクが残留しない', () => {
    const target = abs('target');
    fs.mkdirSync(target);
    const link = abs('link');
    ops.replace(link, target);
    const entries = fs.readdirSync(tmpDir);
    const tmpEntries = entries.filter((e) => e.includes('.tmp-'));
    expect(tmpEntries).toHaveLength(0);
  });

  it('symlink 先が存在しない broken link でも read は参照先文字列を返す', () => {
    const target = abs('noexist-target');
    const link = abs('link');
    ops.replace(link, target);
    expect(ops.read(link)).toBe(target);
  });

  it('相対 symlink の参照先を link の親から解決した絶対パスで返す', () => {
    const link = abs('link');
    fs.symlinkSync('../relative-target', link);

    expect(ops.read(link)).toBe(nodePath.resolve(nodePath.dirname(link), '../relative-target'));
  });

  it('clear は通常 symlink だけを削除', () => {
    const target = abs('target');
    fs.mkdirSync(target);
    const link = abs('link');
    ops.replace(link, target);

    ops.clear(link);

    expect(ops.read(link)).toBeUndefined();
    expect(fs.existsSync(target)).toBe(true);
  });

  it('clear は broken symlink を削除', () => {
    const target = abs('noexist-target');
    const link = abs('link');
    ops.replace(link, target);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);

    ops.clear(link);

    expect(() => fs.lstatSync(link)).toThrow();
  });

  it('clear は symlink が存在しなくても成功', () => {
    expect(() => ops.clear(abs('noexist'))).not.toThrow();
  });

  it('clear は通常ファイルを削除せず明示的に拒否', () => {
    const regularFile = abs('file');
    fs.writeFileSync(regularFile, 'preserve');

    expect(() => ops.clear(regularFile)).toThrowError(
      `Workspace link path is not a symbolic link: ${regularFile}`,
    );
    expect(fs.readFileSync(regularFile, 'utf8')).toBe('preserve');
  });

  it('clear はディレクトリを削除せず明示的に拒否', () => {
    const directory = abs('directory');
    fs.mkdirSync(directory);

    expect(() => ops.clear(directory)).toThrowError(
      `Workspace link path is not a symbolic link: ${directory}`,
    );
    expect(fs.statSync(directory).isDirectory()).toBe(true);
  });

  it('read は symlink 化された親 anchor を辿らない', () => {
    const externalDirectory = abs('external');
    const target = abs('target');
    fs.mkdirSync(externalDirectory);
    fs.mkdirSync(target);
    fs.symlinkSync(target, nodePath.join(externalDirectory, 'active'));
    const anchor = abs('.lanes-root');
    fs.symlinkSync(externalDirectory, anchor);

    expect(() => ops.read(nodePath.join(anchor, 'active') as AbsolutePath)).toThrowError(
      `Workspace link parent is not a real directory: ${anchor}`,
    );
  });

  it('replace は symlink 化された親 anchor の外部 link を置き換えない', () => {
    const externalDirectory = abs('external');
    const originalTarget = abs('original-target');
    const replacementTarget = abs('replacement-target');
    fs.mkdirSync(externalDirectory);
    fs.mkdirSync(originalTarget);
    fs.mkdirSync(replacementTarget);
    const externalLink = nodePath.join(externalDirectory, 'active');
    fs.symlinkSync(originalTarget, externalLink);
    const anchor = abs('.lanes-root');
    fs.symlinkSync(externalDirectory, anchor);

    expect(() =>
      ops.replace(nodePath.join(anchor, 'active') as AbsolutePath, replacementTarget),
    ).toThrowError(`Workspace link parent is not a real directory: ${anchor}`);
    expect(fs.readlinkSync(externalLink)).toBe(originalTarget);
  });

  it('clear は symlink 化された親 anchor の外部 link を削除しない', () => {
    const externalDirectory = abs('external');
    const target = abs('target');
    fs.mkdirSync(externalDirectory);
    fs.mkdirSync(target);
    const externalLink = nodePath.join(externalDirectory, 'active');
    fs.symlinkSync(target, externalLink);
    const anchor = abs('.lanes-root');
    fs.symlinkSync(externalDirectory, anchor);

    expect(() => ops.clear(nodePath.join(anchor, 'active') as AbsolutePath)).toThrowError(
      `Workspace link parent is not a real directory: ${anchor}`,
    );
    expect(fs.readlinkSync(externalLink)).toBe(target);
  });

  it('WorkspaceLinkPort は束縛した namespaced linkPath を read と clear に使う', () => {
    const target = abs('target');
    fs.mkdirSync(target);
    const anchor = makeAnchor();
    fs.mkdirSync(anchor.namespaceDirectoryPath, { recursive: true });
    const adapter = createWorkspaceLinkAdapter(anchor);
    adapter.swap(target);

    expect(adapter.readTarget()).toBe(target);
    adapter.clear();

    expect(adapter.readTarget()).toBeUndefined();
  });

  it('legacy reader は旧 active が通常ファイルなら移行入力なしとして保持する', () => {
    const anchor = makeAnchor();
    fs.mkdirSync(anchor.rootDirectoryPath);
    fs.writeFileSync(anchor.legacyActiveLinkPath, 'preserve');
    const reader = createLegacyWorkspaceLinkReader(anchor);

    expect(reader.readTarget()).toBeUndefined();
    expect(fs.readFileSync(anchor.legacyActiveLinkPath, 'utf8')).toBe('preserve');
  });

  it('legacy reader は旧 active がディレクトリなら移行入力なしとして保持する', () => {
    const anchor = makeAnchor();
    fs.mkdirSync(anchor.legacyActiveLinkPath, { recursive: true });
    const reader = createLegacyWorkspaceLinkReader(anchor);

    expect(reader.readTarget()).toBeUndefined();
    expect(fs.lstatSync(anchor.legacyActiveLinkPath).isDirectory()).toBe(true);
  });

  it('legacy reader は relative broken symlink を絶対パスの移行入力として読む', () => {
    const anchor = makeAnchor();
    fs.mkdirSync(anchor.rootDirectoryPath);
    fs.symlinkSync('../missing-legacy-target', anchor.legacyActiveLinkPath);
    const reader = createLegacyWorkspaceLinkReader(anchor);

    expect(reader.readTarget()).toBe(abs('missing-legacy-target'));
    expect(fs.existsSync(abs('missing-legacy-target'))).toBe(false);
    expect(fs.lstatSync(anchor.legacyActiveLinkPath).isSymbolicLink()).toBe(true);
  });

  it('WorkspaceLinkPort は namespaced active が通常ファイルなら read でも拒否する', () => {
    const anchor = makeAnchor();
    fs.mkdirSync(anchor.namespaceDirectoryPath, { recursive: true });
    fs.writeFileSync(anchor.activeLinkPath, 'preserve');
    const adapter = createWorkspaceLinkAdapter(anchor);

    expect(captureError(() => adapter.readTarget())).toMatchObject({
      code: 'EINVAL',
      syscall: 'readlink',
      path: anchor.activeLinkPath,
    });
    expect(fs.readFileSync(anchor.activeLinkPath, 'utf8')).toBe('preserve');
  });

  it('WorkspaceLinkPort は symlink 化された `.lanes-root` を辿らない', () => {
    const externalDirectory = abs('external');
    const target = abs('target');
    fs.mkdirSync(externalDirectory);
    fs.mkdirSync(target);
    const anchor = makeAnchor();
    fs.symlinkSync(externalDirectory, anchor.rootDirectoryPath);
    const adapter = createWorkspaceLinkAdapter(anchor);

    expect(() => adapter.swap(target)).toThrowError(
      `Workspace link parent is not a real directory: ${anchor.rootDirectoryPath}`,
    );
    expect(fs.readdirSync(externalDirectory)).toEqual([]);
  });

  it('WorkspaceLinkPort は symlink 化された hash directory を辿らない', () => {
    const externalDirectory = abs('external');
    const target = abs('target');
    fs.mkdirSync(externalDirectory);
    fs.mkdirSync(target);
    const anchor = makeAnchor();
    fs.mkdirSync(anchor.rootDirectoryPath);
    fs.symlinkSync(externalDirectory, anchor.namespaceDirectoryPath);
    const adapter = createWorkspaceLinkAdapter(anchor);

    expect(() => adapter.swap(target)).toThrowError(
      `Workspace link parent is not a real directory: ${anchor.namespaceDirectoryPath}`,
    );
    expect(fs.readdirSync(externalDirectory)).toEqual([]);
  });
});
