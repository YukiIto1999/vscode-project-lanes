import type { LaneId } from '../foundation/model';
import type { EditorSnapshot, LaneSessionStore } from './model';

/** インメモリのエディタ状態ストアの生成 */
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
