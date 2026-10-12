// Renderer entry. Runs sandboxed; talks to the main process only through window.ojv.
import { createRoot } from 'react-dom/client';
import { api } from './api';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

// Errors outside React rendering (event handlers, promises) go to the main-process log.
window.addEventListener('error', (e) => api().reportError(`${e.message} at ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => api().reportError(`unhandled rejection: ${e.reason instanceof Error ? (e.reason.stack ?? e.reason.message) : String(e.reason)}`));

createRoot(document.getElementById('root')!).render(<ErrorBoundary><App /></ErrorBoundary>);
