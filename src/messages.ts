/** Stable, language-neutral error contract shared by the server and Worker. */
export const errorDiagnostics = {
  "UNEXPECTED_ERROR": "An unexpected error occurred. Please try again.",
  "REQUEST_FAILED": "The request failed.",
  "WORKER_STOPPED": "The simulation worker stopped unexpectedly.",
  "KEPLER_CONVERGENCE": "Orbital propagation could not converge. Reduce the time scale.",
  "ORBITAL_PLANE_UNDEFINED": "Orbital plane is undefined for radial or zero-speed motion. Use prograde or radial thrust first.",
  "CRAFT_ENGINE_REQUIRED_OFF": "Select a flying spacecraft with its engine off.",
  "INTEGRATION_BUDGET": "Integration budget exceeded. Check the simulation parameters.",
  "NON_FINITE_STATE": "Non-finite physical state. Check the input parameters.",
  "PROPAGATION_BUDGET": "Propagation budget exceeded.",
  "PREDICTION_LIMIT": "Prediction exceeded its time limit.",
  "TARGET_INCLINATION_INVALID": "Target inclination must be between 0° and 180°.",
  "ENGINE_ACTIVE": "Stop the engine before planning a plane change.",
  "NO_FUTURE_NODE": "No future equatorial node exists, or the orbital plane is undefined.",
  "IMPACT_BEFORE_NODE": "The spacecraft will hit the surface before reaching the node.",
  "STALE_PREVIEW": "The plane-change preview is out of date. Preview again before executing.",
  "PLAN_ALREADY_PENDING": "Cancel the existing plane change before scheduling another.",
  "WEBGL_UNAVAILABLE": "WebGL is unavailable. Enable hardware acceleration to view the simulation.",
  "CONFIG_READ_FAILED": "Unable to read celestial-configs.json. Check file permissions.",
  "CONFIG_DAMAGED": "celestial-configs.json is damaged or uses an unsupported format. The file has been preserved.",
  "CONFIG_SAVE_FAILED": "Unable to save celestial-configs.json. Check disk space and file permissions.",
  "CONFIG_INVALID": "Invalid configuration. Check names, masses, radii, altitudes, phases, inclinations and ascending nodes.",
  "CONFIG_ID_INVALID": "Invalid configuration ID.",
  "CONFIG_LIBRARY_FULL": "The configuration library is full.",
  "CONFIG_NOT_FOUND": "Configuration not found.",
  "SAME_ORIGIN_REQUIRED": "Only same-origin requests are accepted.",
  "API_NOT_FOUND": "API endpoint not found.",
  "REQUEST_TOO_LARGE": "Configuration request is too large.",
  "INVALID_JSON": "Invalid JSON request."
} as const;
export type ErrorCode = keyof typeof errorDiagnostics;
export type ErrorParams = Record<string, string | number>;
export interface ErrorPayload { code: ErrorCode; params?: ErrorParams; message: string }
export const isErrorCode = (value: unknown): value is ErrorCode => typeof value === "string" && Object.prototype.hasOwnProperty.call(errorDiagnostics, value);
export class DomainError extends Error {
  constructor(public code: ErrorCode, diagnostic?: string, public params?: ErrorParams) {
    super(diagnostic ?? errorDiagnostics[code]);
    this.name = "DomainError";
  }
}
export function toErrorPayload(error: unknown): ErrorPayload {
  if (error instanceof DomainError) return { code: error.code, params: error.params, message: error.message };
  return { code: "UNEXPECTED_ERROR", message: error instanceof Error ? error.message : errorDiagnostics.UNEXPECTED_ERROR };
}
