import { describe, expect, it } from 'vitest';
import { initialParserState, parseChunk, type Osc633Event, type ParserState } from './osc633';

const ESC = '\x1b';
const BEL = '\x07';

const drive = (
  chunks: readonly string[],
): { state: ParserState; events: readonly Osc633Event[] } => {
  let state = initialParserState();
  const events: Osc633Event[] = [];
  for (const chunk of chunks) {
    const r = parseChunk(state, chunk);
    state = r.state;
    events.push(...r.events);
  }
  return { state, events };
};

describe('parseChunk: 通常出力', () => {
  it('OSC を含まない文字列は output 1 回のみ', () => {
    const { state, events } = drive(['hello world\n']);
    expect(state.phase).toBe('plain');
    expect(events).toEqual([{ kind: 'output' }]);
  });

  it('空チャンクは何も発火しない', () => {
    const { state, events } = drive(['']);
    expect(state.phase).toBe('plain');
    expect(events).toEqual([]);
  });
});

describe('parseChunk: OSC 633 ;C / ;D', () => {
  it('単独の ;C で fg-started を発火', () => {
    const { state, events } = drive([`${ESC}]633;C${BEL}`]);
    expect(state.phase).toBe('plain');
    expect(events).toEqual([{ kind: 'fg-started' }]);
  });

  it('単独の ;D で fg-ended を発火', () => {
    const { events } = drive([`${ESC}]633;D${BEL}`]);
    expect(events).toEqual([{ kind: 'fg-ended' }]);
  });

  it(';D;<status> も fg-ended として扱う', () => {
    const { events } = drive([`${ESC}]633;D;0${BEL}`]);
    expect(events).toEqual([{ kind: 'fg-ended' }]);
  });

  it(';A / ;B / ;P=key=value / ;E=cmd は fg イベントを発火しない', () => {
    const { events } = drive([
      `${ESC}]633;A${BEL}`,
      `${ESC}]633;B${BEL}`,
      `${ESC}]633;P=key=value${BEL}`,
      `${ESC}]633;E=ls -la${BEL}`,
    ]);
    expect(events).toEqual([]);
  });

  it('ST 終端 (ESC \\\\) でも確定する', () => {
    const { state, events } = drive([`${ESC}]633;C${ESC}\\`]);
    expect(state.phase).toBe('plain');
    expect(events).toEqual([{ kind: 'fg-started' }]);
  });

  it('OSC 633 と通常出力が混在する場合、時系列順に output / fg-started / output を発火', () => {
    const { events } = drive([`prompt$ ${ESC}]633;C${BEL}running...`]);
    expect(events).toEqual([{ kind: 'output' }, { kind: 'fg-started' }, { kind: 'output' }]);
  });
});

describe('parseChunk: 非 633 OSC は透過 (skip)', () => {
  it('OSC 0 (ウィンドウタイトル) は無視', () => {
    const { events } = drive([`${ESC}]0;Title${BEL}body`]);
    expect(events).toEqual([{ kind: 'output' }]);
  });

  it('OSC 633 以外は payload 内容を解釈しない', () => {
    const { events } = drive([`${ESC}]999;C${BEL}`]);
    expect(events).toEqual([]);
  });
});

describe('parseChunk: チャンク分割', () => {
  it('1 byte ずつ分割しても確定する', () => {
    const seq = `${ESC}]633;C${BEL}`;
    const chunks = [...seq];
    const { state, events } = drive(chunks);
    expect(state.phase).toBe('plain');
    expect(events).toEqual([{ kind: 'fg-started' }]);
  });

  it('OSC の途中で切れた場合、状態を持ち越し次回継続', () => {
    const r1 = parseChunk(initialParserState(), `${ESC}]633;`);
    expect(r1.state.phase).toBe('osc-633');
    expect(r1.events).toEqual([]);
    const r2 = parseChunk(r1.state, `D${BEL}`);
    expect(r2.state.phase).toBe('plain');
    expect(r2.events).toEqual([{ kind: 'fg-ended' }]);
  });

  it('連続する複数の OSC 633 を順序通り発火', () => {
    const seq = `${ESC}]633;C${BEL}body${ESC}]633;D${BEL}`;
    const { events } = drive([seq]);
    expect(events).toEqual([{ kind: 'fg-started' }, { kind: 'output' }, { kind: 'fg-ended' }]);
  });
});

describe('parseChunk: 不正/未確定シーケンス', () => {
  it('ESC のあと ] 以外は通常出力扱い', () => {
    const { state, events } = drive([`${ESC}A`]);
    expect(state.phase).toBe('plain');
    expect(events).toEqual([{ kind: 'output' }]);
  });

  it('OSC が BEL/ST なしで終わる場合は次チャンクへ持ち越し', () => {
    const r1 = parseChunk(initialParserState(), `${ESC}]633;C`);
    expect(r1.state.phase).toBe('osc-633');
    expect(r1.events).toEqual([]);
  });

  it('633 payload 中の ESC が \\ で終わらなければ payload に取り込んで継続', () => {
    const r1 = parseChunk(initialParserState(), `${ESC}]633;`);
    const r2 = parseChunk(r1.state, `D${ESC}X`);
    expect(r2.state.phase).toBe('osc-633');
    if (r2.state.phase === 'osc-633') expect(r2.state.payload).toBe(`D${ESC}X`);
    expect(r2.events).toEqual([]);
  });
});
