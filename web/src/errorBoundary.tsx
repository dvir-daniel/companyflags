import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@companyfeatures/ui/components/button';

/*
 * A crash in one page shows a message in its place instead of blanking the whole console. main.tsx keys the
 * page's boundary by its address, so going to another page starts that page fresh.
 */
type Props = { children: ReactNode; where: string };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.where}]`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="grid max-w-[620px] content-start gap-4 p-12 max-sm:p-6">
        <h1 className="m-0 text-[28px] leading-tight font-semibold text-ink">Something went wrong on this page</h1>
        <p className="m-0 text-ink-2">
          The page hit an error and stopped. Nothing you saved is lost; unsaved edits are kept in this browser.
          Reload to try again, or go to another page.
        </p>
        <p className="m-0 font-mono text-xs break-words text-ink-3">{error.message}</p>
        <div className="flex gap-2">
          <Button onClick={() => location.reload()}>Reload</Button>
          <Button variant="secondary" onClick={() => { location.hash = '#/flags'; this.setState({ error: null }); }}>Go to flags</Button>
        </div>
      </div>
    );
  }
}
