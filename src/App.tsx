import { tx, msg, renderMessage, useLocale, type MessageRef } from "./i18n";
import { SI } from "./i18n/units";
import { formatDate } from "./i18n/format";
import { bodyName, cutoffLabel, errorMessage, requestError } from "./i18n/messages";
import { DomainError } from "./messages";
import { LanguageSettings } from "./components/LanguageSettings";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  CirclePause,
  CirclePlay,
  Copy,
  FolderOpen,
  Globe2,
  Layers3,
  Orbit,
  Plus,
  Radio,
  Rocket,
  RotateCcw,
  Save,
  Settings2,
  SkipForward,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import {
  DEFAULT_LAUNCH,
  DEFAULT_MANEUVER,
  DEFAULT_SCENE,
  COLORS,
  EARTH,
} from "./defaults";
import type {
  CentralBody,
  LaunchConfig,
  ManeuverSpec,
  OrbitSummary,
  SavedConfiguration,
  SceneConfig,
} from "./types";
import {
  altitudeForSpeed,
  circularSpeed,
  G,
  G0,
  orbitSummary,
} from "./physics/core";
import { norm } from "./physics/vector";
import { orbitalFrame, phaseInPlane } from "./physics/frames";
import { nextEquatorialNode } from "./physics/planeChange";
import { useAppSettings } from "./useAppSettings";
import { useSimulation } from "./useSimulation";
import { Universe } from "./components/Universe";
import { TextSizeSettings } from "./components/TextSizeSettings";
import {
  formatNumber as fmt,
  formatTime,
  Metric,
  NumberField,
  SectionTitle,
} from "./components/Fields";

type Tab = "orbit" | "maneuver" | "inclination" | "launch";
interface Dialog {
  title: MessageRef;
  description: MessageRef;
  confirm: MessageRef;
  input?: string;
  action: (value: string) => void | Promise<void>;
  danger?: boolean;
}
const cloneDefault = () => structuredClone(DEFAULT_SCENE);
const sceneString = (config: SceneConfig) => JSON.stringify(config);
const validCentral = (c: CentralBody) =>
  c.name.trim().length > 0 &&
  c.name.trim().length <= 80 &&
  Number.isFinite(c.mass) &&
  c.mass >= 1e10 &&
  c.mass <= 1e32 &&
  Number.isFinite(c.radius) &&
  c.radius >= 1 &&
  c.radius <= 1e10;
const validManeuver = (m: ManeuverSpec) =>
  Number.isFinite(m.deltaV) &&
  m.deltaV >= 0 &&
  m.deltaV <= 1e6 &&
  Number.isFinite(m.duration) &&
  m.duration > 0 &&
  m.duration <= 7200 &&
  Number.isFinite(m.angle) &&
  Math.abs(m.angle) <= 360 && Number.isFinite(m.elevation) && Math.abs(m.elevation) <= 90;
const validLaunch = (l: LaunchConfig) =>
  Object.values(l).every(Number.isFinite) &&
  l.dryMass >= 1 &&
  l.dryMass <= 1e10 &&
  l.fuelMass > 0 &&
  l.fuelMass <= 1e10 &&
  l.isp > 0 &&
  l.isp <= 10000 &&
  l.thrust > 0 &&
  l.thrust <= 1e12 &&
  l.burnTime > 0 &&
  l.burnTime <= 7200 &&
  l.turnStart >= 0 &&
  l.turnEnd > l.turnStart &&
  l.pitch >= -90 &&
  l.pitch <= 90 && Math.abs(l.latitude) <= 90 && Math.abs(l.longitude) <= 180 && l.azimuth >= 0 && l.azimuth <= 360;
const orbitLabel = (orbit: OrbitSummary) =>
  orbit.kind === "impact"
    ? tx("sandbox:impact")
    : orbit.kind === "escape"
      ? tx("sandbox:escape")
      : orbit.eccentricity < 0.0001
        ? tx("sandbox:circular")
        : tx("sandbox:elliptical");

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  try {
    const response = await fetch(url, init);
    if (response.status === 204) return undefined as T;
    const data = await response.json();
    if (!response.ok) throw requestError(data);
    return data;
  } catch (error) {
    throw error instanceof DomainError ? error : new DomainError("REQUEST_FAILED");
  }
}

function OrbitalMetrics({ orbit }: { orbit: OrbitSummary }) {
  return (
    <div className="metric-grid">
      <Metric
        label={tx("sandbox:apoapsis")}
        value={
          orbit.apoapsis === null ? tx("sandbox:unbounded") : fmt(orbit.apoapsis / 1000)
        }
        unit={orbit.apoapsis === null ? "" : "km"}
      />
      <Metric label={tx("sandbox:periapsis")} value={fmt(orbit.periapsis / 1000)} unit={SI.altitude} />
      <Metric label={tx("sandbox:eccentricity")} value={fmt(orbit.eccentricity, 4)} />
      <Metric
        label={tx("sandbox:period")}
        value={orbit.period === null ? "—" : formatTime(orbit.period)}
      />
      <Metric label={tx("sandbox:metricInclination")} value={orbit.inclination === null ? "N/A" : fmt(orbit.inclination, 3)} unit={orbit.inclination === null ? "" : "deg"} />
      <Metric label={tx("sandbox:metricNode")} value={orbit.ascendingNode === null ? "N/A" : fmt(orbit.ascendingNode, 3)} unit={orbit.ascendingNode === null ? "" : "deg"} />
    </div>
  );
}

export default function App() {
  useLocale();
  const appSettings = useAppSettings();
  const writesBlocked = appSettings.readOnly;
  const writeReason = appSettings.status === "loading" ? msg("common:settingsLoading")
    : appSettings.status === "error" ? msg("common:settingsUnavailable") : msg("common:demoReadOnly");
  const [toast, setToast] = useState<{ text: MessageRef; error?: boolean } | null>(
    null,
  );
  const notify = useCallback(
    (text: MessageRef, error = false) => setToast({ text, error }),
    [],
  );
  const { snapshot, prediction, post, predict, cancelPrediction } =
    useSimulation((error) => {
      setPredicting(false);
      setPredictionError(errorMessage(error));
      notify(errorMessage(error), true);
    });
  const [predictionError, setPredictionError] = useState<MessageRef | "">("");
  const [targetInclination, setTargetInclination] = useState(30);
  const [config, setConfig] = useState<SceneConfig>(cloneDefault);
  const [baseline, setBaseline] = useState(sceneString(DEFAULT_SCENE));
  const [centralDraft, setCentralDraft] = useState<CentralBody>({ ...EARTH });
  const [selectedId, setSelectedId] = useState("odyssey");
  const [tab, setTab] = useState<Tab>("orbit");
  const [maneuver, setManeuver] = useState<ManeuverSpec>({
    ...DEFAULT_MANEUVER,
  });
  const [launch, setLaunch] = useState<LaunchConfig>({ ...DEFAULT_LAUNCH });
  const [previewEnabled, setPreviewEnabled] = useState(true);
  const [predicting, setPredicting] = useState(false);
  const [showOrbits, setShowOrbits] = useState(
    () => localStorage.getItem("orbital-lab.orbits") !== "false",
  );
  const [showTrails, setShowTrails] = useState(
    () => localStorage.getItem("orbital-lab.trails") !== "false",
  );
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [library, setLibrary] = useState<SavedConfiguration[]>([]);
  const [libraryError, setLibraryError] = useState<MessageRef | "">("");
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [loadedName, setLoadedName] = useState("");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dialogText, setDialogText] = useState("");
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);
  const inspectorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    inspectorRef.current?.scrollTo({ top: 0 });
  }, [tab]);
  const [orbitError, setOrbitError] = useState<MessageRef | "">("");
  const selected = snapshot.bodies.find((b) => b.id === selectedId);
  const selectedConfig = config.orbiters.find((b) => b.id === selectedId);
  const [orbitDraft, setOrbitDraft] = useState({
    name: "Odyssey",
    altitude: 800000,
    speed: circularSpeed(EARTH, 800000),
    inclination: 0,
    ascendingNode: 0,
    phase: 28,
  });
  const dirty = sceneString(config) !== baseline;
  const actualOrbit = selected
    ? orbitSummary(selected, snapshot.central)
    : null;
  const activeEngine =
    !!selected?.burn || !!(selected?.launch && !selected.launch.cutoff);
  const planeDefined = !!selected && !!orbitalFrame(selected).normal;
  const maneuverDirectionValid = planeDefined || !["normal", "antinormal", "custom"].includes(maneuver.direction);
  const nextNode = selected && !activeEngine ? nextEquatorialNode(selected, snapshot.central) : null;
  const currentConfigRef = useRef(config);
  currentConfigRef.current = config;

  useEffect(() => {
    if (selectedConfig) {
      setOrbitDraft({
        ...selectedConfig,
        speed: circularSpeed(config.central, selectedConfig.altitude),
      });
      setOrbitError("");
    }
  }, [selectedId, selectedConfig, config.central]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), toast.error ? 8000 : 4000);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  useEffect(() => {
    localStorage.setItem("orbital-lab.orbits", String(showOrbits));
    localStorage.setItem("orbital-lab.trails", String(showTrails));
  }, [showOrbits, showTrails]);
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (
        e.code === "Space" &&
        !(
          e.target instanceof HTMLElement &&
          (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(
            e.target.tagName,
          ) ||
            e.target.isContentEditable)
        ) &&
        !dialog &&
        !help &&
        !libraryOpen
      ) {
        e.preventDefault();
        setPreviewEnabled(false);
        cancelPrediction();
        post({ type: "running", value: !snapshot.running });
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [snapshot.running, post, dialog, help, libraryOpen, cancelPrediction]);
  useEffect(() => {
    const handle = (e: BeforeUnloadEvent) => {
      if (sceneString(currentConfigRef.current) !== baseline) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handle);
    return () => window.removeEventListener("beforeunload", handle);
  }, [baseline]);

  useEffect(() => {
    cancelPrediction();
    setPredicting(false);
    setPredictionError("");
    if (!previewEnabled || tab === "orbit") return;
    if (
      tab === "maneuver" &&
      (!selected ||
        selected.status !== "flying" ||
        activeEngine ||
        !validManeuver(maneuver) || !maneuverDirectionValid)
    )
      return;
    if (tab === "launch" && !validLaunch(launch)) return;
    if (tab === "inclination" && (!selected || selected.status !== "flying" || activeEngine || !planeDefined || snapshot.pendingPlaneChange || !Number.isFinite(targetInclination) || targetInclination < 0 || targetInclination > 180)) return;
    post({ type: "running", value: false });
    setPredicting(true);
    const timer = setTimeout(() => {
      if (tab === "maneuver") predict({ id: selectedId, spec: maneuver });
      else if (tab === "inclination") predict({ id: selectedId, targetInclination });
      else predict({ id: "launch-preview", launch });
    }, 220);
    return () => {
      clearTimeout(timer);
      cancelPrediction();
    };
    // Only committed physics edits invalidate a paused preview, not each telemetry frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tab,
    maneuver,
    targetInclination,
    launch,
    selectedId,
    previewEnabled,
    config.central,
    snapshot.revision,
    snapshot.pendingPlaneChange,
    cancelPrediction,
    post,
    predict,
  ]);
  useEffect(() => {
    if (prediction) setPredicting(false);
  }, [prediction]);

  const openDialog = (value: Dialog) => {
    setDialogText(value.input ?? "");
    setDialog(value);
  };
  const confirmUnsaved = (action: () => void) => {
    if (dirty)
      openDialog({
        title: msg("common:discardTitle"),
        description:
          msg("common:discardDescription"),
        confirm: msg("common:discardContinue"),
        danger: true,
        action,
      });
    else action();
  };
  const refreshLibrary = async () => {
    setLibraryLoading(true);
    setLibraryError("");
    try {
      setLibrary(
        (
          await request<{ configurations: SavedConfiguration[] }>(
            "/api/configurations",
          )
        ).configurations,
      );
    } catch (error) {
      setLibraryError(errorMessage(error));
    } finally {
      setLibraryLoading(false);
    }
  };
  const openLibrary = () => {
    post({ type: "running", value: false });
    setLibraryOpen(true);
    void refreshLibrary();
  };
  const requireWritable = () => {
    if (!writesBlocked) return true;
    notify(writeReason, true);
    return false;
  };
  const saveScene = async (id: string, name: string) => {
    if (!requireWritable()) return;
    const captured = structuredClone(config);
    const saved = await request<SavedConfiguration>(
      `/api/configurations/${id}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...captured, name: name.trim() }),
      },
    );
    setLoadedId(saved.id);
    setLoadedName(saved.name);
    setBaseline(sceneString(captured));
    setLibrary((previous) => [
      ...previous.filter((entry) => entry.id !== saved.id),
      saved,
    ]);
    notify(msg("common:saved"));
  };
  const saveAs = () => {
    if (!requireWritable()) return;
    openDialog({
      title: msg("common:saveAs"),
      description:
        msg("common:saveDescription"),
      confirm: msg("common:save"),
      input: loadedId ? tx("common:copyName", { name: loadedName }) : tx("common:systemName", { name: config.central.name }),
      action: (value) => saveScene(crypto.randomUUID(), value),
    });
  };
  const save = () => {
    if (!requireWritable()) return;
    if (!loadedId) {
      saveAs();
      return;
    }
    openDialog({
      title: msg("common:overwriteTitle"),
      description: msg("common:overwriteDescription", { name: loadedName }),
      confirm: msg("common:overwrite"),
      action: () => saveScene(loadedId, loadedName),
    });
  };
  const loadScene = (saved: SavedConfiguration) =>
    confirmUnsaved(() => {
      const next = { central: saved.central, orbiters: saved.orbiters };
      setConfig(next);
      setCentralDraft({ ...next.central });
      setBaseline(sceneString(next));
      setLoadedId(saved.id);
      setLoadedName(saved.name);
      setSelectedId(saved.orbiters[0]?.id ?? "");
      setTab("orbit");
      setPreviewEnabled(false);
      cancelPrediction();
      post({ type: "reset", config: next });
      setLibraryOpen(false);
      inspectorRef.current?.scrollTo({ top: 0 });
      notify(msg("common:loaded", { name: saved.name }));
    });
  const chooseTab = (value: Tab) => {
    setTab(value);
    setPreviewEnabled(true);
    if (value !== "orbit") post({ type: "running", value: false });
  };
  const chooseBody = (id: string) => {
    if (!snapshot.bodies.some((b) => b.id === id)) return;
    setSelectedId(id);
    setPreviewEnabled(true);
  };
  const reset = () => {
    cancelPrediction();
    setPreviewEnabled(false);
    post({ type: "reset", config });
    setSelectedId(config.orbiters[0]?.id ?? "");
    notify(msg("sandbox:resetNotice"));
  };
  const addOrbiter = () => {
    const index = config.orbiters.length;
    const orbiter = {
      id: crypto.randomUUID(),
      name: `Satellite ${index + 1}`,
      color: COLORS[index % COLORS.length],
      altitude: config.central.radius * (0.2 + (index % 8) * 0.12),
      phase: (index * 137.5) % 360,
      inclination: 0,
      ascendingNode: 0,
    };
    setConfig((previous) => ({
      ...previous,
      orbiters: [...previous.orbiters, orbiter],
    }));
    post({ type: "add", orbiter });
    setSelectedId(orbiter.id);
    chooseTab("orbit");
  };
  const removeOrbiter = (id: string) => {
    setConfig((previous) => ({
      ...previous,
      orbiters: previous.orbiters.filter((b) => b.id !== id),
    }));
    post({ type: "remove", id });
    if (selectedId === id)
      setSelectedId(snapshot.bodies.find((b) => b.id !== id)?.id ?? "");
  };
  const applyCentral = () => {
    if (!validCentral(centralDraft)) {
      notify(
        msg("sandbox:centralValidation", { massUnit: SI.mass, distanceUnit: SI.distance }),
        true,
      );
      return;
    }
    const central = { ...centralDraft, name: centralDraft.name.trim() };
    setConfig((previous) => ({ ...previous, central }));
    setCentralDraft(central);
    post({ type: "central", central });
    notify(msg("sandbox:centralUpdated"));
  };
  const applyOrbit = () => {
    if (!selectedConfig || !selected) return;
    if (
      !orbitDraft.name.trim() ||
      orbitDraft.name.length > 80 ||
      !Number.isFinite(orbitDraft.altitude) ||
      orbitDraft.altitude < 1 ||
      orbitDraft.altitude > 1e12 ||
      ![orbitDraft.inclination, orbitDraft.ascendingNode, orbitDraft.phase].every(Number.isFinite) ||
      orbitDraft.inclination < 0 || orbitDraft.inclination > 180 ||
      orbitDraft.ascendingNode < 0 || orbitDraft.ascendingNode > 360 ||
      orbitDraft.phase < 0 || orbitDraft.phase > 360 ||
      orbitError
    ) {
      notify(
        msg("sandbox:orbitValidation"),
        true,
      );
      return;
    }
    const samePlane = orbitDraft.inclination === selectedConfig.inclination && orbitDraft.ascendingNode === selectedConfig.ascendingNode;
    const altitudeOnly = samePlane && orbitDraft.phase === selectedConfig.phase;
    const inclination = altitudeOnly && actualOrbit?.inclination != null ? actualOrbit.inclination : orbitDraft.inclination;
    const ascendingNode = altitudeOnly && actualOrbit?.inclination != null ? actualOrbit.ascendingNode ?? 0 : orbitDraft.ascendingNode;
    const phase = altitudeOnly ? phaseInPlane(selected.position, inclination, ascendingNode) : orbitDraft.phase;
    const orbiter = {
      ...selectedConfig,
      name: orbitDraft.name.trim(),
      altitude: orbitDraft.altitude,
      inclination,
      ascendingNode,
      phase,
    };
    setConfig((previous) => ({
      ...previous,
      orbiters: previous.orbiters.map((o) =>
        o.id === orbiter.id ? orbiter : o,
      ),
    }));
    post({ type: "orbit", orbiter });
    notify(msg("sandbox:orbitApplied"));
  };
  const updateManeuver = (value: Partial<ManeuverSpec>) => {
    setManeuver((previous) => ({ ...previous, ...value }));
    setPreviewEnabled(true);
  };
  const updateLaunch = (value: Partial<LaunchConfig>) => {
    setLaunch((previous) => ({ ...previous, ...value }));
    setPreviewEnabled(true);
  };
  const executeManeuver = () => {
    if (
      !selected ||
      !validManeuver(maneuver) || !maneuverDirectionValid ||
      !prediction ||
      predicting ||
      activeEngine
    )
      return;
    setPreviewEnabled(false);
    cancelPrediction();
    post({ type: "maneuver", id: selected.id, spec: maneuver });
    if (maneuver.mode === "finite") post({ type: "running", value: true });
    notify(
      maneuver.mode === "finite" ? msg("sandbox:finiteStarted") : msg("sandbox:impulseApplied"),
    );
  };
  const executeLaunch = () => {
    if (!validLaunch(launch) || !prediction || predicting) return;
    const id = `launch-${crypto.randomUUID()}`;
    setPreviewEnabled(false);
    cancelPrediction();
    setSelectedId(id);
    post({ type: "warp", value: 1 });
    post({ type: "launch", id, config: launch });
    notify(msg("sandbox:launchStarted"));
  };
  const activeCount = snapshot.bodies.filter(
    (b) => b.status !== "crashed",
  ).length;
  const actualSpeed = selected ? norm(selected.velocity) : 0;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">
            <Orbit size={27} strokeWidth={1.5} />
          </span>
          <div>
            <strong>
              ORBITAL<span>LAB</span>
            </strong>
            <small>{tx("common:tagline")}</small>
          </div>
          <span className="version-tag">{tx("common:version")}</span>
        </div>
        <div className="header-actions">
          <LanguageSettings />
          <TextSizeSettings />
          <span className="local-indicator">
            <i />{tx("common:localWorkspace")}</span>
          <button
            className="button subtle"
            aria-label={tx("common:configurations")}
            onClick={openLibrary}
          >
            <FolderOpen size={15} />
            <span>{tx("common:configurations")}</span>
          </button>
          <button
            className="button save-button"
            aria-label={tx("common:save")}
            onClick={save}
            disabled={writesBlocked}
            title={writesBlocked ? renderMessage(writeReason) : undefined}
            aria-describedby={writesBlocked ? "configuration-write-status" : undefined}
          >
            <Save size={15} />
            <span>{tx("common:save")}</span>
            {dirty && <i className="unsaved-dot" />}
          </button>
          <button
            className="icon-button help-button"
            title={tx("common:help")}
            aria-label={tx("common:help")}
            onClick={() => setHelp(true)}
          >
            <CircleHelp size={18} />
          </button>
        </div>
      </header>
      {writesBlocked && (
        <div className="settings-notice" id="configuration-write-status" role="status">
          {appSettings.settings?.demoMode && <strong className="demo-badge">{tx("common:demoMode")}</strong>}
          <span>{renderMessage(writeReason)}</span>
          {appSettings.status === "error" && <button className="button outline" onClick={appSettings.retry}>{tx("common:retrySettings")}</button>}
        </div>
      )}
      <div className="workspace-strip">
        <div>
          <span className="workspace-icon">
            <Layers3 size={14} />
          </span>
          <span>{tx("common:workspace")}</span>
          <ChevronRight size={12} />
          <strong>{loadedId ? loadedName : tx("common:untitled")}</strong>
          {dirty && <span className="muted">{tx("common:unsaved")}</span>}
        </div>
        <div>
          <span className="tiny-dot green" />{tx("common:simulation3d")}<span className="strip-divider" />{tx("common:siUnits")}</div>
      </div>
      <main className="main-layout">
        <aside className="left-sidebar">
          <section className="central-section">
            <SectionTitle right={<Globe2 size={16} />}>{tx("sandbox:centralBody")}</SectionTitle>
            <div className="planet-identity">
              <span className="mini-planet" />
              <div>
                <h3>{config.central.name}</h3>
                <span>{tx("sandbox:primary")}</span>
              </div>
              <span className="body-count">01</span>
            </div>
            <label className="field">
              <span>{tx("sandbox:name")}</span>
              <input
                aria-label={tx("sandbox:centralName")}
                maxLength={80}
                value={centralDraft.name}
                onChange={(e) =>
                  setCentralDraft((previous) => ({
                    ...previous,
                    name: e.target.value,
                  }))
                }
              />
            </label>
            <NumberField
              label={tx("sandbox:mass")}
              value={centralDraft.mass / 1e24}
              onChange={(value) =>
                setCentralDraft((previous) => ({
                  ...previous,
                  mass: value * 1e24,
                }))
              }
              unit={SI.massScale}
              min={1e-14}
            />
            <NumberField
              label={tx("sandbox:radius")}
              value={centralDraft.radius / 1000}
              onChange={(value) =>
                setCentralDraft((previous) => ({
                  ...previous,
                  radius: value * 1000,
                }))
              }
              unit={SI.altitude}
              min={0.001}
            />
            <div className="gravity-readout">
              <span>{tx("sandbox:surfaceGravity")}</span>
              <strong>
                {fmt((G * config.central.mass) / config.central.radius ** 2, 2)}{" "}
                <small>{SI.acceleration}</small>
              </strong>
            </div>
            <div className="row-buttons">
              <button className="button outline" onClick={applyCentral}>
                <Check size={13} />{tx("sandbox:applyChanges")}</button>
              <button
                className="icon-button outline"
                title={tx("sandbox:earthPreset")}
                aria-label={tx("sandbox:earthPreset")}
                onClick={() => setCentralDraft({ ...EARTH })}
              >
                <RotateCcw size={14} />
              </button>
            </div>
          </section>
          <section className="spacecraft-section">
            <SectionTitle
              right={
                <span className="count-pill">
                  {snapshot.bodies.length.toString().padStart(2, "0")}
                </span>
              }
            >{tx("sandbox:spacecraft")}</SectionTitle>
            <p className="section-description">{tx("sandbox:independent")}</p>
            <div className="spacecraft-list">
              {snapshot.bodies.map((body, index) => (
                <div
                  className={`spacecraft-card ${selectedId === body.id ? "selected" : ""}`}
                  key={body.id}
                  style={{ "--body-color": body.color } as React.CSSProperties}
                >
                  <button
                    className="spacecraft-select"
                    onClick={() => chooseBody(body.id)}
                  >
                    <span className="craft-symbol">
                      {body.launch ? <Rocket size={17} /> : <Orbit size={19} />}
                    </span>
                    <span>
                      <strong>{bodyName(body)}</strong>
                      <small>
                        {body.status === "crashed"
                          ? tx("sandbox:surfaceImpact")
                          : body.status === "landed"
                            ? tx("sandbox:landed")
                            : tx("sandbox:altitudeSummary", { altitude: fmt((norm(body.position) - snapshot.central.radius) / 1000, 0), unit: SI.altitude })}
                      </small>
                    </span>
                    <span className="craft-index">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                  </button>
                  <button
                    className="remove-craft"
                    title={tx("sandbox:remove", { name: bodyName(body) })}
                    aria-label={tx("sandbox:remove", { name: bodyName(body) })}
                    onClick={() => removeOrbiter(body.id)}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
            {snapshot.bodies.length === 0 && (
              <p className="empty-inline">{tx("sandbox:noCraft")}</p>
            )}
            <button className="add-spacecraft" onClick={addOrbiter}>
              <Plus size={15} />{tx("sandbox:addCraft")}</button>
          </section>
          <section className="display-section">
            <SectionTitle right={<Settings2 size={15} />}>{tx("sandbox:display")}</SectionTitle>
            <label className="toggle-row">
              <span>
                <i className="legend-line" />{tx("sandbox:orbitalPaths")}</span>
              <input
                type="checkbox"
                checked={showOrbits}
                onChange={(e) => setShowOrbits(e.target.checked)}
              />
              <i className="switch" />
            </label>
            <label className="toggle-row">
              <span>
                <i className="legend-line trail" />{tx("sandbox:flightTrails")}</span>
              <input
                type="checkbox"
                checked={showTrails}
                onChange={(e) => setShowTrails(e.target.checked)}
              />
              <i className="switch" />
            </label>
            <div className="model-note">
              <Radio size={14} />
              <span>{tx("sandbox:twoBody")}<br />
                <small>{tx("sandbox:modelShort")}</small>
              </span>
            </div>
          </section>
        </aside>
        <section className="scene-column">
          <Universe
            snapshot={snapshot}
            selectedId={selectedId}
            onSelect={chooseBody}
            prediction={prediction}
            showOrbits={showOrbits}
            showTrails={showTrails}
          />
          <div className="transport">
            <div className="play-controls">
              <button
                className={`play-button ${snapshot.running ? "playing" : ""}`}
                aria-label={
                  snapshot.running ? tx("sandbox:pause") : tx("sandbox:play")
                }
                onClick={() => {
                  setPreviewEnabled(false);
                  cancelPrediction();
                  post({ type: "running", value: !snapshot.running });
                }}
              >
                {snapshot.running ? (
                  <CirclePause size={22} />
                ) : (
                  <CirclePlay size={22} />
                )}
              </button>
              <button
                className="icon-button"
                title={tx("sandbox:step")}
                aria-label={tx("sandbox:step")}
                onClick={() => {
                  setPreviewEnabled(false);
                  cancelPrediction();
                  post({ type: "step" });
                }}
              >
                <SkipForward size={16} />
              </button>
              <button
                className="icon-button"
                title={tx("sandbox:reset")}
                aria-label={tx("sandbox:reset")}
                onClick={reset}
              >
                <RotateCcw size={15} />
              </button>
            </div>
            <div className="transport-time">
              <small>{tx("sandbox:elapsed")}</small>
              <strong>T+ {formatTime(snapshot.time)}</strong>
            </div>
            <div className="warp-controls">
              <span>{tx("sandbox:timeWarp")}</span>
              {[1, 10, 100, 1000].map((value) => (
                <button
                  key={value}
                  className={snapshot.warp === value ? "active" : ""}
                  onClick={() => post({ type: "warp", value })}
                >
                  {value}×
                </button>
              ))}
            </div>
          </div>
          {snapshot.pendingPlaneChange && (
            <div className="scheduled-banner" role="status">
              <span><strong>{tx("sandbox:armed")}</strong> · {bodyName(snapshot.bodies.find((b) => b.id === snapshot.pendingPlaneChange!.bodyId)!)} · T− {formatTime(snapshot.pendingPlaneChange.nodeTime - snapshot.time)} · {fmt(snapshot.pendingPlaneChange.targetInclination, 2)}° · {fmt(norm(snapshot.pendingPlaneChange.deltaV), 1)}{" "}{SI.speed}</span>
              <button className="button outline" onClick={() => { setPreviewEnabled(false); post({ type: "cancelPlaneChange" }); }}>{tx("sandbox:cancelPlaneChange")}</button>
            </div>
          )}
        </section>
        <aside className="right-sidebar">
          <div className="inspector-heading">
            <span className="overline">{tx("sandbox:flightComputer")}</span>
            <span className="live-label">
              <i />{tx("common:live")}</span>
          </div>
          <div className="inspector-tabs">
            <button
              className={tab === "orbit" ? "active" : ""}
              onClick={() => chooseTab("orbit")}
            >
              <Orbit size={14} />{tx("sandbox:orbitTab")}</button>
            <button
              className={tab === "maneuver" ? "active" : ""}
              onClick={() => chooseTab("maneuver")}
            >
              <Zap size={14} />{tx("sandbox:maneuverTab")}</button>
            <button
              className={tab === "inclination" ? "active" : ""}
              onClick={() => chooseTab("inclination")}
            >
              <Layers3 size={14} />{" "}{tx("sandbox:inclination")}</button>
            <button
              className={tab === "launch" ? "active" : ""}
              onClick={() => chooseTab("launch")}
            >
              <Rocket size={14} />{tx("sandbox:launchTab")}</button>
          </div>
          <div className="inspector-content" ref={inspectorRef}>
            {tab !== "launch" && (
              <>
                <div className="selected-heading">
                  <span
                    className="tiny-dot"
                    style={{ background: selected?.color ?? "#8490a0" }}
                  />
                  <h2>{selected ? bodyName(selected) : tx("sandbox:noSelection")}</h2>
                  <span className="selection-tag">{tx("common:selected")}</span>
                </div>
                {selected && actualOrbit && (
                  <>
                    <div
                      className={`orbit-status ${selected.status === "crashed" || actualOrbit.kind === "impact" ? "warning" : ""}`}
                    >
                      <i />
                      {selected.status === "crashed"
                        ? tx("sandbox:surfaceImpact")
                        : selected.status === "landed"
                          ? tx("sandbox:landed")
                          : activeEngine
                            ? tx("sandbox:powered")
                            : orbitLabel(actualOrbit)}
                    </div>
                    <div className="live-metrics">
                      <Metric
                        label={tx("sandbox:altitude")}
                        value={fmt(
                          Math.max(
                            0,
                            norm(selected.position) - snapshot.central.radius,
                          ) / 1000,
                        )}
                        unit={SI.altitude}
                        accent
                      />
                      <Metric
                        label={tx("sandbox:velocity")}
                        value={fmt(actualSpeed, 0)}
                        unit={SI.speed}
                      />
                    </div>
                  </>
                )}
              </>
            )}
            {tab === "orbit" && (
              <>
                {actualOrbit && (
                  <>
                    <OrbitalMetrics orbit={actualOrbit} />
                    <p className="footnote">{nextNode ? nextNode.kind === "equatorial" ? tx("sandbox:equatorialNote") : tx("sandbox:nextNode", { node: tx(nextNode.kind === tx("sandbox:ascending") ? "sandbox:ascending" : "sandbox:descending"), time: formatTime(nextNode.delay) }) : tx("sandbox:noNextNode")}</p>
                    <div className="section-rule" />
                  </>
                )}
                {selectedConfig ? (
                  <>
                    <SectionTitle
                      right={<span className="linked-tag">{tx("sandbox:linked")}</span>}
                    >{tx("sandbox:circularSetup")}</SectionTitle>
                    <p className="panel-description">{tx("sandbox:circularDescription")}</p>
                    <label className="field">
                      <span>{tx("sandbox:spacecraftName")}</span>
                      <input
                        aria-label={tx("sandbox:spacecraftName")}
                        maxLength={80}
                        value={orbitDraft.name}
                        onChange={(e) =>
                          setOrbitDraft((previous) => ({
                            ...previous,
                            name: e.target.value,
                          }))
                        }
                      />
                    </label>
                    <NumberField
                      label={tx("sandbox:orbitalAltitude")}
                      value={orbitDraft.altitude / 1000}
                      unit={SI.altitude}
                      min={0.001}
                      onChange={(value) => {
                        setOrbitError("");
                        setOrbitDraft((previous) => ({
                          ...previous,
                          altitude: value * 1000,
                          speed:
                            value * 1000 + config.central.radius > 0
                              ? circularSpeed(config.central, value * 1000)
                              : 0,
                        }));
                      }}
                    />
                    <div className="link-connector">
                      <span />↕<span />
                    </div>
                    <NumberField
                      label={tx("sandbox:circularVelocity")}
                      value={orbitDraft.speed}
                      unit={SI.speed}
                      min={0}
                      onChange={(value) => {
                        const altitude = altitudeForSpeed(
                          config.central,
                          value,
                        );
                        if (value > 0 && altitude >= 1 && altitude <= 1e12) {
                          setOrbitError("");
                          setOrbitDraft((previous) => ({
                            ...previous,
                            altitude,
                            speed: value,
                          }));
                        } else {
                          setOrbitError(
                            msg("sandbox:invalidCircularSpeed"),
                          );
                          setOrbitDraft((previous) => ({
                            ...previous,
                            speed: value,
                          }));
                        }
                      }}
                    />
                    <NumberField label={tx("sandbox:inclination")} value={orbitDraft.inclination} unit={SI.angle} min={0} max={180} onChange={(inclination) => setOrbitDraft((p) => ({ ...p, inclination }))} />
                    <NumberField label={tx("sandbox:nodeLongitude")} value={orbitDraft.ascendingNode} unit={SI.angle} min={0} max={360} onChange={(ascendingNode) => setOrbitDraft((p) => ({ ...p, ascendingNode }))} />
                    <NumberField label={tx("sandbox:initialPhase")} value={orbitDraft.phase} unit={SI.angle} min={0} max={360} onChange={(phase) => setOrbitDraft((p) => ({ ...p, phase }))} />
                    {orbitError && <p className="field-error">{renderMessage(orbitError)}</p>}
                    <button
                      className="button primary full"
                      onClick={applyOrbit}
                    >
                      <Orbit size={15} />{tx("sandbox:applyCircular")}<ArrowRight size={15} />
                    </button>
                    <p className="footnote">{tx("sandbox:circularNote")}</p>
                  </>
                ) : (
                  <div className="empty-panel">
                    <Orbit size={30} />
                    <h3>
                      {selected?.launch ? tx("sandbox:launchVehicle") : tx("sandbox:exploreTitle")}
                    </h3>
                    <p>
                      {selected?.launch
                        ? tx("sandbox:launchNotSaved")
                        : tx("sandbox:emptyOrbit")}
                    </p>
                    {!selected && (
                      <button className="button outline" onClick={addOrbiter}>
                        <Plus size={14} />{tx("sandbox:addCraft")}</button>
                    )}
                  </div>
                )}
              </>
            )}
            {tab === "maneuver" && (
              <>
                <div className="section-rule" />
                <SectionTitle>{tx("sandbox:planManeuver")}</SectionTitle>
                <p className="panel-description">{tx("sandbox:maneuverDescription")}</p>
                <div className="segmented">
                  <button
                    className={maneuver.mode === "impulse" ? "active" : ""}
                    onClick={() => updateManeuver({ mode: "impulse" })}
                  >{tx("sandbox:impulse")}</button>
                  <button
                    className={maneuver.mode === "finite" ? "active" : ""}
                    onClick={() => updateManeuver({ mode: "finite" })}
                  >{tx("sandbox:finite")}</button>
                </div>
                <NumberField
                  label={tx("sandbox:deltaV")}
                  value={maneuver.deltaV}
                  onChange={(value) => updateManeuver({ deltaV: value })}
                  unit={SI.speed}
                  min={0}
                  max={1e6}
                />
                {maneuver.mode === "finite" && (
                  <NumberField
                    label={tx("sandbox:burnDuration")}
                    value={maneuver.duration}
                    onChange={(value) => updateManeuver({ duration: value })}
                    unit={SI.time}
                    min={0.01}
                    max={7200}
                  />
                )}
                <label className="field">
                  <span>{tx("sandbox:direction")}</span>
                  <select
                    aria-label={tx("sandbox:direction")}
                    value={maneuver.direction}
                    onChange={(e) =>
                      updateManeuver({
                        direction: e.target.value as ManeuverSpec["direction"],
                      })
                    }
                  >
                    <option value="prograde">{tx("sandbox:prograde")}</option>
                    <option value="retrograde">{tx("sandbox:retrograde")}</option>
                    <option value="outward">{tx("sandbox:radialOut")}</option>
                    <option value="inward">{tx("sandbox:radialIn")}</option>
                    <option value="normal" disabled={!planeDefined}>{tx("sandbox:normal")}</option>
                    <option value="antinormal" disabled={!planeDefined}>{tx("sandbox:antiNormal")}</option>
                    <option value="custom" disabled={!planeDefined}>{tx("sandbox:custom")}</option>
                  </select>
                </label>
                {maneuver.direction === "custom" && (
                  <>
                    <NumberField
                      label={tx("sandbox:inPlaneAngle")}
                      value={maneuver.angle}
                      onChange={(value) => updateManeuver({ angle: value })}
                      unit={SI.angle}
                      min={-360}
                      max={360}
                    />
                    <NumberField label={tx("sandbox:outOfPlaneAngle")} value={maneuver.elevation} unit={SI.angle} min={-90} max={90} onChange={(elevation) => updateManeuver({ elevation })} />
                    <p className="footnote">{tx("sandbox:customNote")}</p>
                  </>
                )}
                {!planeDefined && <p className="footnote">{tx("sandbox:undefinedPlaneNote")}</p>}
                {predictionError && <p className="field-error" role="alert">{renderMessage(predictionError)}</p>}
                {!validManeuver(maneuver) && (
                  <p className="field-error">{tx("sandbox:maneuverValidation", { speedUnit: SI.speed, timeUnit: SI.time })}</p>
                )}
                {maneuver.mode === "finite" && (
                  <div className="info-box">
                    <Zap size={14} />
                    <span>{tx("sandbox:idealAcceleration", { value: fmt(maneuver.deltaV / maneuver.duration, 3), unit: SI.acceleration })}</span>
                  </div>
                )}
                {activeEngine ? (
                  <>
                    <div className="burn-progress">
                      <span>{tx("sandbox:engineActive")}</span>
                      <strong>
                        {selected?.burn
                          ? `${fmt(selected.burn.elapsed)} / ${fmt(selected.burn.spec.duration)} s`
                          : `${fmt(selected?.launch?.elapsed ?? 0)} s`}
                      </strong>
                      {selected?.burn && (
                        <>
                          <progress
                            max={selected.burn.spec.duration}
                            value={selected.burn.elapsed}
                          />
                          <small>{tx("sandbox:integratedAcceleration", { value: fmt(selected.burn.integratedDeltaV), unit: SI.speed })}</small>
                        </>
                      )}
                    </div>
                    <button
                      className="button danger full"
                      onClick={() => {
                        setPreviewEnabled(false);
                        post({ type: "abort", id: selectedId });
                      }}
                    >{tx("sandbox:stopEngine")}</button>
                  </>
                ) : (
                  <>
                    <div className="preview-box">
                      <div className="preview-heading">
                        <span className="tiny-dot amber" />
                        <span>{tx("sandbox:maneuverPreview")}</span>
                        <span>
                          {predicting
                            ? tx("common:computing")
                            : prediction
                              ? tx("common:ready")
                              : "—"}
                        </span>
                      </div>
                      {prediction ? (
                        <>
                          <p
                            className={
                              prediction.orbit.kind === "impact"
                                ? "warning-text"
                                : ""
                            }
                          >
                            {orbitLabel(prediction.orbit)}
                          </p>
                          <div className="compact-metrics">
                            <Metric label={tx("sandbox:metricInclination")} value={prediction.orbit.inclination === null ? "N/A" : fmt(prediction.orbit.inclination, 3)} unit={SI.angle} />
                            <Metric
                              label={tx("sandbox:apoapsis")}
                              value={
                                prediction.orbit.apoapsis === null
                                  ? tx("sandbox:unbounded")
                                  : fmt(prediction.orbit.apoapsis / 1000)
                              }
                              unit={
                                prediction.orbit.apoapsis === null ? "" : "km"
                              }
                            />
                            <Metric
                              label={tx("sandbox:periapsis")}
                              value={fmt(prediction.orbit.periapsis / 1000)}
                              unit={SI.altitude}
                            />
                          </div>
                          {prediction.zeroSpeedFallback && (
                            <p className="footnote">{tx("sandbox:zeroSpeed")}</p>
                          )}
                        </>
                      ) : (
                        <p>
                          {predicting
                            ? tx("sandbox:propagating")
                            : tx("sandbox:selectForManeuver")}
                        </p>
                      )}
                    </div>
                    <button
                      className="button outline full"
                      disabled={
                        !selected ||
                        selected.status !== "flying" ||
                        !validManeuver(maneuver) ||
                        !maneuverDirectionValid ||
                        predicting
                      }
                      onClick={() => {
                        if (previewEnabled)
                          predict({ id: selectedId, spec: maneuver });
                        else setPreviewEnabled(true);
                      }}
                    >{tx("sandbox:previewManeuver")}</button>
                    <button
                      className="button primary full"
                      disabled={
                        !prediction ||
                        predicting ||
                        !selected ||
                        selected.status !== "flying" ||
                        !validManeuver(maneuver)
                        || !maneuverDirectionValid
                      }
                      onClick={executeManeuver}
                    >
                      <Zap size={15} />
                      {maneuver.mode === "impulse"
                        ? tx("sandbox:executeImpulse")
                        : tx("sandbox:startFinite")}
                      <ArrowRight size={15} />
                    </button>
                  </>
                )}
                {selected?.lastBurn && (
                  <div className="info-box">
                    <Check size={14} />
                    <span>{tx("sandbox:lastManeuver", { integrated: fmt(selected.lastBurn.integratedDeltaV), actual: fmt(selected.lastBurn.velocityChange), unit: SI.speed })}</span>
                  </div>
                )}
              </>
            )}
            {tab === "inclination" && (
              <>
                <div className="section-rule" />
                <SectionTitle>{tx("sandbox:targetInclination")}</SectionTitle>
                <p className="panel-description">{tx("sandbox:targetDescription")}</p>
                {actualOrbit && <OrbitalMetrics orbit={actualOrbit} />}
                <NumberField label={tx("sandbox:targetInclination")} value={targetInclination} unit={SI.angle} min={0} max={180} onChange={(value) => { setTargetInclination(value); setPreviewEnabled(true); }} />
                {(targetInclination < 0 || targetInclination > 180) && <p className="field-error">{tx("sandbox:targetValidation")}</p>}
                {!planeDefined && <p className="field-error">{tx("sandbox:requirePlane")}</p>}
                {activeEngine && <p className="field-error">{tx("sandbox:stopForPlane")}</p>}
                {predictionError && <p className="field-error" role="alert">{renderMessage(predictionError)}</p>}
                {snapshot.pendingPlaneChange ? <p className="info-box">{tx("sandbox:pendingNote")}</p> : (
                  <>
                    <div className="preview-box">
                      <div className="preview-heading"><span className="tiny-dot amber" /><span>{tx("sandbox:planePreview")}</span><span>{predicting ? tx("common:computing") : prediction?.planeChange ? tx("common:ready") : "—"}</span></div>
                      {prediction?.planeChange ? <>
                        <p>{prediction.planeChange.node.kind === "equatorial" ? tx("sandbox:equatorialExecute") : tx("sandbox:nextNodeName", { node: tx(prediction.planeChange.node.kind === tx("sandbox:ascending") ? "sandbox:ascending" : "sandbox:descending") })}</p>
                        <div className="compact-metrics">
                          <Metric label={tx("sandbox:waitTime")} value={formatTime(prediction.planeChange.node.delay)} />
                          <Metric label={tx("sandbox:requiredDeltaV")} value={fmt(norm(prediction.planeChange.deltaV), 2)} unit={SI.speed} />
                          <Metric label={tx("sandbox:targetMetric")} value={fmt(prediction.orbit.inclination ?? 0, 3)} unit={SI.angle} />
                          <Metric label={tx("sandbox:nodeAltitude")} value={fmt((norm(prediction.planeChange.node.position) - snapshot.central.radius) / 1000)} unit={SI.altitude} />
                        </div>
                        <p className="footnote">{tx("sandbox:solverNote")}</p>
                      </> : <p>{predicting ? tx("sandbox:locatingNode") : tx("sandbox:selectForPlane")}</p>}
                    </div>
                    <button className="button outline full" disabled={!selected || selected.status !== "flying" || activeEngine || !planeDefined || targetInclination < 0 || targetInclination > 180 || predicting} onClick={() => { setPredictionError(""); if (previewEnabled) predict({ id: selectedId, targetInclination }); else setPreviewEnabled(true); }}>{tx("sandbox:previewPlane")}</button>
                    <button className="button primary full" disabled={!prediction?.planeChange || prediction.planeChange.targetInclination !== targetInclination || predicting || snapshot.running} onClick={() => {
                      if (!prediction?.planeChange) return;
                      post({ type: "schedulePlaneChange", plan: prediction.planeChange });
                      setPreviewEnabled(false); cancelPrediction();
                    }}><Layers3 size={15} />{" "}{tx("sandbox:executeAtNode")}</button>
                    <p className="footnote">{tx("sandbox:executionNote")}</p>
                  </>
                )}
                {snapshot.planeChangeResult?.bodyId === selectedId && <div className="info-box"><Check size={14} /><span>{tx("sandbox:planeExecuted", { time: formatTime(snapshot.planeChangeResult.time), inclination: fmt(snapshot.planeChangeResult.inclination ?? 0, 5), deltaV: fmt(snapshot.planeChangeResult.deltaV, 2), unit: SI.speed })}</span></div>}
              </>
            )}
            {tab === "launch" && (
              <>
                <div className="launch-heading">
                  <span>
                    <Rocket size={22} />
                  </span>
                  <div>
                    <h2>{tx("sandbox:launchVehicle")}</h2>
                    <p>{tx("sandbox:launchTagline")}</p>
                  </div>
                </div>
                <SectionTitle>{tx("sandbox:launchSite")}</SectionTitle>
                <div className="two-fields">
                  <NumberField label={tx("sandbox:latitude")} value={launch.latitude} unit={SI.angle} min={-90} max={90} onChange={(latitude) => updateLaunch({ latitude })} />
                  <NumberField label={tx("sandbox:longitude")} value={launch.longitude} unit={SI.angle} min={-180} max={180} onChange={(longitude) => updateLaunch({ longitude })} />
                </div>
                <NumberField label={tx("sandbox:azimuth")} value={launch.azimuth} unit={SI.angle} min={0} max={360} onChange={(azimuth) => updateLaunch({ azimuth })} />
                <p className="footnote">{tx("sandbox:headingNote")}</p>
                <SectionTitle>{tx("sandbox:propulsion")}</SectionTitle>
                <div className="two-fields">
                  <NumberField
                    label={tx("sandbox:dryMass")}
                    value={launch.dryMass}
                    unit={SI.mass}
                    min={1}
                    onChange={(value) => updateLaunch({ dryMass: value })}
                  />
                  <NumberField
                    label={tx("sandbox:propellant")}
                    value={launch.fuelMass}
                    unit={SI.mass}
                    min={0.01}
                    onChange={(value) => updateLaunch({ fuelMass: value })}
                  />
                  <NumberField
                    label={tx("sandbox:isp")}
                    value={launch.isp}
                    unit={SI.time}
                    min={0.01}
                    onChange={(value) => updateLaunch({ isp: value })}
                  />
                  <NumberField
                    label={tx("sandbox:thrust")}
                    value={launch.thrust / 1000}
                    unit={SI.force}
                    min={0.001}
                    onChange={(value) => updateLaunch({ thrust: value * 1000 })}
                  />
                </div>
                <NumberField
                  label={tx("sandbox:workTime")}
                  value={launch.burnTime}
                  unit={SI.time}
                  min={0.01}
                  max={7200}
                  onChange={(value) => updateLaunch({ burnTime: value })}
                />
                <div className="gravity-readout">
                  <span>{tx("sandbox:initialTwr")}</span>
                  <strong>
                    {fmt(
                      launch.thrust /
                        (((launch.dryMass + launch.fuelMass) *
                          G *
                          config.central.mass) /
                          config.central.radius ** 2),
                      2,
                    )}
                    <small> TWR</small>
                  </strong>
                </div>
                <details className="guidance-details" open>
                  <summary>{tx("sandbox:pitchProgram")}<ChevronDown size={14} />
                  </summary>
                  <div className="two-fields">
                    <NumberField
                      label={tx("sandbox:turnStart")}
                      value={launch.turnStart}
                      unit={SI.time}
                      min={0}
                      onChange={(value) => updateLaunch({ turnStart: value })}
                    />
                    <NumberField
                      label={tx("sandbox:turnEnd")}
                      value={launch.turnEnd}
                      unit={SI.time}
                      min={0.01}
                      onChange={(value) => updateLaunch({ turnEnd: value })}
                    />
                  </div>
                  <NumberField
                    label={tx("sandbox:pitch")}
                    value={launch.pitch}
                    unit={SI.angle}
                    min={-90}
                    max={90}
                    onChange={(value) => updateLaunch({ pitch: value })}
                  />
                  <p className="footnote">{tx("sandbox:pitchNote")}</p>
                </details>
                {!validLaunch(launch) && (
                  <p className="field-error">{tx("sandbox:launchValidation", { timeUnit: SI.time })}</p>
                )}
                <div className="preview-box">
                  <div className="preview-heading">
                    <span className="tiny-dot amber" />
                    <span>{tx("sandbox:cutoffPrediction")}</span>
                    <span>
                      {predicting
                        ? tx("common:computing")
                        : prediction?.cutoff
                          ? tx("common:ready")
                          : "—"}
                    </span>
                  </div>
                  {prediction?.cutoff ? (
                    <>
                      <p
                        className={
                          prediction.cutoff.orbit.kind === "impact"
                            ? "warning-text"
                            : ""
                        }
                      >
                        {prediction.final.status === "landed"
                          ? tx("sandbox:noLiftoff")
                          : orbitLabel(prediction.cutoff.orbit)}
                      </p>
                      <div className="compact-metrics">
                        <Metric label={tx("sandbox:cutoffInclination")} value={prediction.cutoff.orbit.inclination === null ? "N/A" : fmt(prediction.cutoff.orbit.inclination, 3)} unit={SI.angle} />
                        <Metric label={tx("sandbox:metricNode")} value={prediction.cutoff.orbit.ascendingNode === null ? "N/A" : fmt(prediction.cutoff.orbit.ascendingNode, 3)} unit={SI.angle} />
                        <Metric
                          label={tx("sandbox:cutoffAltitude")}
                          value={fmt(prediction.cutoff.altitude / 1000)}
                          unit={SI.altitude}
                        />
                        <Metric
                          label={tx("sandbox:cutoffVelocity")}
                          value={fmt(prediction.cutoff.speed, 0)}
                          unit={SI.speed}
                        />
                        <Metric
                          label={tx("sandbox:apoapsis")}
                          value={
                            prediction.cutoff.orbit.apoapsis === null
                              ? tx("sandbox:unbounded")
                              : fmt(prediction.cutoff.orbit.apoapsis / 1000)
                          }
                          unit={
                            prediction.cutoff.orbit.apoapsis === null
                              ? ""
                              : "km"
                          }
                        />
                        <Metric
                          label={tx("sandbox:periapsis")}
                          value={fmt(prediction.cutoff.orbit.periapsis / 1000)}
                          unit={SI.altitude}
                        />
                      </div>
                      <div className="cutoff-detail">
                        {tx("sandbox:cutoffSummary", { reason: cutoffLabel(prediction.cutoff.reason), time: fmt(prediction.cutoff.elapsed), timeUnit: SI.time })}<br />
                        {tx("sandbox:remainingFuel", { fuel: fmt(prediction.cutoff.fuel), unit: SI.mass })}
                      </div>
                    </>
                  ) : (
                    <p>
                      {predicting
                        ? tx("sandbox:simulatingLaunch")
                        : tx("sandbox:adjustLaunch")}
                    </p>
                  )}
                </div>
                <button
                  className="button primary full"
                  onClick={executeLaunch}
                  disabled={
                    !prediction?.cutoff || predicting || !validLaunch(launch)
                  }
                >
                  <Rocket size={15} />{tx("sandbox:launchButton")}<ArrowRight size={15} />
                </button>
                {!previewEnabled && (
                  <button
                    className="button outline full"
                    onClick={() => setPreviewEnabled(true)}
                  >{tx("sandbox:recalculateLaunch")}</button>
                )}
                {selected?.launch && (
                  <div className="live-launch">
                    <SectionTitle>{tx("sandbox:liveFlight")}</SectionTitle>
                    <div className="compact-metrics">
                      <Metric
                        label={tx("sandbox:engineTime")}
                        value={fmt(selected.launch.elapsed)}
                        unit={SI.time}
                      />
                      <Metric
                        label={tx("sandbox:propellantMetric")}
                        value={fmt(selected.launch.fuel, 0)}
                        unit={SI.mass}
                      />
                      <Metric
                        label={tx("sandbox:altitude")}
                        value={fmt(
                          Math.max(
                            0,
                            norm(selected.position) - snapshot.central.radius,
                          ) / 1000,
                        )}
                        unit={SI.altitude}
                      />
                      <Metric
                        label={tx("sandbox:velocity")}
                        value={fmt(actualSpeed, 0)}
                        unit={SI.speed}
                      />
                    </div>
                    <p className="footnote">
                      {selected.launch.cutoff ? cutoffLabel(selected.launch.cutoff.reason) : tx("sandbox:engineFiring")}
                    </p>
                    {selected.launch.cutoff && <><SectionTitle>{tx("sandbox:actualCutoff")}</SectionTitle><OrbitalMetrics orbit={selected.launch.cutoff.orbit} /></>}
                    {!selected.launch.cutoff && (
                      <button
                        className="button danger full"
                        onClick={() => {
                          setPreviewEnabled(false);
                          post({ type: "abort", id: selectedId });
                        }}
                      >{tx("sandbox:stopEngine")}</button>
                    )}
                    {selected.launch.cutoff && (
                      <button
                        className="button outline full"
                        onClick={() => chooseTab("maneuver")}
                      >{tx("sandbox:planManeuverButton")}<ArrowRight size={14} />
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </aside>
      </main>
      <footer className="status-bar">
        <div>
          <span className={`tiny-dot ${snapshot.running ? "green" : ""}`} />
          {snapshot.running ? tx("sandbox:running") : tx("sandbox:paused")}
          <span className="status-divider" />
          {tx("sandbox:activeBodies", { count: activeCount })}
        </div>
        <div>
          <span>{tx("sandbox:newtonian")}</span>
          <span className="status-divider" />
          <span>
            {snapshot.running && snapshot.achievedWarp < snapshot.warp * 0.85
              ? tx("sandbox:effectiveWarp", { actual: fmt(snapshot.achievedWarp, 0), requested: snapshot.warp })
              : "KEPLER + RK45"}
          </span>
          <span className="status-divider" />
          <span>{tx("sandbox:spaceTo")}{" "}{snapshot.running ? tx("sandbox:pauseShort") : tx("sandbox:playShort")}</span>
        </div>
      </footer>
      {toast && (
        <div role="status" className={`toast ${toast.error ? "error" : ""}`}>
          {toast.error ? <CircleHelp size={16} /> : <Check size={16} />}
          <span>{renderMessage(toast.text)}</span>
          <button
            className="icon-button"
            aria-label={tx("common:dismiss")}
            onClick={() => setToast(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {libraryOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setLibraryOpen(false);
          }}
        >
          <section
            className="modal library-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="library-title"
          >
            <div className="modal-heading">
              <div>
                <span className="overline">{tx("common:libraryHeading")}</span>
                <h2 id="library-title">{tx("common:libraryTitle")}</h2>
              <LanguageSettings />
              </div>
              <button
                className="icon-button"
                aria-label={tx("common:closeLibrary")}
                onClick={() => setLibraryOpen(false)}
              >
                <X size={18} />
              </button>
            </div>
            <p className="panel-description">
              {tx("common:libraryDescription", { file: "celestial-configs.json" })}
            </p>
            {writesBlocked && <p className="panel-description" role="status">{renderMessage(writeReason)}</p>}
            <div className="library-toolbar">
              <button className="button primary" onClick={saveAs} disabled={writesBlocked} title={writesBlocked ? renderMessage(writeReason) : undefined}>
                <Plus size={14} />{tx("common:saveAs")}</button>
              <button
                className="button outline"
                onClick={() => void refreshLibrary()}
              >
                <RotateCcw size={14} />{tx("common:refresh")}</button>
            </div>
            {libraryLoading && (
              <p className="empty-inline">{tx("common:reading")}</p>
            )}
            {libraryError && <div className="field-error">{renderMessage(libraryError)}</div>}
            {!libraryLoading && !libraryError && library.length === 0 && (
              <div className="empty-panel">
                <FolderOpen size={32} />
                <h3>{tx("common:libraryEmptyTitle")}</h3>
                <p>{tx("common:libraryEmpty")}</p>
              </div>
            )}
            <div className="library-list">
              {library.map((saved) => (
                <article className="saved-card" key={saved.id}>
                  <div className="saved-icon">
                    <Orbit size={22} />
                  </div>
                  <div className="saved-details">
                    <h3>
                      {saved.name}
                      {saved.id === loadedId && (
                        <span className="linked-tag">{tx("common:current")}</span>
                      )}
                    </h3>
                    <p>
                      {saved.central.name} · {tx("common:spacecraftCount", { count: saved.orbiters.length })}
                    </p>
                    <small>
                      {formatDate(saved.updatedAt)}
                    </small>
                  </div>
                  <button
                    className="button outline"
                    onClick={() => loadScene(saved)}
                  >
                    <ArrowDownToLine size={14} />{tx("common:load")}</button>
                  <button
                    className="icon-button delete-button"
                    aria-label={tx("common:deleteNamed", { name: saved.name })}
                    disabled={writesBlocked}
                    title={writesBlocked ? renderMessage(writeReason) : undefined}
                    onClick={() => {
                      if (!requireWritable()) return;
                      openDialog({
                        title: msg("common:deleteTitle"),
                        description: msg("common:deleteDescription", { name: saved.name }),
                        confirm: msg("common:delete"),
                        danger: true,
                        action: async () => {
                          if (!requireWritable()) return;
                          await request(`/api/configurations/${saved.id}`, {
                            method: "DELETE",
                          });
                          if (loadedId === saved.id) {
                            setLoadedId(null);
                            setLoadedName("");
                          }
                          await refreshLibrary();
                          notify(msg("common:deleted"));
                        },
                      });
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </article>
              ))}
            </div>
            <button
              className="button subtle"
              onClick={() =>
                confirmUnsaved(() => {
                  const next = cloneDefault();
                  setConfig(next);
                  setBaseline(sceneString(next));
                  setCentralDraft(next.central);
                  setLoadedId(null);
                  setLoadedName("");
                  setSelectedId(next.orbiters[0].id);
                  setTab("orbit");
                  setPreviewEnabled(false);
                  post({ type: "reset", config: next });
                  setLibraryOpen(false);
                })
              }
            >
              <RotateCcw size={14} />{tx("common:restoreDefault")}</button>
          </section>
        </div>
      )}
      {help && (
        <div className="modal-backdrop">
          <section
            className="modal help-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-title"
          >
            <div className="modal-heading">
              <h2 id="help-title">{tx("help:title")}</h2>
              <LanguageSettings />
              <button
                className="icon-button"
                aria-label={tx("help:close")}
                onClick={() => setHelp(false)}
              >
                <X size={18} />
              </button>
            </div>
            <p>{tx("help:intro")}</p>
            <ol>
              <li>
                <strong>{tx("help:worldTitle")}</strong>{" "}{tx("help:world")}</li>
              <li>
                <strong>{tx("help:orbitTitle")}</strong>{" "}{tx("help:orbit")}</li>
              <li>
                <strong>{tx("help:maneuverTitle")}</strong>{" "}{tx("help:maneuver")}</li>
              <li>
                <strong>{tx("help:launchTitle")}</strong>{" "}{tx("help:launch")}</li>
              <li>
                <strong>{tx("help:saveTitle")}</strong>{" "}{tx("help:save")}</li>
            </ol>
            <div className="info-box">{tx("help:model")}</div>
            <p className="footnote">
              {tx("help:controls", { distanceUnit: SI.distance, massUnit: SI.mass, timeUnit: SI.time })}
            </p>
          </section>
        </div>
      )}
      {dialog && (
        <div className="modal-backdrop dialog-layer">
          <form
            className="modal confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy || (dialog.input !== undefined && !dialogText.trim()))
                return;
              setBusy(true);
              try {
                await dialog.action(dialogText);
                setDialog(null);
              } catch (error) {
                notify(errorMessage(error), true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="modal-heading">
              <h2 id="confirm-title">{renderMessage(dialog.title)}</h2>
              <LanguageSettings />
              <button
                type="button"
                className="icon-button"
                aria-label={tx("common:closeDialog")}
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                <X size={18} />
              </button>
            </div>
            <p className="panel-description">{renderMessage(dialog.description)}</p>
            {dialog.input !== undefined && (
              <label className="field">
                <span>{tx("common:configurationName")}</span>
                <input
                  aria-label={tx("common:configurationName")}
                  autoFocus
                  required
                  maxLength={80}
                  value={dialogText}
                  onChange={(e) => setDialogText(e.target.value)}
                />
              </label>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="button outline"
                disabled={busy}
                onClick={() => setDialog(null)}
              >{tx("common:cancel")}</button>
              <button
                type="submit"
                className={`button ${dialog.danger ? "danger" : "primary"}`}
                disabled={
                  busy || (dialog.input !== undefined && !dialogText.trim())
                }
              >
                {busy ? tx("common:saving") : renderMessage(dialog.confirm)}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
