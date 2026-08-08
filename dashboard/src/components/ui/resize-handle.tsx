import { useRef, type PointerEvent as ReactPointerEvent } from "react";

import { cn } from "@/lib/utils";

// Draggable column divider for App.tsx's thread-sidebar/main and
// main/right-rail boundaries. Pointer-capture drag, same established
// pattern as RadialChatSelector.tsx's own node dragging (setPointerCapture
// can throw on an invalid pointerId / in jsdom, which has no
// Element.setPointerCapture at all — defended the same way there).

interface ResizeHandleProps {
  onResize: (deltaX: number) => void;
  ariaLabel: string;
  className?: string;
}

const KEYBOARD_STEP_PX = 16;

export function ResizeHandle({ onResize, ariaLabel, className }: ResizeHandleProps) {
  const draggingRef = useRef(false);
  const lastXRef = useRef(0);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    draggingRef.current = true;
    lastXRef.current = event.clientX;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // No-op: dragging still works via document-level pointer events
      // even when capture itself isn't available (jsdom in tests).
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    const delta = event.clientX - lastXRef.current;
    lastXRef.current = event.clientX;
    if (delta !== 0) onResize(delta);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    draggingRef.current = false;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Same defended gap as setPointerCapture above.
    }
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onResize(-KEYBOARD_STEP_PX);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          onResize(KEYBOARD_STEP_PX);
        }
      }}
      className={cn(
        "group relative z-10 hidden w-1.5 shrink-0 touch-none cursor-col-resize items-stretch justify-center select-none md:flex",
        className,
      )}
    >
      <div className="w-px bg-sidebar-border transition-colors group-hover:bg-operator group-active:bg-operator" />
    </div>
  );
}
