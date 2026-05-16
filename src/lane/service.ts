import type { LaneId, WorkspaceKey } from '../foundation/model';
import type { WorkspaceLinkPort } from '../workspace/ports';
import type { WorkspaceCatalogRegistry } from '../workspace/registry';
import { executeActiveLinkSwap, planActiveLinkSwap } from './active-link';
import { planLaneFocus } from './focus-plan';
import type { Lane, LaneCatalog, LaneFocusPlan, LaneServiceSnapshot } from './model';
import type {
  EditorPort,
  LanePromptPort,
  LaneSelectionStorePort,
  LaneSessionStore,
  LaneTerminalPort,
  LaneViewRebindPort,
} from './ports';
import { planLaneRemoval } from './removal-plan';
import { planLaneRename } from './rename-plan';

/** レーンサービスの依存 */
export interface LaneServiceDeps {
  /** カタログ取得関数 */
  readonly getCatalog: () => LaneCatalog;
  /** ワークスペース永続キー */
  readonly workspaceKey: WorkspaceKey;
  /** エディタ操作ポート */
  readonly editor: EditorPort;
  /** symlink 操作ポート */
  readonly link: WorkspaceLinkPort;
  /** ターミナル切替ポート */
  readonly terminal: LaneTerminalPort;
  /** ビュー再走査ポート */
  readonly viewRebind: LaneViewRebindPort;
  /** 選択永続化ポート */
  readonly selectionStore: LaneSelectionStorePort;
  /** ユーザー対話ポート */
  readonly prompt: LanePromptPort;
  /** カタログ正本の操作 */
  readonly registry: WorkspaceCatalogRegistry;
  /** ターミナル rekey ポート */
  readonly terminalRekey: { readonly rekeyLane: (oldId: LaneId, newId: LaneId) => void };
  /** エディタ snapshot ストア */
  readonly editorStore: LaneSessionStore;
}

/** レーンサービスの操作インターフェース */
export interface LaneService {
  /** 起動時初期化 */
  readonly initialize: () => void;
  /**
   * レーンへのフォーカス
   * @param laneId - 切替先レーン識別子、または未指定で対話選択
   * @returns 判定結果
   */
  readonly focus: (laneId?: LaneId) => Promise<LaneFocusPlan>;
  /**
   * 活性レーンのターミナル全終了
   * @returns 完了の Promise
   */
  readonly closeActiveLaneTerminals: () => Promise<void>;
  /**
   * レーン名の変更
   * @param laneId - 対象レーン識別子、または未指定で対話選択
   * @returns 完了の Promise
   */
  readonly renameLane: (laneId?: LaneId) => Promise<void>;
  /**
   * レーンの削除
   * @param laneId - 対象レーン識別子、または未指定で対話選択
   * @returns 完了の Promise
   */
  readonly removeLane: (laneId?: LaneId) => Promise<void>;
  /**
   * 現在状態の取得
   * @returns 現状スナップショット
   */
  readonly snapshot: () => LaneServiceSnapshot;
}

/**
 * レーンサービスの生成
 * @param deps - 依存
 * @returns サービスインスタンス
 */
export const createLaneService = (deps: LaneServiceDeps): LaneService => {
  const {
    getCatalog,
    workspaceKey,
    editor,
    link,
    terminal,
    viewRebind,
    selectionStore,
    prompt,
    registry,
    terminalRekey,
    editorStore,
  } = deps;
  let activeLaneId: LaneId | undefined = selectionStore.load(workspaceKey);

  const initialize = (): void => {
    const catalog = getCatalog();
    if (activeLaneId && !catalog.byId.has(activeLaneId)) {
      activeLaneId = undefined;
      selectionStore.save(workspaceKey, undefined);
    }
    if (!activeLaneId && catalog.lanes.length > 0) {
      const target = link.readTarget();
      const match = target ? catalog.lanes.find((l) => l.rootPath === target) : undefined;
      activeLaneId = (match ?? catalog.lanes[0]!).id;
      selectionStore.save(workspaceKey, activeLaneId);
    }
  };

  const executeFocus = async (targetLane: Lane): Promise<LaneFocusPlan> => {
    const catalog = getCatalog();
    const currentLane = activeLaneId ? catalog.byId.get(activeLaneId) : undefined;
    const plan = planLaneFocus(currentLane, targetLane, editor.hasDirtyEditors());
    if (plan.kind !== 'focus') return plan;

    if (plan.from) {
      editorStore.save(plan.from.id, editor.captureSnapshot());
    }
    await editor.closeAll();

    const currentTarget = link.readTarget();
    const swap = planActiveLinkSwap(link.linkPath, currentTarget, plan.to.rootPath);
    if (swap) {
      executeActiveLinkSwap(swap, link);
      await viewRebind.rebindActiveFolder(plan.to);
    }

    await terminal.revealLane(plan.to);
    const saved = editorStore.get(plan.to.id);
    if (saved) await editor.restoreSnapshot(saved);

    activeLaneId = plan.to.id;
    selectionStore.save(workspaceKey, activeLaneId);
    return plan;
  };

  return {
    initialize,

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

    closeActiveLaneTerminals: async () => {
      if (activeLaneId) await terminal.closeLane(activeLaneId);
    },

    renameLane: async (laneId) => {
      const targetId = laneId ?? (await prompt.pickLane(getCatalog().lanes));
      if (!targetId) return;
      const target = getCatalog().byId.get(targetId);
      if (!target) return;

      const validate = (raw: string): string | undefined => {
        const p = planLaneRename({ targetId, newLabel: raw, catalog: getCatalog() });
        if (p.kind === 'invalid' && p.reason === 'empty') return 'Enter a name.';
        if (p.kind === 'invalid' && p.reason === 'duplicate')
          return 'A lane with this name already exists.';
        return undefined;
      };

      const raw = await prompt.promptRename(target.label, validate);
      if (raw === undefined) return;

      const plan = planLaneRename({ targetId, newLabel: raw, catalog: getCatalog() });
      if (plan.kind !== 'rename') return;

      terminalRekey.rekeyLane(plan.from.id, plan.to.id);
      editorStore.rekey(plan.from.id, plan.to.id);
      if (activeLaneId === plan.from.id) {
        activeLaneId = plan.to.id;
        selectionStore.save(workspaceKey, activeLaneId);
      }
      registry.rename(plan.from.label, plan.to.label);

      if (activeLaneId === plan.to.id) {
        const newLane = getCatalog().byId.get(plan.to.id);
        if (newLane) await viewRebind.rebindActiveFolder(newLane);
      }
    },

    removeLane: async (laneId) => {
      const targetId = laneId ?? (await prompt.pickLane(getCatalog().lanes));
      if (!targetId) return;

      const plan = planLaneRemoval({ targetId, activeLaneId, catalog: getCatalog() });
      if (plan.kind === 'noop') return;
      if (plan.kind === 'blocked') {
        prompt.warnActiveLaneRemoval();
        return;
      }

      const confirmed = await prompt.confirmRemoval(plan.target);
      if (!confirmed) return;

      await terminal.closeLane(plan.target.id);
      editorStore.clear(plan.target.id);
      registry.remove(plan.target.label);
    },

    snapshot: () => ({ catalog: getCatalog(), activeLaneId }),
  };
};
