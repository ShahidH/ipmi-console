// Menu button + popover. Closes on outside click, Escape or after choosing an item.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

interface Props {
  label: ReactNode;
  /** Accessible name when the label is icon-only. */
  ariaLabel?: string;
  /** Tooltip. */
  title?: string;
  buttonClass?: string;
  align?: 'left' | 'right';
  width?: number;
  children: (close: () => void) => ReactNode;
}

export function Menu({ label, ariaLabel, title, buttonClass = 'btn tb', align = 'left', width, children }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    // Focus the first enabled item so the menu is keyboard-usable at once.
    wrap.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
      wrap.current?.querySelector<HTMLElement>('button')?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(wrap.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };

  return (
    <div className="menu-wrap" ref={wrap} onKeyDown={onKeyDown}>
      <button type="button" className={buttonClass} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        aria-label={ariaLabel} title={title} onClick={() => setOpen((v) => !v)}>
        {label}
      </button>
      {open && (
        <div role="menu" id={id} className={`menu${align === 'right' ? ' right' : ''}`} style={width ? { width } : undefined}>
          {children(close)}
        </div>
      )}
    </div>
  );
}
