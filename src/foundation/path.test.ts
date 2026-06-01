import { describe, expect, it } from 'vitest';
import type { AbsolutePath, UriString } from './model';
import { baseName, parentDirectory, uriToAbsolutePath } from './path';

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

describe('parentDirectory', () => {
  it('レーンルートの親ディレクトリを返す', () => {
    expect(parentDirectory('/home/user/projects/web' as AbsolutePath)).toBe('/home/user/projects');
  });

  it('末尾スラッシュを除いた親を返す', () => {
    expect(parentDirectory('/home/user/projects/' as AbsolutePath)).toBe('/home/user');
  });
});

describe('baseName', () => {
  it('絶対パスの末尾要素名を返す', () => {
    expect(baseName('/home/user/projects/web' as AbsolutePath)).toBe('web');
  });
});
