const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;
const DEL = 0x7f;
const BACKSLASH = 0x5c;
const C1_FIRST = 0x80;
const C1_DCS = 0x90;
const C1_SOS = 0x98;
const C1_CSI = 0x9b;
const C1_ST = 0x9c;
const C1_OSC = 0x9d;
const C1_PM = 0x9e;
const C1_APC = 0x9f;
const NON_ASCII = 0xa0;

const ST = '\x1b\\';

/** 応答を返す CSI t の window 状態報告 */
const WINDOW_REPORTS: ReadonlySet<number> = new Set([11, 13, 14, 15, 16, 18, 19, 20, 21]);
/** xterm.js が受け付ける indexed color の上限 */
const MAX_COLOR_INDEX = 255;
/** OSC 10 から連番で積み上がる dynamic color の最終番号 */
const LAST_DYNAMIC_COLOR = 19;

/** xterm.js の VT500 遷移表の状態 */
type Phase =
  | 'ground'
  | 'escape'
  | 'escape-intermediate'
  | 'csi-entry'
  | 'csi-param'
  | 'csi-intermediate'
  | 'csi-ignore'
  | 'osc-string'
  | 'dcs-entry'
  | 'dcs-param'
  | 'dcs-intermediate'
  | 'dcs-ignore'
  | 'dcs-passthrough'
  | 'sos-pm-string'
  | 'apc-entry'
  | 'apc-intermediate'
  | 'apc-passthrough';

/** 文字列制御列の種別 */
type StringKind = 'osc' | 'dcs' | 'apc';

/**
 * 遷移表の EXECUTABLES (CAN、SUB、ESC を除く C0) の判定
 * @param code - 文字コード
 * @returns EXECUTABLES なら true
 */
const isExecutable = (code: number): boolean =>
  code <= 0x17 || code === 0x19 || (code >= 0x1c && code <= 0x1f);

/**
 * 文字列制御列内で xterm.js が読み飛ばす C0 の除去
 * @param value - 文字列制御列の本体
 * @returns C0 を除いた本体
 */
const withoutC0 = (value: string): string =>
  value
    .split('')
    .filter((character) => character >= ' ')
    .join('');

/**
 * CSI 数値引数列の先頭引数
 * @param params - `;` と `:` を含む数値引数列
 * @returns 先頭引数。省略時は 0
 */
const firstParam = (params: string): number => Number(/^\d*/.exec(params)?.[0] || 0);

/**
 * 応答を返す CSI 問い合わせの判定
 * @param collect - prefix と intermediate の連結
 * @param params - 数値引数列
 * @param final - 終端文字
 * @returns DA、DSR、DECRQM、XTVERSION、kitty keyboard、window 報告、XTSMGRAPHICS なら true
 */
const isCsiQuery = (collect: string, params: string, final: string): boolean => {
  switch (final) {
    case 'c':
      return collect === '' || collect === '>' || collect === '=';
    case 'n':
      return collect === '' || collect === '?';
    case 'p':
      return collect === '$' || collect === '?$';
    case 'q':
      return collect === '>';
    case 'u':
    case 'S':
      return collect === '?';
    case 't':
      return collect === '' && WINDOW_REPORTS.has(firstParam(params));
    default:
      return false;
  }
};

/**
 * OSC 4 から色問い合わせを除いた置換列
 * @param args - `4;` 以降の index と色指定の組
 * @param terminator - 置換列の終端
 * @returns 置換列。問い合わせを含まなければ undefined
 */
const indexedColorReplacement = (args: string, terminator: string): string | undefined => {
  const slots = args.split(';');
  const kept: string[] = [];
  let queried = false;
  for (let slot = 0; slot + 1 < slots.length; slot += 2) {
    const color = slots[slot]!;
    const spec = slots[slot + 1]!;
    if (spec === '?' && /^\d+$/.test(color) && Number(color) <= MAX_COLOR_INDEX) {
      queried = true;
    } else {
      kept.push(color, spec);
    }
  }
  if (!queried) return undefined;
  return kept.length === 0 ? '' : `\x1b]4;${kept.join(';')}${terminator}`;
};

/**
 * OSC 10 以降から dynamic color 問い合わせを除いた置換列
 * @param id - 先頭の OSC 番号
 * @param args - 番号以降の色指定列
 * @param terminator - 置換列の終端
 * @returns 設定だけを番号付きで並べた置換列。問い合わせを含まなければ undefined
 */
const dynamicColorReplacement = (
  id: number,
  args: string,
  terminator: string,
): string | undefined => {
  const slots = args.split(';');
  const sets: string[] = [];
  let queried = false;
  for (let offset = 0; offset < slots.length && id + offset <= LAST_DYNAMIC_COLOR; offset += 1) {
    const spec = slots[offset]!;
    if (spec === '?') {
      queried = true;
    } else {
      sets.push(`\x1b]${id + offset};${spec}${terminator}`);
    }
  }
  return queried ? sets.join('') : undefined;
};

/**
 * OSC から問い合わせを除いた置換列
 * @param payload - xterm.js が無視する C0 を除いた OSC 本体
 * @param terminator - 置換列の終端
 * @returns 色と clipboard の問い合わせを除いた置換列。問い合わせでなければ undefined
 */
const oscReplacement = (payload: string, terminator: string): string | undefined => {
  const separator = payload.indexOf(';');
  const idText = separator < 0 ? payload : payload.slice(0, separator);
  if (!/^\d+$/.test(idText)) return undefined;
  const id = Number(idText);
  const args = separator < 0 ? '' : payload.slice(separator + 1);
  if (id === 4) return indexedColorReplacement(args, terminator);
  if (id >= 10 && id <= LAST_DYNAMIC_COLOR) return dynamicColorReplacement(id, args, terminator);
  if (id === 52) return args.split(';')[1] === '?' ? '' : undefined;
  return undefined;
};

/**
 * kitty graphics から応答を除いた置換列
 * @param raw - `G` 以降の APC 本体
 * @param terminator - 置換列の終端
 * @returns 問い合わせは空文字、応答し得る命令は `q=2` を末尾に足した列。応答しなければ undefined
 */
const kittyGraphicsReplacement = (raw: string, terminator: string): string | undefined => {
  const separator = raw.indexOf(';');
  const controlEnd = separator < 0 ? raw.length : separator;
  const control = withoutC0(raw.slice(0, controlEnd));
  const keys = new Map<string, string>();
  for (const entry of control.split(',')) {
    const equals = entry.indexOf('=');
    if (equals > 0) keys.set(entry.slice(0, equals), entry.slice(equals + 1));
  }
  if (keys.get('a') === 'q') return '';
  if (Number(keys.get('q') ?? 0) >= 2) return undefined;
  // 重複 key は後勝ちのため、末尾の q=2 が既存の q を上書きする
  const quiet = control === '' ? 'q=2' : ',q=2';
  return `\x1b_G${raw.slice(0, controlEnd)}${quiet}${raw.slice(controlEnd)}${terminator}`;
};

/**
 * 正常終端した文字列制御列の置換列
 * @param kind - 文字列制御列の種別
 * @param ident - DCS と APC の prefix、intermediate、識別文字の連結
 * @param raw - 本体の生文字列
 * @param terminator - 置換列の終端
 * @returns 問い合わせを除いた置換列。問い合わせでなければ undefined
 */
const stringReplacement = (
  kind: StringKind,
  ident: string,
  raw: string,
  terminator: string,
): string | undefined => {
  switch (kind) {
    case 'osc':
      return oscReplacement(withoutC0(raw), terminator);
    case 'dcs':
      return ident === '$q' || ident === '+q' ? '' : undefined;
    case 'apc':
      return ident === 'G' ? kittyGraphicsReplacement(raw, terminator) : undefined;
  }
};

/**
 * 再生出力からの端末問い合わせの除去
 *
 * 表示面へ届け済みの出力を新しい xterm.js へ再生すると、DA や DSR などの問い合わせへ再び応答し、
 * その応答がシェルへの入力になる。xterm.js の VT500 遷移表と同じ区切りで制御列を読み、
 * 応答を返す問い合わせだけを除く。それ以外の文字列は変更せず、末尾の未完了制御列も後続出力と
 * 連結されるため残す。先頭が制御列の途中から始まる場合も xterm.js と同じく ground 状態から読む。
 * @param data - 再生する出力
 * @returns 問い合わせを除いた出力。除去対象がなければ入力そのもの
 */
export const stripTerminalQueries = (data: string): string => {
  const parts: string[] = [];
  let keptFrom = 0;
  // enter と finishString からも更新するため、宣言時の literal へ絞り込ませない
  let phase = 'ground' as Phase;
  /** ground を離れた位置。中断された制御列が続く間は最初の位置を保つ */
  let chainStart = 0;
  /** chain 内で xterm.js が実行した C0。除去後も効果を残すため再出力する */
  let executed = '';
  /** chain 先頭の ESC が直前の文字列制御列の終端を兼ねるか */
  let terminatesString = false;
  let collect = '';
  let params = '';
  let ident = '';
  let bodyStart = 0;

  const enter = (index: number, next: Phase): void => {
    if (phase === 'ground') {
      chainStart = index;
      executed = '';
      terminatesString = false;
    }
    collect = '';
    params = '';
    phase = next;
  };

  const replaceChain = (end: number, replacement: string): void => {
    parts.push(data.slice(keptFrom, chainStart), terminatesString ? ST : '', executed, replacement);
    keptFrom = end;
  };

  /**
   * 文字列制御列の正常終端
   * @param kind - 文字列制御列の種別
   * @param index - 終端文字の位置
   * @param code - 終端文字
   * @returns 読み終えた位置
   */
  const finishString = (kind: StringKind, index: number, code: number): number => {
    const terminator = code === BEL ? '\x07' : code === C1_ST ? '\x9c' : ST;
    const replacement = stringReplacement(kind, ident, data.slice(bodyStart, index), terminator);
    phase = 'ground';
    if (replacement === undefined) {
      if (code === ESC) {
        enter(index, 'escape');
        terminatesString = true;
      }
      return index;
    }
    if (code !== ESC) {
      replaceChain(index + 1, replacement);
      return index;
    }
    if (data.charCodeAt(index + 1) === BACKSLASH) {
      replaceChain(index + 2, replacement);
      return index + 1;
    }
    // ST 以外の ESC は次の制御列の開始として残し、置換列は自身の ST で閉じる
    replaceChain(index, replacement);
    enter(index, 'escape');
    return index;
  };

  for (let index = 0; index < data.length; index += 1) {
    const code = data.charCodeAt(index);
    if (phase === 'ground' && code !== ESC && (code < C1_FIRST || code > C1_APC)) continue;

    if (code === ESC || code === C1_ST) {
      if (phase === 'osc-string') index = finishString('osc', index, code);
      else if (phase === 'dcs-passthrough') index = finishString('dcs', index, code);
      else if (phase === 'apc-passthrough') index = finishString('apc', index, code);
      else if (code === ESC) enter(index, 'escape');
      else phase = 'ground';
      continue;
    }
    if (code === CAN || code === SUB) {
      phase = 'ground';
      continue;
    }
    if (code >= C1_FIRST && code < NON_ASCII) {
      if (code === C1_CSI) enter(index, 'csi-entry');
      else if (code === C1_DCS) enter(index, 'dcs-entry');
      else if (code === C1_SOS || code === C1_PM) enter(index, 'sos-pm-string');
      else if (code === C1_APC) enter(index, 'apc-entry');
      else if (code === C1_OSC) {
        enter(index, 'osc-string');
        bodyStart = index + 1;
      } else phase = 'ground';
      continue;
    }

    const character = data[index]!;
    switch (phase) {
      case 'escape':
        if (isExecutable(code)) executed += character;
        else if (code === DEL) break;
        else if (code >= 0x20 && code <= 0x2f) phase = 'escape-intermediate';
        else if (character === '[') enter(index, 'csi-entry');
        else if (character === ']') {
          enter(index, 'osc-string');
          bodyStart = index + 1;
        } else if (character === 'P') enter(index, 'dcs-entry');
        else if (character === 'X' || character === '^') enter(index, 'sos-pm-string');
        else if (character === '_') enter(index, 'apc-entry');
        else phase = 'ground';
        break;
      case 'escape-intermediate':
        if (isExecutable(code)) executed += character;
        else if (code !== DEL && (code < 0x20 || code > 0x2f)) phase = 'ground';
        break;
      case 'csi-entry':
      case 'csi-param':
      case 'csi-intermediate':
        if (isExecutable(code)) executed += character;
        else if (code === DEL) break;
        else if (code >= NON_ASCII) phase = 'ground';
        else if (code >= 0x40) {
          if (isCsiQuery(collect, params, character)) replaceChain(index + 1, '');
          phase = 'ground';
        } else if (code <= 0x2f) {
          collect += character;
          phase = 'csi-intermediate';
        } else if (phase === 'csi-intermediate') phase = 'csi-ignore';
        else if (code <= 0x3b) {
          params += character;
          phase = 'csi-param';
        } else if (phase === 'csi-entry') {
          collect += character;
          phase = 'csi-param';
        } else phase = 'csi-ignore';
        break;
      case 'csi-ignore':
        if (isExecutable(code)) executed += character;
        else if (code >= 0x40 && code <= 0x7e) phase = 'ground';
        break;
      case 'osc-string':
        if (code === BEL) index = finishString('osc', index, code);
        break;
      case 'dcs-entry':
      case 'dcs-param':
      case 'dcs-intermediate':
        if (isExecutable(code) || code === DEL) break;
        else if (code >= NON_ASCII) phase = 'ground';
        else if (code >= 0x40) {
          ident = collect + character;
          bodyStart = index + 1;
          phase = 'dcs-passthrough';
        } else if (code <= 0x2f) {
          collect += character;
          phase = 'dcs-intermediate';
        } else if (phase === 'dcs-intermediate') phase = 'dcs-ignore';
        else if (code <= 0x3b) phase = 'dcs-param';
        else if (phase === 'dcs-entry') {
          collect += character;
          phase = 'dcs-param';
        } else phase = 'dcs-ignore';
        break;
      case 'sos-pm-string':
        if (code >= NON_ASCII) phase = 'ground';
        break;
      case 'apc-entry':
      case 'apc-intermediate':
        if (isExecutable(code) || code === DEL) break;
        else if (code >= NON_ASCII) phase = 'ground';
        else if (code <= 0x2f) {
          collect += character;
          phase = 'apc-intermediate';
        } else {
          ident = collect + character;
          bodyStart = index + 1;
          phase = 'apc-passthrough';
        }
        break;
      case 'ground':
      case 'dcs-ignore':
      case 'dcs-passthrough':
      case 'apc-passthrough':
        break;
    }
  }

  if (keptFrom === 0) return data;
  parts.push(data.slice(keptFrom));
  return parts.join('');
};
