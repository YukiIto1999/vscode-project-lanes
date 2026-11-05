import { describe, expect, it } from 'vitest';
import { stripTerminalQueries } from './terminal-query';

describe('stripTerminalQueries', () => {
  it.each([
    ['平文と改行', 'plain text\r\n日本語 😀\r\n'],
    ['SGR と cursor 移動', '\x1b[1;31mred\x1b[0m\x1b[2J\x1b[H\x1b[10;5H\x1b[3A'],
    ['DEC private mode', '\x1b[?1049h\x1b[?2004h\x1b[?1004h\x1b[?25l'],
    ['cursor style、soft reset、DECSCA', '\x1b[2 q\x1b[!p\x1b[1"q'],
    ['cursor 復元と kitty keyboard の設定', '\x1b[u\x1b[=1;1u\x1b[>1u\x1b[<u'],
    ['scroll と DA 以外の c 終端', '\x1b[3S\x1b[$c'],
    ['window title stack と resize', '\x1b[22;0t\x1b[23;0t\x1b[8;24;80t'],
    ['BEL と ST で閉じた title', '\x1b]0;title\x07\x1b]2;name\x1b\\'],
    [
      'hyperlink と shell integration',
      '\x1b]8;;https://example.com\x07link\x1b]8;;\x07\x1b]633;C\x07',
    ],
    ['色と clipboard の設定', '\x1b]4;1;rgb:ff/00/00\x07\x1b]10;#ffffff\x07\x1b]52;c;aGVsbG8=\x07'],
    ['sixel と XTSETTCAP', '\x1bPq#0;2;0;0;0#0~~\x1b\\\x1bP+p544e\x1b\\'],
    ['応答を止めた kitty graphics', '\x1b_Ga=T,f=100,q=2;QUJD\x1b\\'],
    ['単独の ESC と C1 制御', '\x1b7\x1b8\x1bc\x1b(B\x85\x9c'],
  ])('%s は同一の文字列として返す', (_label, input) => {
    expect(stripTerminalQueries(input)).toBe(input);
  });

  it.each([
    ['primary DA', '\x1b[c'],
    ['引数付き primary DA', '\x1b[0c'],
    ['secondary DA', '\x1b[>c'],
    ['引数付き secondary DA', '\x1b[>0c'],
    ['tertiary DA', '\x1b[=c'],
    ['status report', '\x1b[5n'],
    ['cursor position report', '\x1b[6n'],
    ['DEC cursor position report', '\x1b[?6n'],
    ['color scheme 問い合わせ', '\x1b[?996n'],
    ['ANSI DECRQM', '\x1b[4$p'],
    ['DEC DECRQM', '\x1b[?2026$p'],
    ['XTVERSION', '\x1b[>q'],
    ['引数付き XTVERSION', '\x1b[>0q'],
    ['kitty keyboard 問い合わせ', '\x1b[?u'],
    ['text area pixel 報告', '\x1b[14t'],
    ['window pixel 報告', '\x1b[14;2t'],
    ['cell pixel 報告', '\x1b[16t'],
    ['text area 文字数報告', '\x1b[18t'],
    ['title 報告', '\x1b[21t'],
    ['XTSMGRAPHICS', '\x1b[?1;1;0S'],
    ['BEL 終端の前景色問い合わせ', '\x1b]10;?\x07'],
    ['ST 終端の背景色問い合わせ', '\x1b]11;?\x1b\\'],
    ['C1 ST 終端の cursor 色問い合わせ', '\x1b]12;?\x9c'],
    ['連続する dynamic color 問い合わせ', '\x1b]10;?;?\x07'],
    ['indexed color 問い合わせ', '\x1b]4;1;?\x07'],
    ['複数の indexed color 問い合わせ', '\x1b]4;1;?;2;?\x1b\\'],
    ['clipboard 読み取り', '\x1b]52;c;?\x07'],
    ['DECRQSS', '\x1bP$qm\x1b\\'],
    ['空白 intermediate の DECRQSS', '\x1bP$q q\x1b\\'],
    ['XTGETTCAP', '\x1bP+q544e\x1b\\'],
    ['kitty graphics 問い合わせ', '\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\'],
    ['C1 CSI の cursor position report', '\x9b6n'],
    ['C1 OSC の背景色問い合わせ', '\x9d11;?\x07'],
    ['C1 DCS の DECRQSS', '\x90$qm\x9c'],
  ])('%s を周囲の出力を保ったまま除く', (_label, query) => {
    expect(stripTerminalQueries(`before${query}after`)).toBe('beforeafter');
  });

  it('連続した問い合わせと通常出力の混在から問い合わせだけを除く', () => {
    const input =
      '\x1b[?u\x1b[c$ nvim\r\n\x1b[?1049h\x1b]11;?\x07\x1b[?2026$p\x1b[1;1H~\x1bP$q q\x1b\\\x1b[6n';

    expect(stripTerminalQueries(input)).toBe('$ nvim\r\n\x1b[?1049h\x1b[1;1H~');
  });

  it.each([
    ['indexed color の設定を残す', '\x1b]4;1;?;2;rgb:00/00/ff\x07', '\x1b]4;2;rgb:00/00/ff\x07'],
    [
      '後続の dynamic color 設定を番号付きで残す',
      '\x1b]10;?;#000000\x1b\\',
      '\x1b]11;#000000\x1b\\',
    ],
    ['先行の dynamic color 設定を残す', '\x1b]10;#ffffff;?\x07', '\x1b]10;#ffffff\x07'],
    [
      '間の問い合わせを除いて両側の設定を残す',
      '\x1b]10;red;?;blue\x9c',
      '\x1b]10;red\x9c\x1b]12;blue\x9c',
    ],
  ])('設定と問い合わせを含む OSC から %s', (_label, input, expected) => {
    expect(stripTerminalQueries(input)).toBe(expected);
  });

  it.each([
    ['q なし', '\x1b_Gi=1,a=T,f=100;QUJD\x1b\\', '\x1b_Gi=1,a=T,f=100,q=2;QUJD\x1b\\'],
    ['q=1', '\x1b_Gi=1,q=1,a=p\x1b\\', '\x1b_Gi=1,q=1,a=p,q=2\x1b\\'],
    ['control なし', '\x1b_G;QUJD\x1b\\', '\x1b_Gq=2;QUJD\x1b\\'],
  ])('kitty graphics の %s 命令は表示を保ったまま応答を止める', (_label, input, expected) => {
    expect(stripTerminalQueries(input)).toBe(expected);
  });

  it('ST 以外の ESC で閉じた問い合わせは ESC を次の制御列として残す', () => {
    expect(stripTerminalQueries('a\x1b]11;?\x1b[1mb')).toBe('a\x1b[1mb');
    expect(stripTerminalQueries('a\x1bP$qm\x1b[1mb')).toBe('a\x1b[1mb');
  });

  it('末尾の ESC で閉じた問い合わせは後続の `\\` が ST になるよう ESC を残す', () => {
    expect(stripTerminalQueries('a\x1b]11;?\x1b')).toBe('a\x1b');
  });

  it('設定を残す OSC が ST 以外の ESC で閉じる場合は置換列を自身の ST で閉じる', () => {
    expect(stripTerminalQueries('\x1b]10;red;?\x1b[1m')).toBe('\x1b]10;red\x1b\\\x1b[1m');
  });

  it.each([
    ['CSI', 'abc\x1b[6'],
    ['prefix 付き CSI', 'abc\x1b[?'],
    ['OSC', 'abc\x1b]11;?'],
    ['DCS', 'abc\x1bP$q'],
    ['APC', 'abc\x1b_Ga=q'],
    ['単独の ESC', 'abc\x1b'],
  ])('末尾で未完了の %s は後続出力と連結できるよう残す', (_label, input) => {
    expect(stripTerminalQueries(input)).toBe(input);
  });

  it.each([
    ['CSI の引数', '6nabc'],
    ['OSC の本体', '11;?\x07abc'],
    ['DCS の本体', '$qm\x1b\\abc'],
    ['ESC 直後の CSI', '[6nabc'],
  ])('scrollback 先頭が %s から始まる場合は xterm.js と同じく平文として残す', (_label, input) => {
    expect(stripTerminalQueries(input)).toBe(input);
  });

  it.each([
    ['CAN で中断した CSI', '\x1b[6\x18n'],
    ['SUB で中断した CSI', '\x1b[6\x1an'],
    ['CAN で中断した OSC', '\x1b]11;?\x18'],
    ['C1 制御で中断した OSC', '\x1b]11;?\x85'],
    ['CAN で中断した DCS', '\x1bP$qm\x18'],
    ['prefix の位置が不正な CSI', '\x1b[6?n'],
    ['intermediate 後に引数を持つ CSI', '\x1b[$6p'],
    ['番号に数字以外を含む OSC', '\x1b]1x;?\x07'],
  ])('xterm.js が応答しない %s は残す', (_label, input) => {
    expect(stripTerminalQueries(input)).toBe(input);
  });

  it('CSI 内で実行される C0 は除去後も残す', () => {
    expect(stripTerminalQueries('a\x1b[6\nnb')).toBe('a\nb');
    expect(stripTerminalQueries('a\x1b\r[cb')).toBe('a\rb');
  });

  it('問い合わせの直前で中断された制御列も合わせて除き、後続の平文を守る', () => {
    expect(stripTerminalQueries('\x1b\x1b[6nabc')).toBe('abc');
    expect(stripTerminalQueries('\x1b[1;\x1b[6nabc')).toBe('abc');
    expect(stripTerminalQueries('\x1b]0;tit\x9b6nabc')).toBe('abc');
  });

  it('ESC で閉じた OSC の直後の問い合わせは OSC を ST で閉じ直して除く', () => {
    expect(stripTerminalQueries('\x1b]0;title\x1b[6nabc')).toBe('\x1b]0;title\x1b\\abc');
  });

  it('OSC 本体に混在する無視対象の C0 を xterm.js と同じく読み飛ばす', () => {
    expect(stripTerminalQueries('a\x1b]1\x0e1;\x0e?\x07b')).toBe('ab');
  });

  it('64 KB の再生出力から全ての問い合わせを除く', () => {
    const unit = `${'x'.repeat(100)}\x1b[1m\x1b[6n\x1b]11;?\x07\x1b[0m\r\n`;
    const kept = `${'x'.repeat(100)}\x1b[1m\x1b[0m\r\n`;
    const count = Math.ceil((64 * 1024) / unit.length);

    expect(stripTerminalQueries(unit.repeat(count))).toBe(kept.repeat(count));
  });
});
