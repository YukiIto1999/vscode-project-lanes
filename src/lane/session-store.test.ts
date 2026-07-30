import { describe, expect, it } from 'vitest';
import type { LaneId, UriString } from '../foundation/model';
import { createLaneSessionStore } from './session-store';

describe('createLaneSessionStore', () => {
  it('保存と取得', () => {
    const store = createLaneSessionStore();
    const snapshot = { tabs: [{ uri: 'file:///a.ts' as UriString, viewColumn: 1 }] };
    store.save('web' as LaneId, snapshot);
    expect(store.get('web' as LaneId)).toEqual(snapshot);
  });

  it('未保存レーンは undefined', () => {
    const store = createLaneSessionStore();
    expect(store.get('unknown' as LaneId)).toBeUndefined();
  });

  it('上書き保存', () => {
    const store = createLaneSessionStore();
    store.save('web' as LaneId, { tabs: [{ uri: 'file:///a.ts' as UriString, viewColumn: 1 }] });
    const updated = { tabs: [{ uri: 'file:///b.ts' as UriString, viewColumn: 2 }] };
    store.save('web' as LaneId, updated);
    expect(store.get('web' as LaneId)).toEqual(updated);
  });

  it('clear で削除', () => {
    const store = createLaneSessionStore();
    store.save('web' as LaneId, { tabs: [] });
    store.clear('web' as LaneId);
    expect(store.get('web' as LaneId)).toBeUndefined();
  });

  it('レーン間の分離', () => {
    const store = createLaneSessionStore();
    const snap1 = { tabs: [{ uri: 'file:///a.ts' as UriString, viewColumn: 1 }] };
    const snap2 = { tabs: [{ uri: 'file:///b.ts' as UriString, viewColumn: 2 }] };
    store.save('web' as LaneId, snap1);
    store.save('api' as LaneId, snap2);
    expect(store.get('web' as LaneId)).toEqual(snap1);
    expect(store.get('api' as LaneId)).toEqual(snap2);
  });
});
