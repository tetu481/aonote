import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Target = { label: HTMLElement; trigger: HTMLElement; text: string; left: number; top: number };
const selector = "[data-full-name]";
const isTruncated = (element: HTMLElement) => element.scrollWidth > element.clientWidth;

// One delegated tooltip for all names, including rows inserted after a reload.
// The portal keeps it outside the tree's scrolling/clipping container.
export function NameTooltip() {
  const [target, setTarget] = useState<Target | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    let touchInteraction = false;
    let anchor: Target | null = null;
    const hide = () => { anchor = null; setTarget(null); };
    const show = (node: EventTarget | null) => {
      if (!(node instanceof Element)) { hide(); return; }
      const control = node.closest<HTMLElement>("button");
      const label = node.closest<HTMLElement>(selector)
        ?? Array.from(control?.querySelectorAll<HTMLElement>(selector) ?? []).find(isTruncated);
      if (!label?.isConnected || !isTruncated(label) || !label.dataset.fullName) { hide(); return; }
      const text = label.dataset.fullName;
      const { left, top } = label.getBoundingClientRect();
      const next = { label, trigger: control ?? label, text, left, top };
      anchor = next;
      setTarget((current) => current?.label === label && current.text === text && current.left === left && current.top === top
        ? current : next);
    };
    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType !== "touch") show(event.target);
    };
    const onPointerOut = (event: PointerEvent) => {
      if (event.pointerType !== "touch") show(event.relatedTarget);
    };
    const onPointerDown = (event: PointerEvent) => {
      touchInteraction = event.pointerType === "touch";
      hide();
    };
    const onFocus = (event: FocusEvent) => { if (!touchInteraction) show(event.target); };
    const onScroll = () => {
      if (!anchor) return;
      const rect = anchor.label.getBoundingClientRect();
      // Focus/hover can follow a scroll before its queued event is dispatched.
      // Dismiss only if the anchor actually moved since the tooltip was shown.
      if (!anchor.label.isConnected || rect.left !== anchor.left || rect.top !== anchor.top) hide();
    };
    const onKey = (event: KeyboardEvent) => {
      touchInteraction = false;
      if (event.key === "Escape") hide();
    };
    document.addEventListener("pointerover", onPointerOver);
    // Moving within the same row should reveal its name again after scrolling
    // or dismissing the previous tooltip with Escape.
    document.addEventListener("pointermove", onPointerOver);
    document.addEventListener("pointerout", onPointerOut);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", hide);
    document.addEventListener("click", hide, true);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointermove", onPointerOver);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("click", hide, true);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
    };
  }, []);

  useLayoutEffect(() => {
    if (!target || !tooltipRef.current) return;
    const anchor = target.label.getBoundingClientRect();
    const box = tooltipRef.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - box.width - 8));
    const below = anchor.bottom + 6;
    const top = Math.max(8, below + box.height <= window.innerHeight - 8 ? below : anchor.top - box.height - 6);
    // Position the portal before paint without a second state update. A focus
    // change during navigation must not start a layout-effect render loop.
    tooltipRef.current.style.left = `${left}px`;
    tooltipRef.current.style.top = `${top}px`;
    const previous = target.trigger.getAttribute("aria-describedby");
    target.trigger.setAttribute("aria-describedby", [previous, id].filter(Boolean).join(" "));
    return () => {
      if (previous === null) target.trigger.removeAttribute("aria-describedby");
      else target.trigger.setAttribute("aria-describedby", previous);
    };
  }, [target, id]);

  return target ? createPortal(
    <div id={id} role="tooltip" className="name-tooltip" ref={tooltipRef}>{target.text}</div>,
    document.body,
  ) : null;
}
