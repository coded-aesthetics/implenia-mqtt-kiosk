/**
 * The on-screen keyboard's layouts and editing rules.
 *
 * Pure on purpose: the component around it is a grid of buttons, and
 * everything that could silently corrupt what a worker typed — where the caret
 * lands, which decimal separator goes in, which layout a field gets — is
 * decided here and unit-tested.
 *
 * There is no physical keyboard on a kiosk. Every value a worker or a service
 * tech enters (MQTT broker, API token, calibration factors, geology
 * descriptions, comments) comes through this.
 */

export type KeyboardLayout = 'text' | 'symbols' | 'numpad';

/** The slice of an input the keyboard edits. */
export interface EditState {
  value: string;
  start: number;
  end: number;
}

export type Key =
  | { kind: 'char'; label: string; shifted?: string; flex?: number }
  | { kind: 'space'; flex?: number }
  | { kind: 'backspace'; flex?: number }
  | { kind: 'shift'; flex?: number }
  | { kind: 'layout'; to: KeyboardLayout; label: string; flex?: number }
  | { kind: 'done'; flex?: number };

const c = (label: string, shifted?: string): Key => ({ kind: 'char', label, shifted });

/** German QWERTZ. Umlauts sit in the letter rows, not behind a modifier. */
export const TEXT_ROWS: Key[][] = [
  ['q', 'w', 'e', 'r', 't', 'z', 'u', 'i', 'o', 'p', 'ü'].map((k) => c(k)),
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'ö', 'ä'].map((k) => c(k)),
  [
    { kind: 'shift', flex: 1.5 },
    ...['y', 'x', 'c', 'v', 'b', 'n', 'm'].map((k) => c(k)),
    c('ß', 'ß'),
    c('-', '_'),
    { kind: 'backspace', flex: 1.5 },
  ],
  [
    { kind: 'layout', to: 'symbols', label: '123', flex: 1.5 },
    c(','),
    { kind: 'space', flex: 5 },
    c('.'),
    { kind: 'done', flex: 2 },
  ],
];

/**
 * Digits and the punctuation the configuration screens need: an MQTT broker is
 * `mqtt://192.168.2.1:1883` and an API base URL is not typable without `:` and
 * `/`.
 */
export const SYMBOL_ROWS: Key[][] = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((k) => c(k)),
  [':', '/', '.', '-', '_', '@', '#', '+', '%', '&'].map((k) => c(k)),
  [
    ...['(', ')', '?', '!', '"', "'", '=', '*', ';', ','].map((k) => c(k)),
    { kind: 'backspace', flex: 1.5 },
  ],
  [
    { kind: 'layout', to: 'text', label: 'ABC', flex: 1.5 },
    { kind: 'space', flex: 5 },
    { kind: 'done', flex: 2 },
  ],
];

/**
 * `-` is on it because a calibration offset is routinely negative, and a worker
 * who cannot type a minus sign has no way to enter one.
 *
 * `separator === null` gives a digits-only pad, which is what an
 * `<input type="number">` must have — see `separatorFor`.
 */
export function numpadRows(separator: string | null): Key[][] {
  if (separator === null) {
    return [
      [c('7'), c('8'), c('9')],
      [c('4'), c('5'), c('6')],
      [c('1'), c('2'), c('3')],
      [{ kind: 'backspace' }, c('0'), { kind: 'done' }],
    ];
  }
  return [
    [c('7'), c('8'), c('9'), { kind: 'backspace' }],
    [c('4'), c('5'), c('6'), c('-')],
    [c('1'), c('2'), c('3'), c(separator)],
    [{ kind: 'char', label: '0', flex: 2 }, { kind: 'done', flex: 2 }],
  ];
}

export interface TargetAttrs {
  type?: string | null;
  inputMode?: string | null;
  tagName?: string;
}

const NUMERIC_INPUT_MODES = new Set(['decimal', 'numeric', 'tel']);

/**
 * A number field gets digits, everything else gets letters. Deliberately keyed
 * on what the markup already declares — `inputMode="decimal"` on the
 * calibration and Rohrwechsel fields, `type="number"` on the Elvis baud rate —
 * so a new field gets the right keyboard without anybody wiring it up.
 */
export function layoutFor(attrs: TargetAttrs): KeyboardLayout {
  if (attrs.tagName === 'TEXTAREA') return 'text';
  if (attrs.type === 'number') return 'numpad';
  if (attrs.inputMode && NUMERIC_INPUT_MODES.has(attrs.inputMode)) return 'numpad';
  return 'text';
}

/**
 * The decimal separator a field can actually take, or `null` for a field that
 * can take none.
 *
 * German inputs take a comma — `DatenstromDetail.parseNumber` and
 * `RohrwechselSettings` both normalise `,` to `.` before parsing, and a comma
 * is what a number is written with everywhere else in this UI.
 *
 * **`<input type="number">` can take no separator at all**, and a period is not
 * a workaround. The HTML value sanitization algorithm empties the value
 * whenever it is not a valid floating-point number, and the intermediate state
 * of typing a decimal always is one: after "1." the browser answers `el.value`
 * as `""`, so the next digit starts a new number and "1.2" comes out as "2".
 * No amount of care on this side can produce that intermediate.
 *
 * Nothing is lost by it. The only `type="number"` field in this app is the
 * Elvis baud rate, an integer; the fields that really hold decimals declare
 * `inputMode="decimal"` on a text input, where the value is whatever was typed.
 */
export function separatorFor(attrs: TargetAttrs): string | null {
  return attrs.type === 'number' ? null : ',';
}

/** The character a key produces, given the shift state. */
export function charFor(key: Key, shift: boolean): string | null {
  if (key.kind === 'space') return ' ';
  if (key.kind !== 'char') return null;
  if (!shift) return key.label;
  return key.shifted ?? key.label.toUpperCase();
}

/** Insert text over the current selection. */
export function insert(state: EditState, text: string): EditState {
  const value = state.value.slice(0, state.start) + text + state.value.slice(state.end);
  const caret = state.start + text.length;
  return { value, start: caret, end: caret };
}

/**
 * Delete the selection, or the character before the caret. Pressing backspace
 * at position 0 changes nothing — it must not wrap round and eat the last
 * character, which is what a naive `slice(0, -1)` does.
 */
export function backspace(state: EditState): EditState {
  if (state.start !== state.end) {
    const value = state.value.slice(0, state.start) + state.value.slice(state.end);
    return { value, start: state.start, end: state.start };
  }
  if (state.start === 0) return state;
  const value = state.value.slice(0, state.start - 1) + state.value.slice(state.start);
  const caret = state.start - 1;
  return { value, start: caret, end: caret };
}

export function rowsFor(layout: KeyboardLayout, separator: string | null): Key[][] {
  switch (layout) {
    case 'numpad':
      return numpadRows(separator);
    case 'symbols':
      return SYMBOL_ROWS;
    default:
      return TEXT_ROWS;
  }
}
