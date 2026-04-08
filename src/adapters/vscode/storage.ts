import * as vscode from 'vscode';
import type { LaneId } from '../../foundation/model';
import type { LaneSelectionStorePort } from '../../lane/ports';

/** VS Code globalState によるレーン選択の永続化アダプター */
export const createSelectionStoreAdapter = (
  globalState: vscode.Memento,
): LaneSelectionStorePort => ({
  load: (key) => globalState.get<LaneId>(key),
  save: (key, laneId) => {
    globalState.update(key, laneId);
  },
});
