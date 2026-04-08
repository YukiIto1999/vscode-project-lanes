import type { Disposable } from '../../foundation/model';
import type { TimerPort } from '../../app/model';

/** setInterval ベースの定期実行アダプター */
export const createTimerAdapter = (): TimerPort => ({
  every: (intervalMs, callback): Disposable => {
    const id = setInterval(callback, intervalMs);
    return { dispose: () => clearInterval(id) };
  },
});
