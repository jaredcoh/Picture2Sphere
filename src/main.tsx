import React, { Component, type ErrorInfo, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

interface AppErrorBoundaryState {
  error: Error | null;
}

class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[SpherePanorama] React render crashed.", {
      error,
      componentStack: errorInfo.componentStack,
    });
  }

  render() {
    if (this.state.error) {
      return (
        <main className="fatalError">
          <h1>App failed to render</h1>
          <p>Open the browser console for the full error stack.</p>
          <pre>{this.state.error.stack ?? this.state.error.message}</pre>
        </main>
      );
    }

    return this.props.children;
  }
}

window.addEventListener("error", (event) => {
  console.error("[SpherePanorama] Uncaught browser error.", {
    message: event.message,
    source: event.filename,
    line: event.lineno,
    column: event.colno,
    error: event.error,
  });
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("[SpherePanorama] Unhandled promise rejection.", event.reason);
});

const rootElement = document.getElementById("root");

if (!rootElement) {
  console.error("[SpherePanorama] Missing #root element. React cannot mount.");
  throw new Error("Missing #root element.");
}

console.info("[SpherePanorama] Booting app.", {
  href: window.location.href,
  userAgent: navigator.userAgent,
  rootRect: rootElement.getBoundingClientRect().toJSON(),
  viewport: {
    width: window.innerWidth,
    height: window.innerHeight,
  },
});

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);

requestAnimationFrame(() => {
  console.info("[SpherePanorama] First animation frame.", {
    rootRect: rootElement.getBoundingClientRect().toJSON(),
    bodyRect: document.body.getBoundingClientRect().toJSON(),
  });
  window.dispatchEvent(new Event("resize"));

  requestAnimationFrame(() => {
    console.info("[SpherePanorama] Second animation frame after resize.", {
      rootRect: rootElement.getBoundingClientRect().toJSON(),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
    });
    window.dispatchEvent(new Event("resize"));
  });
});
