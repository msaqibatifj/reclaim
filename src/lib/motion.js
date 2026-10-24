/**
 * Motion (DESIGN.md §5). Small, quick, and never in the way.
 *
 *  - Nothing here ever blocks input; content is usable while it animates.
 *  - Windows "Animation effects" (prefers-reduced-motion) turns all of it off.
 */
import { animate, stagger } from 'animejs';

export const DUR = { quick: 160, move: 320 };

const reducedQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
export const isOff = () => !!reducedQuery?.matches;

/** Tween a plain number. Calls onUpdate(value) each frame; returns a cancel function. */
export function tween(from, to, { duration = DUR.move, ease = 'outQuint', onUpdate, onComplete } = {}) {
  if (isOff() || from === to || duration <= 0) {
    onUpdate?.(to);
    onComplete?.();
    return () => {};
  }
  const o = { v: from };
  const a = animate(o, {
    v: to,
    duration,
    ease,
    onUpdate: () => onUpdate?.(o.v),
    onComplete: () => {
      onUpdate?.(to);
      onComplete?.();
    },
  });
  return () => a.cancel();
}

/** New rows fade in. Only the first rows animate; the rest are instant. */
export function fadeRows(rows) {
  const list = [...rows].filter((r) => r && !r.hasAttribute('data-shown'));
  list.forEach((r) => r.setAttribute('data-shown', ''));
  if (isOff() || !list.length) return;
  animate(list.slice(0, 24), { opacity: [0, 1], duration: DUR.quick, ease: 'outQuad', delay: stagger(15) });
}
