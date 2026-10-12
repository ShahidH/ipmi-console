// Last line of defence for rendering errors: a recovery screen instead of a blank window.
import { Component, type ReactNode } from 'react';
import { api } from '../api';

interface State { error: Error | null }

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    api().reportError(`render error: ${error.stack ?? error.message}${info.componentStack ?? ''}`);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="scrim" role="alert">
        <div className="modal">
          <div className="modal-head"><h2>Something went wrong</h2></div>
          <div className="modal-body">
            <p>The window hit an unexpected error. It has been written to the log. Reloading the window closes any KVM session.</p>
            <p className="fingerprint">{this.state.error.message}</p>
          </div>
          <div className="modal-foot">
            <button type="button" className="btn primary tall" onClick={() => location.reload()}>Reload window</button>
          </div>
        </div>
      </div>
    );
  }
}
