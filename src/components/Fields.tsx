import { useEffect, useState, type ReactNode } from "react";

export function NumberField({
  label,
  value,
  onChange,
  unit,
  min,
  max,
  step = "any",
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  unit?: string;
  min?: number;
  max?: number;
  step?: number | "any";
}) {
  // Keep the raw decimal draft across label changes and language-selector focus.
  const [text, setText] = useState(String(Number(value.toPrecision(10))));
  useEffect(() => {
    setText((previous) =>
      Number(previous) === value && previous !== ""
        ? previous
        : String(Number(value.toPrecision(10))),
    );
  }, [value]);
  return (
    <label className="field">
      <span>{label}</span>
      <div className="input-wrap">
        <input
          aria-label={label}
          type="number"
          step={step}
          min={min}
          max={max}
          value={text}
          onChange={(event) => {
            const raw = event.target.value;
            setText(raw);
            if (raw.trim() !== "" && Number.isFinite(Number(raw)))
              onChange(Number(raw));
          }}
        />
        {unit && <span className="input-unit">{unit}</span>}
      </div>
    </label>
  );
}
export function Metric({
  label,
  value,
  unit,
  accent = false,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  accent?: boolean;
}) {
  return (
    <div className={`metric ${accent ? "accent" : ""}`}>
      <span>{label}</span>
      <strong>
        {value}
        <small>{unit}</small>
      </strong>
    </div>
  );
}
export function SectionTitle({
  children,
  right,
}: {
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="section-title">
      <h2>{children}</h2>
      {right}
    </div>
  );
}
export { formatNumber } from "../i18n/format";
export const formatTime = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
