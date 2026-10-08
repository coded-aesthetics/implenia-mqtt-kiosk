import { useCallback, useState } from 'react';

/**
 * Ignore the tail of the gesture that opened this surface.
 *
 * A touchscreen dispatches a compatibility `click` after `touchend`, and it
 * hit-tests the DOM *as it is then* — not as it was when the finger went
 * down. So a surface that appears in the space the finger just tapped
 * receives that click as if the operator had chosen something.
 *
 * On the geology sign-off screen that was not cosmetic. Arming `+ Hindernis`
 * and tapping a depth swaps the profile column for the obstruction picker,
 * and the ghost click then picked whichever tile had landed under the finger:
 * a tap at 250px recorded `Hindernis Stahl`, at 330px `Beton`, at 420px
 * `Holz`. The operator never saw the picker — the layer was simply inserted
 * with a ground type chosen by how high up the profile they had pointed, and
 * the screen moved on as though they had picked it.
 *
 * The rule is the one the din4023 package already applies to tap-versus-drag:
 * **a control acts on a gesture that began on it.** A press that starts here
 * arms the surface; a click arriving without one is the previous gesture
 * finishing and is dropped.
 *
 * Keyboard clicks carry `detail === 0` and are let through — they have no
 * pointer gesture to begin with, and a kiosk being driven by a plugged-in
 * keyboard during service should still work.
 */
export function useGestenSperre() {
  const [eigeneGeste, setEigeneGeste] = useState(false);

  /** Spread onto the surface's container. */
  const sperrProps = {
    onPointerDown: useCallback(() => setEigeneGeste(true), []),
  };

  /**
   * True when this click belongs to a gesture that started here — or to no
   * gesture at all, which is what a keyboard produces.
   */
  const darfHandeln = useCallback(
    (e: { detail: number }) => eigeneGeste || e.detail === 0,
    [eigeneGeste],
  );

  return { sperrProps, darfHandeln };
}
