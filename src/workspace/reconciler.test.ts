import { describe, expect, it } from 'vitest';
import type { LaneId, UriString } from '../foundation/model';
import type { WorkspaceFolder } from './model';
import { reconcileUserChange } from './reconciler';

const toUri = (path: string) => `file://${path}` as UriString;
const mkFolder = (name: string, path: string): WorkspaceFolder => ({
  name,
  uri: toUri(path),
});

const anchor = mkFolder('.lanes-root', '/home/user/.lanes-root');
const web = mkFolder('web', '/home/user/web');
const api = mkFolder('api', '/home/user/api');
const docs = mkFolder('docs', '/home/user/docs');

describe('reconcileUserChange', () => {
  describe('unfocused', () => {
    it('raw と current が同じなら noop', () => {
      const action = reconcileUserChange({
        rawFolders: [anchor, web, api],
        currentLanes: [web, api],
        activeLaneId: undefined,
      });
      expect(action).toEqual({ kind: 'noop' });
    });

    it('追加されていれば replace', () => {
      const action = reconcileUserChange({
        rawFolders: [anchor, web, api, docs],
        currentLanes: [web, api],
        activeLaneId: undefined,
      });
      expect(action).toEqual({ kind: 'replace', canonicalLanes: [web, api, docs] });
    });

    it('削除されていれば replace', () => {
      const action = reconcileUserChange({
        rawFolders: [anchor, web],
        currentLanes: [web, api],
        activeLaneId: undefined,
      });
      expect(action).toEqual({ kind: 'replace', canonicalLanes: [web] });
    });

    it('並び替えも replace', () => {
      const action = reconcileUserChange({
        rawFolders: [anchor, api, web],
        currentLanes: [web, api],
        activeLaneId: undefined,
      });
      expect(action).toEqual({ kind: 'replace', canonicalLanes: [api, web] });
    });
  });

  describe('focused', () => {
    it('期待通り [anchor, activeLane] なら noop', () => {
      const action = reconcileUserChange({
        rawFolders: [anchor, web],
        currentLanes: [web, api],
        activeLaneId: 'web' as LaneId,
      });
      expect(action).toEqual({ kind: 'noop' });
    });

    it('ユーザー追加は absorb + focus 復元要求', () => {
      const newProject = mkFolder('new-project', '/home/user/new-project');
      const action = reconcileUserChange({
        rawFolders: [anchor, web, newProject],
        currentLanes: [web, api],
        activeLaneId: 'web' as LaneId,
      });
      expect(action).toEqual({
        kind: 'absorb',
        additions: [newProject],
        restoreFocusLaneId: 'web' as LaneId,
      });
    });

    it('既知レーンが追加フォルダとして現れただけなら noop', () => {
      const action = reconcileUserChange({
        rawFolders: [anchor, web, api],
        currentLanes: [web, api],
        activeLaneId: 'web' as LaneId,
      });
      expect(action).toEqual({ kind: 'noop' });
    });
  });
});
