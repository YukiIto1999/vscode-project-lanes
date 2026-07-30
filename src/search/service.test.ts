import { describe, expect, it, vi } from 'vitest';
import type { AbsolutePath, LaneId, UriString } from '../foundation/model';
import type { Lane, LaneCatalog, LaneFocusPlan, LaneRootAvailability } from '../lane/model';
import type { LaneRootAvailabilityPort } from '../workspace/ports';
import type { LaneSearchOutcome, LaneSearchResult } from './model';
import type { FileOpenPort, LaneSearchPort, SearchUiPort } from './ports';
import { createLaneSearchService } from './service';

const lane = (id: string): Lane => ({
  id: id as LaneId,
  label: id,
  rootUri: `file:///repo/${id}` as UriString,
  rootPath: `/repo/${id}` as AbsolutePath,
});

const catalog = (): LaneCatalog => {
  const lanes = [lane('web'), lane('api')];
  return { lanes, byId: new Map(lanes.map((l) => [l.id, l])) };
};

const catalogOf = (...ids: readonly string[]): LaneCatalog => {
  const lanes = ids.map(lane);
  return { lanes, byId: new Map(lanes.map((item) => [item.id, item])) };
};

const contentHit = (laneId: string): LaneSearchResult => ({
  kind: 'content',
  laneId: laneId as LaneId,
  path: `/repo/${laneId}/a.ts` as AbsolutePath,
  relativePath: 'a.ts',
  line: 3,
  column: 5,
  preview: 'hit',
});

const focusOk = (laneId: string): LaneFocusPlan => ({
  kind: 'focus',
  from: undefined,
  to: lane(laneId),
});
const focusBlocked: LaneFocusPlan = { kind: 'blocked', reason: 'dirty-editors' };

const harness = (
  over: Partial<{
    query: string | undefined;
    contentOutcome: LaneSearchOutcome;
    filesOutcome: LaneSearchOutcome;
    picked: LaneSearchResult | undefined;
    focusResult: LaneFocusPlan;
  }>,
) => {
  const openAt = vi.fn(async () => undefined);
  const warnUnavailable = vi.fn();
  const notifyEmpty = vi.fn();
  const pickContentResult = vi.fn(async () => over.picked);
  const pickFileResult = vi.fn(async () => over.picked);
  const searchContent = vi.fn(
    async (): Promise<LaneSearchOutcome> =>
      over.contentOutcome ?? { kind: 'results', results: [], truncated: false },
  );
  const listFiles = vi.fn(
    async (): Promise<LaneSearchOutcome> =>
      over.filesOutcome ?? { kind: 'results', results: [], truncated: false },
  );
  const search: LaneSearchPort = {
    searchContent,
    listFiles,
  };
  const ui: SearchUiPort = {
    promptQuery: async () => over.query,
    pickContentResult,
    pickFileResult,
    notifyEmpty,
    warnUnavailable,
  };
  const fileOpen: FileOpenPort = { openAt };
  const focus = vi.fn(async (): Promise<LaneFocusPlan> => over.focusResult ?? focusOk('web'));
  const inspectRoot = vi.fn((_: AbsolutePath): LaneRootAvailability => 'available');
  const rootAvailability: LaneRootAvailabilityPort = { inspect: inspectRoot };
  return {
    openAt,
    warnUnavailable,
    notifyEmpty,
    pickContentResult,
    pickFileResult,
    searchContent,
    listFiles,
    search,
    ui,
    fileOpen,
    focus,
    inspectRoot,
    rootAvailability,
  };
};

const serviceFrom = (h: ReturnType<typeof harness>, getCatalog: () => LaneCatalog = catalog) =>
  createLaneSearchService({
    getCatalog,
    search: h.search,
    ui: h.ui,
    fileOpen: h.fileOpen,
    focus: h.focus,
    rootAvailability: h.rootAvailability,
  });

describe('createLaneSearchService.findInLanes', () => {
  it('空クエリのとき検索せず終了する', async () => {
    const h = harness({ query: '   ' });
    const service = serviceFrom(h);
    await service.findInLanes();
    expect(h.searchContent).not.toHaveBeenCalled();
  });

  it('バックエンド不在のとき警告し選択へ進まない', async () => {
    const h = harness({ query: 'foo', contentOutcome: { kind: 'unavailable' } });
    const service = serviceFrom(h);
    await service.findInLanes();
    expect(h.warnUnavailable).toHaveBeenCalledOnce();
    expect(h.openAt).not.toHaveBeenCalled();
  });

  it('検索が cancelled のとき通知、選択、focus、openを行わず終了する', async () => {
    const h = harness({ query: 'foo', contentOutcome: { kind: 'cancelled' } });
    const service = serviceFrom(h);

    await service.findInLanes();

    expect(h.warnUnavailable).not.toHaveBeenCalled();
    expect(h.notifyEmpty).not.toHaveBeenCalled();
    expect(h.pickContentResult).not.toHaveBeenCalled();
    expect(h.focus).not.toHaveBeenCalled();
    expect(h.openAt).not.toHaveBeenCalled();
  });

  it('検索 backend の Error を同じ instance のまま拒否する', async () => {
    const error = new Error('backend failed');
    const h = harness({ query: 'foo' });
    h.searchContent.mockRejectedValueOnce(error);
    const service = serviceFrom(h);

    await expect(service.findInLanes()).rejects.toBe(error);
    expect(h.warnUnavailable).not.toHaveBeenCalled();
  });

  it('0 件のとき空を通知する', async () => {
    const h = harness({
      query: 'foo',
      contentOutcome: { kind: 'results', results: [], truncated: false },
    });
    const service = serviceFrom(h);
    await service.findInLanes();
    expect(h.notifyEmpty).toHaveBeenCalledOnce();
  });

  it('実行時に各rootを検査し、availableだけをcontent検索へ渡す', async () => {
    const h = harness({ query: 'foo' });
    h.inspectRoot.mockImplementation((path) => {
      if (path === '/repo/web') return 'available';
      if (path === '/repo/api') return 'missing';
      return 'inaccessible';
    });
    const service = serviceFrom(h, () => catalogOf('web', 'api', 'docs'));

    await service.findInLanes();

    expect(h.inspectRoot.mock.calls.map(([path]) => path)).toEqual([
      '/repo/web',
      '/repo/api',
      '/repo/docs',
    ]);
    expect(h.searchContent).toHaveBeenCalledWith('foo', [{ laneId: 'web', rootPath: '/repo/web' }]);
  });

  it('全rootが利用不能でもcontent検索へ空rootsを渡して0件を通知する', async () => {
    const h = harness({ query: 'foo' });
    h.inspectRoot.mockReturnValue('missing');
    const service = serviceFrom(h);

    await service.findInLanes();

    expect(h.searchContent).toHaveBeenCalledWith('foo', []);
    expect(h.notifyEmpty).toHaveBeenCalledOnce();
    expect(h.warnUnavailable).not.toHaveBeenCalled();
  });

  it('選択結果のレーンへ focus し位置付きで開く', async () => {
    const hit = contentHit('api');
    const h = harness({
      query: 'foo',
      contentOutcome: { kind: 'results', results: [hit], truncated: false },
      picked: hit,
      focusResult: focusOk('api'),
    });
    const service = serviceFrom(h);
    await service.findInLanes();
    expect(h.openAt).toHaveBeenCalledWith('/repo/api/a.ts', { line: 3, column: 5 });
  });

  it('focus が blocked のとき開かない', async () => {
    const hit = contentHit('api');
    const h = harness({
      query: 'foo',
      contentOutcome: { kind: 'results', results: [hit], truncated: false },
      picked: hit,
      focusResult: focusBlocked,
    });
    const service = serviceFrom(h);
    await service.findInLanes();
    expect(h.openAt).not.toHaveBeenCalled();
  });

  it('focus が no-target のとき開かない', async () => {
    const hit = contentHit('api');
    const h = harness({
      query: 'foo',
      contentOutcome: { kind: 'results', results: [hit], truncated: false },
      picked: hit,
      focusResult: { kind: 'noop', reason: 'no-target' },
    });
    const service = serviceFrom(h);

    await service.findInLanes();

    expect(h.openAt).not.toHaveBeenCalled();
  });

  it('focus が transition-failed のとき原因を通知境界へ返して開かない', async () => {
    const hit = contentHit('api');
    const error = new Error('transition failed');
    const h = harness({
      query: 'foo',
      contentOutcome: { kind: 'results', results: [hit], truncated: false },
      picked: hit,
      focusResult: { kind: 'failed', reason: 'transition-failed', error },
    });
    const service = serviceFrom(h);

    await expect(service.findInLanes()).rejects.toBe(error);
    expect(h.openAt).not.toHaveBeenCalled();
  });

  it('focus target が検索結果の lane と異なるとき開かない', async () => {
    const hit = contentHit('api');
    const h = harness({
      query: 'foo',
      contentOutcome: { kind: 'results', results: [hit], truncated: false },
      picked: hit,
      focusResult: focusOk('web'),
    });
    const service = serviceFrom(h);

    await service.findInLanes();

    expect(h.openAt).not.toHaveBeenCalled();
  });

  it('focus が same-lane のとき現在の lane で開く', async () => {
    const hit = contentHit('api');
    const h = harness({
      query: 'foo',
      contentOutcome: { kind: 'results', results: [hit], truncated: false },
      picked: hit,
      focusResult: { kind: 'noop', reason: 'same-lane' },
    });
    const service = serviceFrom(h);

    await service.findInLanes();

    expect(h.openAt).toHaveBeenCalledWith('/repo/api/a.ts', { line: 3, column: 5 });
  });
});

describe('createLaneSearchService.goToFileInLanes', () => {
  it('ファイル列挙が cancelled のとき通知、選択、focus、openを行わず終了する', async () => {
    const h = harness({ filesOutcome: { kind: 'cancelled' } });
    const service = serviceFrom(h);

    await service.goToFileInLanes();

    expect(h.warnUnavailable).not.toHaveBeenCalled();
    expect(h.notifyEmpty).not.toHaveBeenCalled();
    expect(h.pickFileResult).not.toHaveBeenCalled();
    expect(h.focus).not.toHaveBeenCalled();
    expect(h.openAt).not.toHaveBeenCalled();
  });

  it('実行時に各rootを検査し、availableだけをfile検索へ渡す', async () => {
    const h = harness({});
    h.inspectRoot.mockImplementation((path) => {
      if (path === '/repo/web') return 'available';
      if (path === '/repo/api') return 'missing';
      return 'inaccessible';
    });
    const service = serviceFrom(h, () => catalogOf('web', 'api', 'docs'));

    await service.goToFileInLanes();

    expect(h.inspectRoot.mock.calls.map(([path]) => path)).toEqual([
      '/repo/web',
      '/repo/api',
      '/repo/docs',
    ]);
    expect(h.listFiles).toHaveBeenCalledWith([{ laneId: 'web', rootPath: '/repo/web' }]);
  });

  it('全rootが利用不能でもfile検索へ空rootsを渡して0件を通知する', async () => {
    const h = harness({});
    h.inspectRoot.mockReturnValue('inaccessible');
    const service = serviceFrom(h);

    await service.goToFileInLanes();

    expect(h.listFiles).toHaveBeenCalledWith([]);
    expect(h.notifyEmpty).toHaveBeenCalledOnce();
    expect(h.warnUnavailable).not.toHaveBeenCalled();
  });

  it('次回実行時に復旧したrootを再検査して検索へ戻す', async () => {
    const h = harness({ query: 'foo' });
    let availability: LaneRootAvailability = 'missing';
    h.inspectRoot.mockImplementation(() => availability);
    const service = serviceFrom(h, () => catalogOf('web'));

    await service.findInLanes();
    availability = 'available';
    await service.goToFileInLanes();

    expect(h.inspectRoot).toHaveBeenCalledTimes(2);
    expect(h.searchContent).toHaveBeenCalledWith('foo', []);
    expect(h.listFiles).toHaveBeenCalledWith([{ laneId: 'web', rootPath: '/repo/web' }]);
  });

  it('次回実行時に最新catalogを取得して検索rootsを組み直す', async () => {
    const h = harness({ query: 'foo' });
    let currentCatalog = catalogOf('web');
    const service = serviceFrom(h, () => currentCatalog);

    await service.findInLanes();
    currentCatalog = catalogOf('api');
    await service.goToFileInLanes();

    expect(h.searchContent).toHaveBeenCalledWith('foo', [{ laneId: 'web', rootPath: '/repo/web' }]);
    expect(h.listFiles).toHaveBeenCalledWith([{ laneId: 'api', rootPath: '/repo/api' }]);
    expect(h.inspectRoot.mock.calls.map(([path]) => path)).toEqual(['/repo/web', '/repo/api']);
  });

  it('file 結果を位置なしで開く', async () => {
    const fileHit: LaneSearchResult = {
      kind: 'file',
      laneId: 'web' as LaneId,
      path: '/repo/web/a.ts' as AbsolutePath,
      relativePath: 'a.ts',
    };
    const h = harness({
      filesOutcome: { kind: 'results', results: [fileHit], truncated: false },
      picked: fileHit,
      focusResult: focusOk('web'),
    });
    const service = serviceFrom(h);
    await service.goToFileInLanes();
    expect(h.openAt).toHaveBeenCalledWith('/repo/web/a.ts', undefined);
  });
});
