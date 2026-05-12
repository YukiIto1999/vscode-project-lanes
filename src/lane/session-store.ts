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
    rekey: (oldLaneId, newLaneId) => {
      if (oldLaneId === newLaneId) return;
      const snapshot = store.get(oldLaneId);
      if (snapshot === undefined) return;
      store.delete(oldLaneId);
      store.set(newLaneId, snapshot);
    },
    clear: (laneId) => {
      store.delete(laneId);
    },
  };
};
