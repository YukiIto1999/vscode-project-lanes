import { describe, expect, it } from 'vitest';
import type { UriString } from './model';
import { uriToAbsolutePath } from './path';

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
