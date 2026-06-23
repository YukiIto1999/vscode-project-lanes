import { describe, expect, it } from 'vitest';
import { parseLaneQuery } from './query';

describe('parseLaneQuery', () => {
  it('空文字のとき undefined を返す', () => {
    expect(parseLaneQuery('')).toBeUndefined();
  });
  it('空白のみのとき undefined を返す', () => {
    expect(parseLaneQuery('   ')).toBeUndefined();
  });
  it('未入力のとき undefined を返す', () => {
    expect(parseLaneQuery(undefined)).toBeUndefined();
  });
  it('前後の空白を除いたクエリを返す', () => {
    expect(parseLaneQuery('  foo  ')).toBe('foo');
  });
  it('非空クエリをそのまま返す', () => {
    expect(parseLaneQuery('createLaneService')).toBe('createLaneService');
  });
});
