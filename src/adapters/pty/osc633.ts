/**
 * OSC 633 ストリームパーサ。
 * シェル統合スクリプトが吐く `\x1b]633;<payload>\x07` (または `\x1b]633;<payload>\x1b\\`) を
 * 純粋な状態遷移として認識し、`fg-started` / `fg-ended` / `output` の各事実を抽出する。
 * バイト列受け取り → 構造化イベント列 への変換に閉じ、時刻取得・I/O は行わない。
 */

const ESC = '\x1b';
const BEL = '\x07';
const OSC_OPEN = ']';
const OSC_ID_633 = '633';
const PARAM_SEP = ';';
const ST_TAIL = '\\';
const PAYLOAD_FG_STARTED = 'C';
const PAYLOAD_FG_ENDED_PREFIX = 'D';

/** OSC 633 由来の事実 */
export type Osc633Event =
  | { readonly kind: 'fg-started' }
  | { readonly kind: 'fg-ended' }
  | { readonly kind: 'output' };

/**
 * パーサの状態。各フェーズはチャンク境界を跨いで保持される。
 * - plain: 通常出力
 * - esc: ESC を観測直後 (次が `]` なら OSC 突入)
 * - osc-id: ESC `]` のあとの識別子蓄積中 (`;` を境に payload/skip へ分岐)
 * - osc-633: 633 確定後の payload 蓄積中
 * - osc-633-st: 633 payload 中で ESC を観測 (次が `\` で ST 終端)
 * - osc-other: 非 633 OSC を読み飛ばし中
 * - osc-other-st: 非 633 OSC 中で ESC を観測
 */
export type ParserState =
  | { readonly phase: 'plain' }
  | { readonly phase: 'esc' }
  | { readonly phase: 'osc-id'; readonly id: string }
  | { readonly phase: 'osc-633'; readonly payload: string }
  | { readonly phase: 'osc-633-st'; readonly payload: string }
  | { readonly phase: 'osc-other' }
  | { readonly phase: 'osc-other-st' };

/** 1 文字遷移の結果 */
interface StepResult {
  /** 遷移後状態 */
  readonly state: ParserState;
  /** 通常出力が観測されたか */
  readonly emittedOutput: boolean;
  /** 確定した OSC 633 イベント (無ければ undefined) */
  readonly emittedFg?: Osc633Event | undefined;
}

/**
 * 初期状態の生成
 * @returns plain フェーズの初期状態
 */
export const initialParserState = (): ParserState => ({ phase: 'plain' });

/**
 * payload 文字列から fg-started / fg-ended への解釈。
 * `C` / `D` / `D;<status>` のみを対象とし、それ以外 (A, B, E, P 等) は無視。
 * @param payload - `633;` 以降の本体文字列
 * @returns 対応イベント、対象外なら undefined
 */
const interpretFgPayload = (payload: string): Osc633Event | undefined => {
  if (payload === PAYLOAD_FG_STARTED) return { kind: 'fg-started' };
  if (payload === PAYLOAD_FG_ENDED_PREFIX) return { kind: 'fg-ended' };
  if (payload.startsWith(PAYLOAD_FG_ENDED_PREFIX + PARAM_SEP)) return { kind: 'fg-ended' };
  return undefined;
};

const stepPlain = (c: string): StepResult => {
  if (c === ESC) return { state: { phase: 'esc' }, emittedOutput: false };
  return { state: { phase: 'plain' }, emittedOutput: true };
};

const stepEsc = (c: string): StepResult => {
  if (c === OSC_OPEN) return { state: { phase: 'osc-id', id: '' }, emittedOutput: false };
  return { state: { phase: 'plain' }, emittedOutput: true };
};

const stepOscId = (state: { phase: 'osc-id'; id: string }, c: string): StepResult => {
  if (c === PARAM_SEP) {
    const next: ParserState =
      state.id === OSC_ID_633 ? { phase: 'osc-633', payload: '' } : { phase: 'osc-other' };
    return { state: next, emittedOutput: false };
  }
  if (c === BEL) return { state: { phase: 'plain' }, emittedOutput: false };
  if (c === ESC) return { state: { phase: 'osc-other-st' }, emittedOutput: false };
  return { state: { phase: 'osc-id', id: state.id + c }, emittedOutput: false };
};

const stepOsc633 = (state: { phase: 'osc-633'; payload: string }, c: string): StepResult => {
  if (c === BEL)
    return {
      state: { phase: 'plain' },
      emittedOutput: false,
      emittedFg: interpretFgPayload(state.payload),
    };
  if (c === ESC)
    return { state: { phase: 'osc-633-st', payload: state.payload }, emittedOutput: false };
  return { state: { phase: 'osc-633', payload: state.payload + c }, emittedOutput: false };
};

const stepOsc633St = (state: { phase: 'osc-633-st'; payload: string }, c: string): StepResult => {
  if (c === ST_TAIL)
    return {
      state: { phase: 'plain' },
      emittedOutput: false,
      emittedFg: interpretFgPayload(state.payload),
    };
  return { state: { phase: 'osc-633', payload: state.payload + ESC + c }, emittedOutput: false };
};

const stepOscOther = (c: string): StepResult => {
  if (c === BEL) return { state: { phase: 'plain' }, emittedOutput: false };
  if (c === ESC) return { state: { phase: 'osc-other-st' }, emittedOutput: false };
  return { state: { phase: 'osc-other' }, emittedOutput: false };
};

const stepOscOtherSt = (c: string): StepResult => {
  if (c === ST_TAIL) return { state: { phase: 'plain' }, emittedOutput: false };
  return { state: { phase: 'osc-other' }, emittedOutput: false };
};

/**
 * 1 文字進行
 * @param state - 遷移前状態
 * @param c - 入力 1 文字
 * @returns 遷移結果
 */
const step = (state: ParserState, c: string): StepResult => {
  switch (state.phase) {
    case 'plain':
      return stepPlain(c);
    case 'esc':
      return stepEsc(c);
    case 'osc-id':
      return stepOscId(state, c);
    case 'osc-633':
      return stepOsc633(state, c);
    case 'osc-633-st':
      return stepOsc633St(state, c);
    case 'osc-other':
      return stepOscOther(c);
    case 'osc-other-st':
      return stepOscOtherSt(c);
  }
};

/**
 * チャンク 1 つ分のパース。
 * - 連続する通常出力区間ごとに `output` を 1 回発火 (バイト時系列を保つ)
 * - OSC 633 ;C / ;D[;...] の終端確定時に `fg-started` / `fg-ended` を発火
 * - 不完全シーケンスは状態として持ち越す
 * @param state - 遷移前状態
 * @param chunk - PTY から到着したチャンク
 * @returns 遷移後状態と発火イベント列
 */
export const parseChunk = (
  state: ParserState,
  chunk: string,
): { readonly state: ParserState; readonly events: readonly Osc633Event[] } => {
  const events: Osc633Event[] = [];
  let cur = state;
  let outputPending = false;

  const flushOutput = (): void => {
    if (!outputPending) return;
    events.push({ kind: 'output' });
    outputPending = false;
  };

  for (const c of chunk) {
    const result = step(cur, c);
    cur = result.state;
    if (result.emittedOutput) {
      outputPending = true;
      continue;
    }
    flushOutput();
    if (result.emittedFg) events.push(result.emittedFg);
  }

  flushOutput();
  return { state: cur, events };
};
