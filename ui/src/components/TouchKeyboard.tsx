import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  backspace,
  charFor,
  separatorFor,
  insert,
  layoutFor,
  rowsFor,
  type EditState,
  type Key,
  type KeyboardLayout,
} from '../utils/touchKeyboard';

/**
 * The on-screen keyboard.
 *
 * There is no physical keyboard on a kiosk, so this is the only way anything
 * gets typed: the broker URL and API token in the wizard, calibration factors,
 * a geology description, a comment.
 *
 * **It is a flex child of the app shell, not an overlay.** Rendered between
 * `main` and the recording bar, it takes its height out of `main` — which is
 * `flex: 1` — so the layout shrinks instead of the keyboard covering it, and
 * the recording bar stays where the worker expects it. An overlay would hide
 * the bar, and with it the depth and the stop button, while somebody typed.
 *
 * It attaches by listening for focus on the document rather than by wrapping
 * every input, so a field added later gets a keyboard without anybody
 * remembering to wire one up. The layout follows what the markup already
 * declares (`type`, `inputMode`).
 *
 * **A full-viewport overlay holding an input must end at
 * `var(--keyboard-inset, 0)`**, which this publishes on `:root` while open.
 * Shrinking out of the shell's flex column does nothing for an overlay that is
 * `position: fixed; inset: 0` — GeologiePicker, whose search field is the one
 * place a worker types mid-drilling. Without it the keyboard sits under the
 * overlay: invisible, with the field it belongs to focused.
 *
 * The inset is the distance from the bottom of the viewport to the top of the
 * keyboard, **not** the keyboard's height: the keyboard sits above the
 * recording bar, so reserving its height alone leaves an overlay overlapping
 * it by the bar's 76px. Measured, so a route without the bar is right too.
 */

type Typable = HTMLInputElement | HTMLTextAreaElement;

/** Types that open their own control or hold no text. */
const UNTYPABLE = new Set([
  'file', 'checkbox', 'radio', 'submit', 'button', 'reset', 'range', 'color', 'hidden', 'image',
]);

function isTypable(node: EventTarget | null): node is Typable {
  if (!(node instanceof HTMLElement)) return false;
  if (node.tagName === 'TEXTAREA') {
    const el = node as HTMLTextAreaElement;
    return !el.readOnly && !el.disabled;
  }
  if (node.tagName !== 'INPUT') return false;
  const el = node as HTMLInputElement;
  return !el.readOnly && !el.disabled && !UNTYPABLE.has((el.type || 'text').toLowerCase());
}

/**
 * `<input type="number">` exposes no selection — Chromium answers null and
 * Firefox throws — so editing there happens at the end of the value. That is
 * also where a caret would be after tapping into a short numeric field.
 */
function readState(el: Typable): EditState {
  const value = el.value ?? '';
  try {
    if (el.selectionStart !== null && el.selectionStart !== undefined) {
      return { value, start: el.selectionStart, end: el.selectionEnd ?? el.selectionStart };
    }
  } catch {
    /* no selection support on this input type */
  }
  return { value, start: value.length, end: value.length };
}

/**
 * React tracks an input's value on the DOM node, so assigning `el.value`
 * directly is swallowed on the next render. Going through the prototype's
 * setter and dispatching a bubbling `input` event is what makes a controlled
 * component see the change.
 */
function writeState(el: Typable, next: EditState): void {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, next.value);
  else el.value = next.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  try {
    el.setSelectionRange(next.start, next.end);
  } catch {
    /* see readState */
  }
}

/**
 * On a touchscreen by default, off on a development machine with a real
 * keyboard. `any-pointer: coarse` rather than `pointer: coarse` so a mouse
 * plugged in by a service tech does not take the keyboard away from the
 * touchscreen. `localStorage.touchKeyboard = 'on' | 'off'` overrides it, which
 * is how this gets exercised in development.
 */
function keyboardEnabled(): boolean {
  try {
    const forced = localStorage.getItem('touchKeyboard');
    if (forced === 'on') return true;
    if (forced === 'off') return false;
  } catch {
    /* storage can be unavailable; fall through to the pointer test */
  }
  return window.matchMedia?.('(any-pointer: coarse)').matches ?? false;
}

export function TouchKeyboard() {
  const enabled = useMemo(keyboardEnabled, []);
  const [target, setTarget] = useState<Typable | null>(null);
  const [layout, setLayout] = useState<KeyboardLayout>('text');
  const [shift, setShift] = useState(false);
  const targetRef = useRef<Typable | null>(null);
  targetRef.current = target;
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const onFocusIn = (e: FocusEvent) => {
      if (!isTypable(e.target)) return;
      const el = e.target;
      setTarget(el);
      setLayout(layoutFor({ type: el.getAttribute('type'), inputMode: el.getAttribute('inputmode'), tagName: el.tagName }));
      setShift(false);
    };
    // Every key cancels its own pointerdown, so focus never leaves the field
    // while typing — this only fires when focus genuinely goes elsewhere.
    const onFocusOut = () => setTarget(null);
    // Hash routing: leaving the screen must take the keyboard with it, or it
    // stays open over the next one, bound to an input that no longer exists.
    const onNavigate = () => setTarget(null);

    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    window.addEventListener('hashchange', onNavigate);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      window.removeEventListener('hashchange', onNavigate);
    };
  }, [enabled]);

  /**
   * Publish the band overlays must keep clear. Measured after layout rather
   * than derived from the row count, so neither a different keyboard layout nor
   * a route that hides the recording bar can leave an overlay reserving the
   * wrong amount.
   */
  useEffect(() => {
    const root = document.documentElement;
    if (!target || !panelRef.current) {
      root.style.removeProperty('--keyboard-inset');
      return;
    }
    const top = panelRef.current.getBoundingClientRect().top;
    root.style.setProperty('--keyboard-inset', `${Math.max(0, window.innerHeight - top)}px`);
    return () => {
      root.style.removeProperty('--keyboard-inset');
    };
  }, [target, layout]);

  // `main` just lost a third of its height, so the field may be out of sight.
  useEffect(() => {
    if (!target) return;
    const frame = requestAnimationFrame(() => {
      if (!target.isConnected) {
        setTarget(null);
        return;
      }
      target.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [target]);

  const press = useCallback(
    (key: Key) => {
      const el = targetRef.current;
      if (!el || !el.isConnected) {
        setTarget(null);
        return;
      }
      if (key.kind === 'done') {
        el.blur();
        setTarget(null);
        return;
      }
      if (key.kind === 'shift') {
        setShift((s) => !s);
        return;
      }
      if (key.kind === 'layout') {
        setLayout(key.to);
        return;
      }
      if (key.kind === 'backspace') {
        writeState(el, backspace(readState(el)));
        return;
      }
      const char = charFor(key, shift);
      if (char === null) return;
      writeState(el, insert(readState(el), char));
      if (shift) setShift(false); // one-shot, like every touch keyboard
    },
    [shift],
  );

  if (!enabled || !target) return null;

  const separator = separatorFor({ type: target.getAttribute('type'), inputMode: target.getAttribute('inputmode') });
  const rows = rowsFor(layout, separator);

  return (
    <div
      ref={panelRef}
      style={{ ...styles.panel, ...(layout === 'numpad' ? styles.panelNumpad : null) }}
      // The panel is furniture, not content: nothing in it is reachable by tab
      // and nothing in it may take focus away from the field being typed into.
      aria-label="Bildschirmtastatur"
    >
      {rows.map((row, i) => (
        <div key={i} style={styles.row}>
          {row.map((key, j) => (
            <KeyButton key={j} entry={key} shift={shift} onPress={press} />
          ))}
        </div>
      ))}
    </div>
  );
}

function KeyButton({ entry, shift, onPress }: { entry: Key; shift: boolean; onPress: (k: Key) => void }) {
  const label = labelFor(entry, shift);
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={ariaLabel(entry)}
      // pointerdown, and cancelled: `preventDefault` keeps the focus (and the
      // caret) in the field, and because nothing listens for `click` there is
      // no compatibility click afterwards to land on whatever key took this
      // one's place when the layout switched.
      onPointerDown={(e) => {
        e.preventDefault();
        onPress(entry);
      }}
      style={{
        ...styles.key,
        flex: entry.flex ?? 1,
        ...(entry.kind === 'done' ? styles.keyDone : null),
        ...(entry.kind === 'backspace' ? styles.keyModifier : null),
        ...(entry.kind === 'layout' ? styles.keyModifier : null),
        ...(entry.kind === 'shift' ? (shift ? styles.keyShiftActive : styles.keyModifier) : null),
        ...(label.length > 2 ? styles.keyWordLabel : null),
      }}
    >
      {label}
    </button>
  );
}

function labelFor(entry: Key, shift: boolean): string {
  switch (entry.kind) {
    case 'char':
      return shift ? entry.shifted ?? entry.label.toUpperCase() : entry.label;
    case 'space':
      return 'Leerzeichen';
    case 'backspace':
      return '⌫';
    case 'shift':
      return '⇧';
    case 'layout':
      return entry.label;
    case 'done':
      return 'Fertig';
  }
}

function ariaLabel(entry: Key): string | undefined {
  switch (entry.kind) {
    case 'backspace':
      return 'Löschen';
    case 'shift':
      return 'Großschreibung';
    case 'space':
      return 'Leerzeichen';
    default:
      return undefined;
  }
}

const styles: Record<string, CSSProperties> = {
  panel: {
    flexShrink: 0,
    // Above the full-viewport overlays (GeologiePicker is 500), so an overlay
    // that has not opted into --keyboard-height still leaves the keys usable
    // rather than burying them.
    position: 'relative',
    zIndex: 600,
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-sm)',
    padding: '0.75rem var(--space-md)',
    backgroundColor: 'var(--surface-0)',
    borderTop: '2px solid var(--border)',
    boxSizing: 'border-box',
  },
  // A numpad spread over 1024px would put the digits a hand-span apart.
  panelNumpad: {
    maxWidth: '560px',
    width: '100%',
    marginLeft: 'auto',
    marginRight: 'auto',
    borderLeft: '2px solid var(--border)',
    borderRight: '2px solid var(--border)',
  },
  row: {
    display: 'flex',
    gap: 'var(--space-sm)',
  },
  key: {
    minHeight: 'var(--tap-min)',
    minWidth: 0,
    padding: 0,
    fontSize: 'var(--font-md)',
    fontWeight: 700,
    fontFamily: 'inherit',
    color: 'var(--text-primary)',
    backgroundColor: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
    // No double-tap zoom, no text selection dragged out of a key by a glove.
    touchAction: 'manipulation',
    userSelect: 'none',
  },
  keyWordLabel: {
    fontSize: 'var(--font-base)',
  },
  keyModifier: {
    backgroundColor: 'var(--surface-3)',
    color: 'var(--text-secondary)',
  },
  keyShiftActive: {
    backgroundColor: 'var(--color-accent)',
    color: '#fff',
    borderColor: 'var(--color-accent)',
  },
  keyDone: {
    backgroundColor: 'var(--color-accent)',
    color: '#fff',
    borderColor: 'var(--color-accent)',
  },
};
