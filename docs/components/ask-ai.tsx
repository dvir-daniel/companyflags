'use client';
// "Ask AI" in the corner of the docs' pages (⌘I or Ctrl+I): it opens Claude in a new tab, told to
// read these docs (/llms-full.txt) and the page you're on. No AI service of our own: the site stays static files.
import { useEffect } from 'react';
import { BASE } from '@/lib/source';

function ask() {
  const docs = `${location.origin}${BASE}/llms-full.txt`;
  const page = `${location.origin}${location.pathname}.md`;
  const q = `Read the CompanyFlags docs at ${docs} (I'm on ${page}) and help me with my question about CompanyFlags: `;
  window.open(`https://claude.ai/new?q=${encodeURIComponent(q)}`, '_blank', 'noopener,noreferrer');
}

export function AskAI() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'i') { e.preventDefault(); ask(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  return (
    <button type="button" onClick={ask} className="cf-ask" aria-label="Ask AI about these docs (opens Claude)">
      <span>Ask AI</span>
      <span aria-hidden className="cf-ask-rule" />
      <kbd>⌘I</kbd>
    </button>
  );
}
