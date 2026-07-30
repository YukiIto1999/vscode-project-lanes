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
      '--no-config',
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
  it('設定を無効化し -- 区切りの後にルートを並べる', () => {
    expect(buildFileListArgs(roots)).toEqual([
      '--no-config',
      '--files',
      '--',
      '/repo/web',
      '/repo/api',
    ]);
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

  it('match イベントから行・UTF-16桁・preview・laneId を抽出する', () => {
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
      preview: '  const foo = 1',
    });
  });

  it('UTF-8 byte offset を 1 始まり UTF-16 桁へ変換する', () => {
    const unicodeMatch = JSON.stringify({
      type: 'match',
      data: {
        path: { text: '/repo/web/src/a.ts' },
        lines: { text: '😀漢 foo\n' },
        line_number: 2,
        submatches: [{ start: Buffer.byteLength('😀漢 ', 'utf8') }],
      },
    });

    const { results } = parseContentMatches(`${unicodeMatch}\n`, roots, 100);

    expect(results[0]).toMatchObject({ column: 5, preview: '😀漢 foo' });
  });

  it('preview は水平空白を保ち、match 周辺の 1000 UTF-16 code unit 以下に収める', () => {
    const text = `\t${'a'.repeat(1499)}foo${'b'.repeat(1499)}  \t\r\n`;
    const boundedMatch = JSON.stringify({
      type: 'match',
      data: {
        path: { text: '/repo/web/src/a.ts' },
        lines: { text },
        line_number: 2,
        submatches: [{ start: Buffer.byteLength(text.slice(0, 1500), 'utf8') }],
      },
    });

    const { results } = parseContentMatches(`${boundedMatch}\n`, roots, 100);
    const result = results[0];

    expect(result?.kind).toBe('content');
    if (result?.kind !== 'content') return;
    expect(result.preview).toContain('foo');
    expect(result.preview).toHaveLength(1000);
  });

  it('短い preview は CRLF だけを除き水平空白を保つ', () => {
    const whitespaceMatch = JSON.stringify({
      type: 'match',
      data: {
        path: { text: '/repo/web/src/a.ts' },
        lines: { text: '\t  foo  \t\r\n' },
        line_number: 2,
        submatches: [{ start: 3 }],
      },
    });

    const { results } = parseContentMatches(`${whitespaceMatch}\n`, roots, 100);

    expect(results[0]).toMatchObject({ preview: '\t  foo  \t' });
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

  it('limit 件の後が summary だけなら truncated を立てない', () => {
    const summary = JSON.stringify({ type: 'summary', data: {} });
    const { results, truncated } = parseContentMatches(
      `${matchLine}\n${matchLine}\n${summary}\n`,
      roots,
      2,
    );

    expect(results).toHaveLength(2);
    expect(truncated).toBe(false);
  });

  it('壊れた JSON 行を backend error として拒否する', () => {
    expect(() => parseContentMatches(`not json\n${matchLine}\n`, roots, 100)).toThrow(Error);
  });

  it.each([
    {
      label: 'path の bytes payload',
      event: {
        type: 'match',
        data: {
          path: { bytes: 'L3JlcG8vd2ViL3NyYy9hLnRz' },
          lines: { text: 'foo\n' },
          line_number: 1,
          submatches: [{ start: 0 }],
        },
      },
    },
    {
      label: 'lines の bytes payload',
      event: {
        type: 'match',
        data: {
          path: { text: '/repo/web/src/a.ts' },
          lines: { bytes: 'Zm9vCg==' },
          line_number: 1,
          submatches: [{ start: 0 }],
        },
      },
    },
  ])('$label を backend error として拒否する', ({ event }) => {
    expect(() => parseContentMatches(`${JSON.stringify(event)}\n`, roots, 100)).toThrow(Error);
  });

  it('必須フィールドを欠く match を backend error として拒否する', () => {
    expect(() =>
      parseContentMatches(
        `${JSON.stringify({
          type: 'match',
          data: {
            path: { text: '/repo/web/src/a.ts' },
            lines: { text: 'foo\n' },
            line_number: 1,
          },
        })}\n`,
        roots,
        100,
      ),
    ).toThrow(Error);
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
