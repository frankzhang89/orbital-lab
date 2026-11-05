export type Vec3 = [number, number, number];
export interface CentralBody {
  name: string;
  mass: number;
  radius: number;
}
export interface OrbiterConfig {
  id: string;
  name: string;
  color: string;
  altitude: number;
  phase: number;
  inclination: number;
  ascendingNode: number;
}
export interface SceneConfig {
  central: CentralBody;
  orbiters: OrbiterConfig[];
}
export interface SavedConfiguration extends SceneConfig {
  id: string;
  name: string;
  updatedAt: string;
}
export type Direction =
  "prograde" | "retrograde" | "outward" | "inward" | "normal" | "antinormal" | "custom";
export interface ManeuverSpec {
  mode: "impulse" | "finite";
  deltaV: number;
  duration: number;
  direction: Direction;
  angle: number;
  elevation: number;
}
export interface ActiveBurn {
  spec: ManeuverSpec;
  elapsed: number;
  startVelocity: Vec3;
  integratedDeltaV: number;
}
export interface LaunchConfig {
  dryMass: number;
  fuelMass: number;
  isp: number;
  thrust: number;
  burnTime: number;
  turnStart: number;
  turnEnd: number;
  pitch: number;
  latitude: number;
  longitude: number;
  azimuth: number;
}
export interface CutoffResult {
  elapsed: number;
  altitude: number;
  speed: number;
  fuel: number;
  orbit: OrbitSummary;
  reason: string;
}
export interface LaunchState {
  config: LaunchConfig;
  elapsed: number;
  fuel: number;
  airborne: boolean;
  cutoff?: CutoffResult;
}
export interface BodyState {
  id: string;
  name: string;
  color: string;
  position: Vec3;
  velocity: Vec3;
  status: "flying" | "landed" | "crashed";
  burn?: ActiveBurn;
  launch?: LaunchState;
  lastBurn?: { integratedDeltaV: number; velocityChange: number };
  trail: Vec3[];
}
export interface OrbitSummary {
  kind: "bound" | "impact" | "escape";
  eccentricity: number;
  periapsis: number;
  apoapsis: number | null;
  period: number | null;
  energy: number;
  inclination: number | null;
  ascendingNode: number | null;
}
export interface EquatorialNode {
  delay: number;
  position: Vec3;
  kind: "ascending" | "descending" | "equatorial";
}
export interface PlaneChangePlan {
  bodyId: string;
  epoch: number;
  revision: number;
  nodeTime: number;
  node: EquatorialNode;
  deltaV: Vec3;
  finalVelocity: Vec3;
  targetInclination: number;
}
export interface Snapshot {
  central: CentralBody;
  bodies: BodyState[];
  time: number;
  running: boolean;
  warp: number;
  achievedWarp: number;
  revision: number;
  pendingPlaneChange?: PlaneChangePlan;
  planeChangeResult?: { bodyId: string; time: number; inclination: number | null; deltaV: number };
}
export interface Prediction {
  id: number;
  bodyId: string;
  path: Vec3[];
  final: BodyState;
  orbit: OrbitSummary;
  cutoff?: CutoffResult;
  zeroSpeedFallback: boolean;
  planeChange?: PlaneChangePlan;
}
export type WorkerCommand =
  | { type: "reset"; config: SceneConfig }
  | { type: "central"; central: CentralBody }
  | { type: "add"; orbiter: OrbiterConfig }
  | { type: "remove"; id: string }
  | { type: "orbit"; orbiter: OrbiterConfig }
  | { type: "running"; value: boolean }
  | { type: "warp"; value: number }
  | { type: "step" }
  | { type: "maneuver"; id: string; spec: ManeuverSpec }
  | { type: "abort"; id: string }
  | { type: "launch"; id: string; config: LaunchConfig }
  | { type: "schedulePlaneChange"; plan: PlaneChangePlan }
  | { type: "cancelPlaneChange" }
  | {
      type: "predict";
      requestId: number;
      id: string;
      spec?: ManeuverSpec;
      launch?: LaunchConfig;
      targetInclination?: number;
    }
  | { type: "cancelPrediction" };
export type WorkerResponse =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "prediction"; prediction: Prediction }
  | { type: "error"; message: string };
