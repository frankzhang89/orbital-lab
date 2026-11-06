import { describe, expect, it } from "vitest";
import { DEFAULT_LAUNCH, DEFAULT_MANEUVER, EARTH } from "../src/defaults";
import {
  abortBurn,
  advanceBody,
  altitudeForSpeed,
  applyManeuver,
  circularSpeed,
  createLaunch,
  createOrbiter,
  G0,
  integrateAdaptive,
  keplerStep,
  muOf,
  orbitPath,
  orbitSummary,
} from "../src/physics/core";
import { cross, norm, scale, sub } from "../src/physics/vector";
import type { BodyState, LaunchConfig, Vec3 } from "../src/types";

const craft = () =>
  createOrbiter(
    {
      id: "test",
      name: "Test",
      color: "#aabbcc",
      altitude: 800000,
      phase: 28,
      inclination: 0,
      ascendingNode: 0,
    },
    EARTH,
  );
const relative = (a: number, b: number) => Math.abs((a - b) / b);
const launchUntilCutoff = (cfg: LaunchConfig, dt = 1): BodyState => {
  const body = createLaunch("launch", cfg, EARTH);
  for (let i = 0; i < 20000 && !body.launch!.cutoff; i++)
    advanceBody(body, EARTH, dt);
  expect(body.launch?.cutoff).toBeDefined();
  return body;
};

describe("circular orbits and universal-variable propagation", () => {
  it("links altitude and speed in both directions", () => {
    for (const altitude of [1, 400000, 800000, 36000000, 1e10])
      expect(
        Math.abs(
          altitudeForSpeed(EARTH, circularSpeed(EARTH, altitude)) - altitude,
        ),
      ).toBeLessThan(Math.max(1e-5, altitude * 1e-12));
  });
  it("preserves energy, angular momentum and position over twenty periods", () => {
    const body = craft(),
      start = structuredClone(body),
      initial = orbitSummary(body, EARTH),
      h = norm(cross(body.position, body.velocity));
    for (let i = 0; i < 200; i++)
      advanceBody(body, EARTH, initial.period! / 10);
    expect(
      relative(orbitSummary(body, EARTH).energy, initial.energy),
    ).toBeLessThan(1e-8);
    expect(relative(norm(cross(body.position, body.velocity)), h)).toBeLessThan(
      1e-8,
    );
    expect(
      norm(sub(body.position, start.position)) / norm(start.position),
    ).toBeLessThan(1e-5);
  });
  it("handles clockwise and circular degeneracy", () => {
    const body = craft();
    body.velocity = scale(body.velocity, -1);
    const orbit = orbitSummary(body, EARTH);
    expect(orbit.eccentricity).toBeLessThan(1e-12);
    expect(orbit.periapsis).toBeCloseTo(800000, 4);
    const next = keplerStep(
      body.position,
      body.velocity,
      orbit.period!,
      muOf(EARTH),
    );
    expect(norm(sub(next.position, body.position))).toBeLessThan(0.01);
  });
  it("propagates nearly parabolic and hyperbolic states without non-finite values", () => {
    for (const factor of [
      Math.sqrt(2) * (1 - 1e-10),
      Math.sqrt(2),
      Math.sqrt(2) * (1 + 1e-10),
      2,
    ]) {
      const body = craft();
      body.velocity = scale(body.velocity, factor);
      advanceBody(body, EARTH, 10000);
      expect([...body.position, ...body.velocity].every(Number.isFinite)).toBe(
        true,
      );
      expect(
        orbitSummary(body, EARTH).apoapsis === null ||
          orbitSummary(body, EARTH).apoapsis! > 0,
      ).toBe(true);
    }
  });
  it("detects ground intersection and stops exactly on the surface, including radial fall", () => {
    for (const radial of [false, true]) {
      const body = craft();
      body.velocity = radial ? [0, 0, 0] : scale(body.velocity, 0.4);
      expect(orbitSummary(body, EARTH).kind).toBe("impact");
      advanceBody(body, EARTH, 10000);
      expect(body.status).toBe("crashed");
      expect(Math.abs(norm(body.position) - EARTH.radius)).toBeLessThan(0.01);
    }
  });
});

describe("maneuvers and finite burns", () => {
  it("prograde raises apoapsis, retrograde lowers periapsis and radial impulses create eccentricity", () => {
    for (const direction of [
      "prograde",
      "retrograde",
      "outward",
      "inward",
      "custom",
    ] as const) {
      const body = craft();
      applyManeuver(body, { ...DEFAULT_MANEUVER, direction, angle: 45 });
      const orbit = orbitSummary(body, EARTH);
      expect(orbit.eccentricity).toBeGreaterThan(0.01);
      if (direction === "prograde") {
        expect(orbit.apoapsis!).toBeGreaterThan(800000);
        expect(orbit.periapsis).toBeCloseTo(800000, 3);
      }
      if (direction === "retrograde")
        expect(orbit.periapsis).toBeLessThan(800000);
    }
  });
  it("labels escape with no finite apoapsis or period", () => {
    const body = craft();
    applyManeuver(body, { ...DEFAULT_MANEUVER, deltaV: 5000 });
    expect(orbitSummary(body, EARTH)).toMatchObject({
      kind: "escape",
      apoapsis: null,
      period: null,
    });
  });
  it("distinguishes a future impact from a below-surface periapsis in the past", () => {
    const body = craft();
    body.velocity = scale(body.position, 12000 / norm(body.position));
    expect(orbitSummary(body, EARTH)).toMatchObject({
      kind: "escape",
      apoapsis: null,
    });
    body.velocity = scale(body.velocity, -1);
    expect(orbitSummary(body, EARTH).kind).toBe("impact");
  });
  it("integrates the requested acceleration and stops at the exact duration", () => {
    const body = craft();
    applyManeuver(body, {
      ...DEFAULT_MANEUVER,
      mode: "finite",
      duration: 13.25,
    });
    advanceBody(body, EARTH, 50);
    expect(body.burn).toBeUndefined();
    expect(body.lastBurn?.integratedDeltaV).toBeCloseTo(400, 7);
    expect(body.lastBurn!.velocityChange).toBeGreaterThan(0);
  });
  it("counts acceleration through the precise instant of impact", () => {
    const body = craft();
    body.position = [0, EARTH.radius + 1, 0];
    body.velocity = [0, -100, 0];
    applyManeuver(body, {
      ...DEFAULT_MANEUVER,
      mode: "finite",
      deltaV: 1,
      duration: 10,
      direction: "outward",
    });
    advanceBody(body, EARTH, 1);
    const netGravity = muOf(EARTH) / EARTH.radius ** 2 - 0.1;
    const impactTime = 2 / (100 + Math.sqrt(10000 + 2 * netGravity));
    expect(body.status).toBe("crashed");
    expect(body.lastBurn!.integratedDeltaV).toBeCloseTo(impactTime * 0.1, 8);
  });
  it("draws outbound radial escape away from the surface", () => {
    const body = craft();
    body.velocity = scale(body.position, 12000 / norm(body.position));
    const path = orbitPath(body, EARTH);
    expect(norm(path.at(-1)!)).toBeGreaterThan(norm(body.position));
  });
  it("is consistent across time partitions", () => {
    const a = craft(),
      b = craft();
    for (const body of [a, b])
      applyManeuver(body, {
        ...DEFAULT_MANEUVER,
        mode: "finite",
        duration: 67.3,
        direction: "outward",
      });
    advanceBody(a, EARTH, 200);
    for (let i = 0; i < 600; i++) advanceBody(b, EARTH, 1 / 3);
    expect(norm(sub(a.position, b.position)) / norm(a.position)).toBeLessThan(
      1e-8,
    );
    expect(norm(sub(a.velocity, b.velocity)) / norm(a.velocity)).toBeLessThan(
      1e-8,
    );
  });
  it("supports a zero-velocity tangent fallback and aborts without changing velocity", () => {
    const body = craft();
    body.velocity = [0, 0, 0];
    applyManeuver(body, { ...DEFAULT_MANEUVER, mode: "finite" });
    advanceBody(body, EARTH, 0.5);
    const velocity = [...body.velocity];
    abortBurn(body, EARTH);
    expect(body.burn).toBeUndefined();
    expect(body.velocity).toEqual(velocity);
  });
});

describe("launch propulsion and guidance", () => {
  it("matches the ideal rocket equation without gravity", () => {
    const thrust = 150000,
      isp = 450,
      dry = 1000,
      fuel = 9000,
      time = 100,
      flow = thrust / (isp * G0);
    const result = integrateAdaptive(
      [0, 0, 0, 0, 0, 0, fuel],
      time,
      (_t, y) => [y[3], 0, 0, thrust / (dry + y[6]), 0, 0, -flow],
    );
    expect(
      relative(
        result[3],
        isp * G0 * Math.log((dry + fuel) / (dry + fuel - time * flow)),
      ),
    ).toBeLessThan(1e-9);
    expect(result[6]).toBeCloseTo(fuel - time * flow, 6);
  });
  it("stops exactly on timed cutoff with fuel remaining", () => {
    const body = launchUntilCutoff({ ...DEFAULT_LAUNCH, burnTime: 17.25 });
    expect(body.launch!.cutoff!.elapsed).toBeCloseTo(17.25, 8);
    expect(body.launch!.cutoff!.reason).toBe("burnTimeReached");
    expect(body.launch!.fuel).toBeGreaterThan(0);
  });
  it("stops exactly at propellant exhaustion, even inside a large step", () => {
    const cfg = { ...DEFAULT_LAUNCH, burnTime: 1000, fuelMass: 1000 };
    const body = launchUntilCutoff(cfg, 17);
    expect(body.launch!.cutoff!.elapsed).toBeCloseTo(
      (cfg.fuelMass * cfg.isp * G0) / cfg.thrust,
      7,
    );
    expect(body.launch!.cutoff!.reason).toBe("fuelDepleted");
    expect(body.launch!.fuel).toBeCloseTo(0, 6);
  });
  it("holds a weak engine on the pad while consuming fuel", () => {
    const cfg = { ...DEFAULT_LAUNCH, thrust: 100, burnTime: 10 };
    const body = launchUntilCutoff(cfg);
    expect(body.status).toBe("landed");
    expect(body.launch!.airborne).toBe(false);
    expect(norm(body.position)).toBe(EARTH.radius);
    expect(norm(body.velocity)).toBe(0);
    expect(body.launch!.fuel).toBeLessThan(cfg.fuelMass);
  });
  it("a vertical flight returns to the ground", () => {
    const body = launchUntilCutoff({
      ...DEFAULT_LAUNCH,
      burnTime: 50,
      turnStart: 100,
      turnEnd: 200,
    });
    expect(body.launch!.airborne).toBe(true);
    advanceBody(body, EARTH, 3000);
    expect(body.status).toBe("crashed");
  });
  it("pitch guidance creates horizontal motion, and prediction partitions match playback", () => {
    const a = launchUntilCutoff(DEFAULT_LAUNCH, 1),
      b = launchUntilCutoff(DEFAULT_LAUNCH, 1 / 7);
    expect(Math.abs(a.velocity[0])).toBeGreaterThan(1000);
    const ca = a.launch!.cutoff!,
      cb = b.launch!.cutoff!;
    expect(relative(ca.speed, cb.speed)).toBeLessThan(1e-7);
    expect(relative(ca.altitude, cb.altitude)).toBeLessThan(1e-7);
    expect(relative(ca.orbit.apoapsis!, cb.orbit.apoapsis!)).toBeLessThan(1e-6);
  });
  it("can propagate 50 independent bodies with finite states", () => {
    const bodies = Array.from({ length: 50 }, (_, i) =>
      createOrbiter(
        {
          id: String(i),
          name: `Craft ${i}`,
          altitude: 300000 + i * 100000,
          phase: i * 7,
          color: "#aabbcc",
          inclination: (i * 37) % 181,
          ascendingNode: (i * 71) % 360,
        },
        EARTH,
      ),
    );
    bodies.forEach((body) => advanceBody(body, EARTH, 1000));
    expect(
      bodies.every(
        (body) =>
          body.status === "flying" &&
          [...body.position, ...body.velocity].every(Number.isFinite),
      ),
    ).toBe(true);
  });
});
