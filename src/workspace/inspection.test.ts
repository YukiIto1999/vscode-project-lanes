import { describe, expect, it } from 'vitest';
import type { AbsolutePath, UriString } from '../foundation/model';
import type { WorkspaceFileInfo, WorkspaceFolder } from './model';
import {
  inspectWorkspace,
  type WorkspaceInspectionResult,
  type WorkspaceInspectionPorts,
} from './inspection';

const toUri = (path: string) => `file://${path}` as UriString;
const mkFolder = (name: string, path: string): WorkspaceFolder => ({ name, uri: toUri(path) });

const fileInfo: WorkspaceFileInfo = {
  uri: toUri('/home/user/workspace.code-workspace'),
  directoryPath: '/home/user' as AbsolutePath,
};

interface InspectionState {
  readonly workspaceFile?: WorkspaceFileInfo;
  readonly stored?: readonly WorkspaceFolder[];
  readonly folders?: readonly WorkspaceFolder[];
  readonly target?: AbsolutePath;
}

const makePorts = ({
  workspaceFile = fileInfo,
  stored,
  folders = [],
  target,
}: InspectionState = {}): WorkspaceInspectionPorts => ({
  workspaceFile: { read: () => workspaceFile },
  catalogStore: { load: () => stored },
  workspaceHost: { readFolders: () => folders },
  link: { readTarget: () => target },
});

const inspect = (state?: InspectionState): WorkspaceInspectionResult =>
  inspectWorkspace(makePorts(state));

describe('inspectWorkspace', () => {
  it('workspace file がなければ unsupported', () => {
    const unexpectedRead = () => {
      throw new Error('workspace file 以外を読んだ');
    };
    const ports: WorkspaceInspectionPorts = {
      workspaceFile: { read: () => undefined },
      catalogStore: { load: unexpectedRead },
      workspaceHost: { readFolders: unexpectedRead },
      link: { readTarget: unexpectedRead },
    };

    expect(inspectWorkspace(ports)).toEqual({ kind: 'unsupported' });
  });

  it.each([{ stored: [] }, { stored: [mkFolder('web', '/home/user/web')] }])(
    '保存済み catalog が %j なら managed',
    ({ stored }) => {
      expect(inspect({ stored })).toEqual({ kind: 'managed', evidence: 'catalog' });
    },
  );

  it.each([
    ['active-folder', mkFolder('任意の表示名', '/home/user/.lanes-root/active')],
    ['legacy-anchor', mkFolder('.lanes-root', '/home/user/.lanes-root')],
  ])('workspace file 隣の正確な %s なら managed', (evidence, folder) => {
    expect(inspect({ folders: [folder] })).toEqual({ kind: 'managed', evidence });
  });

  it.each([
    ['同名の別 folder', mkFolder('.lanes-root', '/home/user/project')],
    ['別名の legacy anchor path', mkFolder('project', '/home/user/.lanes-root')],
    ['別 directory の active path', mkFolder('active', '/other/.lanes-root/active')],
    ['active に似た path', mkFolder('active', '/home/user/.lanes-root/active-copy')],
  ])('%s だけでは unmanaged', (_case, folder) => {
    expect(inspect({ folders: [folder] })).toEqual({ kind: 'unmanaged' });
  });

  it('active link target が通常の raw folder と一致すれば managed', () => {
    expect(
      inspect({
        folders: [mkFolder('web', '/home/user/web'), mkFolder('api', '/home/user/api')],
        target: '/home/user/api' as AbsolutePath,
      }),
    ).toEqual({ kind: 'managed', evidence: 'active-target' });
  });

  it.each([
    ['raw folders にない target', '/home/user/other'],
    ['別 path の target', '/other/web'],
  ])('%s は unmanaged', (_case, target) => {
    expect(
      inspect({
        folders: [mkFolder('web', '/home/user/web')],
        target: target as AbsolutePath,
      }),
    ).toEqual({ kind: 'unmanaged' });
  });

  it('管理状態を示す情報がなければ unmanaged', () => {
    expect(inspect({ folders: [mkFolder('web', '/home/user/web')] })).toEqual({
      kind: 'unmanaged',
    });
  });
});
