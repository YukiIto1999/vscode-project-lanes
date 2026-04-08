import { describe, expect, it } from 'vitest';
import type { AbsolutePath, UriString } from './model';
import { isDescendantOf, uriToAbsolutePath } from './path';

describe('uriToAbsolutePath', () => {
  it('file:// URI を絶対パスに変換', () => {
    const uri = 'file:///home/user/project' as UriString;
    expect(uriToAbsolutePath(uri)).toBe('/home/user/project');
  });

  it('エンコード済み URI をデコード', () => {
    const uri = 'file:///home/user/my%20project' as UriString;
    expect(uriToAbsolutePath(uri)).toBe('/home/user/my project');
  });
});

describe('isDescendantOf', () => {
  it('同一パスは true', () => {
    const path = '/home/user/project' as AbsolutePath;
    expect(isDescendantOf(path, path)).toBe(true);
  });

  it('子パスは true', () => {
    const child = '/home/user/project/src' as AbsolutePath;
    const parent = '/home/user/project' as AbsolutePath;
    expect(isDescendantOf(child, parent)).toBe(true);
  });

  it('プレフィクスが一致するだけでは false（パス区切り文字境界）', () => {
    const child = '/home/user/project-extra' as AbsolutePath;
    const parent = '/home/user/project' as AbsolutePath;
    expect(isDescendantOf(child, parent)).toBe(false);
  });

  it('無関係なパスは false', () => {
    const child = '/tmp/other' as AbsolutePath;
    const parent = '/home/user/project' as AbsolutePath;
    expect(isDescendantOf(child, parent)).toBe(false);
  });
});
