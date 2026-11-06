import { useState } from "react";
import { Globe2 } from "lucide-react";
import { changeLanguage, tx, useLocale } from "../i18n";
import { selectableLanguages } from "../i18n/languages";

export function LanguageSettings() {
  const language = useLocale();
  const [loading, setLoading] = useState(false);
  return <label className="language-settings" title={tx("common:language")}>
    <Globe2 size={18} aria-hidden="true" />
    <select aria-label={tx("common:language")} value={language} disabled={loading} onChange={async (event) => {
      const requested = event.currentTarget.value;
      setLoading(true);
      try { await changeLanguage(requested); } finally { setLoading(false); }
    }}>
      {selectableLanguages.map((entry) => <option key={entry.code} value={entry.code} lang={entry.code}>{entry.nativeName}</option>)}
    </select>
    {loading && <span className="sr-only" role="status">{tx("common:languageLoading")}</span>}
  </label>;
}
