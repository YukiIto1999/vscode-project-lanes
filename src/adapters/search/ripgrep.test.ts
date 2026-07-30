import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AbsolutePath, LaneId } from '../../foundation/model';
import type { LaneQuery, LaneRoot } from '../../search/model';

const node = vi.hoisted(() => ({
  resolve: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: node.spawn,
}));

vi.mock('node:module', () => ({
  createRequire: () => ({ resolve: node.resolve }),
}));

import { createRipgrepSearchAdapter } from './ripgrep';

interface TestChild extends EventEmitter {
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly kill: ReturnType<typeof vi.fn>;
}

const root = (laneId: string, rootPath: string): LaneRoot => ({
  laneId: laneId as LaneId,
  rootPath: rootPath as AbsolutePath,
});

const roots: readonly LaneRoot[] = [root('web', '/repo/web')];

const createChild = (): TestChild => {
  const child = new EventEmitter() as TestChild;
  Object.defineProperties(child, {
    stdout: { value: new PassThrough(), enumerable: true },
    stderr: { value: new PassThrough(), enumerable: true },
    kill: { value: vi.fn(() => true), enumerable: true },
  });
  return child;
};

const createHarness = (child = createChild()) => {
  node.spawn.mockReturnValue(child);
  const adapter = createRipgrepSearchAdapter();
  return { adapter, child };
};

const matchLine = (text = 'foo\n', start = 0, path = '/repo/web/a.ts'): string =>
  JSON.stringify({
    type: 'match',
    data: {
      path: { text: path },
      lines: { text },
      line_number: 1,
      submatches: [{ start }],
    },
  });

const close = (child: TestChild, code: number): void => {
  child.emit('close', code, null);
};

describe('createRipgrepSearchAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    node.resolve.mockReturnValue('/extension/bin/rg');
  });

  it('shell=false と設定無効化済み引数で ripgrep を起動する', async () => {
    const { adapter, child } = createHarness();
    const pending = adapter.searchContent('foo' as LaneQuery, roots);

    child.stdout.end();
    close(child, 1);
    await pending;

    expect(node.spawn).toHaveBeenCalledWith(
      '/extension/bin/rg',
      ['--no-config', '--json', '--fixed-strings', '--smart-case', '--', 'foo', '/repo/web'],
      expect.objectContaining({ shell: false }),
    );
  });

  it('JSON 行と multibyte UTF-8 が chunk 境界を跨いでも一件として復号する', async () => {
    const { adapter, child } = createHarness();
    const pending = adapter.searchContent('foo' as LaneQuery, roots);
    const line = `${matchLine('😀漢 foo\n', Buffer.byteLength('😀漢 ', 'utf8'))}\n`;
    const bytes = Buffer.from(line, 'utf8');
    const multibyteStart = bytes.indexOf(Buffer.from('漢', 'utf8'));

    child.stdout.write(bytes.subarray(0, multibyteStart + 1));
    child.stdout.write(bytes.subarray(multibyteStart + 1, multibyteStart + 2));
    child.stdout.end(bytes.subarray(multibyteStart + 2));
    close(child, 0);

    await expect(pending).resolves.toMatchObject({
      kind: 'results',
      truncated: false,
      results: [
        expect.objectContaining({
          kind: 'content',
          column: 5,
          preview: '😀漢 foo',
        }),
      ],
    });
  });

  it('chunk 分割された単一出力行が1Mi code unitを超えた時点で停止する', async () => {
    const { adapter, child } = createHarness();
    const pending = adapter.searchContent('foo' as LaneQuery, roots);

    child.stdout.write('x'.repeat(512 * 1024));
    child.stdout.write('x'.repeat(512 * 1024));
    const killCountAtLimit = child.kill.mock.calls.length;
    child.stdout.write('x');
    const killCountBeforeClose = child.kill.mock.calls.length;
    child.stdout.end();
    close(child, 0);

    await expect(pending).rejects.toThrow(/ripgrep output line exceeded/);
    expect(killCountAtLimit).toBe(0);
    expect(killCountBeforeClose).toBe(1);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('2000件と summary の正常終了は truncated にしない', async () => {
    const { adapter, child } = createHarness();
    const pending = adapter.searchContent('foo' as LaneQuery, roots);
    const matches = Array.from({ length: 2000 }, () => matchLine()).join('\n');

    child.stdout.end(`${matches}\n${JSON.stringify({ type: 'summary', data: {} })}\n`);
    close(child, 0);

    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: 'results', truncated: false });
    if (outcome.kind === 'results') expect(outcome.results).toHaveLength(2000);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('2001件目の有効な match でだけ truncated にして child を一度停止する', async () => {
    const { adapter, child } = createHarness();
    const pending = adapter.searchContent('foo' as LaneQuery, roots);
    const matches = Array.from({ length: 2001 }, () => matchLine()).join('\n');

    child.stdout.write(`${matches}\n`);

    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: 'results', truncated: true });
    if (outcome.kind === 'results') expect(outcome.results).toHaveLength(2000);
    expect(child.kill).toHaveBeenCalledOnce();

    close(child, 2);
    adapter.disposable.dispose();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('limit 停止の kill が同期的に close を通知しても truncated を維持する', async () => {
    const child = createChild();
    child.kill.mockImplementation(() => {
      close(child, 2);
      return true;
    });
    const { adapter } = createHarness(child);
    const pending = adapter.searchContent('foo' as LaneQuery, roots);
    const matches = Array.from({ length: 2001 }, () => matchLine()).join('\n');

    child.stdout.write(`${matches}\n`);

    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: 'results', truncated: true });
    if (outcome.kind === 'results') expect(outcome.results).toHaveLength(2000);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('file 出力を chunk ごとに復号し、件数を制限せず全件返す', async () => {
    const japaneseRoots = [root('docs', '/repo/日本')];
    const { adapter, child } = createHarness();
    const pending = adapter.listFiles(japaneseRoots);
    const paths = Array.from({ length: 2001 }, (_, index) => `/repo/日本/${index}.ts`);
    const bytes = Buffer.from(`${paths.join('\n')}\n`, 'utf8');
    const multibyteStart = bytes.indexOf(Buffer.from('日', 'utf8'));

    child.stdout.write(bytes.subarray(0, multibyteStart + 1));
    child.stdout.end(bytes.subarray(multibyteStart + 1));
    close(child, 0);

    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: 'results', truncated: false });
    if (outcome.kind === 'results') expect(outcome.results).toHaveLength(2001);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('exit 1 を一致なしの正常結果として扱う', async () => {
    const { adapter, child } = createHarness();
    const pending = adapter.searchContent('foo' as LaneQuery, roots);

    child.stdout.end();
    close(child, 1);

    await expect(pending).resolves.toEqual({ kind: 'results', results: [], truncated: false });
  });

  it('resolver がバイナリを解決できないときだけ unavailable を返す', async () => {
    node.resolve.mockImplementation(() => {
      throw new Error('not installed');
    });
    const adapter = createRipgrepSearchAdapter();

    await expect(adapter.listFiles(roots)).resolves.toEqual({ kind: 'unavailable' });
    expect(node.spawn).not.toHaveBeenCalled();
  });

  it('spawn の ENOENT を unavailable として扱う', async () => {
    node.spawn.mockImplementation(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    const adapter = createRipgrepSearchAdapter();

    await expect(adapter.listFiles(roots)).resolves.toEqual({ kind: 'unavailable' });
  });

  it('spawn の ENOENT 以外を同じ原因を持つ Error として拒否する', async () => {
    const cause = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    node.spawn.mockImplementation(() => {
      throw cause;
    });
    const adapter = createRipgrepSearchAdapter();

    const error = await adapter.listFiles(roots).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).cause).toBe(cause);
  });

  it('child の ENOENT を unavailable として扱う', async () => {
    const { adapter, child } = createHarness();
    const pending = adapter.listFiles(roots);

    child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));

    await expect(pending).resolves.toEqual({ kind: 'unavailable' });
  });

  it('exit 2 は末尾64KiB以内の stderr を含む Error で拒否する', async () => {
    const { adapter, child } = createHarness();
    const pending = adapter.listFiles(roots);

    child.stderr.end(`EARLY_MARKER${'x'.repeat(70 * 1024)}TAIL`);
    child.stdout.end();
    close(child, 2);

    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('TAIL');
    expect((error as Error).message).not.toContain('EARLY_MARKER');
    expect(Buffer.byteLength((error as Error).message, 'utf8')).toBeLessThan(66 * 1024);
  });

  it('stdout stream error は stderr tail を含む Error で拒否し child を停止する', async () => {
    const { adapter, child } = createHarness();
    const pending = adapter.searchContent('foo' as LaneQuery, roots);

    child.stderr.write('diagnostic tail');
    child.stdout.emit('error', new Error('stdout failed'));

    await expect(pending).rejects.toThrow(/stdout failed[\s\S]*diagnostic tail/);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('壊れた relevant JSON と bytes payload を Error として拒否する', async () => {
    const malformed = createHarness();
    const malformedPending = malformed.adapter.searchContent('foo' as LaneQuery, roots);
    malformed.child.stdout.write('not-json\n');
    await expect(malformedPending).rejects.toBeInstanceOf(Error);
    expect(malformed.child.kill).toHaveBeenCalledOnce();

    const bytes = createHarness();
    const bytesPending = bytes.adapter.searchContent('foo' as LaneQuery, roots);
    bytes.child.stdout.write(
      `${JSON.stringify({
        type: 'match',
        data: {
          path: { bytes: 'L3JlcG8vd2ViL2EudHM=' },
          lines: { text: 'foo\n' },
          line_number: 1,
          submatches: [{ start: 0 }],
        },
      })}\n`,
    );
    await expect(bytesPending).rejects.toBeInstanceOf(Error);
    expect(bytes.child.kill).toHaveBeenCalledOnce();
  });

  it('dispose は pending 呼出しを cancelled で一度だけ解決し、kill も一度に限る', async () => {
    const { adapter, child } = createHarness();
    const pending = adapter.listFiles(roots);

    adapter.disposable.dispose();
    adapter.disposable.dispose();

    await expect(pending).resolves.toEqual({ kind: 'cancelled' });
    expect(child.kill).toHaveBeenCalledOnce();

    child.emit('error', new Error('late error'));
    close(child, 2);
    adapter.disposable.dispose();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('dispose の kill が同期的に close を通知しても cancelled を維持する', async () => {
    const child = createChild();
    child.kill.mockImplementation(() => {
      close(child, 0);
      return true;
    });
    const { adapter } = createHarness(child);
    const pending = adapter.listFiles(roots);

    adapter.disposable.dispose();

    await expect(pending).resolves.toEqual({ kind: 'cancelled' });
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('早期 settle 後は data listener を外し、close 後に全 listener を解放する', async () => {
    const { adapter, child } = createHarness();
    const pending = adapter.listFiles(roots);

    adapter.disposable.dispose();
    await pending;

    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.stderr.listenerCount('data')).toBe(0);
    expect(child.stdout.listenerCount('error')).toBe(1);
    expect(child.stderr.listenerCount('error')).toBe(1);
    expect(child.listenerCount('error')).toBe(1);

    child.stdout.emit('error', new Error('late stdout error'));
    close(child, 0);

    expect(child.stdout.listenerCount('error')).toBe(0);
    expect(child.stderr.listenerCount('error')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
  });

  it('dispose は実行中の全 child を停止し、全呼出しを cancelled で解決する', async () => {
    const first = createChild();
    const second = createChild();
    node.spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const adapter = createRipgrepSearchAdapter();
    const content = adapter.searchContent('foo' as LaneQuery, roots);
    const files = adapter.listFiles(roots);

    adapter.disposable.dispose();

    await expect(Promise.all([content, files])).resolves.toEqual([
      { kind: 'cancelled' },
      { kind: 'cancelled' },
    ]);
    expect(first.kill).toHaveBeenCalledOnce();
    expect(second.kill).toHaveBeenCalledOnce();
  });

  it('完了済み child は後の dispose で再停止しない', async () => {
    const { adapter, child } = createHarness();
    const pending = adapter.listFiles(roots);
    child.stdout.end('/repo/web/a.ts\n');
    close(child, 0);
    await pending;

    adapter.disposable.dispose();

    expect(child.kill).not.toHaveBeenCalled();
  });

  it('dispose 後の検索は child を起動せず cancelled を返す', async () => {
    const { adapter } = createHarness();
    adapter.disposable.dispose();

    await expect(adapter.listFiles(roots)).resolves.toEqual({ kind: 'cancelled' });
    expect(node.spawn).not.toHaveBeenCalled();
  });
});
