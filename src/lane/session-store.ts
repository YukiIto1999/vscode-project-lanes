import type { LaneId } from '../foundation/model';
import type { EditorSnapshot, LaneSessionStore } from './model';

/**
 * インメモリ実装のエディタ状態ストア生成
 * @returns ストアインスタンス
 */
export const createLaneSessionStore = (): LaneSessionStore => {
  const store = new Map<LaneId, EditorSnapshot>();

  return {
    save: (laneId, snapshot) => {
      store.set(laneId, snapshot);
    },
    get: (laneId) => store.get(laneId),
    clear: (laneId) => {
      store.delete(laneId);
    },
  };
};
