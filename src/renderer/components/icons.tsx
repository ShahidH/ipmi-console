// Stroke icons (24×24 grid). Decorative: always aria-hidden; the control carries the label.
import type { ReactNode } from 'react';

function Icon({ size = 16, width = 2, children, fill }: { size?: number; width?: number; children: ReactNode; fill?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'}
      strokeWidth={width} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

type P = { size?: number };
export const MonitorIcon = (p: P) => <Icon {...p}><rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M8 20h8M12 16v4" /></Icon>;
export const SearchIcon = (p: P) => <Icon {...p}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></Icon>;
export const PlusIcon = (p: P) => <Icon {...p} width={2.4}><path d="M12 5v14M5 12h14" /></Icon>;
export const DotsIcon = (p: P) => <Icon {...p} fill><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></Icon>;
export const DownloadIcon = (p: P) => <Icon {...p}><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></Icon>;
export const CloseIcon = (p: P) => <Icon {...p}><path d="M6 6l12 12M18 6L6 18" /></Icon>;
export const CheckIcon = (p: P) => <Icon {...p} width={2.4}><path d="M5 12.5l4.5 4.5L19 7.5" /></Icon>;
export const AlertIcon = (p: P) => <Icon {...p}><path d="M12 3l9.5 17h-19z" /><path d="M12 10v4M12 17.5h.01" /></Icon>;
export const BackIcon = (p: P) => <Icon {...p}><path d="M15 6l-6 6 6 6" /></Icon>;
export const KeyboardIcon = (p: P) => <Icon {...p}><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></Icon>;
export const ChevronIcon = (p: P) => <Icon {...p} width={2.4}><path d="M6 9l6 6 6-6" /></Icon>;
export const ClipboardIcon = (p: P) => <Icon {...p}><rect x="7" y="3" width="10" height="4" rx="1" /><path d="M7 5H5v16h14V5h-2M9 12h6M9 16h4" /></Icon>;
export const TextSelectIcon = (p: P) => <Icon {...p}><path d="M9 4h6M9 20h6M12 4v16" /><path d="M4 9h2M18 9h2M4 15h2M18 15h2" /></Icon>;
export const FitIcon = (p: P) => <Icon {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M8 9l-2 3 2 3M16 9l2 3-2 3" /></Icon>;
export const FullscreenIcon = (p: P) => <Icon {...p}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></Icon>;
export const PowerIcon = (p: P) => <Icon {...p}><path d="M12 3v8M7.5 6.2a7 7 0 1 0 9 0" /></Icon>;
export const SlidersIcon = (p: P) => <Icon {...p}><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></Icon>;
export const RetryIcon = (p: P) => <Icon {...p}><path d="M21 12a9 9 0 1 1-3.2-6.9" /><path d="M21 4v5h-5" /></Icon>;
export const ResetIcon = (p: P) => <Icon {...p}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></Icon>;
export const LockIcon = (p: P) => <Icon {...p}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></Icon>;
