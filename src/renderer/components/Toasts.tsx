// Transient notices (results of actions, errors). Not used for anything the user must decide.
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

export interface Toast { id: number; title: string; detail?: string; level?: 'info' | 'err'; action?: { label: string; run: () => void } }
type Push = (t: Omit<Toast, 'id'>) => void;

const Ctx = createContext<Push>(() => {});
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback<Push>((t) => {
    const id = next.current++;
    setToasts((ts) => [...ts.slice(-2), { ...t, id }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), t.level === 'err' ? 10000 : 6000);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.level === 'err' ? ' err' : ''}`}>
            <span><strong>{t.title}</strong>{t.detail && <span className="sub"> {t.detail}</span>}</span>
            {t.action && <button type="button" className="btn sm" onClick={t.action.run}>{t.action.label}</button>}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
