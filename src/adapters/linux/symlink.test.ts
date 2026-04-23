import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import type { AbsolutePath } from '../../foundation/model';
import { createSymlinkOps } from './symlink';

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

  it('存在しない symlink の read は undefined', () => {
    expect(ops.read(abs('noexist'))).toBeUndefined();
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

  it('置換後に tmp リンクが残留しない', () => {
    const target = abs('target');
    fs.mkdirSync(target);
    const link = abs('link');
    ops.replace(link, target);
    const entries = fs.readdirSync(tmpDir);
    const tmpEntries = entries.filter((e) => e.includes('.tmp-'));
    expect(tmpEntries).toHaveLength(0);
  });

  it('symlink 先が存在しなくても read は参照先文字列を返す（broken link 許容）', () => {
    const target = abs('noexist-target');
    const link = abs('link');
    ops.replace(link, target);
    expect(ops.read(link)).toBe(target);
  });
});
