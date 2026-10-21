"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { RefreshCw } from "lucide-react";
import { buttonClass } from "../ui";

export interface ConfirmDialogProps {
  /** Whether the dialog is showing. The parent owns this state. */
  open: boolean;
  /** Called when the dialog closes for any reason: Cancel, Esc, a backdrop click, or after a confirm. */
  onClose: () => void;
  /** Called when the person confirms. The dialog waits for a returned promise, then closes. */
  onConfirm: () => void | Promise<void>;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" styles the confirm button for destructive actions. */
  tone?: "default" | "danger";
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal confirmation built on the native <dialog> element with showModal(): the rest of the
 * page is inert while it is open. Focus starts on Cancel, Tab cycles inside the dialog, Esc and a
 * backdrop click cancel, and focus returns to whatever opened it.
 */
export function ConfirmDialog({ open, onClose, onConfirm, title, description, confirmLabel = "Confirm", cancelLabel = "Cancel", tone = "default" }: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const pressStartedOnBackdrop = useRef(false);
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      cancelRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Return focus to the opener once the dialog has closed (by any route).
  const handleClose = () => {
    const target = returnTo.current;
    returnTo.current = null;
    if (target && target.isConnected) target.focus();
    if (open) onClose();
  };

  const cancel = () => {
    if (busy) return;
    onClose();
  };

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
    onClose();
  };

  // Keep Tab and Shift+Tab inside the dialog (the browser would otherwise move to its own chrome).
  const onKeyDown = (e: KeyboardEvent<HTMLDialogElement>) => {
    if (e.key !== "Tab" || !ref.current) return;
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // The dialog element itself only receives pointer events on its backdrop: its content fills it.
  // Require the press to start there too, so a drag that ends outside the box does not cancel.
  const onMouseDown = (e: MouseEvent<HTMLDialogElement>) => {
    pressStartedOnBackdrop.current = e.target === e.currentTarget;
  };
  const onClick = (e: MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget && pressStartedOnBackdrop.current) cancel();
    pressStartedOnBackdrop.current = false;
  };

  return (
    <dialog
      ref={ref}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descId}
      onCancel={(e) => {
        // Esc: let the parent's state drive the close so the two never disagree.
        e.preventDefault();
        cancel();
      }}
      onClose={handleClose}
      onKeyDown={onKeyDown}
      onMouseDown={onMouseDown}
      onClick={onClick}
      className="fixed inset-0 m-auto h-fit w-[min(28rem,calc(100vw-2rem))] max-w-none rounded-xl border border-line-strong bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/50 backdrop:backdrop-blur-[1px]"
    >
      <div className="px-5 pb-4 pt-5">
        <h2 id={titleId} className="text-base font-semibold tracking-tight text-ink">
          {title}
        </h2>
        <p id={descId} className="mt-2 text-sm leading-relaxed text-ink-2">
          {description}
        </p>
      </div>
      <div className="flex flex-wrap justify-end gap-2 rounded-b-xl border-t border-line bg-surface-2 px-5 py-3">
        <button ref={cancelRef} type="button" autoFocus className={buttonClass("secondary")} onClick={cancel} disabled={busy}>
          {cancelLabel}
        </button>
        <button type="button" className={buttonClass(tone === "danger" ? "danger" : "primary")} onClick={confirm} disabled={busy}>
          {busy ? <RefreshCw size={14} className="animate-spin" aria-hidden /> : null}
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
