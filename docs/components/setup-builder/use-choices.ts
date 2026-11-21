// The setup builder's answers, kept in the page's query string (?where=aws&cdnhost=1…) so a setup is a link to share.
// Nothing else is stored. The first render uses the defaults, as the static page does; the link's answers come in
// once the page runs.
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULTS, fromQuery, normalize, toQuery, validDomain, type Choices } from '@/lib/setup/index.ts';

export function useChoices() {
  const [choices, setChoices] = useState<Choices>(DEFAULTS);
  /** What is typed in the domain field, which may not be a host name yet. */
  const [domainText, setDomainText] = useState(DEFAULTS.domain);
  const loaded = useRef(false);

  useEffect(() => {
    const c = fromQuery(window.location.search);
    setChoices(c);
    setDomainText(c.domain);
    loaded.current = true;
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    const q = toQuery(choices);
    const url = `${window.location.pathname}${q ? `?${q}` : ''}${window.location.hash}`;
    if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history.replaceState(window.history.state, '', url);
  }, [choices]);

  const update = useCallback((patch: Partial<Choices>) => setChoices((prev) => normalize({ ...prev, ...patch })), []);

  const typeDomain = useCallback((text: string) => {
    setDomainText(text);
    const d = text.trim().toLowerCase();
    setChoices((prev) => normalize({ ...prev, domain: validDomain(d) ? d : DEFAULTS.domain }));
  }, []);

  return { choices, update, domainText, typeDomain, domainValid: validDomain(domainText.trim().toLowerCase()) };
}

/** Copy the page's address, with the answers in it. */
export async function copyLink(): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(window.location.href);
    return true;
  } catch {
    return false;
  }
}
