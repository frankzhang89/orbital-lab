import { tx, msg, renderMessage, useLocale, type MessageRef, type TranslationKey } from "../i18n";
import { bodyName } from "../i18n/messages";
import { SI } from "../i18n/units";
import { formatNumber as fmt } from "../i18n/format";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Crosshair, Minus, Plus, Scan, Focus, Layers3 } from "lucide-react";
import type { Prediction, Snapshot, Vec3 } from "../types";
import { muOf, orbitPath } from "../physics/core";
import { orbitalFrame } from "../physics/frames";
import { cross, dot, norm, scale, sub, unit } from "../physics/vector";

const UNIT = 1e6;
const planetVertex = `varying vec3 vNormal; varying vec3 vPosition; void main(){vNormal=normalize(normalMatrix*normal);vPosition=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
const planetFragment = `
varying vec3 vNormal; varying vec3 vPosition;
float hash(vec3 p){p=fract(p*.3183099+vec3(.1,.2,.3));p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float noise(vec3 x){vec3 i=floor(x),f=fract(x);f=f*f*(3.-2.*f);return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
float fbm(vec3 p){float n=0.;float a=.5;for(int i=0;i<5;i++){n+=a*noise(p);p=p*2.03+vec3(1.3,4.7,2.8);a*=.5;}return n;}
void main(){vec3 p=normalize(vPosition);float n=fbm(p*4.+vec3(2.4,1.2,.6));float land=smoothstep(.49,.52,n);vec3 ocean=mix(vec3(.028,.105,.19),vec3(.055,.25,.32),noise(p*17.));vec3 terrain=mix(vec3(.12,.24,.22),vec3(.28,.35,.24),fbm(p*22.));vec3 col=mix(ocean,terrain,land);float ice=smoothstep(.87,.99,abs(p.z)+fbm(p*14.)*.10);col=mix(col,vec3(.68,.78,.8),ice);float cloud=smoothstep(.59,.72,fbm(p*9.+5.));col=mix(col,vec3(.61,.72,.77),cloud*.55);vec3 light=normalize(vec3(-.8,.6,1.));float diffuse=max(0.,dot(normalize(vNormal),light));col*=.16+.95*diffuse;float rim=pow(1.-max(0.,vNormal.z),3.);col+=vec3(.12,.32,.48)*rim*.6;gl_FragColor=vec4(col,1.);}`;

interface Label {
  id: string; x: number; y: number; name: string; color: string;
  selected?: boolean; sub?: string; craft?: boolean;
}
const viewLabels = { top: "sandbox:viewTop", front: "sandbox:viewFront", side: "sandbox:viewSide", orbitPlane: "sandbox:viewOrbitPlane" } as const satisfies Record<string, TranslationKey>;
type View = "top" | "front" | "side" | "orbitPlane";
interface SceneControls {
  zoom: (factor: number) => void; fit: () => void; center: () => void;
  view: (view: View) => void;
}
interface Props {
  snapshot: Snapshot; selectedId: string; onSelect: (id: string) => void;
  prediction: Prediction | null; showOrbits: boolean; showTrails: boolean;
}

export function Universe(props: Props) {
  useLocale();
  const { snapshot, prediction, onSelect } = props;
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const controlsRef = useRef<SceneControls | null>(null);
  const [labels, setLabels] = useState<Label[]>([]);
  const [scaleKm, setScaleKm] = useState(1000);
  const [follow, setFollow] = useState(false);
  const followRef = useRef(false);
  followRef.current = follow;
  const [reference, setReference] = useState(true);
  const referenceRef = useRef(true);
  referenceRef.current = reference;
  const [webglError, setWebglError] = useState<MessageRef | "">("");

  useEffect(() => {
    const element = host.current!;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); }
    catch { setWebglError(msg("errors:WEBGL_UNAVAILABLE")); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x080e18, 1);
    element.prepend(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-20, 20, 20, -20, 0.001, 2000);
    camera.up.set(0, 0, 1);
    camera.position.set(35, -45, 32);
    const orbitControls = new OrbitControls(camera, renderer.domElement);
    orbitControls.enableDamping = true;
    orbitControls.dampingFactor = 0.12;
    orbitControls.minPolarAngle = 0.000001;
    orbitControls.maxPolarAngle = Math.PI - 0.000001;
    orbitControls.addEventListener("start", () => setFollow(false));
    let width = 1, height = 1, span = 34, disposed = false;
    let previousState: Snapshot | null = null, previousPrediction: Prediction | null = null;
    let previousSelection = "", previousOrbits = true, previousTrails = true, lastLabels = 0;
    const planet = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), new THREE.ShaderMaterial({ vertexShader: planetVertex, fragmentShader: planetFragment }));
    scene.add(planet);
    const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(1.035, 64, 48), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.BackSide,
      vertexShader: "varying vec3 n;varying vec3 v;void main(){vec4 p=modelViewMatrix*vec4(position,1.);n=normalize(normalMatrix*normal);v=normalize(-p.xyz);gl_Position=projectionMatrix*p;}",
      fragmentShader: "varying vec3 n;varying vec3 v;void main(){float a=pow(1.-abs(dot(normalize(n),normalize(v))),5.)*.24;gl_FragColor=vec4(.17,.52,.76,a);}",
    }));
    scene.add(atmosphere);
    const starPositions: number[] = [];
    let seed = 618;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < 3500; i++) {
      const z = 2 * random() - 1, angle = random() * Math.PI * 2, r = Math.sqrt(1 - z * z) * 650;
      starPositions.push(r * Math.cos(angle), r * Math.sin(angle), z * 650);
    }
    const stars = new THREE.Points(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(starPositions, 3)), new THREE.PointsMaterial({ color: 0xa3bbd1, size: 1.1, sizeAttenuation: false, transparent: true, opacity: 0.42, depthWrite: false }));
    scene.add(stars);
    const grid = new THREE.GridHelper(2, 16, 0x415d77, 0x22394e);
    grid.rotation.x = Math.PI / 2;
    grid.material.transparent = true; grid.material.opacity = 0.25; grid.material.depthWrite = false;
    scene.add(grid);
    const axis = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 1)]), new THREE.LineBasicMaterial({ color: 0x749fbc, transparent: true, opacity: 0.35 }));
    scene.add(axis);

    // Stable geometry/material objects; only their buffers and transforms change.
    const lines = new Map<string, THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>>();
    const markers = new Map<string, { group: THREE.Group; dot: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>; ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial> }>();
    const activeLines = new Set<string>();
    const line = (key: string, points: Vec3[], color: string | number, opacity: number, dashed = false) => {
      activeLines.add(key);
      let object = lines.get(key);
      if (!object) {
        const material = dashed ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 0.15, gapSize: 0.1 }) : new THREE.LineBasicMaterial({ color, transparent: true, opacity });
        object = new THREE.Line(new THREE.BufferGeometry(), material);
        lines.set(key, object); scene.add(object);
      }
      object.visible = points.length > 1;
      if (!object.visible) return;
      let attribute = object.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
      if (!attribute || attribute.count < points.length) {
        object.geometry.dispose();
        object.geometry = new THREE.BufferGeometry();
        attribute = new THREE.BufferAttribute(new Float32Array(Math.max(512, points.length) * 3), 3);
        attribute.setUsage(THREE.DynamicDrawUsage);
        object.geometry.setAttribute("position", attribute);
      }
      points.forEach((p, i) => attribute!.setXYZ(i, p[0] / UNIT, p[1] / UNIT, p[2] / UNIT));
      attribute.needsUpdate = true;
      object.geometry.setDrawRange(0, points.length);
      object.geometry.computeBoundingSphere();
      object.material.color.set(color); object.material.opacity = opacity;
      if (dashed) object.computeLineDistances();
    };
    const toWorld = (p: Vec3) => new THREE.Vector3(...p).multiplyScalar(1 / UNIT);
    const updateCamera = () => {
      const aspect = width / Math.max(1, height);
      camera.left = -span * aspect / 2; camera.right = span * aspect / 2;
      camera.top = span / 2; camera.bottom = -span / 2;
      camera.updateProjectionMatrix();
    };
    const fit = () => {
      const s = latest.current.snapshot;
      const extent = Math.max(s.central.radius * 1.8, ...s.bodies.map((b) => norm(b.position))) / UNIT;
      span = extent * 2.65 / Math.min(1, width / height);
      const direction = camera.position.clone().sub(orbitControls.target).normalize();
      orbitControls.target.set(0, 0, 0);
      camera.position.copy(direction.multiplyScalar(Math.max(50, extent * 5)));
      camera.far = Math.max(2000, extent * 30); camera.zoom = 1;
      orbitControls.minZoom = 0.0001; orbitControls.maxZoom = span / (s.central.radius / UNIT * 0.003);
      setFollow(false); updateCamera(); orbitControls.update();
    };
    const look = (direction: THREE.Vector3) => {
      const distance = camera.position.distanceTo(orbitControls.target);
      camera.position.copy(orbitControls.target).add(direction.normalize().multiplyScalar(distance));
      camera.lookAt(orbitControls.target); orbitControls.update();
    };
    controlsRef.current = {
      fit,
      zoom(factor) { camera.zoom = Math.max(orbitControls.minZoom, Math.min(orbitControls.maxZoom, camera.zoom / factor)); camera.updateProjectionMatrix(); },
      center() { camera.position.sub(orbitControls.target); orbitControls.target.set(0, 0, 0); setFollow(false); orbitControls.update(); },
      view(view) {
        const b = latest.current.snapshot.bodies.find((b) => b.id === latest.current.selectedId);
        const n = b ? orbitalFrame(b).normal : null;
        look(view === "top" ? new THREE.Vector3(0, -1e-6, 1) : view === "front" ? new THREE.Vector3(0, -1, 0) : view === "side" ? new THREE.Vector3(1, 0, 0) : n ? new THREE.Vector3(...n).add(new THREE.Vector3(0, -1e-6, 0)) : new THREE.Vector3(0, -1e-6, 1));
      },
    };
    const observer = new ResizeObserver((entries) => {
      width = Math.max(1, entries[0].contentRect.width); height = Math.max(1, entries[0].contentRect.height);
      renderer.setSize(width, height); updateCamera();
    });
    observer.observe(element);
    const viewDirection = new THREE.Vector3();
    const project = (p: Vec3) => {
      const world = toWorld(p), ndc = world.clone().project(camera);
      camera.getWorldDirection(viewDirection);
      const distance = world.dot(viewDirection), perpendicular2 = world.lengthSq() - distance * distance;
      const radius = latest.current.snapshot.central.radius / UNIT;
      const occluded = perpendicular2 < radius * radius && distance > -Math.sqrt(Math.max(0, radius * radius - perpendicular2)) + radius * 1e-7;
      return { x: (ndc.x + 1) / 2 * width, y: (1 - ndc.y) / 2 * height, visible: !occluded && ndc.z >= -1 && ndc.z <= 1, depth: distance };
    };
    let down: { x: number; y: number } | null = null;
    const pointerDown = (e: PointerEvent) => { if (e.button === 0) down = { x: e.clientX, y: e.clientY }; };
    const pointerUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) { down = null; return; }
      down = null;
      const rect = renderer.domElement.getBoundingClientRect(), textScale = parseFloat(getComputedStyle(document.documentElement).fontSize) / 13;
      const hits = latest.current.snapshot.bodies.map((b) => ({ b, p: project(b.position) })).filter(({ p }) => p.visible && Math.hypot(p.x - (e.clientX - rect.left), p.y - (e.clientY - rect.top)) < 18 * textScale).sort((a, b) => a.p.depth - b.p.depth);
      if (hits[0]) latest.current.onSelect(hits[0].b.id);
    };
    renderer.domElement.addEventListener("pointerdown", pointerDown);
    renderer.domElement.addEventListener("pointerup", pointerUp);
    fit();
    const animate = (now: number) => {
      if (disposed) return;
      const { snapshot: s, selectedId, prediction: pred, showOrbits, showTrails } = latest.current;
      const body = s.bodies.find((b) => b.id === selectedId);
      if (followRef.current && body) {
        const next = toWorld(body.position), delta = next.clone().sub(orbitControls.target);
        orbitControls.target.copy(next); camera.position.add(delta);
      }
      orbitControls.update(); camera.updateMatrixWorld();
      const radius = s.central.radius / UNIT;
      planet.scale.setScalar(radius); atmosphere.scale.setScalar(radius);
      grid.scale.setScalar(Math.max(radius * 3, span / camera.zoom)); grid.visible = referenceRef.current;
      axis.scale.setScalar(radius * 2.4); axis.visible = referenceRef.current;
      if (previousState !== s || previousPrediction !== pred || previousSelection !== selectedId || previousOrbits !== showOrbits || previousTrails !== showTrails) {
        activeLines.clear();
        for (const b of s.bodies) {
          if (showOrbits && b.status === "flying") line(`orbit-${b.id}`, orbitPath(b, s.central), b.color, b.id === selectedId ? 0.65 : 0.3);
          if (showTrails) line(`trail-${b.id}`, b.trail, b.color, 0.8);
          let marker = markers.get(b.id);
          if (!marker) {
            const group = new THREE.Group();
            const dot = new THREE.Mesh(new THREE.CircleGeometry(1, 20), new THREE.MeshBasicMaterial({ color: b.color }));
            const ring = new THREE.Mesh(new THREE.RingGeometry(2, 2.12, 40), new THREE.MeshBasicMaterial({ color: b.color, transparent: true, opacity: 0.65, depthWrite: false }));
            group.add(dot, ring); scene.add(group); marker = { group, dot, ring }; markers.set(b.id, marker);
          }
          marker.group.position.copy(toWorld(b.position));
          marker.dot.material.color.set(b.status === "crashed" ? "#ed7e7e" : b.color);
          marker.ring.material.color.set(b.color); marker.ring.visible = b.id === selectedId;
        }
        for (const [id, marker] of markers) if (!s.bodies.some((b) => b.id === id)) {
          scene.remove(marker.group); marker.dot.geometry.dispose(); marker.dot.material.dispose(); marker.ring.geometry.dispose(); marker.ring.material.dispose(); markers.delete(id);
        }
        if (pred) line("prediction", pred.path, "#f6dfa5", 0.9, true);
        for (const [key, object] of lines) if (!activeLines.has(key)) {
          scene.remove(object); object.geometry.dispose(); object.material.dispose(); lines.delete(key);
        }
        previousState = s; previousPrediction = pred; previousSelection = selectedId; previousOrbits = showOrbits; previousTrails = showTrails;
      }
      const textScale = parseFloat(getComputedStyle(document.documentElement).fontSize) / 13;
      const unitsPerPixel = span / camera.zoom / height;
      for (const [id, marker] of markers) {
        marker.dot.quaternion.copy(camera.quaternion); marker.ring.quaternion.copy(camera.quaternion);
        marker.group.scale.setScalar(unitsPerPixel * (id === selectedId ? 5 : 3.5) * textScale);
      }
      const previewLine = lines.get("prediction");
      if (previewLine?.material instanceof THREE.LineDashedMaterial) { previewLine.material.dashSize = unitsPerPixel * 7 * textScale; previewLine.material.gapSize = unitsPerPixel * 5 * textScale; }
      if (now - lastLabels > 70) {
        const nextLabels: Label[] = [];
        const plan = s.pendingPlaneChange ?? pred?.planeChange;
        const addLabel = (p: Vec3, label: Omit<Label, "x" | "y">) => {
          const point = project(p);
          if (point.visible && point.x > 0 && point.x < width && point.y > 0 && point.y < height) nextLabels.push({ ...label, x: point.x, y: point.y });
        };
        s.bodies.forEach((b) => addLabel(b.position, { id: b.id, name: bodyName(b), color: b.color, selected: b.id === selectedId, craft: true, sub: b.id === selectedId ? `${fmt((norm(b.position) - s.central.radius) / 1000, 0)} ${SI.altitude}` : undefined }));
        if (body && body.status === "flying") {
          const h = cross(body.position, body.velocity), p = dot(h, h) / muOf(s.central);
          const evec = sub(scale(cross(body.velocity, h), 1 / muOf(s.central)), unit(body.position)), e = norm(evec);
          if (e > 1e-5 && p > 1e-5) {
            const peri = scale(unit(evec), p / (1 + e));
            if (norm(peri) >= s.central.radius) addLabel(peri, { id: "peri", name: tx("sandbox:periMarker"), color: "#a4b4c8", sub: `${fmt((norm(peri) - s.central.radius) / 1000, 0)} ${SI.altitude}` });
            if (e < 0.99999) { const apo = scale(unit(evec), -p / (1 - e)); addLabel(apo, { id: "apo", name: tx("sandbox:apoMarker"), color: "#a4b4c8", sub: `${fmt((norm(apo) - s.central.radius) / 1000, 0)} ${SI.altitude}` }); }
          }
          const n = orbitalFrame(body).normal;
          if (n) {
            const node = cross([0, 0, 1], n);
            if (norm(node) > 1e-10) for (const sign of [1, -1]) {
              const direction = scale(unit(node), sign), denominator = 1 + dot(evec, direction);
              if (denominator > 1e-10 && p / denominator > s.central.radius) {
                const position = scale(direction, p / denominator);
                if (!plan || norm(sub(position, plan.node.position)) > s.central.radius * 1e-6)
                  addLabel(position, { id: sign === 1 ? "an" : "dn", name: sign === 1 ? "◇ AN" : "◇ DN", color: "#c9b0ff" });
              }
            }
          }
        }
        if (plan) addLabel(plan.node.position, { id: "burn-node", name: tx("sandbox:burnMarker", { node: plan.node.kind === "equatorial" ? "" : plan.node.kind === tx("sandbox:ascending") ? " · AN" : " · DN" }), color: "#f6dfa5", sub: `T− ${fmt(Math.max(0, plan.nodeTime - s.time), 1)} s` });
        if (referenceRef.current) addLabel([0, 0, s.central.radius * 2.4], { id: "north", name: tx("sandbox:north"), color: "#749fbc" });
        setLabels(nextLabels); setScaleKm(unitsPerPixel * 90 * UNIT / 1000); lastLabels = now;
      }
      renderer.render(scene, camera); requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
    return () => {
      disposed = true; observer.disconnect(); orbitControls.dispose(); controlsRef.current = null;
      renderer.domElement.removeEventListener("pointerdown", pointerDown); renderer.domElement.removeEventListener("pointerup", pointerUp);
      for (const object of lines.values()) { object.geometry.dispose(); object.material.dispose(); }
      for (const marker of markers.values()) { marker.dot.geometry.dispose(); marker.dot.material.dispose(); marker.ring.geometry.dispose(); marker.ring.material.dispose(); }
      for (const object of [planet, atmosphere, stars, grid, axis]) { object.geometry.dispose(); if (Array.isArray(object.material)) object.material.forEach((m) => m.dispose()); else object.material.dispose(); }
      renderer.dispose(); renderer.domElement.remove();
    };
  }, []);

  return <div className="universe" ref={host} aria-label={tx("sandbox:interactiveView")}>
    <div className="scene-heading"><span className="overline">{tx("sandbox:flightDynamics")}</span><div><span className="tiny-dot" />{tx("sandbox:inertialFrame", { name: snapshot.central.name.toUpperCase() })}</div></div>
    <div className="view-tools">
      <button className={`icon-button ${follow ? "active" : ""}`} title={tx("sandbox:follow")} aria-label={tx("sandbox:follow")} onClick={() => setFollow((v) => !v)}><Focus size={16} /></button>
      <button className="icon-button" title={tx("sandbox:center")} aria-label={tx("sandbox:center")} onClick={() => controlsRef.current?.center()}><Crosshair size={16} /></button>
      <button className="icon-button" title={tx("sandbox:fitAll")} aria-label={tx("sandbox:fitAll")} onClick={() => controlsRef.current?.fit()}><Scan size={16} /></button>
      <button className="icon-button" title={tx("sandbox:zoomIn")} aria-label={tx("sandbox:zoomIn")} onClick={() => controlsRef.current?.zoom(0.8)}><Plus size={16} /></button>
      <button className="icon-button" title={tx("sandbox:zoomOut")} aria-label={tx("sandbox:zoomOut")} onClick={() => controlsRef.current?.zoom(1.25)}><Minus size={16} /></button>
      <button className={`icon-button ${reference ? "active" : ""}`} title={tx("sandbox:toggleReference")} aria-label={tx("sandbox:toggleReference")} onClick={() => setReference((v) => !v)}><Layers3 size={16} /></button>
    </div>
    <div className="view-presets" aria-label={tx("sandbox:cameraPresets")}>{(["top", "front", "side", "orbitPlane"] as const).map((view) => <button key={view} onClick={() => controlsRef.current?.view(view)}>{tx(viewLabels[view])}</button>)}</div>
    <div className="scene-labels">{labels.map((label) => label.craft ? <button key={`craft-${label.id}`} className={`space-label ${label.selected ? "selected" : ""}`} style={{ left: label.x, top: label.y, "--body-color": label.color } as React.CSSProperties} onClick={() => onSelect(label.id)}><span>{label.name}</span>{label.sub && <small>{label.sub}</small>}</button> : <div key={`annotation-${label.id}`} className="space-label apsis-label" style={{ left: label.x, top: label.y, "--body-color": label.color } as React.CSSProperties}><span>{label.name}</span>{label.sub && <small>{label.sub}</small>}</div>)}</div>
    {webglError && <div className="webgl-error">{renderMessage(webglError)}</div>}
    <div className="scene-bottom"><span><i className="legend-line" />{" "}{tx("sandbox:orbitTab")}{" "}<i className="legend-line trail" />{" "}{tx("sandbox:trail")}{" "}{prediction && <><i className="legend-line prediction" />{" "}{tx("sandbox:preview")}</>}</span><span className="scale-bar">{scaleKm >= 1000 ? `${fmt(scaleKm / 1000, 1)}k` : fmt(scaleKm, 0)}{" "}{SI.altitude}<div /></span></div>
    <div className="scene-instruction">{tx("sandbox:rotate")}{" "}<span>·</span>{" "}{tx("sandbox:pan")}{" "}<span>·</span>{" "}{tx("sandbox:zoom")}{" "}<span>·</span>{" "}{tx("sandbox:inspect")}</div>
  </div>;
}
