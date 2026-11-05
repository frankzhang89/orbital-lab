import type { SceneConfig, LaunchConfig, ManeuverSpec } from "./types";
export const EARTH = { name: "Earth", mass: 5.9722e24, radius: 6371000 };
export const COLORS = [
  "#8ee7c5",
  "#b4a0f5",
  "#f6bf79",
  "#77bdfb",
  "#f389a4",
  "#e2e999",
];
export const DEFAULT_SCENE: SceneConfig = {
  central: { ...EARTH },
  orbiters: [
    {
      id: "odyssey",
      name: "Odyssey",
      color: COLORS[0],
      altitude: 800000,
      phase: 28,
      inclination: 0,
      ascendingNode: 0,
    },
    {
      id: "kepler",
      name: "Kepler",
      color: COLORS[1],
      altitude: 3600000,
      phase: 145,
      inclination: 51.6,
      ascendingNode: 40,
    },
    {
      id: "pioneer",
      name: "Pioneer",
      color: COLORS[2],
      altitude: 7000000,
      phase: 285,
      inclination: 90,
      ascendingNode: 120,
    },
  ],
};
export const DEFAULT_MANEUVER: ManeuverSpec = {
  mode: "impulse",
  deltaV: 400,
  duration: 60,
  direction: "prograde",
  angle: 0,
  elevation: 0,
};
export const DEFAULT_LAUNCH: LaunchConfig = {
  dryMass: 1000,
  fuelMass: 9000,
  isp: 450,
  thrust: 150000,
  burnTime: 265,
  turnStart: 12,
  turnEnd: 180,
  pitch: 0,
  latitude: 0,
  longitude: 90,
  azimuth: 90,
};
