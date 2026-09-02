import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /**
   * Called after the boundary clears its own error, for callers that need to
   * reset the state which caused the failure in the first place.
   */
  onReset?: () => void;
}

interface State {
  error: Error | null;
}

/*
 * React unmounts the whole tree when any component throws during render, so
 * without a boundary a single bad data shape reaching one chart blanks the
 * entire page. Error boundaries have no hook equivalent — they must be class
 * components.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the failure debuggable: React itself only surfaces the error to the
    // boundary, so without this it would leave no trace in the console.
    console.error("Dashboard render failed:", error, info.componentStack);
  }

  handleRetry = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="error-boundary" role="alert">
        <h2 className="error-boundary__title">Something went wrong displaying this data</h2>
        <p className="error-boundary__message">
          A part of the dashboard failed while rendering. The page header is still
          usable, so you can switch networks or reload. Fresh data arrives every few
          seconds, so trying again will often clear this.
        </p>
        {error.message && <p className="error-boundary__detail">{error.message}</p>}
        <div className="error-boundary__actions">
          <button type="button" className="error-boundary__btn" onClick={this.handleRetry}>
            Try again
          </button>
          <button
            type="button"
            className="error-boundary__btn error-boundary__btn--muted"
            onClick={this.handleReload}
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
