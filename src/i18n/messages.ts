import type { BodyState, CutoffReason } from "../types";
import { DomainError, isErrorCode, type ErrorPayload } from "../messages";
import { msg, tx, type MessageRef } from "./index";

export function errorMessage(error: unknown): MessageRef {
  const payload = error && typeof error === "object" ? error as Partial<ErrorPayload> : {};
  return msg(`errors:${isErrorCode(payload.code) ? payload.code : "UNEXPECTED_ERROR"}`, payload.params);
}
export function requestError(payload: Partial<ErrorPayload> & { error?: string }): DomainError {
  const code = isErrorCode(payload.code) ? payload.code : "REQUEST_FAILED";
  return new DomainError(code, payload.error, payload.params);
}
export const bodyName = (body: Pick<BodyState, "name" | "launch">) => body.launch ? tx("sandbox:launchVehicle") : body.name;
const cutoffKeys = {
  fuelDepleted: "sandbox:fuelDepleted", burnTimeReached: "sandbox:burnTimeReached",
  surfaceImpact: "sandbox:surfaceImpact", engineStopped: "sandbox:engineStopped",
} as const satisfies Record<CutoffReason, MessageRef["key"]>;
export const cutoffLabel = (reason: CutoffReason) => tx(cutoffKeys[reason] ?? "errors:UNEXPECTED_ERROR");
