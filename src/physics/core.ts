import type {
  BodyState,
  CentralBody,
  CutoffResult,
  LaunchConfig,
  ManeuverSpec,
  OrbiterConfig,
  OrbitSummary,
  Vec3,
} from "../types";
import { add, cross, dot, norm, scale, sub, unit } from "./vector";
import { orbitalFrame, orbitalToWorld, planeOrientation, RAD, surfaceFrame, surfacePosition } from "./frames";

export const G = 6.6743e-11;
export const G0 = 9.80665;
export const muOf = (central: CentralBody) => G * central.mass;
export const circularSpeed = (central: CentralBody, altitude: number) =>
  Math.sqrt(muOf(central) / (central.radius + altitude));
export const altitudeForSpeed = (central: CentralBody, speed: number) =>
  muOf(central) / (speed * speed) - central.radius;

export function createOrbiter(
  config: OrbiterConfig,
  central: CentralBody,
): BodyState {
  const angle = (config.phase * Math.PI) / 180;
  const radial = orbitalToWorld([Math.cos(angle), Math.sin(angle), 0], config.inclination, config.ascendingNode);
  const tangent = orbitalToWorld([-Math.sin(angle), Math.cos(angle), 0], config.inclination, config.ascendingNode);
  const position = scale(radial, central.radius + config.altitude);
  return {
    id: config.id,
    name: config.name,
    color: config.color,
    position,
    velocity: scale(
      tangent,
      circularSpeed(central, config.altitude),
    ),
    status: "flying",
    trail: [position],
  };
}

export function orbitSummary(
  body: Pick<BodyState, "position" | "velocity">,
  central: CentralBody,
): OrbitSummary {
  const r = norm(body.position),
    v2 = dot(body.velocity, body.velocity),
    mu = muOf(central);
  const energy = v2 / 2 - mu / r;
  const h = cross(body.position, body.velocity);
  const eccentricity = norm(
    sub(scale(cross(body.velocity, h), 1 / mu), scale(body.position, 1 / r)),
  );
  const p = dot(h, h) / mu;
  const periapsis = p / (1 + eccentricity) - central.radius;
  const bound = energy < (-mu / r) * 1e-12;
  const a = bound ? -mu / (2 * energy) : null;
  return {
    ...planeOrientation(body),
    // On an outbound open orbit, a below-surface periapsis is in the past.
    kind:
      periapsis < -0.001 && (bound || dot(body.position, body.velocity) < 0)
        ? "impact"
        : bound
          ? "bound"
          : "escape",
    eccentricity,
    periapsis,
    apoapsis: a === null ? null : a * (1 + eccentricity) - central.radius,
    period: a === null ? null : 2 * Math.PI * Math.sqrt(a ** 3 / mu),
    energy,
  };
}

// Universal-variable f/g propagation works for elliptic, parabolic and hyperbolic motion.
function stumpff(z: number): [number, number] {
  if (Math.abs(z) < 1e-5)
    return [
      0.5 - z / 24 + (z * z) / 720 - z ** 3 / 40320,
      1 / 6 - z / 120 + (z * z) / 5040 - z ** 3 / 362880,
    ];
  if (z > 0) {
    const q = Math.sqrt(z);
    return [(1 - Math.cos(q)) / z, (q - Math.sin(q)) / q ** 3];
  }
  const q = Math.sqrt(-z);
  return [(Math.cosh(q) - 1) / -z, (Math.sinh(q) - q) / q ** 3];
}

export function keplerStep(
  position: Vec3,
  velocity: Vec3,
  dt: number,
  mu: number,
): { position: Vec3; velocity: Vec3 } {
  if (dt === 0) return { position: [...position], velocity: [...velocity] };
  const r0 = norm(position),
    sqrtMu = Math.sqrt(mu),
    rv = dot(position, velocity) / sqrtMu;
  const alpha = 2 / r0 - dot(velocity, velocity) / mu;
  let x = (sqrtMu * dt) / r0;
  let converged = false;
  for (let i = 0; i < 70; i++) {
    const z = alpha * x * x,
      [c, s] = stumpff(z);
    const f =
      rv * x * x * c + (1 - alpha * r0) * x ** 3 * s + r0 * x - sqrtMu * dt;
    const df = rv * x * (1 - z * s) + (1 - alpha * r0) * x * x * c + r0;
    const change = f / df;
    x -= change;
    if (!Number.isFinite(x)) break;
    if (Math.abs(change) < 1e-9 * Math.max(1, Math.abs(x))) {
      converged = true;
      break;
    }
  }
  if (!converged) {
    if (Math.abs(dt) < 1e-6)
      throw new Error(
        "Orbital propagation could not converge. Reduce the time scale.",
      );
    const half = keplerStep(position, velocity, dt / 2, mu);
    return keplerStep(half.position, half.velocity, dt / 2, mu);
  }
  const [c, s] = stumpff(alpha * x * x);
  const f = 1 - ((x * x) / r0) * c,
    g = dt - (x ** 3 / sqrtMu) * s;
  const nextPosition = add(scale(position, f), scale(velocity, g)),
    r = norm(nextPosition);
  const fdot = (sqrtMu / (r * r0)) * (alpha * x ** 3 * s - x);
  const gdot = 1 - ((x * x) / r) * c;
  return {
    position: nextPosition,
    velocity: add(scale(position, fdot), scale(velocity, gdot)),
  };
}

export function maneuverDirection(
  body: Pick<BodyState, "position" | "velocity">,
  spec: ManeuverSpec,
): Vec3 {
  const { radial, transverse: tangent, normal } = orbitalFrame(body);
  if (!normal && ["normal", "antinormal", "custom"].includes(spec.direction))
    throw new Error("Orbital plane is undefined for radial or zero-speed motion. Use prograde or radial thrust first.");
  const prograde = norm(body.velocity) > 1e-8 ? unit(body.velocity) : tangent;
  switch (spec.direction) {
    case "prograde":
      return prograde;
    case "retrograde":
      return scale(prograde, -1);
    case "outward":
      return radial;
    case "inward":
      return scale(radial, -1);
    case "normal":
      return normal!;
    case "antinormal":
      return scale(normal!, -1);
    case "custom": {
      const a = (spec.angle * Math.PI) / 180;
      const b = spec.elevation * RAD;
      return add(scale(add(scale(tangent, Math.cos(a)), scale(radial, Math.sin(a))), Math.cos(b)), scale(normal!, Math.sin(b)));
    }
  }
}

export function applyManeuver(body: BodyState, spec: ManeuverSpec): void {
  if (body.status !== "flying" || (body.launch && !body.launch.cutoff))
    throw new Error("Select a flying spacecraft with its engine off.");
  if (spec.mode === "impulse") {
    body.velocity = add(
      body.velocity,
      scale(maneuverDirection(body, spec), spec.deltaV),
    );
    body.lastBurn = {
      integratedDeltaV: spec.deltaV,
      velocityChange: spec.deltaV,
    };
  } else
    body.burn = {
      spec: { ...spec },
      elapsed: 0,
      startVelocity: [...body.velocity],
      integratedDeltaV: 0,
    };
}

export function createLaunch(
  id: string,
  config: LaunchConfig,
  central: CentralBody,
): BodyState {
  return {
    id,
    name: "Launch vehicle",
    color: "#f5bf78",
    position: surfacePosition(config.latitude, config.longitude, central.radius),
    velocity: [0, 0, 0],
    status: "landed",
    trail: [],
    launch: {
      config: { ...config },
      elapsed: 0,
      fuel: config.fuelMass,
      airborne: false,
    },
  };
}

// Dormand–Prince 5(4). Error is scaled separately for position, velocity and fuel.
const A = [
  [],
  [1 / 5],
  [3 / 40, 9 / 40],
  [44 / 45, -56 / 15, 32 / 9],
  [19372 / 6561, -25360 / 2187, 64448 / 6561, -212 / 729],
  [9017 / 3168, -355 / 33, 46732 / 5247, 49 / 176, -5103 / 18656],
  [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84],
];
const C = [0, 1 / 5, 3 / 10, 4 / 5, 8 / 9, 1, 1];
const B5 = [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84, 0];
const B4 = [
  5179 / 57600,
  0,
  7571 / 16695,
  393 / 640,
  -92097 / 339200,
  187 / 2100,
  1 / 40,
];
type Derivative = (t: number, y: number[]) => number[];

function rkTrial(
  y: number[],
  time: number,
  dt: number,
  derivative: Derivative,
): { y: number[]; error: number } {
  const k: number[][] = [];
  for (let stage = 0; stage < 7; stage++) {
    const state = y.map(
      (value, i) =>
        value + dt * A[stage].reduce((sum, a, j) => sum + a * k[j][i], 0),
    );
    k.push(derivative(time + C[stage] * dt, state));
  }
  const next = y.map(
    (value, i) => value + dt * B5.reduce((sum, a, j) => sum + a * k[j][i], 0),
  );
  const error = Math.max(
    ...y.map((value, i) => {
      const delta =
        dt * B5.reduce((sum, a, j) => sum + (a - B4[j]) * k[j][i], 0);
      const atol = i < 3 ? 1e-3 : 1e-7;
      return (
        Math.abs(delta) /
        (atol + 1e-10 * Math.max(Math.abs(value), Math.abs(next[i])))
      );
    }),
  );
  return { y: next, error };
}

export function integrateAdaptive(
  y: number[],
  duration: number,
  derivative: Derivative,
): number[] {
  let t = 0,
    h = Math.min(0.5, duration),
    result = [...y];
  let iterations = 0;
  while (t < duration - 1e-10) {
    if (++iterations > 100000)
      throw new Error(
        "Integration budget exceeded. Check the simulation parameters.",
      );
    h = Math.min(h, duration - t);
    const trial = rkTrial(result, t, h, derivative);
    if (!Number.isFinite(trial.error))
      throw new Error("Non-finite physical state. Check the input parameters.");
    if (trial.error <= 1 || h < 1e-7) {
      result = trial.y;
      t += h;
    }
    h *= Math.max(
      0.15,
      Math.min(4, 0.9 * Math.max(trial.error, 1e-12) ** -0.2),
    );
    h = Math.min(h, 2);
  }
  return result;
}

function poweredStep(
  body: BodyState,
  central: CentralBody,
  dt: number,
): { position: Vec3; velocity: Vec3; fuel: number } {
  const launch = body.launch && !body.launch.cutoff ? body.launch : undefined;
  const burn = body.burn;
  const initialFuel = launch?.fuel ?? 0;
  const derivative: Derivative = (t, y) => {
    const position = y.slice(0, 3) as Vec3,
      velocity = y.slice(3, 6) as Vec3;
    const r = norm(position),
      radial = unit(position);
    let acceleration = scale(position, -muOf(central) / r ** 3),
      fuelRate = 0;
    if (launch) {
      const cfg = launch.config,
        elapsed = launch.elapsed + t;
      const fraction = Math.max(
        0,
        Math.min(1, (elapsed - cfg.turnStart) / (cfg.turnEnd - cfg.turnStart)),
      );
      const pitch = ((90 + (cfg.pitch - 90) * fraction) * Math.PI) / 180;
      const { east, north } = surfaceFrame(position, cfg.longitude);
      let tangent = add(scale(north, Math.cos(cfg.azimuth * RAD)), scale(east, Math.sin(cfg.azimuth * RAD)));
      if (Math.abs(Math.cos(cfg.latitude * RAD)) < 1e-10) {
        // Geographic bearing is singular at a pole. Keep the initial meridian
        // plane selected by longitude and azimuth instead of flipping heading.
        const initialUp = surfacePosition(cfg.latitude, cfg.longitude, 1);
        const initialFrame = surfaceFrame(initialUp, cfg.longitude);
        const initialHeading = add(scale(initialFrame.north, Math.cos(cfg.azimuth * RAD)), scale(initialFrame.east, Math.sin(cfg.azimuth * RAD)));
        tangent = unit(cross(cross(initialUp, initialHeading), radial));
      }
      const heading = add(
        scale(tangent, Math.cos(pitch)),
        scale(radial, Math.sin(pitch)),
      );
      acceleration = add(
        acceleration,
        scale(heading, cfg.thrust / (cfg.dryMass + Math.max(0, y[6]))),
      );
      fuelRate = -cfg.thrust / (cfg.isp * G0);
      if (
        !launch.airborne &&
        r <= central.radius + 1e-4 &&
        dot(acceleration, radial) <= 0
      )
        return [0, 0, 0, 0, 0, 0, fuelRate];
    } else if (burn)
      acceleration = add(
        acceleration,
        scale(
          maneuverDirection({ position, velocity }, burn.spec),
          burn.spec.deltaV / burn.spec.duration,
        ),
      );
    return [...velocity, ...acceleration, fuelRate];
  };
  const result = integrateAdaptive(
    [...body.position, ...body.velocity, initialFuel],
    dt,
    derivative,
  );
  return {
    position: result.slice(0, 3) as Vec3,
    velocity: result.slice(3, 6) as Vec3,
    fuel: Math.max(0, result[6]),
  };
}

function recordCutoff(
  body: BodyState,
  central: CentralBody,
  reason: string,
): CutoffResult {
  const result = {
    elapsed: body.launch!.elapsed,
    altitude: Math.max(0, norm(body.position) - central.radius),
    speed: norm(body.velocity),
    fuel: body.launch!.fuel,
    orbit: orbitSummary(body, central),
    reason,
  };
  body.launch!.cutoff = result;
  return result;
}

export function abortBurn(body: BodyState, central: CentralBody): void {
  if (body.burn) {
    body.lastBurn = {
      integratedDeltaV: body.burn.integratedDeltaV,
      velocityChange: norm(sub(body.velocity, body.burn.startVelocity)),
    };
    delete body.burn;
  }
  if (body.launch && !body.launch.cutoff)
    recordCutoff(body, central, "Engine stopped");
}

// The step size is limited by local dynamics and altitude, so a fast craft cannot
// pass through the surface between sampled endpoints. Impact is then bisected.
export function advanceBody(
  body: BodyState,
  central: CentralBody,
  duration: number,
): void {
  let remaining = duration;
  let guard = 0;
  while (remaining > 1e-8) {
    if (++guard > 100000) throw new Error("Propagation budget exceeded.");
    if (
      body.status === "crashed" ||
      (body.status === "landed" && (!body.launch || body.launch.cutoff))
    )
      break;
    const r = norm(body.position),
      altitude = Math.max(0, r - central.radius),
      speed = norm(body.velocity);
    const activeLaunch =
      body.launch && !body.launch.cutoff ? body.launch : undefined;
    const powered = !!body.burn || !!activeLaunch;
    let dt = Math.min(remaining, 0.03 * Math.sqrt(r ** 3 / muOf(central)));
    if (powered) dt = Math.min(dt, 2);
    // Bound travel near the surface, including near-grazing trajectories.
    if (body.status === "flying")
      dt = Math.min(
        dt,
        Math.max(0.001, ((altitude + 1) / Math.max(speed, 1)) * 0.6),
      );
    if (body.burn)
      dt = Math.min(
        dt,
        Math.max(0, body.burn.spec.duration - body.burn.elapsed),
      );
    if (activeLaunch) {
      const cfg = activeLaunch.config;
      dt = Math.min(
        dt,
        Math.max(0, cfg.burnTime - activeLaunch.elapsed),
        (activeLaunch.fuel * cfg.isp * G0) / cfg.thrust,
      );
      for (const event of [cfg.turnStart, cfg.turnEnd])
        if (event > activeLaunch.elapsed + 1e-8)
          dt = Math.min(dt, event - activeLaunch.elapsed);
    }
    if (dt < 1e-8) {
      if (body.burn) abortBurn(body, central);
      if (activeLaunch)
        recordCutoff(
          body,
          central,
          activeLaunch.fuel <= 1e-6 ? "Fuel depleted" : "Burn time reached",
        );
      continue;
    }
    const compute = (span: number) =>
      powered
        ? poweredStep(body, central, span)
        : {
            ...keplerStep(body.position, body.velocity, span, muOf(central)),
            fuel: body.launch?.fuel ?? 0,
          };
    let next = compute(dt);
    if (
      norm(next.position) < central.radius - 1e-6 &&
      (body.status === "flying" || activeLaunch?.airborne)
    ) {
      let lo = 0,
        hi = dt;
      for (let i = 0; i < 38; i++) {
        const mid = (lo + hi) / 2;
        if (norm(compute(mid).position) > central.radius) lo = mid;
        else hi = mid;
      }
      dt = hi;
      next = compute(dt);
      body.position = scale(unit(next.position), central.radius);
      body.velocity = next.velocity;
      if (activeLaunch) {
        activeLaunch.elapsed += dt;
        activeLaunch.fuel = next.fuel;
        recordCutoff(body, central, "Surface impact");
      }
      if (body.burn) {
        body.burn.elapsed += dt;
        body.burn.integratedDeltaV +=
          (dt * body.burn.spec.deltaV) / body.burn.spec.duration;
      }
      abortBurn(body, central);
      body.status = "crashed";
      break;
    }
    body.position = next.position;
    body.velocity = next.velocity;
    if (activeLaunch) {
      activeLaunch.elapsed += dt;
      activeLaunch.fuel = next.fuel;
      if (
        norm(body.position) > central.radius + 1e-5 ||
        dot(body.velocity, body.position) > 1e-5
      ) {
        activeLaunch.airborne = true;
        body.status = "flying";
      }
      if (
        activeLaunch.fuel < 1e-7 ||
        activeLaunch.elapsed >= activeLaunch.config.burnTime - 1e-8
      )
        recordCutoff(
          body,
          central,
          activeLaunch.fuel < 1e-7 ? "Fuel depleted" : "Burn time reached",
        );
    }
    if (body.burn) {
      body.burn.elapsed += dt;
      body.burn.integratedDeltaV +=
        (dt * body.burn.spec.deltaV) / body.burn.spec.duration;
      if (body.burn.elapsed >= body.burn.spec.duration - 1e-8)
        abortBurn(body, central);
    }
    remaining -= dt;
  }
}

// Geometric osculating conic for a coast preview, truncated at the surface.
export function orbitPath(
  body: BodyState,
  central: CentralBody,
  count = 256,
): Vec3[] {
  const mu = muOf(central),
    r = norm(body.position),
    h = cross(body.position, body.velocity),
    p = dot(h, h) / mu;
  const evec = sub(
    scale(cross(body.velocity, h), 1 / mu),
    scale(body.position, 1 / r),
  );
  const e = norm(evec);
  if (p < 1e-5) {
    const radial = unit(body.position);
    if (dot(body.position, body.velocity) <= 0)
      return [body.position, scale(radial, central.radius)];
    const energy = dot(body.velocity, body.velocity) / 2 - mu / r;
    if (energy >= 0)
      return [
        body.position,
        scale(radial, Math.max(r * 3, central.radius * 10)),
      ];
    return [
      body.position,
      scale(radial, -mu / energy),
      scale(radial, central.radius),
    ];
  }
  const x = e > 1e-7 ? unit(evec) : unit(body.position);
  const y = unit(cross(unit(h), x));
  const limit = e < 1 ? Math.PI : Math.acos(-1 / e) - 0.025;
  if (p / (1 + e) < central.radius && e > 1e-7) {
    // Leave the hidden inside-surface arc out of the line.
    const hit = Math.acos(
      Math.max(-1, Math.min(1, (p / central.radius - 1) / e)),
    );
    if (e < 1) {
      return Array.from({ length: count + 1 }, (_, i) => {
        const a = hit + ((2 * Math.PI - 2 * hit) * i) / count;
        return add(
          scale(x, (p / (1 + e * Math.cos(a))) * Math.cos(a)),
          scale(y, (p / (1 + e * Math.cos(a))) * Math.sin(a)),
        );
      });
    }
    const outbound = dot(body.position, body.velocity) >= 0;
    const start = outbound ? hit : -limit,
      end = outbound ? limit : -hit;
    return Array.from({ length: count + 1 }, (_, i) => {
      const a = start + ((end - start) * i) / count;
      const radius = Math.min(p / (1 + e * Math.cos(a)), central.radius * 300);
      return add(
        scale(x, radius * Math.cos(a)),
        scale(y, radius * Math.sin(a)),
      );
    });
  }
  return Array.from({ length: count + 1 }, (_, i) => {
    const a = -limit + (2 * limit * i) / count,
      radius = Math.min(p / (1 + e * Math.cos(a)), central.radius * 300);
    return add(scale(x, radius * Math.cos(a)), scale(y, radius * Math.sin(a)));
  });
}
