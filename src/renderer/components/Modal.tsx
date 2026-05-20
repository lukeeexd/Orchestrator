import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from 'react';

/**
 * Shared modal wrapper. Provides:
 *   - role="dialog" + aria-modal="true" + aria-labelledby tying
 *     the heading to the dialog so screen readers announce it.
 *   - Escape closes (when `onClose` is provided — gates that have
 *     no close path, like CliMissingGate, can omit it).
 *   - Click on the backdrop closes (same gating).
 *   - Focus trap: Tab cycles within the dialog, Shift+Tab too.
 *   - Initial focus on the first tabbable element.
 *   - Focus restoration on unmount to whatever element was focused
 *     when the modal opened.
 *
 * The existing CSS classes (`modal-backdrop`, `modal`, `modal-head`,
 * `title`, `modal-body`, `modal-foot`) keep working — this just
 * wraps them with the a11y/keyboard plumbing every modal in the
 * app used to lack.
 */

interface ModalProps {
  title: ReactNode;
  children: ReactNode;
  /**
   * Footer content (action buttons). Optional — modals like
   * CliMissingGate use only the head + body.
   */
  footer?: ReactNode;
  /**
   * Called when the user wants to dismiss the modal — Esc, backdrop
   * click, or close button. Omit for blocking gates that cannot be
   * dismissed.
   */
  onClose?: () => void;
  /** Override the inner panel max-width (default 520). */
  maxWidth?: number;
  /** Optional extra class on the panel for screen-specific styling. */
  panelClassName?: string;
}

const TABBABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getTabbable(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR),
  ).filter((el) => !el.hasAttribute('aria-hidden'));
}

export function Modal({
  title,
  children,
  footer,
  onClose,
  maxWidth = 520,
  panelClassName,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // Capture the focused element BEFORE the modal mounts so we can
  // restore on close. useLayoutEffect runs before paint, so the
  // restore is seamless.
  useLayoutEffect(() => {
    restoreFocusRef.current =
      (document.activeElement as HTMLElement | null) ?? null;
    return () => {
      restoreFocusRef.current?.focus?.();
    };
  }, []);

  // Move focus into the dialog on mount.
  useEffect(() => {
    const tabbables = getTabbable(panelRef.current);
    if (tabbables.length > 0) {
      tabbables[0].focus();
    } else {
      // Nothing focusable inside — focus the panel itself so the
      // keyboard event listeners pick up Esc / Tab.
      panelRef.current?.focus();
    }
  }, []);

  // Esc to close + Tab focus trap.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && onClose) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const tabbables = getTabbable(panelRef.current);
      if (tabbables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = tabbables[0];
      const last = tabbables[tabbables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !panelRef.current?.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !panelRef.current?.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [onClose]);

  const onBackdrop = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget && onClose) onClose();
  };

  const panelClasses = ['modal', panelClassName ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className="modal-backdrop"
      onMouseDown={onBackdrop}
      role="presentation"
    >
      <div
        ref={panelRef}
        className={panelClasses}
        style={{ maxWidth }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="modal-head">
          <span className="title" id={titleId}>
            {title}
          </span>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
