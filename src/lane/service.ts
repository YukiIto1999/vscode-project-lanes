import type { LaneId, WorkspaceKey } from '../foundation/model';
import { planLaneFocus } from './focus-plan';
import type { Lane, LaneCatalog, LaneFocusPlan, LaneServiceSnapshot } from './model';
import type {
  EditorPort,
  LanePromptPort,
  LaneSelectionStorePort,
  LaneTerminalPort,
  LaneVisibilityPort,
} from './ports';
import { createLaneSessionStore } from './session-store';

/** レーンサービスの依存 */
export interface LaneServiceDeps {
  /** カタログは実行時に変化しうるため関数で注入 */
  readonly getCatalog: () => LaneCatalog;
  readonly workspaceKey: WorkspaceKey;
  readonly editor: EditorPort;
  readonly visibility: LaneVisibilityPort;
  readonly terminal: LaneTerminalPort;
  readonly selectionStore: LaneSelectionStorePort;
  readonly prompt: LanePromptPort;
}

/** レーンサービスの操作インターフェース */
export interface LaneService {
  readonly focus: (laneId?: LaneId) => Promise<LaneFocusPlan>;
  readonly unfocus: () => void;
  readonly closeActiveLaneTerminals: () => Promise<void>;
  readonly snapshot: () => LaneServiceSnapshot;
}

/** レーンサービスの生成 */
export const createLaneService = (deps: LaneServiceDeps): LaneService => {
  const { getCatalog, workspaceKey, editor, visibility, terminal, selectionStore, prompt } = deps;
  const editorStore = createLaneSessionStore();
  let activeLaneId: LaneId | undefined = selectionStore.load(workspaceKey);

  /** 初回フォーカスの適用（存在しないレーンは無視） */
  const initialCatalog = getCatalog();
  if (activeLaneId && initialCatalog.byId.has(activeLaneId)) {
    const lane = initialCatalog.byId.get(activeLaneId)!;
    visibility.focusLane(lane);
  } else {
    activeLaneId = undefined;
  }

  /** フォーカスパイプライン: plan → save → close → filter → terminal → restore → persist */
  const executeFocus = async (targetLane: Lane): Promise<LaneFocusPlan> => {
    const catalog = getCatalog();
    const currentLane = activeLaneId ? catalog.byId.get(activeLaneId) : undefined;
    const plan = planLaneFocus(currentLane, targetLane, editor.hasDirtyEditors());

    if (plan.kind !== 'focus') return plan;

    if (plan.from) {
      editorStore.save(plan.from.id, editor.captureSnapshot());
    }
    await editor.closeAll();
    visibility.focusLane(plan.to);
    await terminal.revealLane(plan.to);
    const saved = editorStore.get(plan.to.id);
    if (saved) await editor.restoreSnapshot(saved);

    activeLaneId = plan.to.id;
    selectionStore.save(workspaceKey, activeLaneId);

    return plan;
  };

  return {
    focus: async (laneId) => {
      const catalog = getCatalog();
      const targetId = laneId ?? (await prompt.pickLane(catalog.lanes));
      if (!targetId) return { kind: 'noop', reason: 'no-target' };
      const targetLane = catalog.byId.get(targetId);
      if (!targetLane) return { kind: 'noop', reason: 'no-target' };

      const result = await executeFocus(targetLane);
      if (result.kind === 'blocked') prompt.warnDirtyEditors();
      return result;
    },

    unfocus: () => {
      visibility.revealAllLanes(getCatalog().lanes);
      activeLaneId = undefined;
      selectionStore.save(workspaceKey, undefined);
    },

    closeActiveLaneTerminals: async () => {
      if (activeLaneId) await terminal.closeLane(activeLaneId);
    },

    snapshot: () => ({ catalog: getCatalog(), activeLaneId }),
  };
};
