// Motion for the docs and the landing page, in the way better-auth.com moves: short, quiet, never in the way.
//
// - Between pages: the page's content fades out and the next one rises in (the View Transitions API); the bar and
//   the sidebar stay where they are. Browsers without it get the rise only.
// - Light ↔ dark: a circle grows from the switch (Layout.vue).
// - `v-reveal`: a section rises in the first time it scrolls into view. One already on screen when the page opens
//   is left as it is, so nothing flashes.
// Everyone who asks their system for less motion gets none of it (style.css turns the animations off too).
import { nextTick, type Directive } from 'vue';
import type { Router } from 'vitepress';

export const lessMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
// a hidden tab draws nothing, and the browser cancels a transition there
const canTransition = () => typeof document !== 'undefined' && 'startViewTransition' in document && !document.hidden && !lessMotion();

/** A transition the browser skips (a newer one started, the tab was hidden) rejects its promises: that's expected. */
export const quiet = (t: ViewTransition) => { t.ready.catch(() => {}); t.finished.catch(() => {}); t.updateCallbackDone.catch(() => {}); return t; };

/** Page transitions on the router: the old page is captured before it changes, the new one once Vue has drawn it. */
export function pageTransitions(router: Router) {
  if (typeof window === 'undefined') return;
  let finish: (() => void) | null = null;
  const before = router.onBeforeRouteChange;
  const after = router.onAfterRouteChange;
  router.onBeforeRouteChange = async (to) => {
    if ((await before?.(to)) === false) return false;
    if (!canTransition()) return;
    finish?.();
    const drawn = new Promise<void>((resolve) => { finish = () => { finish = null; resolve(); }; });
    // The router changes the page only once the browser has the old one (it calls back on its next frame), so the
    // old page fades out, not the new one. A page in a hidden tab gets few frames: then it goes ahead after 300ms.
    let captured: () => void = () => {};
    const ready = new Promise<void>((resolve) => { captured = resolve; });
    const t = quiet(document.startViewTransition(() => {
      captured();
      setTimeout(() => finish?.(), 800);       // never hold the page if the change doesn't come
      return drawn;
    }));
    const late = setTimeout(() => t.skipTransition(), 1000);   // a tab the browser isn't drawing never starts it
    void ready.then(() => clearTimeout(late));
    await Promise.race([ready, new Promise((r) => setTimeout(r, 300))]);
  };
  router.onAfterRouteChange = async (to) => {
    await after?.(to);
    await nextTick();
    // not in requestAnimationFrame: the browser draws nothing while a transition waits, so it would never run
    if (finish) finish();
    else if (!lessMotion()) rise();
  };
}

/** Without view transitions: the content rises in. */
function rise() {
  const el = document.querySelector<HTMLElement>('.VPContent');
  if (!el) return;
  el.classList.remove('cf-rise');
  void el.offsetWidth;
  el.classList.add('cf-rise');
}

let seen: IntersectionObserver | null = null;
const observer = () => (seen ??= new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    e.target.classList.add('cf-in');
    seen?.unobserve(e.target);
  }
}, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }));

/** `v-reveal` (or `v-reveal="2"` for the third in a row: it starts a little later). */
export const reveal: Directive<HTMLElement, number | undefined> = {
  getSSRProps: () => ({}),
  mounted(el, { value }) {
    if (lessMotion() || typeof IntersectionObserver === 'undefined') return;
    if (el.getBoundingClientRect().top < innerHeight * 0.92) return;   // on screen already: leave it
    if (value) el.style.setProperty('--cf-delay', `${Math.min(value, 8) * 60}ms`);
    el.classList.add('cf-reveal');
    observer().observe(el);
  },
  unmounted(el) { seen?.unobserve(el); },
};
