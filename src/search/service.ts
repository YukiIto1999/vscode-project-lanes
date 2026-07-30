import type { LaneId } from '../foundation/model';
import type { LaneCatalog, LaneFocusPlan } from '../lane/model';
import type { LaneRoot, LaneSearchResult } from './model';
import type { FileOpenPort, LaneSearchPort, SearchUiPort } from './ports';
import { parseLaneQuery } from './query';

/** 横断検索サービスの依存 */
export interface LaneSearchServiceDeps {
  /** カタログ取得関数 */
  readonly getCatalog: () => LaneCatalog;
  /** 検索バックエンドポート */
  readonly search: LaneSearchPort;
  /** 対話ポート */
  readonly ui: SearchUiPort;
  /** ファイルオープンポート */
  readonly fileOpen: FileOpenPort;
  /** レーンフォーカス関数 */
  readonly focus: (laneId: LaneId) => Promise<LaneFocusPlan>;
}

/** 横断検索サービスの操作 */
export interface LaneSearchService {
  /** ファイル内文字列の横断検索 */
  readonly findInLanes: () => Promise<void>;
  /** ファイル名の横断検索 */
  readonly goToFileInLanes: () => Promise<void>;
}

/**
 * 横断検索サービスの生成
 * @param deps - 依存
 * @returns サービスインスタンス
 */
export const createLaneSearchService = (deps: LaneSearchServiceDeps): LaneSearchService => {
  const { getCatalog, search, ui, fileOpen, focus } = deps;

  const rootsOf = (): readonly LaneRoot[] =>
    getCatalog().lanes.map((lane) => ({ laneId: lane.id, rootPath: lane.rootPath }));

  const navigate = async (result: LaneSearchResult): Promise<void> => {
    const plan = await focus(result.laneId);
    if (plan.kind === 'failed') throw plan.error;
    const targetActive =
      (plan.kind === 'focus' && plan.to.id === result.laneId) ||
      (plan.kind === 'noop' && plan.reason === 'same-lane');
    if (!targetActive) return;
    const position =
      result.kind === 'content' ? { line: result.line, column: result.column } : undefined;
    await fileOpen.openAt(result.path, position);
  };

  return {
    findInLanes: async () => {
      const query = parseLaneQuery(await ui.promptQuery());
      if (!query) return;
      const outcome = await search.searchContent(query, rootsOf());
      if (outcome.kind === 'unavailable') {
        ui.warnUnavailable();
        return;
      }
      if (outcome.results.length === 0) {
        ui.notifyEmpty();
        return;
      }
      const chosen = await ui.pickContentResult(outcome.results, outcome.truncated);
      if (!chosen) return;
      await navigate(chosen);
    },

    goToFileInLanes: async () => {
      const outcome = await search.listFiles(rootsOf());
      if (outcome.kind === 'unavailable') {
        ui.warnUnavailable();
        return;
      }
      if (outcome.results.length === 0) {
        ui.notifyEmpty();
        return;
      }
      const chosen = await ui.pickFileResult(outcome.results);
      if (!chosen) return;
      await navigate(chosen);
    },
  };
};
