import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_SCENE } from "./defaults";
import { createOrbiter } from "./physics/core";
import type {
  Prediction,
  Snapshot,
  WorkerCommand,
  WorkerResponse,
} from "./types";

export function useSimulation(onError: (message: string) => void) {
  const workerRef = useRef<Worker | null>(null);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const [snapshot, setSnapshot] = useState<Snapshot>({
    central: DEFAULT_SCENE.central,
    bodies: DEFAULT_SCENE.orbiters.map((o) =>
      createOrbiter(o, DEFAULT_SCENE.central),
    ),
    time: 0,
    running: false,
    warp: 1,
    achievedWarp: 1,
    revision: 0,
  });
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const requestIdRef = useRef(0);
  useEffect(() => {
    const worker = new Worker(
      new URL("./physics/simulation.worker.ts", import.meta.url),
      { type: "module" },
    );
    workerRef.current = worker;
    worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      if (data.type === "snapshot") setSnapshot(data.snapshot);
      if (
        data.type === "prediction" &&
        data.prediction.id === requestIdRef.current
      )
        setPrediction(data.prediction);
      if (data.type === "error") errorRef.current(data.message);
    };
    worker.onerror = (event) =>
      errorRef.current(
        event.message || "The simulation worker stopped unexpectedly.",
      );
    worker.postMessage({
      type: "reset",
      config: DEFAULT_SCENE,
    } satisfies WorkerCommand);
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);
  const post = useCallback(
    (command: WorkerCommand) => workerRef.current?.postMessage(command),
    [],
  );
  const cancelPrediction = useCallback(() => {
    requestIdRef.current++;
    setPrediction(null);
    post({ type: "cancelPrediction" });
  }, [post]);
  const predict = useCallback(
    (
      command: Omit<
        Extract<WorkerCommand, { type: "predict" }>,
        "type" | "requestId"
      >,
    ) => {
      const requestId = ++requestIdRef.current;
      setPrediction(null);
      post({ type: "predict", requestId, ...command });
    },
    [post],
  );
  return { snapshot, prediction, post, predict, cancelPrediction };
}
