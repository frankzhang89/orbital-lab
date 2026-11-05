/// <reference lib="webworker" />
import type {
  BodyState,
  Prediction,
  Snapshot,
  WorkerCommand,
  WorkerResponse,
} from "../types";
import { DEFAULT_SCENE } from "../defaults";
import {
  abortBurn,
  advanceBody,
  applyManeuver,
  createLaunch,
  createOrbiter,
  orbitPath,
  orbitSummary,
} from "./core";
import { norm } from "./vector";
import { planPlaneChange } from "./planeChange";
import { advanceSimulation, invalidatePlaneChange, schedulePlaneChange } from "./timeline";

let state: Snapshot = {
  central: structuredClone(DEFAULT_SCENE.central),
  bodies: [],
  time: 0,
  running: false,
  warp: 1,
  achievedWarp: 1,
  revision: 0,
};
let predictionToken = 0;
const send = (message: WorkerResponse) => self.postMessage(message);
const publish = () => send({ type: "snapshot", snapshot: state });
const waitForMessages = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

function advance(dt: number) {
  advanceSimulation(state, dt);
}

async function predict(command: Extract<WorkerCommand, { type: "predict" }>) {
  const token = ++predictionToken,
    central = structuredClone(state.central);
  const current = state.bodies.find((b) => b.id === command.id);
  if (!current && !command.launch) return;
  const body: BodyState = command.launch
    ? createLaunch(command.id, command.launch, central)
    : structuredClone(current!);
  body.trail = [];
  if (command.targetInclination !== undefined) {
    const plan = planPlaneChange(body, central, command.targetInclination, state.time, state.revision);
    advanceBody(body, central, plan.node.delay);
    body.velocity = [...plan.finalVelocity];
    if (token !== predictionToken) return;
    send({ type: "prediction", prediction: {
      id: command.requestId, bodyId: body.id, path: orbitPath(body, central), final: body,
      orbit: orbitSummary(body, central), zeroSpeedFallback: false, planeChange: plan,
    } });
    return;
  }
  const zeroSpeedFallback =
    norm(body.velocity) < 1e-8 &&
    !!command.spec &&
    ["prograde", "retrograde"].includes(command.spec.direction);
  if (command.spec) applyManeuver(body, command.spec);
  const path = [[...body.position] as [number, number, number]];
  let steps = 0;
  while (
    (body.burn || (body.launch && !body.launch.cutoff)) &&
    body.status !== "crashed"
  ) {
    advanceBody(body, central, 1);
    path.push([...body.position]);
    if (++steps % 40 === 0) {
      await waitForMessages();
      if (token !== predictionToken) return;
    }
    if (steps > 15000) throw new Error("Prediction exceeded its time limit.");
  }
  const orbit = orbitSummary(body, central);
  if (body.status === "flying") {
    if (command.launch || command.spec?.mode === "finite") {
      // Keep the powered path distinct from the osculating coast drawn by the renderer.
      const duration = Math.min(orbit.period ?? 8000, 30000);
      for (let i = 0; i < 240 && body.status === "flying"; i++) {
        advanceBody(body, central, duration / 240);
        path.push([...body.position]);
        if (i % 40 === 0) {
          await waitForMessages();
          if (token !== predictionToken) return;
        }
      }
    } else path.splice(0, path.length, ...orbitPath(body, central));
  }
  if (token !== predictionToken) return;
  const prediction: Prediction = {
    id: command.requestId,
    bodyId: command.id,
    path,
    final: body,
    orbit,
    cutoff: body.launch?.cutoff,
    zeroSpeedFallback,
  };
  send({ type: "prediction", prediction });
}

self.onmessage = (event: MessageEvent<WorkerCommand>) => {
  const command = event.data;
  try {
    if (command.type === "predict") {
      void predict(command).catch((error) =>
        send({ type: "error", message: String(error.message ?? error) }),
      );
      return;
    }
    if (command.type === "cancelPrediction") {
      predictionToken++;
      return;
    }
    if (command.type === "running") state.running = command.value;
    else if (command.type === "warp") state.warp = command.value;
    else if (command.type === "cancelPlaneChange") {
      invalidatePlaneChange(state);
      state.running = false;
    } else if (command.type === "schedulePlaneChange") {
      schedulePlaneChange(state, command.plan);
      advance(0);
      state.running = true;
      predictionToken++;
    }
    else if (command.type === "step") {
      state.running = false;
      advance(1);
    } else {
      predictionToken++;
      state.revision++;
      if (command.type === "reset") {
        state = {
          ...state,
          central: structuredClone(command.config.central),
          bodies: command.config.orbiters.map((o) =>
            createOrbiter(o, command.config.central),
          ),
          time: 0,
          running: false,
          pendingPlaneChange: undefined,
          planeChangeResult: undefined,
        };
      } else if (command.type === "central") {
        invalidatePlaneChange(state);
        state.running = false;
        state.central = structuredClone(command.central);
        for (const body of state.bodies)
          if (norm(body.position) <= state.central.radius) {
            abortBurn(body, state.central);
            body.status = "crashed";
          }
      } else if (command.type === "add")
        state.bodies.push(createOrbiter(command.orbiter, state.central));
      else if (command.type === "remove") {
        invalidatePlaneChange(state, command.id);
        state.bodies = state.bodies.filter((b) => b.id !== command.id);
      } else if (command.type === "orbit") {
        invalidatePlaneChange(state, command.orbiter.id);
        const index = state.bodies.findIndex(
          (b) => b.id === command.orbiter.id,
        );
        if (index >= 0)
          state.bodies[index] = createOrbiter(command.orbiter, state.central);
        state.running = false;
      } else if (command.type === "launch") {
        state.bodies.push(
          createLaunch(command.id, command.config, state.central),
        );
        state.running = true;
      } else {
        const body = state.bodies.find((b) => b.id === command.id);
        invalidatePlaneChange(state, command.id);
        if (body && command.type === "maneuver")
          applyManeuver(body, command.spec);
        if (body && command.type === "abort") abortBurn(body, state.central);
      }
    }
    publish();
  } catch (error) {
    state.running = false;
    send({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    publish();
  }
};

let previous = performance.now();
setInterval(() => {
  const now = performance.now(),
    wallTime = Math.min(0.1, (now - previous) / 1000);
  previous = now;
  if (!state.running) return;
  try {
    // Stop consuming catch-up time once the frame's physics budget is exhausted.
    const requested = wallTime * state.warp;
    let completed = 0;
    const start = performance.now();
    while (completed < requested - 1e-8) {
      const dt = Math.min(requested - completed, 2);
      advance(dt);
      completed += dt;
      if (performance.now() - start > 18) break;
    }
    state.achievedWarp = wallTime > 0 ? completed / wallTime : state.warp;
    publish();
  } catch (error) {
    state.running = false;
    send({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    publish();
  }
}, 33);
