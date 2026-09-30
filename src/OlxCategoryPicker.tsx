import { useState } from "react";
import { LoaderCircle, Search } from "lucide-react";
import { api } from "./api";
import type { OlxCategory, OlxCategoryOption } from "./types";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong";

/** `elektronika/komputery/podzespoly-i-czesci` → `elektronika › komputery › podzespoly i czesci` */
const readablePath = (path: string) =>
  path.split("/").filter(Boolean).map((segment) => segment.replace(/-/g, " ")).join(" › ");

/**
 * OLX searches every category by default, so "rtx 3070" is mostly whole PCs
 * and "iphone 13" mostly cases. Counts come from OLX's own category sidebar
 * for the current query; loading them costs one request and nothing is
 * fetched until the user asks.
 */
export function OlxCategoryPicker({
  query,
  value,
  onChange,
}: {
  query: string;
  value: OlxCategory | null;
  onChange: (category: OlxCategory | null) => void;
}) {
  const [options, setOptions] = useState<OlxCategoryOption[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const trimmed = query.trim();
  const load = async () => {
    if (!trimmed) return;
    setLoading(true);
    setNote(null);
    try {
      const result = await api.olxCategories(trimmed);
      // Path order reads as a tree: parents sort before their children.
      setOptions([...result.categories].sort((a, b) => a.path.localeCompare(b.path)));
      setLoadedFor(trimmed);
      if (!result.categories.length) setNote(`OLX has no category counts for "${trimmed}".`);
    } catch (loadError) {
      setNote(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  };
  const minDepth = options.length ? Math.min(...options.map((option) => option.path.split("/").length)) : 1;
  const select = (raw: string) => {
    if (!raw) return onChange(null);
    const id = Number(raw);
    if (value?.id === id) return;
    const option = options.find((candidate) => candidate.id === id);
    if (option) onChange({ id: option.id, label: option.label, path: option.path });
  };
  return (
    <div className="field-label">
      <span>
        OLX category <span>optional · OLX scans only</span>
      </span>
      <div className="olx-category-picker">
        <select
          aria-label="OLX category"
          value={value ? String(value.id) : ""}
          onChange={(event) => select(event.target.value)}
        >
          <option value="">All categories</option>
          {value && !options.some((option) => option.id === value.id) ? (
            <option value={String(value.id)}>{value.label}</option>
          ) : null}
          {options.map((option) => (
            <option key={option.id} value={String(option.id)} title={readablePath(option.path)}>
              {"  ".repeat(Math.max(0, option.path.split("/").length - minDepth))}
              {option.label} · {option.count.toLocaleString("pl-PL")}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ghost-button"
          disabled={!trimmed || loading}
          onClick={() => void load()}
        >
          {loading ? <LoaderCircle size={15} className="spin" /> : <Search size={15} />}
          {loadedFor && loadedFor === trimmed ? "Refresh counts" : "Find categories"}
        </button>
      </div>
      {note ? (
        <small className="field-hint" role="status">{note}</small>
      ) : value?.path ? (
        <small className="field-hint">{readablePath(value.path)}</small>
      ) : (
        <small className="field-hint">
          Shows how many OLX listings match the search terms in each category. Pick one to leave out other kinds of items, such as whole PCs in a GPU watch.
        </small>
      )}
    </div>
  );
}
