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
  title: string;
  description: string;
  confirm: string;
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
    ? "Surface intersection"
    : orbit.kind === "escape"
      ? "Escape trajectory"
      : orbit.eccentricity < 0.0001
        ? "Circular orbit"
        : "Elliptical orbit";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (response.status === 204) return undefined as T;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "The request failed.");
  return data;
}

function OrbitalMetrics({ orbit }: { orbit: OrbitSummary }) {
  return (
    <div className="metric-grid">
      <Metric
        label="APOAPSIS"
        value={
          orbit.apoapsis === null ? "Unbounded" : fmt(orbit.apoapsis / 1000)
        }
        unit={orbit.apoapsis === null ? "" : "km"}
      />
      <Metric label="PERIAPSIS" value={fmt(orbit.periapsis / 1000)} unit="km" />
      <Metric label="ECCENTRICITY" value={fmt(orbit.eccentricity, 4)} />
      <Metric
        label="ORBITAL PERIOD"
        value={orbit.period === null ? "—" : formatTime(orbit.period)}
      />
      <Metric label="INCLINATION" value={orbit.inclination === null ? "N/A" : fmt(orbit.inclination, 3)} unit={orbit.inclination === null ? "" : "deg"} />
      <Metric label="ASCENDING NODE" value={orbit.ascendingNode === null ? "N/A" : fmt(orbit.ascendingNode, 3)} unit={orbit.ascendingNode === null ? "" : "deg"} />
    </div>
  );
}

export default function App() {
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(
    null,
  );
  const notify = useCallback(
    (text: string, error = false) => setToast({ text, error }),
    [],
  );
  const { snapshot, prediction, post, predict, cancelPrediction } =
    useSimulation((message) => {
      setPredicting(false);
      setPredictionError(message);
      notify(message, true);
    });
  const [predictionError, setPredictionError] = useState("");
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
  const [libraryError, setLibraryError] = useState("");
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [loadedName, setLoadedName] = useState("Untitled system");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dialogText, setDialogText] = useState("");
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);
  const inspectorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    inspectorRef.current?.scrollTo({ top: 0 });
  }, [tab]);
  const [orbitError, setOrbitError] = useState("");
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
        title: "Discard unsaved changes?",
        description:
          "The current system has changes that have not been saved. Loading another system will replace them.",
        confirm: "Discard & Continue",
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
      setLibraryError((error as Error).message);
    } finally {
      setLibraryLoading(false);
    }
  };
  const openLibrary = () => {
    post({ type: "running", value: false });
    setLibraryOpen(true);
    void refreshLibrary();
  };
  const saveScene = async (id: string, name: string) => {
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
    notify("Configuration saved to celestial-configs.json.");
  };
  const saveAs = () =>
    openDialog({
      title: "Save As",
      description:
        "Save the central body and initial circular orbits. Live maneuvers and launch vehicles are not included.",
      confirm: "Save Configuration",
      input: loadedId ? `${loadedName} copy` : `${config.central.name} system`,
      action: (value) => saveScene(crypto.randomUUID(), value),
    });
  const save = () => {
    if (!loadedId) {
      saveAs();
      return;
    }
    openDialog({
      title: "Overwrite configuration?",
      description: `Replace “${loadedName}” with the current initial configuration?`,
      confirm: "Overwrite",
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
      notify(`Loaded “${saved.name}”. Simulation paused.`);
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
    notify("Initial orbits restored.");
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
        "Enter a name, mass between 10¹⁰ and 10³² kg, and radius between 1 and 10¹⁰ m.",
        true,
      );
      return;
    }
    const central = { ...centralDraft, name: centralDraft.name.trim() };
    setConfig((previous) => ({ ...previous, central }));
    setCentralDraft(central);
    post({ type: "central", central });
    notify("Central body updated. Position and velocity preserved.");
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
        "Enter a name, a valid altitude, inclination 0–180°, and node longitude / phase 0–360°.",
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
    notify("Circular orbit applied. Simulation paused.");
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
      maneuver.mode === "finite" ? "Finite burn started." : "Impulse applied.",
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
    notify("Launch sequence started.");
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
            <small>GRAVITY IS YOUR PLAYGROUND</small>
          </div>
          <span className="version-tag">3D SANDBOX / 02</span>
        </div>
        <div className="header-actions">
          <TextSizeSettings />
          <span className="local-indicator">
            <i />
            LOCAL WORKSPACE
          </span>
          <button
            className="button subtle"
            aria-label="Configurations"
            onClick={openLibrary}
          >
            <FolderOpen size={15} />
            <span>Configurations</span>
          </button>
          <button
            className="button save-button"
            aria-label="Save Configuration"
            onClick={save}
          >
            <Save size={15} />
            <span>Save Configuration</span>
            {dirty && <i className="unsaved-dot" />}
          </button>
          <button
            className="icon-button help-button"
            title="Help"
            aria-label="Help"
            onClick={() => setHelp(true)}
          >
            <CircleHelp size={18} />
          </button>
        </div>
      </header>
      <div className="workspace-strip">
        <div>
          <span className="workspace-icon">
            <Layers3 size={14} />
          </span>
          <span>Workspace</span>
          <ChevronRight size={12} />
          <strong>{loadedName}</strong>
          {dirty && <span className="muted">Unsaved changes</span>}
        </div>
        <div>
          <span className="tiny-dot green" />
          3D SIMULATION
          <span className="strip-divider" />
          SI UNITS
        </div>
      </div>
      <main className="main-layout">
        <aside className="left-sidebar">
          <section className="central-section">
            <SectionTitle right={<Globe2 size={16} />}>
              Central body
            </SectionTitle>
            <div className="planet-identity">
              <span className="mini-planet" />
              <div>
                <h3>{config.central.name}</h3>
                <span>PRIMARY GRAVITY SOURCE</span>
              </div>
              <span className="body-count">01</span>
            </div>
            <label className="field">
              <span>Name</span>
              <input
                aria-label="Central body name"
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
              label="Mass"
              value={centralDraft.mass / 1e24}
              onChange={(value) =>
                setCentralDraft((previous) => ({
                  ...previous,
                  mass: value * 1e24,
                }))
              }
              unit="×10²⁴ kg"
              min={1e-14}
            />
            <NumberField
              label="Radius"
              value={centralDraft.radius / 1000}
              onChange={(value) =>
                setCentralDraft((previous) => ({
                  ...previous,
                  radius: value * 1000,
                }))
              }
              unit="km"
              min={0.001}
            />
            <div className="gravity-readout">
              <span>Surface gravity</span>
              <strong>
                {fmt((G * config.central.mass) / config.central.radius ** 2, 2)}{" "}
                <small>m/s²</small>
              </strong>
            </div>
            <div className="row-buttons">
              <button className="button outline" onClick={applyCentral}>
                <Check size={13} />
                Apply Changes
              </button>
              <button
                className="icon-button outline"
                title="Use Earth preset"
                aria-label="Use Earth preset"
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
            >
              Spacecraft
            </SectionTitle>
            <p className="section-description">
              Independent bodies. One shared gravity.
            </p>
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
                      <strong>{body.name}</strong>
                      <small>
                        {body.status === "crashed"
                          ? "Surface impact"
                          : body.status === "landed"
                            ? "On launchpad"
                            : `${fmt((norm(body.position) - snapshot.central.radius) / 1000, 0)} km altitude`}
                      </small>
                    </span>
                    <span className="craft-index">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                  </button>
                  <button
                    className="remove-craft"
                    title={`Remove ${body.name}`}
                    aria-label={`Remove ${body.name}`}
                    onClick={() => removeOrbiter(body.id)}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
            {snapshot.bodies.length === 0 && (
              <p className="empty-inline">
                No spacecraft yet. Add one to begin.
              </p>
            )}
            <button className="add-spacecraft" onClick={addOrbiter}>
              <Plus size={15} />
              Add Spacecraft
            </button>
          </section>
          <section className="display-section">
            <SectionTitle right={<Settings2 size={15} />}>Display</SectionTitle>
            <label className="toggle-row">
              <span>
                <i className="legend-line" />
                Orbital paths
              </span>
              <input
                type="checkbox"
                checked={showOrbits}
                onChange={(e) => setShowOrbits(e.target.checked)}
              />
              <i className="switch" />
            </label>
            <label className="toggle-row">
              <span>
                <i className="legend-line trail" />
                Flight trails
              </span>
              <input
                type="checkbox"
                checked={showTrails}
                onChange={(e) => setShowTrails(e.target.checked)}
              />
              <i className="switch" />
            </label>
            <div className="model-note">
              <Radio size={14} />
              <span>
                Two-body physics
                <br />
                <small>No atmosphere · No mutual gravity</small>
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
                  snapshot.running ? "Pause simulation" : "Play simulation"
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
                title="Step one second"
                aria-label="Step one second"
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
                title="Reset to initial orbits"
                aria-label="Reset to initial orbits"
                onClick={reset}
              >
                <RotateCcw size={15} />
              </button>
            </div>
            <div className="transport-time">
              <small>MISSION ELAPSED</small>
              <strong>T+ {formatTime(snapshot.time)}</strong>
            </div>
            <div className="warp-controls">
              <span>TIME WARP</span>
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
              <span><strong>PLANE CHANGE ARMED</strong> · {snapshot.bodies.find((b) => b.id === snapshot.pendingPlaneChange!.bodyId)?.name} · T− {formatTime(snapshot.pendingPlaneChange.nodeTime - snapshot.time)} · {fmt(snapshot.pendingPlaneChange.targetInclination, 2)}° · {fmt(norm(snapshot.pendingPlaneChange.deltaV), 1)} m/s</span>
              <button className="button outline" onClick={() => { setPreviewEnabled(false); post({ type: "cancelPlaneChange" }); }}>Cancel Plane Change</button>
            </div>
          )}
        </section>
        <aside className="right-sidebar">
          <div className="inspector-heading">
            <span className="overline">FLIGHT COMPUTER</span>
            <span className="live-label">
              <i />
              LIVE
            </span>
          </div>
          <div className="inspector-tabs">
            <button
              className={tab === "orbit" ? "active" : ""}
              onClick={() => chooseTab("orbit")}
            >
              <Orbit size={14} />
              Orbit
            </button>
            <button
              className={tab === "maneuver" ? "active" : ""}
              onClick={() => chooseTab("maneuver")}
            >
              <Zap size={14} />
              Maneuver
            </button>
            <button
              className={tab === "inclination" ? "active" : ""}
              onClick={() => chooseTab("inclination")}
            >
              <Layers3 size={14} /> Inclination
            </button>
            <button
              className={tab === "launch" ? "active" : ""}
              onClick={() => chooseTab("launch")}
            >
              <Rocket size={14} />
              Launch
            </button>
          </div>
          <div className="inspector-content" ref={inspectorRef}>
            {tab !== "launch" && (
              <>
                <div className="selected-heading">
                  <span
                    className="tiny-dot"
                    style={{ background: selected?.color ?? "#8490a0" }}
                  />
                  <h2>{selected?.name ?? "No spacecraft selected"}</h2>
                  <span className="selection-tag">SELECTED</span>
                </div>
                {selected && actualOrbit && (
                  <>
                    <div
                      className={`orbit-status ${selected.status === "crashed" || actualOrbit.kind === "impact" ? "warning" : ""}`}
                    >
                      <i />
                      {selected.status === "crashed"
                        ? "Surface impact"
                        : selected.status === "landed"
                          ? "On launchpad"
                          : activeEngine
                            ? "Powered flight"
                            : orbitLabel(actualOrbit)}
                    </div>
                    <div className="live-metrics">
                      <Metric
                        label="ALTITUDE"
                        value={fmt(
                          Math.max(
                            0,
                            norm(selected.position) - snapshot.central.radius,
                          ) / 1000,
                        )}
                        unit="km"
                        accent
                      />
                      <Metric
                        label="VELOCITY"
                        value={fmt(actualSpeed, 0)}
                        unit="m/s"
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
                    <p className="footnote">{nextNode ? nextNode.kind === "equatorial" ? "Equatorial orbit · every position lies on the reference plane." : `Next ${nextNode.kind} node in ${formatTime(nextNode.delay)}.` : "Next equatorial node: N/A"}</p>
                    <div className="section-rule" />
                  </>
                )}
                {selectedConfig ? (
                  <>
                    <SectionTitle
                      right={<span className="linked-tag">↔ LINKED</span>}
                    >
                      Circular orbit setup
                    </SectionTitle>
                    <p className="panel-description">
                      Altitude and velocity stay in sync for a circular orbit.
                    </p>
                    <label className="field">
                      <span>Spacecraft name</span>
                      <input
                        aria-label="Spacecraft name"
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
                      label="Orbital altitude"
                      value={orbitDraft.altitude / 1000}
                      unit="km"
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
                      label="Circular velocity"
                      value={orbitDraft.speed}
                      unit="m/s"
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
                            "This speed does not produce a circular orbit above the surface.",
                          );
                          setOrbitDraft((previous) => ({
                            ...previous,
                            speed: value,
                          }));
                        }
                      }}
                    />
                    <NumberField label="Inclination" value={orbitDraft.inclination} unit="deg" min={0} max={180} onChange={(inclination) => setOrbitDraft((p) => ({ ...p, inclination }))} />
                    <NumberField label="Ascending node longitude" value={orbitDraft.ascendingNode} unit="deg" min={0} max={360} onChange={(ascendingNode) => setOrbitDraft((p) => ({ ...p, ascendingNode }))} />
                    <NumberField label="Initial orbital phase" value={orbitDraft.phase} unit="deg" min={0} max={360} onChange={(phase) => setOrbitDraft((p) => ({ ...p, phase }))} />
                    {orbitError && <p className="field-error">{orbitError}</p>}
                    <button
                      className="button primary full"
                      onClick={applyOrbit}
                    >
                      <Orbit size={15} />
                      Apply Circular Orbit
                      <ArrowRight size={15} />
                    </button>
                    <p className="footnote">
                      Rebuilds a circular orbit and pauses. Altitude-only edits keep the live orbital plane and phase. Changing the plane or phase resets position to the editor setup. Inclination is measured from XY; +Z is north.
                    </p>
                  </>
                ) : (
                  <div className="empty-panel">
                    <Orbit size={30} />
                    <h3>
                      {selected?.launch ? "Launch vehicle" : "Start exploring"}
                    </h3>
                    <p>
                      {selected?.launch
                        ? "This live launch is not part of the saved initial configuration. Use Maneuver after engine cutoff."
                        : "Add a spacecraft or launch a vehicle to inspect its orbit."}
                    </p>
                    {!selected && (
                      <button className="button outline" onClick={addOrbiter}>
                        <Plus size={14} />
                        Add Spacecraft
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
            {tab === "maneuver" && (
              <>
                <div className="section-rule" />
                <SectionTitle>Plan a maneuver</SectionTitle>
                <p className="panel-description">
                  Shape your orbit with a change in velocity.
                </p>
                <div className="segmented">
                  <button
                    className={maneuver.mode === "impulse" ? "active" : ""}
                    onClick={() => updateManeuver({ mode: "impulse" })}
                  >
                    Instant impulse
                  </button>
                  <button
                    className={maneuver.mode === "finite" ? "active" : ""}
                    onClick={() => updateManeuver({ mode: "finite" })}
                  >
                    Finite burn
                  </button>
                </div>
                <NumberField
                  label="Delta-v"
                  value={maneuver.deltaV}
                  onChange={(value) => updateManeuver({ deltaV: value })}
                  unit="m/s"
                  min={0}
                  max={1e6}
                />
                {maneuver.mode === "finite" && (
                  <NumberField
                    label="Burn duration"
                    value={maneuver.duration}
                    onChange={(value) => updateManeuver({ duration: value })}
                    unit="s"
                    min={0.01}
                    max={7200}
                  />
                )}
                <label className="field">
                  <span>Acceleration direction</span>
                  <select
                    aria-label="Acceleration direction"
                    value={maneuver.direction}
                    onChange={(e) =>
                      updateManeuver({
                        direction: e.target.value as ManeuverSpec["direction"],
                      })
                    }
                  >
                    <option value="prograde">Prograde · along velocity</option>
                    <option value="retrograde">
                      Retrograde · against velocity
                    </option>
                    <option value="outward">
                      Radial out · away from center
                    </option>
                    <option value="inward">Radial in · toward center</option>
                    <option value="normal" disabled={!planeDefined}>Normal · +orbit normal</option>
                    <option value="antinormal" disabled={!planeDefined}>Anti-normal · −orbit normal</option>
                    <option value="custom" disabled={!planeDefined}>Custom 3D direction</option>
                  </select>
                </label>
                {maneuver.direction === "custom" && (
                  <>
                    <NumberField
                      label="In-plane angle"
                      value={maneuver.angle}
                      onChange={(value) => updateManeuver({ angle: value })}
                      unit="deg"
                      min={-360}
                      max={360}
                    />
                    <NumberField label="Out-of-plane angle" value={maneuver.elevation} unit="deg" min={-90} max={90} onChange={(elevation) => updateManeuver({ elevation })} />
                    <p className="footnote">
                      In-plane: 0° = transverse along motion; 90° = radial out. Out-of-plane: +90° = normal; −90° = anti-normal.
                    </p>
                  </>
                )}
                {!planeDefined && <p className="footnote">Orbital plane is undefined for radial or zero-speed motion. Normal and custom directions are unavailable; use prograde or radial thrust first.</p>}
                {predictionError && <p className="field-error" role="alert">{predictionError}</p>}
                {!validManeuver(maneuver) && (
                  <p className="field-error">
                    Use Δv 0–1,000,000 m/s, duration 0–7,200 s (exclusive of
                    zero), in-plane angle ±360°, and out-of-plane angle ±90°.
                  </p>
                )}
                {maneuver.mode === "finite" && (
                  <div className="info-box">
                    <Zap size={14} />
                    <span>
                      Ideal acceleration:{" "}
                      <strong>
                        {fmt(maneuver.deltaV / maneuver.duration, 3)} m/s²
                      </strong>
                      . Local direction updates in flight. No fuel consumed.
                    </span>
                  </div>
                )}
                {activeEngine ? (
                  <>
                    <div className="burn-progress">
                      <span>ENGINE ACTIVE</span>
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
                          <small>
                            Integrated acceleration:{" "}
                            {fmt(selected.burn.integratedDeltaV)} m/s
                          </small>
                        </>
                      )}
                    </div>
                    <button
                      className="button danger full"
                      onClick={() => {
                        setPreviewEnabled(false);
                        post({ type: "abort", id: selectedId });
                      }}
                    >
                      Stop Engine
                    </button>
                  </>
                ) : (
                  <>
                    <div className="preview-box">
                      <div className="preview-heading">
                        <span className="tiny-dot amber" />
                        <span>MANEUVER PREVIEW</span>
                        <span>
                          {predicting
                            ? "COMPUTING"
                            : prediction
                              ? "READY"
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
                            <Metric label="INCLINATION" value={prediction.orbit.inclination === null ? "N/A" : fmt(prediction.orbit.inclination, 3)} unit="deg" />
                            <Metric
                              label="APOAPSIS"
                              value={
                                prediction.orbit.apoapsis === null
                                  ? "Unbounded"
                                  : fmt(prediction.orbit.apoapsis / 1000)
                              }
                              unit={
                                prediction.orbit.apoapsis === null ? "" : "km"
                              }
                            />
                            <Metric
                              label="PERIAPSIS"
                              value={fmt(prediction.orbit.periapsis / 1000)}
                              unit="km"
                            />
                          </div>
                          {prediction.zeroSpeedFallback && (
                            <p className="footnote">
                              Velocity is zero; using the local tangent as
                              prograde.
                            </p>
                          )}
                        </>
                      ) : (
                        <p>
                          {predicting
                            ? "Propagating the proposed trajectory…"
                            : "Select a flying spacecraft and preview your maneuver."}
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
                    >
                      Preview Maneuver
                    </button>
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
                        ? "Execute Impulse"
                        : "Start Finite Burn"}
                      <ArrowRight size={15} />
                    </button>
                  </>
                )}
                {selected?.lastBurn && (
                  <div className="info-box">
                    <Check size={14} />
                    <span>
                      Last maneuver: integrated{" "}
                      {fmt(selected.lastBurn.integratedDeltaV)} m/s; actual
                      velocity-vector change{" "}
                      {fmt(selected.lastBurn.velocityChange)} m/s (includes
                      gravity).
                    </span>
                  </div>
                )}
              </>
            )}
            {tab === "inclination" && (
              <>
                <div className="section-rule" />
                <SectionTitle>Target inclination</SectionTitle>
                <p className="panel-description">Rotate the orbital plane at the next equatorial crossing while preserving orbital energy and shape. This is an ideal, fuel-free impulse.</p>
                {actualOrbit && <OrbitalMetrics orbit={actualOrbit} />}
                <NumberField label="Target inclination" value={targetInclination} unit="deg" min={0} max={180} onChange={(value) => { setTargetInclination(value); setPreviewEnabled(true); }} />
                {(targetInclination < 0 || targetInclination > 180) && <p className="field-error">Target inclination must be between 0° and 180°.</p>}
                {!planeDefined && <p className="field-error">An orbital plane is required. Use prograde or radial thrust first.</p>}
                {activeEngine && <p className="field-error">Stop the engine before planning a plane change.</p>}
                {predictionError && <p className="field-error" role="alert">{predictionError}</p>}
                {snapshot.pendingPlaneChange ? <p className="info-box">A plane change is armed. Use the simulation controls to pause or resume, or cancel it below the view before planning another.</p> : (
                  <>
                    <div className="preview-box">
                      <div className="preview-heading"><span className="tiny-dot amber" /><span>PLANE CHANGE PREVIEW</span><span>{predicting ? "COMPUTING" : prediction?.planeChange ? "READY" : "—"}</span></div>
                      {prediction?.planeChange ? <>
                        <p>{prediction.planeChange.node.kind === "equatorial" ? "Equatorial orbit · execute at current position" : `Next ${prediction.planeChange.node.kind} node`}</p>
                        <div className="compact-metrics">
                          <Metric label="WAIT TIME" value={formatTime(prediction.planeChange.node.delay)} />
                          <Metric label="REQUIRED DELTA-V" value={fmt(norm(prediction.planeChange.deltaV), 2)} unit="m/s" />
                          <Metric label="TARGET INCLINATION" value={fmt(prediction.orbit.inclination ?? 0, 3)} unit="deg" />
                          <Metric label="NODE ALTITUDE" value={fmt((norm(prediction.planeChange.node.position) - snapshot.central.radius) / 1000)} unit="km" />
                        </div>
                        <p className="footnote">The lowest Δv solution at this node is selected. Normal-only thrust generally changes speed and orbit shape; this maneuver combines velocity components.</p>
                      </> : <p>{predicting ? "Locating the next node and solving the velocity change…" : "Select a coasting spacecraft and preview a target between 0° and 180°."}</p>}
                    </div>
                    <button className="button outline full" disabled={!selected || selected.status !== "flying" || activeEngine || !planeDefined || targetInclination < 0 || targetInclination > 180 || predicting} onClick={() => { setPredictionError(""); if (previewEnabled) predict({ id: selectedId, targetInclination }); else setPreviewEnabled(true); }}>Preview Plane Change</button>
                    <button className="button primary full" disabled={!prediction?.planeChange || prediction.planeChange.targetInclination !== targetInclination || predicting || snapshot.running} onClick={() => {
                      if (!prediction?.planeChange) return;
                      post({ type: "schedulePlaneChange", plan: prediction.planeChange });
                      setPreviewEnabled(false); cancelPrediction();
                    }}><Layers3 size={15} /> Execute at Next Node</button>
                    <p className="footnote">Execution advances with simulation time. Pause or cancel at any time. Edits to the central body or this spacecraft cancel the plan.</p>
                  </>
                )}
                {snapshot.planeChangeResult?.bodyId === selectedId && <div className="info-box"><Check size={14} /><span>Plane change executed at T+ {formatTime(snapshot.planeChangeResult.time)}. Inclination: {fmt(snapshot.planeChangeResult.inclination ?? 0, 5)}° · Δv: {fmt(snapshot.planeChangeResult.deltaV, 2)} m/s.</span></div>}
              </>
            )}
            {tab === "launch" && (
              <>
                <div className="launch-heading">
                  <span>
                    <Rocket size={22} />
                  </span>
                  <div>
                    <h2>Launch vehicle</h2>
                    <p>From the surface to the stars.</p>
                  </div>
                </div>
                <SectionTitle>Launch site & heading</SectionTitle>
                <div className="two-fields">
                  <NumberField label="Launch latitude" value={launch.latitude} unit="deg" min={-90} max={90} onChange={(latitude) => updateLaunch({ latitude })} />
                  <NumberField label="Launch longitude" value={launch.longitude} unit="deg" min={-180} max={180} onChange={(longitude) => updateLaunch({ longitude })} />
                </div>
                <NumberField label="Launch azimuth" value={launch.azimuth} unit="deg" min={0} max={360} onChange={(azimuth) => updateLaunch({ azimuth })} />
                <p className="footnote">0° = local north · 90° = east. Non-rotating surface; zero initial velocity. At a polar site, longitude and azimuth select the launch meridian plane, which guidance keeps.</p>
                <SectionTitle>Vehicle & propulsion</SectionTitle>
                <div className="two-fields">
                  <NumberField
                    label="Dry mass"
                    value={launch.dryMass}
                    unit="kg"
                    min={1}
                    onChange={(value) => updateLaunch({ dryMass: value })}
                  />
                  <NumberField
                    label="Propellant"
                    value={launch.fuelMass}
                    unit="kg"
                    min={0.01}
                    onChange={(value) => updateLaunch({ fuelMass: value })}
                  />
                  <NumberField
                    label="Specific impulse"
                    value={launch.isp}
                    unit="s"
                    min={0.01}
                    onChange={(value) => updateLaunch({ isp: value })}
                  />
                  <NumberField
                    label="Thrust"
                    value={launch.thrust / 1000}
                    unit="kN"
                    min={0.001}
                    onChange={(value) => updateLaunch({ thrust: value * 1000 })}
                  />
                </div>
                <NumberField
                  label="Engine work time"
                  value={launch.burnTime}
                  unit="s"
                  min={0.01}
                  max={7200}
                  onChange={(value) => updateLaunch({ burnTime: value })}
                />
                <div className="gravity-readout">
                  <span>Initial thrust-to-weight</span>
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
                  <summary>
                    Automatic pitch program
                    <ChevronDown size={14} />
                  </summary>
                  <div className="two-fields">
                    <NumberField
                      label="Turn start"
                      value={launch.turnStart}
                      unit="s"
                      min={0}
                      onChange={(value) => updateLaunch({ turnStart: value })}
                    />
                    <NumberField
                      label="Turn end"
                      value={launch.turnEnd}
                      unit="s"
                      min={0.01}
                      onChange={(value) => updateLaunch({ turnEnd: value })}
                    />
                  </div>
                  <NumberField
                    label="Final pitch"
                    value={launch.pitch}
                    unit="deg"
                    min={-90}
                    max={90}
                    onChange={(value) => updateLaunch({ pitch: value })}
                  />
                  <p className="footnote">
                    90° = vertical · 0° = local horizon. A single continuous
                    burn; no automatic circularization.
                  </p>
                </details>
                {!validLaunch(launch) && (
                  <p className="field-error">
                    Use positive vehicle parameters, burn time ≤ 7,200 s, turn
                    end after turn start, pitch / latitude ±90°, longitude ±180°, and azimuth 0–360°.
                  </p>
                )}
                <div className="preview-box">
                  <div className="preview-heading">
                    <span className="tiny-dot amber" />
                    <span>ENGINE CUTOFF PREDICTION</span>
                    <span>
                      {predicting
                        ? "COMPUTING"
                        : prediction?.cutoff
                          ? "READY"
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
                          ? "No liftoff"
                          : orbitLabel(prediction.cutoff.orbit)}
                      </p>
                      <div className="compact-metrics">
                        <Metric label="CUTOFF INCLINATION" value={prediction.cutoff.orbit.inclination === null ? "N/A" : fmt(prediction.cutoff.orbit.inclination, 3)} unit="deg" />
                        <Metric label="ASCENDING NODE" value={prediction.cutoff.orbit.ascendingNode === null ? "N/A" : fmt(prediction.cutoff.orbit.ascendingNode, 3)} unit="deg" />
                        <Metric
                          label="CUTOFF ALTITUDE"
                          value={fmt(prediction.cutoff.altitude / 1000)}
                          unit="km"
                        />
                        <Metric
                          label="CUTOFF VELOCITY"
                          value={fmt(prediction.cutoff.speed, 0)}
                          unit="m/s"
                        />
                        <Metric
                          label="APOAPSIS"
                          value={
                            prediction.cutoff.orbit.apoapsis === null
                              ? "Unbounded"
                              : fmt(prediction.cutoff.orbit.apoapsis / 1000)
                          }
                          unit={
                            prediction.cutoff.orbit.apoapsis === null
                              ? ""
                              : "km"
                          }
                        />
                        <Metric
                          label="PERIAPSIS"
                          value={fmt(prediction.cutoff.orbit.periapsis / 1000)}
                          unit="km"
                        />
                      </div>
                      <div className="cutoff-detail">
                        {prediction.cutoff.reason} at{" "}
                        {fmt(prediction.cutoff.elapsed)} s<br />
                        Propellant remaining: {fmt(prediction.cutoff.fuel)} kg
                      </div>
                    </>
                  ) : (
                    <p>
                      {predicting
                        ? "Simulating ascent and engine cutoff…"
                        : "Adjust parameters to calculate a new launch."}
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
                  <Rocket size={15} />
                  Launch Vehicle
                  <ArrowRight size={15} />
                </button>
                {!previewEnabled && (
                  <button
                    className="button outline full"
                    onClick={() => setPreviewEnabled(true)}
                  >
                    Recalculate Launch
                  </button>
                )}
                {selected?.launch && (
                  <div className="live-launch">
                    <SectionTitle>Live flight</SectionTitle>
                    <div className="compact-metrics">
                      <Metric
                        label="ENGINE TIME"
                        value={fmt(selected.launch.elapsed)}
                        unit="s"
                      />
                      <Metric
                        label="PROPELLANT"
                        value={fmt(selected.launch.fuel, 0)}
                        unit="kg"
                      />
                      <Metric
                        label="ALTITUDE"
                        value={fmt(
                          Math.max(
                            0,
                            norm(selected.position) - snapshot.central.radius,
                          ) / 1000,
                        )}
                        unit="km"
                      />
                      <Metric
                        label="VELOCITY"
                        value={fmt(actualSpeed, 0)}
                        unit="m/s"
                      />
                    </div>
                    <p className="footnote">
                      {selected.launch.cutoff?.reason ?? "Engine firing"}
                    </p>
                    {selected.launch.cutoff && <><SectionTitle>Actual engine cutoff orbit</SectionTitle><OrbitalMetrics orbit={selected.launch.cutoff.orbit} /></>}
                    {!selected.launch.cutoff && (
                      <button
                        className="button danger full"
                        onClick={() => {
                          setPreviewEnabled(false);
                          post({ type: "abort", id: selectedId });
                        }}
                      >
                        Stop Engine
                      </button>
                    )}
                    {selected.launch.cutoff && (
                      <button
                        className="button outline full"
                        onClick={() => chooseTab("maneuver")}
                      >
                        Plan a Maneuver
                        <ArrowRight size={14} />
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
          {snapshot.running ? "Simulation running" : "Simulation paused"}
          <span className="status-divider" />
          {activeCount} active {activeCount === 1 ? "body" : "bodies"}
        </div>
        <div>
          <span>NEWTONIAN GRAVITY</span>
          <span className="status-divider" />
          <span>
            {snapshot.running && snapshot.achievedWarp < snapshot.warp * 0.85
              ? `${fmt(snapshot.achievedWarp, 0)}× effective / ${snapshot.warp}× requested`
              : "KEPLER + RK45"}
          </span>
          <span className="status-divider" />
          <span>SPACE TO {snapshot.running ? "PAUSE" : "PLAY"}</span>
        </div>
      </footer>
      {toast && (
        <div role="status" className={`toast ${toast.error ? "error" : ""}`}>
          {toast.error ? <CircleHelp size={16} /> : <Check size={16} />}
          <span>{toast.text}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
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
                <span className="overline">LOCAL CONFIGURATION LIBRARY</span>
                <h2 id="library-title">Your orbital systems</h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close configuration library"
                onClick={() => setLibraryOpen(false)}
              >
                <X size={18} />
              </button>
            </div>
            <p className="panel-description">
              Initial body settings, saved beside your project in{" "}
              <code>celestial-configs.json</code>.
            </p>
            <div className="library-toolbar">
              <button className="button primary" onClick={saveAs}>
                <Plus size={14} />
                Save As
              </button>
              <button
                className="button outline"
                onClick={() => void refreshLibrary()}
              >
                <RotateCcw size={14} />
                Refresh
              </button>
            </div>
            {libraryLoading && (
              <p className="empty-inline">Reading configurations…</p>
            )}
            {libraryError && <div className="field-error">{libraryError}</div>}
            {!libraryLoading && !libraryError && library.length === 0 && (
              <div className="empty-panel">
                <FolderOpen size={32} />
                <h3>A universe of possibilities</h3>
                <p>Save your first system to return to it later.</p>
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
                        <span className="linked-tag">CURRENT</span>
                      )}
                    </h3>
                    <p>
                      {saved.central.name} · {saved.orbiters.length} spacecraft
                    </p>
                    <small>
                      {new Date(saved.updatedAt).toLocaleString("en-US")}
                    </small>
                  </div>
                  <button
                    className="button outline"
                    onClick={() => loadScene(saved)}
                  >
                    <ArrowDownToLine size={14} />
                    Load Configuration
                  </button>
                  <button
                    className="icon-button delete-button"
                    aria-label={`Delete ${saved.name}`}
                    onClick={() =>
                      openDialog({
                        title: "Delete configuration?",
                        description: `Permanently remove “${saved.name}” from the local file? The current scene will stay open.`,
                        confirm: "Delete Configuration",
                        danger: true,
                        action: async () => {
                          await request(`/api/configurations/${saved.id}`, {
                            method: "DELETE",
                          });
                          if (loadedId === saved.id) {
                            setLoadedId(null);
                            setLoadedName("Untitled system");
                          }
                          await refreshLibrary();
                          notify("Configuration deleted.");
                        },
                      })
                    }
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
                  setLoadedName("Untitled system");
                  setSelectedId(next.orbiters[0].id);
                  setTab("orbit");
                  setPreviewEnabled(false);
                  post({ type: "reset", config: next });
                  setLibraryOpen(false);
                })
              }
            >
              <RotateCcw size={14} />
              Restore Default Example
            </button>
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
              <h2 id="help-title">Welcome to Orbital Lab</h2>
              <button
                className="icon-button"
                aria-label="Close help"
                onClick={() => setHelp(false)}
              >
                <X size={18} />
              </button>
            </div>
            <p>Explore three-dimensional orbits governed by Newtonian gravity.</p>
            <ol>
              <li>
                <strong>Set your world.</strong> Edit the central body's mass
                and radius, then apply.
              </li>
              <li>
                <strong>Build an orbit.</strong> Add spacecraft. Altitude and
                circular velocity are linked; applying resets that craft to a
                circular orbit.
              </li>
              <li>
                <strong>Change your trajectory.</strong> Preview a delta-v under
                Maneuver, then execute an instant impulse or finite ideal burn.
              </li>
              <li>
                <strong>Launch from the surface.</strong> Set vehicle and
                pitch-program parameters. A high apoapsis alone does not mean a
                stable orbit: periapsis must clear the surface.
              </li>
              <li>
                <strong>Keep your experiments.</strong> Save named initial
                configurations to the local JSON file. Live flight state is not
                saved.
              </li>
            </ol>
            <div className="info-box">
              The central body is fixed and non-rotating. There is no
              atmosphere, mutual gravity, staging, or automatic orbit insertion. Custom
              0° points along the local transverse direction of motion. Use Normal / Anti-normal for manual plane changes or Inclination to target a node impulse. Finite burns
              track local direction and do not consume fuel; launches do.
            </div>
            <p className="footnote">
              Drag to rotate · Right-drag to pan · Scroll to zoom · Space to play/pause. All internal
              calculations use meters, kilograms and seconds.
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
                notify((error as Error).message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="modal-heading">
              <h2 id="confirm-title">{dialog.title}</h2>
              <button
                type="button"
                className="icon-button"
                aria-label="Cancel dialog"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                <X size={18} />
              </button>
            </div>
            <p className="panel-description">{dialog.description}</p>
            {dialog.input !== undefined && (
              <label className="field">
                <span>Configuration name</span>
                <input
                  aria-label="Configuration name"
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
              >
                Cancel
              </button>
              <button
                type="submit"
                className={`button ${dialog.danger ? "danger" : "primary"}`}
                disabled={
                  busy || (dialog.input !== undefined && !dialogText.trim())
                }
              >
                {busy ? "Saving…" : dialog.confirm}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
