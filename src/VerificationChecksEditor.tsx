import { Plus, X } from "lucide-react";
import type { VerificationCheck } from "./types";

const MAX_CHECKS = 8;

/** Drops blank rows and trims text before a check list is sent. */
export const cleanVerificationChecks = (checks: VerificationCheck[]) =>
  checks
    .map((check) => ({ ...check, text: check.text.trim() }))
    .filter((check) => check.text);

/**
 * Require/Exclude check rows shared by the watch dialog and the search form.
 * Rows are keyed by position: they have no identity beyond their place.
 */
export function VerificationChecksEditor({
  checks,
  onChange,
  hint,
}: {
  checks: VerificationCheck[];
  onChange: (checks: VerificationCheck[]) => void;
  hint: string;
}) {
  const update = (index: number, patch: Partial<VerificationCheck>) =>
    onChange(checks.map((check, position) => (position === index ? { ...check, ...patch } : check)));
  return (
    <div className="variant-editor">
      {checks.map((check, index) => (
        <div className="variant-row verification-check-row" key={index}>
          <select
            value={check.mode}
            onChange={(event) => update(index, { mode: event.target.value === "exclude" ? "exclude" : "require" })}
            aria-label="Check mode"
          >
            <option value="require">Require</option>
            <option value="exclude">Exclude</option>
          </select>
          <input
            value={check.text}
            maxLength={120}
            onChange={(event) => update(index, { text: event.target.value })}
            placeholder={check.mode === "exclude" ? "e.g. iCloud locked" : "e.g. includes original charger"}
          />
          <button
            type="button"
            className="icon-button"
            onClick={() => onChange(checks.filter((_, position) => position !== index))}
            aria-label={`Remove ${check.text || "check"}`}
          >
            <X size={16} />
          </button>
        </div>
      ))}
      <div className="variant-actions">
        <button
          type="button"
          className="ghost-button"
          disabled={checks.length >= MAX_CHECKS}
          onClick={() => onChange([...checks, { text: "", mode: "require" }])}
        >
          <Plus size={15} />
          Add check
        </button>
      </div>
      {checks.length ? <small className="field-hint">{hint}</small> : null}
    </div>
  );
}
