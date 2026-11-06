import { LanguageSettings } from "./LanguageSettings";
import { tx, useLocale } from "../i18n";
import { formatNumber as fmt } from "../i18n/format";
import { SI } from "../i18n/units";
import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Type, X } from "lucide-react";

const STORAGE_KEY = "orbital-lab.text-size";
const TEXT_SIZES = [100, 125, 150, 175, 200, 225, 250];

function readTextSize(): number {
  try {
    const saved = Number(localStorage.getItem(STORAGE_KEY));
    return TEXT_SIZES.includes(saved) ? saved : 100;
  } catch {
    return 100;
  }
}

export function TextSizeSettings() {
  useLocale();
  const [textSize, setTextSize] = useState(readTextSize);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--ui-font-scale", String(textSize / 100));
    // Breakpoints account for enlarged controls as well as viewport width.
    // Keep viewport-fixed dialogs outside any CSS containment context.
    const updateLayout = () => {
      const availableWidth = window.innerWidth / (textSize / 100);
      root.dataset.uiSmall = String(availableWidth < 400);
      root.dataset.uiVerySmall = String(availableWidth < 240);
      root.dataset.uiLayout =
        availableWidth <= 760
          ? "mobile"
          : availableWidth <= 950
            ? "narrow"
            : availableWidth <= 1200
              ? "medium"
              : availableWidth >= 1600
                ? "wide"
                : "standard";
    };
    updateLayout();
    window.addEventListener("resize", updateLayout);
    try {
      localStorage.setItem(STORAGE_KEY, String(textSize));
    } catch {
      // The setting still works for this session if browser storage is disabled.
    }
    return () => window.removeEventListener("resize", updateLayout);
  }, [textSize]);

  return (
    <>
      <button
        className="button subtle text-size-button"
        aria-label={tx("common:textSize")}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={tx("common:textSizeTitle", { size: textSize })}
        onClick={() => setOpen(true)}
      >
        <Type size={18} />
        <span>{tx("common:textSize")}</span>
      </button>
      {open &&
        createPortal(
          <div
            className="modal-backdrop text-size-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setOpen(false);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") {
                setOpen(false);
              }
            }}
          >
            <section
              className="modal text-size-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="text-size-title"
              aria-describedby="text-size-description"
            >
              <div className="modal-heading">
                <h2 id="text-size-title">{tx("common:textSize")}</h2>
                <LanguageSettings />
                <button
                  className="icon-button"
                  aria-label={tx("common:closeTextSize")}
                  onClick={() => setOpen(false)}
                >
                  <X size={18} />
                </button>
              </div>
              <p className="panel-description" id="text-size-description">{tx("common:textSizeDescription")}</p>
              <label className="field">
                <span>{tx("common:interfaceTextSize")}</span>
                <select
                  autoFocus
                  aria-label={tx("common:interfaceTextSize")}
                  value={textSize}
                  onChange={(event) => setTextSize(Number(event.target.value))}
                >
                  {TEXT_SIZES.map((size) => (
                    <option key={size} value={size}>
                      {size}%
                      {size === 100
                        ? tx("common:textSizeDefault")
                        : size === 200
                          ? tx("common:textSize4k")
                          : ""}
                    </option>
                  ))}
                </select>
              </label>
              <div className="text-size-preview">
                <span className="overline">{tx("common:textSizeLive", { size: textSize })}</span>
                <h3>{tx("common:textSizePreviewTitle")}</h3>
                <p>{tx("common:textSizePreview", { altitude: fmt(800), speed: fmt(7456, 0), distanceUnit: SI.altitude, speedUnit: SI.speed })}</p>
              </div>
              <p className="footnote">{tx("common:textSizeNote")}</p>
              <div className="dialog-actions">
                <button
                  className="button outline"
                  disabled={textSize === 100}
                  onClick={() => setTextSize(100)}
                >{tx("common:resetTextSize")}</button>
                <button
                  className="button primary"
                  onClick={() => setOpen(false)}
                >{tx("common:done")}</button>
              </div>
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
