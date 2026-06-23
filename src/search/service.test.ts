import { describe, expect, it, vi } from 'vitest';
import type { AbsolutePath, LaneId, UriString } from '../foundation/model';
import type { Lane, LaneCatalog, LaneFocusPlan } from '../lane/model';
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

const contentHit = (laneId: string): LaneSearchResult => ({
  kind: 'content',
  laneId: laneId as LaneId,
  path: `/repo/${laneId}/a.ts` as AbsolutePath,
  relativePath: 'a.ts',
  line: 3,
  column: 5,
  preview: 'hit',
});

const focusOk: LaneFocusPlan = { kind: 'focus', from: undefined, to: lane('web') };
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
  const searchContent = vi.fn(
    async (): Promise<LaneSearchOutcome> =>
      over.contentOutcome ?? { kind: 'results', results: [], truncated: false },
  );
  const search: LaneSearchPort = {
    searchContent,
    listFiles: async () => over.filesOutcome ?? { kind: 'results', results: [], truncated: false },
  };
  const ui: SearchUiPort = {
    promptQuery: async () => over.query,
    pickContentResult: async () => over.picked,
    pickFileResult: async () => over.picked,
    notifyEmpty,
    warnUnavailable,
  };
  const fileOpen: FileOpenPort = { openAt };
  const focus = async (): Promise<LaneFocusPlan> => over.focusResult ?? focusOk;
  return { openAt, warnUnavailable, notifyEmpty, searchContent, search, ui, fileOpen, focus };
};

describe('createLaneSearchService.findInLanes', () => {
  it('空クエリのとき検索せず終了する', async () => {
    const h = harness({ query: '   ' });
    const service = createLaneSearchService({
      getCatalog: catalog,
      search: h.search,
      ui: h.ui,
      fileOpen: h.fileOpen,
      focus: h.focus,
    });
    await service.findInLanes();
    expect(h.searchContent).not.toHaveBeenCalled();
  });

  it('バックエンド不在のとき警告し選択へ進まない', async () => {
    const h = harness({ query: 'foo', contentOutcome: { kind: 'unavailable' } });
    const service = createLaneSearchService({
      getCatalog: catalog,
      search: h.search,
      ui: h.ui,
      fileOpen: h.fileOpen,
      focus: h.focus,
    });
    await service.findInLanes();
    expect(h.warnUnavailable).toHaveBeenCalledOnce();
    expect(h.openAt).not.toHaveBeenCalled();
  });

  it('0 件のとき空を通知する', async () => {
    const h = harness({
      query: 'foo',
      contentOutcome: { kind: 'results', results: [], truncated: false },
    });
    const service = createLaneSearchService({
      getCatalog: catalog,
      search: h.search,
      ui: h.ui,
      fileOpen: h.fileOpen,
      focus: h.focus,
    });
    await service.findInLanes();
    expect(h.notifyEmpty).toHaveBeenCalledOnce();
  });

  it('選択結果のレーンへ focus し位置付きで開く', async () => {
    const hit = contentHit('api');
    const h = harness({
      query: 'foo',
      contentOutcome: { kind: 'results', results: [hit], truncated: false },
      picked: hit,
      focusResult: focusOk,
    });
    const service = createLaneSearchService({
      getCatalog: catalog,
      search: h.search,
      ui: h.ui,
      fileOpen: h.fileOpen,
      focus: h.focus,
    });
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
    const service = createLaneSearchService({
      getCatalog: catalog,
      search: h.search,
      ui: h.ui,
      fileOpen: h.fileOpen,
      focus: h.focus,
    });
    await service.findInLanes();
    expect(h.openAt).not.toHaveBeenCalled();
  });
});

describe('createLaneSearchService.goToFileInLanes', () => {
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
      focusResult: focusOk,
    });
    const service = createLaneSearchService({
      getCatalog: catalog,
      search: h.search,
      ui: h.ui,
      fileOpen: h.fileOpen,
      focus: h.focus,
    });
    await service.goToFileInLanes();
    expect(h.openAt).toHaveBeenCalledWith('/repo/web/a.ts', undefined);
  });
});
