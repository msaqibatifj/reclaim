import React, { createContext, useContext, useEffect, useRef } from 'react';
import { bytes } from '../lib/format.js';
import { DUR, isOff, tween } from '../lib/motion.js';

/* ------------------------------------------------------------------ */
/* View context: is this view the visible one? (views stay mounted)     */

export const ViewCtx = createContext({ active: true, id: '' });
export const useView = () => useContext(ViewCtx);

/** Window keydown listener that only fires while this view is visible. */
export function useViewKeys(handler) {
  const { active } = useView();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return undefined;
    const k = (e) => ref.current(e);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [active]);
}

/* ------------------------------------------------------------------ */
/* Layout                                                                */

export function Page({ title, sub, children }) {
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">{title}</h1>
        {sub && <div className="page-sub">{sub}</div>}
      </div>
      {children}
    </div>
  );
}

export function Card({ title, meta, children, className = '', ...rest }) {
  return (
    <section className={`card ${className}`} {...rest}>
      {title && (
        <div className="card-head">
          <h2>{title}</h2>
          {meta != null && meta !== '' && <span className="meta">{meta}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

/** A one-line message: tone is info | error | success | warn. */
export function Notice({ tone = 'info', children, actions }) {
  return (
    <div className={`notice ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span className="grow">{children}</span>
      {actions}
    </div>
  );
}

export function Button({ variant = '', small, className = '', children, ...rest }) {
  return (
    <button type="button" className={`btn ${variant} ${small ? 'small' : ''} ${className}`} {...rest}>
      {children}
    </button>
  );
}

export function Box({ checked, onChange, disabled, label }) {
  return (
    <input
      type="checkbox"
      className="box"
      checked={!!checked}
      disabled={disabled}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      aria-label={label}
    />
  );
}

/** Sticky footer for a list: what is selected and the next step. */
export function ActionBar({ summary, children }) {
  return (
    <div className="action-bar">
      <span className="summary">{summary}</span>
      <span className="spacer" />
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Numbers                                                               */

/** A number that rolls to its new value. Text is written directly to avoid re-renders per frame. */
export function Num({ value, format = bytes, className = '' }) {
  const ref = useRef(null);
  const prev = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || value == null) {
      if (el) el.textContent = format(value);
      return undefined;
    }
    const from = prev.current ?? value;
    prev.current = value;
    return tween(from, value, { onUpdate: (v) => (el.textContent = format(v)) });
  }, [value, format]);
  return <span ref={ref} className={className}>{format(value)}</span>;
}

/* ------------------------------------------------------------------ */
/* Drive bar                                                             */

/**
 * Used space in grey; the part a cleanup would free in green, taken off the right edge
 * of used space; the rest is free.
 */
export function DriveBar({ drive, freeing = 0 }) {
  const usedRef = useRef(null);
  const freeRef = useRef(null);
  const state = useRef(null);
  const used = Math.max(0, drive.size - drive.free);
  const f = Math.min(freeing, used);

  useEffect(() => {
    const paint = (u, p) => {
      if (!usedRef.current || !freeRef.current || !drive.size) return;
      const up = (u / drive.size) * 100;
      const pp = (p / drive.size) * 100;
      usedRef.current.style.width = `${up - pp}%`;
      freeRef.current.style.left = `${up - pp}%`;
      freeRef.current.style.width = `${pp}%`;
    };
    const from = state.current;
    state.current = { u: used, p: f };
    if (!from || isOff()) return paint(used, f);
    return tween(0, 1, { duration: DUR.move, ease: 'inOutQuart', onUpdate: (t) => paint(from.u + (used - from.u) * t, from.p + (f - from.p) * t) });
  }, [used, f, drive.size]);

  return (
    <div
      className="drive-bar"
      role="img"
      aria-label={`${drive.letter} ${bytes(used)} used of ${bytes(drive.size)}${f ? `, ${bytes(f)} selected to free` : ''}, ${bytes(drive.free)} free`}
    >
      <div className="drive-used" ref={usedRef} />
      <div className="drive-freed" ref={freeRef} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Safety levels                                                         */

export const GRADE = {
  A: { tag: 'Safe', cls: 'safe', explain: 'Safe to remove. It is rebuilt automatically when needed.' },
  B: { tag: 'Re-downloads', cls: 'info', explain: 'Safe to remove. It is downloaded or rebuilt again the next time it is needed, which can take a while.' },
  C: { tag: 'Check first', cls: 'check', explain: 'These are your files. Only remove them if you are sure you don’t need them.' },
};

export function GradeTag({ grade }) {
  const g = GRADE[grade] || GRADE.B;
  return <span className={`tag ${g.cls}`} title={g.explain}>{g.tag}</span>;
}
