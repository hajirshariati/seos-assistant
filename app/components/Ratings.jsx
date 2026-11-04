// Ratings — the ranked lists with proportional bars (the Recordings page's
// "why they said so" and "what they were asking about") and the CSV export
// hook the embedded app's pages share.
import { useState, useCallback } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";

export const RATINGS_CSS = `
  .an-col__title { margin-bottom: 8px; font-size: 12px; line-height: 16px; font-weight: 650; color: #303030; }
  .an-rank { display: grid; gap: 9px; margin: 0; padding: 0; list-style: none; }
  .an-rank__top { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .an-rank__title { min-width: 0; font-size: 13px; line-height: 18px; color: #1a1a1a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .an-rank__n { flex: none; font-size: 12.5px; font-weight: 650; color: #1a2e26; font-variant-numeric: tabular-nums; }
  .an-rank__bar { height: 4px; margin-top: 4px; border-radius: 999px; background: rgba(26,46,38,0.06); overflow: hidden; }
  .an-rank__bar span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #2D6B4F, #3a8a66); }
  .an-rank--down .an-rank__n { color: #a33d3d; }
  .an-rank--down .an-rank__bar span { background: linear-gradient(90deg, #a33d3d, #c46a6a); }
`;

export function RankList({ rows, tone }) {
  if (!rows || rows.length === 0) return <div className="an-empty" style={{ padding: "4px 0 0" }}>Nothing yet.</div>;
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <ol className={`an-rank${tone === "down" ? " an-rank--down" : ""}`}>
      {rows.map((r, i) => (
        <li key={`${r.title}-${i}`}>
          <div className="an-rank__top"><span className="an-rank__title" title={r.title}>{r.title}</span><span className="an-rank__n">{r.count}</span></div>
          <div className="an-rank__bar"><span style={{ width: `${Math.max(4, Math.round((r.count / max) * 100))}%` }} /></div>
        </li>
      ))}
    </ol>
  );
}

// CSV download from inside the embedded iframe: the App Bridge session token
// goes in the header (a new tab would have none and bounce to the login).
export function useCsvExport(baseParams = {}) {
  const shopify = useAppBridge();
  const [exporting, setExporting] = useState(null);
  const handleExport = useCallback(async (section, extraParams = {}) => {
    if (exporting) return;
    setExporting(section);
    try {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries({ ...baseParams, ...extraParams })) if (v) params.set(k, v);
      params.set("section", section);
      const token = await shopify.idToken();
      const res = await fetch(`/app/exports?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const filename = res.headers.get("Content-Disposition")?.match(/filename="?([^";]+)"?/)?.[1] || `${section}.csv`;
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch (err) {
      console.error("[export] failed:", err);
      shopify.toast.show("Export failed. Please try again.", { isError: true });
    } finally {
      setExporting(null);
    }
  }, [shopify, exporting, baseParams]);
  return [exporting, handleExport];
}
