import type { MouseEvent } from "react";
import { cx, navigate, tid } from "../runtime.ts";

export function linkHandler(href: string) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
}

export function Crumbs({ items }: { items: Array<{ label: string; href?: string }> }) {
  return (
    <nav aria-label="Breadcrumb" className={cx("crumbs")}>
      {items.map((item, i) => (
        <span key={item.label} className={cx("crumb")}>
          {item.href ? (
            <a href={item.href} data-testid={tid(`crumb-${i}`)} onClick={linkHandler(item.href)}>
              {item.label}
            </a>
          ) : (
            <span aria-current="page">{item.label}</span>
          )}
          {i < items.length - 1 && (
            <span aria-hidden="true" className={cx("crumb-sep")}>
              {" / "}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}
