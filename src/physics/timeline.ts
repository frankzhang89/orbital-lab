import { DomainError } from "../messages";
import type { Snapshot, PlaneChangePlan } from "../types";
import { advanceBody, orbitSummary } from "./core";
import { norm, sub } from "./vector";
import { planPlaneChange } from "./planeChange";

export function schedulePlaneChange(state: Snapshot, plan: PlaneChangePlan): void {
  const body = state.bodies.find((b) => b.id === plan.bodyId);
  if (!body || plan.revision !== state.revision || Math.abs(plan.epoch - state.time) > 1e-7)
    throw new DomainError("STALE_PREVIEW");
  if (state.pendingPlaneChange) throw new DomainError("PLAN_ALREADY_PENDING");
  // Recompute rather than trusting vectors supplied by the interface.
  state.pendingPlaneChange = planPlaneChange(body, state.central, plan.targetInclination, state.time, state.revision);
  delete state.planeChangeResult;
}

function executePending(state: Snapshot) {
  const plan = state.pendingPlaneChange;
  if (!plan || plan.nodeTime > state.time + 1e-8) return;
  const body = state.bodies.find((b) => b.id === plan.bodyId);
  delete state.pendingPlaneChange;
  if (!body || body.status !== "flying" || body.burn || (body.launch && !body.launch.cutoff)) return;
  body.velocity = [...plan.finalVelocity];
  body.lastBurn = { integratedDeltaV: norm(plan.deltaV), velocityChange: norm(plan.deltaV) };
  state.revision++;
  state.planeChangeResult = { bodyId: body.id, time: state.time, inclination: orbitSummary(body, state.central).inclination, deltaV: norm(plan.deltaV) };
}

/** Event-aligned advancement shared by the Worker and integration tests. */
export function advanceSimulation(state: Snapshot, duration: number): void {
  let remaining = duration;
  executePending(state);
  while (remaining > 1e-9) {
    const dt = Math.min(remaining, state.pendingPlaneChange ? Math.max(0, state.pendingPlaneChange.nodeTime - state.time) : remaining);
    if (dt <= 1e-9) { executePending(state); continue; }
    for (const body of state.bodies) {
      advanceBody(body, state.central, dt);
      const previous = body.trail.at(-1);
      if (!previous || norm(sub(body.position, previous)) > state.central.radius * 0.002) {
        body.trail.push([...body.position]);
        if (body.trail.length > 300) body.trail.shift();
      }
    }
    state.time += dt;
    remaining -= dt;
    if (state.pendingPlaneChange && state.bodies.find((b) => b.id === state.pendingPlaneChange!.bodyId)?.status !== "flying")
      delete state.pendingPlaneChange;
    executePending(state);
  }
}

export function invalidatePlaneChange(state: Snapshot, bodyId?: string): void {
  if (!bodyId || state.pendingPlaneChange?.bodyId === bodyId) delete state.pendingPlaneChange;
}
