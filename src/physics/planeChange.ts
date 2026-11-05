import type { BodyState, CentralBody, EquatorialNode, PlaneChangePlan, Vec3 } from "../types";
import { advanceBody, keplerStep, muOf } from "./core";
import { orbitalFrame, RAD } from "./frames";
import { add, cross, dot, norm, scale, sub, unit } from "./vector";

const tau = 2 * Math.PI;
const wrap = (a: number) => ((a % tau) + tau) % tau;

/** Time from the present state to a direction in its orbital plane. */
function timeToDirection(body: BodyState, direction: Vec3, central: CentralBody): number | null {
  const mu = muOf(central), r = norm(body.position), h = cross(body.position, body.velocity);
  const p = dot(h, h) / mu, evec = sub(scale(cross(body.velocity, h), 1 / mu), unit(body.position));
  const e = norm(evec), n = unit(h), x = e > 1e-10 ? unit(evec) : unit(body.position);
  const y = cross(n, x);
  const current = Math.atan2(dot(body.position, y), dot(body.position, x));
  const target = Math.atan2(dot(direction, y), dot(direction, x));
  if (1 + e * Math.cos(target) <= 1e-12) return null;
  if (Math.abs(wrap(target - current)) < 1e-10 || Math.abs(wrap(current - target)) < 1e-10) return 0;
  let delay: number;
  if (e < 1 - 1e-8) {
    const mean = (nu: number) => {
      const E = Math.atan2(Math.sqrt(1 - e * e) * Math.sin(nu), e + Math.cos(nu));
      return E - e * Math.sin(E);
    };
    const a = p / (1 - e * e);
    delay = wrap(mean(target) - mean(current)) * Math.sqrt(a ** 3 / mu);
  } else if (e > 1 + 1e-8) {
    const mean = (nu: number) => {
      const H = Math.asinh(Math.sqrt(e * e - 1) * Math.sin(nu) / (1 + e * Math.cos(nu)));
      return e * Math.sinh(H) - H;
    };
    delay = (mean(target) - mean(current)) * Math.sqrt((p / (e * e - 1)) ** 3 / mu);
  } else {
    const barker = (nu: number) => {
      const d = Math.tan(nu / 2);
      return d + d ** 3 / 3;
    };
    delay = (barker(target) - barker(current)) * Math.sqrt(p ** 3 / mu) / 2;
  }
  if (!Number.isFinite(delay) || delay < 0) return null;
  // Refine the conic time formula against the same propagator used at runtime.
  for (let k = 0; k < 12; k++) {
    const at = keplerStep(body.position, body.velocity, delay, mu);
    if (Math.abs(at.position[2]) < r * 1e-12) break;
    if (Math.abs(at.velocity[2]) < 1e-10) break;
    const next = delay - at.position[2] / at.velocity[2];
    if (!Number.isFinite(next) || next < 0) return null;
    delay = next;
  }
  return delay;
}

export function nextEquatorialNode(body: BodyState, central: CentralBody): EquatorialNode | null {
  if (body.status !== "flying") return null;
  const { normal } = orbitalFrame(body);
  if (!normal) return null;
  const line = cross([0, 0, 1], normal);
  if (norm(line) < 1e-10)
    return { delay: 0, position: [...body.position], kind: "equatorial" };
  const nodes = [unit(line), scale(unit(line), -1)].flatMap((direction) => {
    const delay = timeToDirection(body, direction, central);
    if (delay === null) return [];
    const at = keplerStep(body.position, body.velocity, delay, muOf(central));
    if (dot(at.position, direction) <= 0 || Math.abs(at.position[2]) > norm(at.position) * 1e-8) return [];
    return [{ delay, position: at.position, kind: at.velocity[2] >= 0 ? "ascending" as const : "descending" as const }];
  });
  return nodes.sort((a, b) => a.delay - b.delay)[0] ?? null;
}

export function planPlaneChange(body: BodyState, central: CentralBody, targetInclination: number, epoch: number, revision: number): PlaneChangePlan {
  if (!Number.isFinite(targetInclination) || targetInclination < 0 || targetInclination > 180)
    throw new Error("Target inclination must be between 0° and 180°.");
  if (body.burn || (body.launch && !body.launch.cutoff))
    throw new Error("Stop the engine before planning a plane change.");
  const node = nextEquatorialNode(body, central);
  if (!node) throw new Error("No future equatorial node exists, or the orbital plane is undefined.");
  const at = structuredClone(body);
  advanceBody(at, central, node.delay);
  if (at.status !== "flying" || norm(at.position) <= central.radius)
    throw new Error("The spacecraft will hit the surface before reaching the node.");
  const { radial, normal: oldNormal } = orbitalFrame(at);
  const horizontal = unit(cross([0, 0, 1], radial));
  const i = targetInclination * RAD;
  const candidates = [1, -1].map((sign) => add(scale([0, 0, 1], Math.cos(i)), scale(horizontal, sign * Math.sin(i))));
  const targetNormal = candidates.sort((a, b) => dot(b, oldNormal!) - dot(a, oldNormal!))[0];
  const radialSpeed = dot(at.velocity, radial), transverseSpeed = norm(cross(radial, at.velocity));
  const finalVelocity = add(scale(radial, radialSpeed), scale(unit(cross(targetNormal, radial)), transverseSpeed));
  return { bodyId: body.id, epoch, revision, nodeTime: epoch + node.delay, node: { ...node, position: [...at.position] }, deltaV: sub(finalVelocity, at.velocity), finalVelocity, targetInclination };
}

