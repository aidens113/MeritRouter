"use client";

import { Children, useState, type ReactNode } from "react";

/**
 * Long lists show their first rows and a "Show all" control (panel-v2 D3). `ShowAll` wraps list
 * items or blocks; `ShowAllRows` wraps table rows (it renders inside a `<tbody>`).
 */
export function ShowAll({ children, limit = 10, noun = "items" }: { children: ReactNode; limit?: number; noun?: string }) {
  const items = Children.toArray(children);
  const [all, setAll] = useState(false);
  if (items.length <= limit) return <>{items}</>;
  return (
    <>
      {all ? items : items.slice(0, limit)}
      <MoreButton all={all} total={items.length} noun={noun} onClick={() => setAll((v) => !v)} />
    </>
  );
}

export function ShowAllRows({ children, limit = 10, colSpan, noun = "rows" }: { children: ReactNode; limit?: number; colSpan: number; noun?: string }) {
  const rows = Children.toArray(children);
  const [all, setAll] = useState(false);
  if (rows.length <= limit) return <>{rows}</>;
  return (
    <>
      {all ? rows : rows.slice(0, limit)}
      <tr>
        <td colSpan={colSpan} className="!py-1.5">
          <MoreButton all={all} total={rows.length} noun={noun} onClick={() => setAll((v) => !v)} />
        </td>
      </tr>
    </>
  );
}

function MoreButton({ all, total, noun, onClick }: { all: boolean; total: number; noun: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-expanded={all} className="rounded-md px-2 py-1 text-xs font-medium text-accent-ink hover:bg-surface-2 hover:underline">
      {all ? "Show fewer" : `Show all ${total} ${noun}`}
    </button>
  );
}
