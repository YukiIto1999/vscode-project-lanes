import { describe, expect, it } from 'vitest';
import type { AbsolutePath, LaneId } from '../foundation/model';
import type { LaneQuery, LaneRoot } from './model';
import {
  attributeLane,
  buildContentArgs,
  buildFileListArgs,
  parseContentMatches,
  parseFileList,
} from './ripgrep';

const root = (laneId: string, rootPath: string): LaneRoot => ({
  laneId: laneId as LaneId,
  rootPath: rootPath as AbsolutePath,
});

const roots: readonly LaneRoot[] = [root('web', '/repo/web'), root('api', '/repo/api')];

describe('buildContentArgs', () => {
  it('固定フラグと -- 区切りの後にクエリとルートを並べる', () => {
    expect(buildContentArgs('foo' as LaneQuery, roots)).toEqual([
      '--json',
      '--fixed-strings',
      '--smart-case',
      '--',
      'foo',
      '/repo/web',
      '/repo/api',
    ]);
  });
});

describe('buildFileListArgs', () => {
  it('--files の後にルートを並べる', () => {
    expect(buildFileListArgs(roots)).toEqual(['--files', '/repo/web', '/repo/api']);
  });
});

describe('attributeLane', () => {
  it('ルート配下のパスを該当レーンへ帰属させる', () => {
    expect(attributeLane(roots, '/repo/web/src/a.ts')?.laneId).toBe('web');
  });
  it('入れ子ルートでは最長一致を選ぶ', () => {
    const nested = [root('outer', '/repo'), root('inner', '/repo/web')];
    expect(attributeLane(nested, '/repo/web/a.ts')?.laneId).toBe('inner');
  });
  it('どのルート配下でもないパスは undefined', () => {
    expect(attributeLane(roots, '/other/x.ts')).toBeUndefined();
  });
  it('ルート名の前方部分一致を誤帰属しない', () => {
    expect(attributeLane(roots, '/repo/web-extra/x.ts')).toBeUndefined();
  });
});

describe('parseContentMatches', () => {
  const matchLine = JSON.stringify({
    type: 'match',
    data: {
      path: { text: '/repo/web/src/a.ts' },
      lines: { text: '  const foo = 1\n' },
      line_number: 12,
      submatches: [{ start: 8 }],
    },
  });
  const beginLine = JSON.stringify({
    type: 'begin',
    data: { path: { text: '/repo/web/src/a.ts' } },
  });

  it('match イベントから行・桁・preview・laneId を抽出する', () => {
    const { results, truncated } = parseContentMatches(`${beginLine}\n${matchLine}\n`, roots, 100);
    expect(truncated).toBe(false);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'content',
      laneId: 'web',
      path: '/repo/web/src/a.ts',
      relativePath: 'src/a.ts',
      line: 12,
      column: 9,
      preview: 'const foo = 1',
    });
  });

  it('match 以外のイベントを無視する', () => {
    const { results } = parseContentMatches(`${beginLine}\n`, roots, 100);
    expect(results).toHaveLength(0);
  });

  it('limit を超えた分を切詰め truncated を立てる', () => {
    const stdout = `${matchLine}\n${matchLine}\n${matchLine}\n`;
    const { results, truncated } = parseContentMatches(stdout, roots, 2);
    expect(results).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  it('壊れた JSON 行を無視する', () => {
    const { results } = parseContentMatches(`not json\n${matchLine}\n`, roots, 100);
    expect(results).toHaveLength(1);
  });
});

describe('parseFileList', () => {
  it('各行を該当レーンの file 結果へ変換する', () => {
    const results = parseFileList('/repo/web/src/a.ts\n/repo/api/main.go\n', roots);
    expect(results).toEqual([
      { kind: 'file', laneId: 'web', path: '/repo/web/src/a.ts', relativePath: 'src/a.ts' },
      { kind: 'file', laneId: 'api', path: '/repo/api/main.go', relativePath: 'main.go' },
    ]);
  });
  it('空行とどのルート配下でもない行を無視する', () => {
    const results = parseFileList('\n/other/x.ts\n', roots);
    expect(results).toHaveLength(0);
  });
});
