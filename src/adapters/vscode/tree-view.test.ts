import { describe, expect, it, vi } from 'vitest';
import type { LaneId, UriString } from '../../foundation/model';
import type { LaneTreeItemViewModel } from '../../ui/model';

const vscode = vi.hoisted(() => {
  class TreeItem {
    readonly label: string;
    id: string | undefined;
    description: string | undefined;
    iconPath: unknown;
    resourceUri: unknown;
    contextValue: string | undefined;
    command: unknown;

    constructor(label: string) {
      this.label = label;
    }
  }

  class ThemeColor {
    constructor(readonly id: string) {}
  }

  class ThemeIcon {
    constructor(
      readonly id: string,
      readonly color?: ThemeColor,
    ) {}
  }

  return { TreeItem, ThemeColor, ThemeIcon };
});

vi.mock('vscode', () => ({
  TreeItem: vscode.TreeItem,
  ThemeColor: vscode.ThemeColor,
  ThemeIcon: vscode.ThemeIcon,
  Uri: { parse: (value: string) => ({ value }) },
}));

import { toTreeItem } from './tree-view';

const viewModel = (overrides: Partial<LaneTreeItemViewModel> = {}): LaneTreeItemViewModel => ({
  laneId: 'web' as LaneId,
  label: 'web',
  description: '',
  availability: 'available',
  action: 'switch',
  isActive: false,
  resourceUri: 'lane:///web' as UriString,
  ...overrides,
});

describe('toTreeItem', () => {
  it('available lane は switch command と available context を持つ', () => {
    const item = toTreeItem(viewModel());

    expect(item.contextValue).toBe('projectLaneAvailable');
    expect(item.command).toEqual({
      command: 'projectLanes.switchLane',
      title: 'Switch Lane',
      arguments: ['web'],
    });
  });

  it.each(['missing', 'inaccessible'] as const)(
    '%s lane は Locate Folder command と unavailable context を持つ',
    (availability) => {
      const item = toTreeItem(
        viewModel({
          availability,
          action: 'locate',
          description: 'Folder unavailable',
        }),
      );

      expect(item.contextValue).toBe('projectLaneUnavailable');
      expect(item.command).toEqual({
        command: 'projectLanes.locateFolder',
        title: 'Locate Folder',
        arguments: ['web'],
      });
    },
  );
});
