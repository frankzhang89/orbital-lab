import { describe, expect, it } from "vitest";
import { DEFAULT_LAUNCH, DEFAULT_MANEUVER, DEFAULT_SCENE, EARTH } from "../src/defaults";
import { advanceBody, applyManeuver, circularSpeed, createLaunch, createOrbiter, keplerStep, maneuverDirection, muOf, orbitPath, orbitSummary } from "../src/physics/core";
import { orbitalFrame, orbitalToWorld, phaseInPlane, surfaceFrame, surfacePosition } from "../src/physics/frames";
import { nextEquatorialNode, planPlaneChange } from "../src/physics/planeChange";
import { advanceSimulation, invalidatePlaneChange, schedulePlaneChange } from "../src/physics/timeline";
import { cross, dot, norm, scale, sub, unit } from "../src/physics/vector";
import type { BodyState, LaunchConfig, Snapshot, Vec3 } from "../src/types";

const craft = (inclination = 51.6, ascendingNode = 37, phase = 28) => createOrbiter({ ...DEFAULT_SCENE.orbiters[0], inclination, ascendingNode, phase }, EARTH);
const relative = (a: number, b: number) => Math.abs(a - b) / Math.max(1, Math.abs(b));
const snapshot = (body = craft()): Snapshot => ({ central: { ...EARTH }, bodies: [body], running: false, time: 0, warp: 1, achievedWarp: 1, revision: 0 });
function assertShape(a: BodyState, b: BodyState) {
  const before = orbitSummary(a, EARTH), after = orbitSummary(b, EARTH);
  expect(relative(after.energy, before.energy)).toBeLessThan(1e-8);
  expect(Math.abs(after.eccentricity - before.eccentricity)).toBeLessThan(1e-8);
  expect(relative(after.periapsis, before.periapsis)).toBeLessThan(1e-5);
  if (before.apoapsis !== null) expect(relative(after.apoapsis!, before.apoapsis)).toBeLessThan(1e-5);
}

describe("three-dimensional orbit frames and propagation", () => {
  it.each([0, 23.4, 51.6, 90, 120, 179.99, 180])("constructs and conserves a %s degree orbit", (inclination) => {
    const b = craft(inclination), original = structuredClone(b), initial = orbitSummary(b, EARTH);
    expect(initial.inclination).toBeCloseTo(inclination, 9);
    expect(initial.ascendingNode).toEqual(inclination === 0 || inclination === 180 ? null : expect.closeTo(37, 9));
    const h = cross(b.position, b.velocity);
    for (let i = 0; i < 200; i++) advanceBody(b, EARTH, initial.period! / 10);
    expect(norm(sub(b.position, original.position)) / norm(original.position)).toBeLessThan(1e-5);
    expect(norm(sub(cross(b.position, b.velocity), h)) / norm(h)).toBeLessThan(1e-8);
    assertShape(original, b);
    expect(phaseInPlane(original.position, inclination, 37)).toBeCloseTo(28, 9);
    orbitPath(original, EARTH).forEach((p) => expect(Math.abs(dot(p, unit(h))) / norm(p)).toBeLessThan(1e-12));
  });
  it("is rotationally equivalent for elliptical and escape propagation", () => {
    for (const factor of [0.95, 1.2, Math.sqrt(2), 1.6]) {
      const a = craft(0, 0), b = craft(72, 137);
      a.velocity = scale(a.velocity, factor); b.velocity = scale(b.velocity, factor);
      advanceBody(a, EARTH, 4000); advanceBody(b, EARTH, 4000);
      expect(norm(sub(b.position, orbitalToWorld(a.position, 72, 137))) / norm(b.position)).toBeLessThan(1e-7);
      expect(norm(sub(b.velocity, orbitalToWorld(a.velocity, 72, 137))) / norm(b.velocity)).toBeLessThan(1e-7);
    }
  });
  it("uses an orthonormal RTN basis and unit custom directions in polar / retrograde motion", () => {
    for (const i of [0, 90, 120, 180]) {
      const b = craft(i), frame = orbitalFrame(b);
      expect(dot(frame.transverse, frame.radial)).toBeCloseTo(0, 12);
      expect(dot(frame.transverse, unit(b.velocity))).toBeCloseTo(1, 12);
      const d = maneuverDirection(b, { ...DEFAULT_MANEUVER, direction: "custom", angle: 37, elevation: 54 });
      expect(norm(d)).toBeCloseTo(1, 12);
      expect(dot(d, frame.normal!)).toBeCloseTo(Math.sin(54 * Math.PI / 180), 12);
    }
  });
  it("handles radial and zero-speed states without inventing orbital planes", () => {
    const b = craft(); b.velocity = scale(unit(b.position), -100);
    expect(orbitSummary(b, EARTH).inclination).toBeNull();
    expect(nextEquatorialNode(b, EARTH)).toBeNull();
    expect(() => applyManeuver(b, { ...DEFAULT_MANEUVER, direction: "normal" })).toThrow("undefined");
    b.position = [0, 0, EARTH.radius + 10]; b.velocity = [0, 0, 0];
    expect(norm(maneuverDirection(b, DEFAULT_MANEUVER))).toBeCloseTo(1, 12);
    advanceBody(b, EARTH, 10);
    expect(b.status).toBe("crashed");
    expect(norm(b.position)).toBeCloseTo(EARTH.radius, 4);
  });
  it.each(["normal", "antinormal", "custom"] as const)("executes %s finite burns consistently across time partitions", (direction) => {
    const a = craft(), b = craft();
    const spec = { ...DEFAULT_MANEUVER, mode: "finite" as const, duration: 43.25, direction, elevation: 23, angle: -17, deltaV: 450 };
    [a, b].forEach((body) => applyManeuver(body, spec));
    advanceBody(a, EARTH, 100);
    for (let i = 0; i < 700; i++) advanceBody(b, EARTH, 1 / 7);
    expect(a.lastBurn?.integratedDeltaV).toBeCloseTo(450, 8);
    expect(norm(sub(a.position, b.position)) / norm(a.position)).toBeLessThan(1e-8);
    expect(norm(sub(a.velocity, b.velocity)) / norm(a.velocity)).toBeLessThan(1e-8);
    expect(Math.abs(orbitSummary(a, EARTH).inclination! - 51.6)).toBeGreaterThan(0.01);
  });
});

describe("node targeting and event-aligned plane changes", () => {
  it.each([0, 30, 90, 140, 180])("targets %s degrees while preserving circular and elliptical orbit shape", (target) => {
    for (const factor of [1, 1.15]) {
      const b = craft(); b.velocity = scale(b.velocity, factor);
      const before = structuredClone(b), plan = planPlaneChange(b, EARTH, target, 123, 7);
      expect(plan.node.delay).toBeGreaterThan(0);
      expect(Math.abs(plan.node.position[2]) / norm(plan.node.position)).toBeLessThan(1e-10);
      advanceBody(b, EARTH, plan.node.delay); b.velocity = plan.finalVelocity;
      expect(orbitSummary(b, EARTH).inclination).toBeCloseTo(target, 7);
      assertShape(before, b);
    }
  });
  it("matches the independent circular plane-change equation and chooses the nearer plane", () => {
    const b = craft(0, 0), plan = planPlaneChange(b, EARTH, 60, 0, 0);
    expect(plan.node.kind).toBe("equatorial");
    expect(plan.node.delay).toBe(0);
    expect(relative(norm(plan.deltaV), 2 * circularSpeed(EARTH, 800000) * Math.sin(Math.PI / 6))).toBeLessThan(1e-12);
    const inclined = craft(120, 10, 0), p = planPlaneChange(inclined, EARTH, 130, 0, 0);
    expect(relative(norm(p.deltaV), 2 * norm(inclined.velocity) * Math.sin(5 * Math.PI / 180))).toBeLessThan(1e-12);
  });
  it("normal-only impulses change inclination and energy, unlike shape-preserving targeting", () => {
    const b = craft(0, 0), before = orbitSummary(b, EARTH);
    applyManeuver(b, { ...DEFAULT_MANEUVER, direction: "normal", deltaV: 1000 });
    const after = orbitSummary(b, EARTH);
    expect(after.inclination).toBeGreaterThan(0);
    expect(after.energy).toBeGreaterThan(before.energy);
    expect(after.apoapsis).toBeGreaterThan(before.apoapsis!);
  });
  it("finds both kinds of future nodes including near-parabolic and hyperbolic trajectories", () => {
    expect(nextEquatorialNode(craft(60, 20, 28), EARTH)?.kind).toBe("descending");
    expect(nextEquatorialNode(craft(60, 20, 200), EARTH)?.kind).toBe("ascending");
    for (const factor of [Math.sqrt(2) * (1 - 1e-10), Math.sqrt(2), Math.sqrt(2) * (1 + 1e-10), 1.7]) {
      const b = craft(60, 20, 28);
      // Start shortly before pericenter, with a future ascending node.
      b.position = orbitalToWorld([7e6 * Math.cos(-0.1), 7e6 * Math.sin(-0.1), 0], 60, 20);
      b.velocity = orbitalToWorld([0, Math.sqrt(muOf(EARTH) / 7e6) * factor, 0], 60, 20);
      const node = nextEquatorialNode(b, EARTH);
      expect(node).not.toBeNull();
      const at = keplerStep(b.position, b.velocity, node!.delay, muOf(EARTH));
      expect(Math.abs(at.position[2]) / norm(at.position)).toBeLessThan(1e-8);
    }
    const outgoing = craft(60, 0, 28); outgoing.velocity = scale(outgoing.velocity, 2);
    expect(nextEquatorialNode(outgoing, EARTH)).toBeNull();
  });
  it("rejects undefined planes, active engines, invalid targets, and impact before node", () => {
    const b = craft(60, 0, 5); b.velocity = scale(b.velocity, 0.25);
    expect(() => planPlaneChange(b, EARTH, 30, 0, 0)).toThrow("surface");
    const active = craft(); applyManeuver(active, { ...DEFAULT_MANEUVER, mode: "finite" });
    expect(() => planPlaneChange(active, EARTH, 30, 0, 0)).toThrow("engine");
    expect(() => planPlaneChange(craft(), EARTH, NaN, 0, 0)).toThrow("between");
  });
  it("executes exactly at the node and produces the same result for different frame / warp partitions", () => {
    const a = snapshot(), b = snapshot();
    const plan = planPlaneChange(a.bodies[0], EARTH, 12, 0, 0);
    schedulePlaneChange(a, plan); schedulePlaneChange(b, plan);
    const duration = plan.node.delay + 123;
    advanceSimulation(a, duration);
    for (let remaining = duration; remaining > 1e-8;) { const dt = Math.min(remaining, 1 / 3); advanceSimulation(b, dt); remaining -= dt; }
    expect(a.pendingPlaneChange).toBeUndefined();
    expect(a.planeChangeResult?.time).toBeCloseTo(plan.nodeTime, 8);
    expect(b.planeChangeResult?.time).toBeCloseTo(plan.nodeTime, 8);
    expect(orbitSummary(a.bodies[0], EARTH).inclination).toBeCloseTo(12, 7);
    expect(norm(sub(a.bodies[0].position, b.bodies[0].position)) / norm(a.bodies[0].position)).toBeLessThan(1e-7);
    expect(norm(sub(a.bodies[0].velocity, b.bodies[0].velocity)) / norm(a.bodies[0].velocity)).toBeLessThan(1e-7);
  });
  it("cancels / invalidates plans, rejects stale previews and permits only one pending plan", () => {
    const s = snapshot(), plan = planPlaneChange(s.bodies[0], EARTH, 20, 0, 0);
    schedulePlaneChange(s, plan);
    expect(() => schedulePlaneChange(s, plan)).toThrow("existing");
    const before = structuredClone(s.bodies[0]);
    invalidatePlaneChange(s, "different-body"); expect(s.pendingPlaneChange).toBeDefined();
    invalidatePlaneChange(s); expect(s.bodies[0]).toEqual(before);
    s.revision++;
    expect(() => schedulePlaneChange(s, plan)).toThrow("out of date");
    s.revision = 0; s.time = 1;
    expect(() => schedulePlaneChange(s, plan)).toThrow("out of date");
  });
  it("does not execute while paused, and aligns a one-second step across the node", () => {
    const s = snapshot(craft(60, 0, 179.98));
    const plan = planPlaneChange(s.bodies[0], EARTH, 10, 0, 0);
    schedulePlaneChange(s, plan);
    expect(s.running).toBe(false); expect(s.time).toBe(0); expect(s.pendingPlaneChange).toBeDefined();
    expect(plan.node.delay).toBeLessThan(1);
    advanceSimulation(s, 1);
    expect(s.planeChangeResult?.time).toBeCloseTo(plan.nodeTime, 8);
    expect(s.time).toBeCloseTo(1, 8);
    expect(s.running).toBe(false);
  });
});

function cutoff(config: LaunchConfig, dt = 1) {
  const b = createLaunch("test-launch", config, EARTH);
  for (let k = 0; k < 20000 && !b.launch!.cutoff; k++) advanceBody(b, EARTH, dt);
  expect(b.launch!.cutoff).toBeDefined();
  return b;
}

describe("three-dimensional launch sites and headings", () => {
  it("uses orthonormal east / north / up frames even at the poles", () => {
    for (const lat of [-90, -45, 0, 45, 90]) for (const lon of [-180, 0, 37, 180]) {
      const p = surfacePosition(lat, lon, EARTH.radius), f = surfaceFrame(p, lon);
      expect(norm(p)).toBeCloseTo(EARTH.radius, 6);
      expect(norm(f.east)).toBeCloseTo(1, 12); expect(norm(f.north)).toBeCloseTo(1, 12);
      expect(dot(f.east, f.up)).toBeCloseTo(0, 12); expect(dot(f.north, f.up)).toBeCloseTo(0, 12);
    }
  });
  it("launches east on the equator and north into a polar orbit", () => {
    expect(cutoff(DEFAULT_LAUNCH).launch!.cutoff!.orbit.inclination).toBeCloseTo(0, 7);
    const north = cutoff({ ...DEFAULT_LAUNCH, azimuth: 0 });
    expect(north.launch!.cutoff!.orbit.inclination).toBeCloseTo(90, 6);
    expect(Math.abs(north.position[2])).toBeGreaterThan(5e5);
  });
  it.each([-90, -65, 65, 90])("produces finite polar / high-latitude flight at %s degrees", (latitude) => {
    const config = { ...DEFAULT_LAUNCH, latitude, longitude: 37, azimuth: 90, burnTime: 100 };
    const a = cutoff(config, 1), b = cutoff(config, 1 / 7);
    const ca = a.launch!.cutoff!, cb = b.launch!.cutoff!;
    expect([...a.position, ...a.velocity, ca.altitude, ca.speed].every(Number.isFinite)).toBe(true);
    expect(ca.elapsed).toBeCloseTo(100, 7);
    expect(relative(ca.altitude, cb.altitude)).toBeLessThan(1e-5);
    expect(relative(ca.speed, cb.speed)).toBeLessThan(1e-5);
    expect(ca.orbit.inclination).not.toBeNull();
  });
  it("keeps polar-site launches in their chosen meridian without compass-heading singularities", () => {
    const equatorial = cutoff(DEFAULT_LAUNCH).launch!.cutoff!;
    for (const latitude of [-90, 90]) for (const azimuth of [0, 90, 237]) {
      const c = cutoff({ ...DEFAULT_LAUNCH, latitude, longitude: 37, azimuth }).launch!.cutoff!;
      expect(c.orbit.inclination).toBeCloseTo(90, 6);
      expect(relative(c.altitude, equatorial.altitude)).toBeLessThan(1e-7);
      expect(relative(c.speed, equatorial.speed)).toBeLessThan(1e-7);
    }
  });
  it("keeps vertical flights radial at any site and aligns fuel depletion", () => {
    const config = { ...DEFAULT_LAUNCH, latitude: 63, longitude: -120, pitch: 90, burnTime: 1000, fuelMass: 1000 };
    const b = cutoff(config);
    expect(b.launch!.cutoff!.reason).toBe("Fuel depleted");
    expect(b.launch!.cutoff!.orbit.inclination).toBeNull();
    expect(norm(cross(unit(b.position), unit(b.velocity)))).toBeLessThan(1e-10);
  });
});
