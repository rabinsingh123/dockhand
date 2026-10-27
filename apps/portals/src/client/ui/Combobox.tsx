// Accessible editable combobox (WAI-ARIA 1.2 list autocomplete). Renders in headless screenshots,
// unlike a native <select>. Click or ArrowDown opens; typing filters; Enter/click selects;
// Escape closes; leaving the field commits an exact (case-insensitive) match or reverts.

import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { type FieldDef, slug } from "../../shared/fields.ts";
import { cx, M } from "../runtime.ts";
import { IconCheck, IconChevronDown } from "./icons.tsx";

function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").trim();
}

export interface ComboboxProps {
  def: FieldDef;
  id: string;
  labelId: string;
  value: string;
  onChange(value: string): void;
  invalid: boolean;
  describedBy?: string;
}

export function Combobox({ def, id, labelId, value, onChange, invalid, describedBy }: ComboboxProps) {
  const options = def.options ?? [];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const [dropUp, setDropUp] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  // Pressing the mouse on the popup (options, scrollbar) must not blur the input.
  useEffect(() => {
    const el = popupRef.current;
    if (!open || !el) return;
    const keepFocus = (e: MouseEvent) => e.preventDefault();
    el.addEventListener("mousedown", keepFocus);
    return () => el.removeEventListener("mousedown", keepFocus);
  }, [open]);

  const filtered = useMemo(() => {
    if (query === null || query.trim() === "") return options;
    const q = norm(query);
    const starts = options.filter((o) => norm(o).startsWith(q));
    const contains = options.filter((o) => !norm(o).startsWith(q) && norm(o).includes(q));
    return [...starts, ...contains];
  }, [query, options]);

  const listId = M.id(`${def.domId}-listbox`);
  const optionId = (o: string) => M.id(`${def.domId}-option-${slug(o)}`);
  const activeOption = open && active >= 0 ? filtered[active] : undefined;

  // Keep the active option visible inside the list without scrolling the page.
  useEffect(() => {
    if (!activeOption) return;
    const el = document.getElementById(optionId(activeOption));
    const list = el?.parentElement;
    if (!el || !list) return;
    if (el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop;
    else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight;
    }
  });

  function openList() {
    // Open upward when the list would be cut off by the bottom of the viewport.
    const rect = wrapRef.current?.getBoundingClientRect();
    setDropUp(rect ? window.innerHeight - rect.bottom < 270 && rect.top > 270 : false);
    setOpen(true);
    setActive(Math.max(filtered.indexOf(value), 0));
  }

  function commit(option: string) {
    onChange(option);
    setQuery(null);
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!open) openList();
        else setActive((i) => Math.min(i + 1, filtered.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        if (!open) openList();
        else setActive((i) => Math.max(i - 1, 0));
        break;
      case "Home":
        if (open) {
          e.preventDefault();
          setActive(0);
        }
        break;
      case "End":
        if (open) {
          e.preventDefault();
          setActive(filtered.length - 1);
        }
        break;
      case "Enter":
        e.preventDefault();
        if (open) {
          const choice = filtered[Math.max(active, 0)];
          if (choice) commit(choice);
        }
        break;
      case "Escape":
        if (open) {
          e.preventDefault();
          setOpen(false);
          setQuery(null);
          setActive(-1);
        }
        break;
      default:
        break;
    }
  }

  function onBlur() {
    if (query !== null) {
      const typed = query.trim();
      if (typed === "") onChange("");
      else {
        const exact = options.find((o) => norm(o) === norm(typed));
        if (exact) onChange(exact);
      }
    }
    setQuery(null);
    setOpen(false);
    setActive(-1);
  }

  return (
    <div ref={wrapRef} className={cx("combo", open && "is-open")}>
      <input
        id={id}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={activeOption ? optionId(activeOption) : undefined}
        aria-required={def.required ? true : undefined}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        required={def.required}
        autoComplete="off"
        spellCheck={false}
        placeholder={def.placeholder}
        className={cx("input", "combo-input")}
        data-testid={M.testid(def.testid)}
        value={query ?? value}
        onChange={(e) => {
          if (!open) {
            const rect = wrapRef.current?.getBoundingClientRect();
            setDropUp(rect ? window.innerHeight - rect.bottom < 270 && rect.top > 270 : false);
          }
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onClick={() => {
          if (!open) openList();
        }}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
      <span className={cx("combo-chevron")} aria-hidden="true">
        <IconChevronDown />
      </span>
      {open && (
        <div ref={popupRef} className={cx("combo-popup", dropUp && "is-up")}>
          {filtered.length > 0 ? (
            <div role="listbox" id={listId} aria-labelledby={labelId} className={cx("combo-list")}>
              {filtered.map((o, i) => (
                <div
                  key={o}
                  id={optionId(o)}
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === active}
                  data-testid={M.testid(`${def.testid}-option-${slug(o)}`)}
                  className={cx("combo-option", i === active && "is-active", o === value && "is-selected")}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => commit(o)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      commit(o);
                    }
                  }}
                >
                  <span>{o}</span>
                  {o === value && <IconCheck size={16} />}
                </div>
              ))}
            </div>
          ) : (
            <div className={cx("combo-empty")}>No matches for “{query}”</div>
          )}
        </div>
      )}
    </div>
  );
}
