import type { BodyState, Vec3 } from "../types";
import { cross, dot, norm, scale, unit } from "./vector";

export const RAD = Math.PI / 180;
export const degrees = (radians: number) => radians / RAD;
export const wrapDegrees = (angle: number) => ((angle % 360) + 360) % 360;
export const clamp = (n: number) => Math.max(-1, Math.min(1, n));

/** Rz(node) Rx(inclination): the inertial reference plane is XY, north is +Z. */
export function orbitalToWorld(v: Vec3, inclination: number, node: number): Vec3 {
  const i = inclination * RAD, o = node * RAD;
  const y = v[1] * Math.cos(i) - v[2] * Math.sin(i);
  const z = v[1] * Math.sin(i) + v[2] * Math.cos(i);
  return [v[0] * Math.cos(o) - y * Math.sin(o), v[0] * Math.sin(o) + y * Math.cos(o), z];
}

export function phaseInPlane(position: Vec3, inclination: number, node: number): number {
  const x = orbitalToWorld([1, 0, 0], inclination, node);
  const y = orbitalToWorld([0, 1, 0], inclination, node);
  return wrapDegrees(degrees(Math.atan2(dot(position, y), dot(position, x))));
}

export function orbitalFrame(body: Pick<BodyState, "position" | "velocity">) {
  const radial = unit(body.position), h = cross(body.position, body.velocity);
  const defined = norm(h) > Math.max(1e-8, norm(body.position) * norm(body.velocity) * 1e-10);
  const normal = defined ? unit(h) : null;
  // A deterministic horizontal fallback, including at the poles, for zero-speed prograde.
  const reference: Vec3 = Math.abs(radial[2]) < 0.99 ? [0, 0, 1] : [1, 0, 0];
  const transverse = normal ? unit(cross(normal, radial)) : unit(cross(reference, radial));
  return { radial, transverse, normal };
}

export function planeOrientation(body: Pick<BodyState, "position" | "velocity">) {
  const { normal } = orbitalFrame(body);
  if (!normal) return { inclination: null, ascendingNode: null };
  const inclination = degrees(Math.atan2(Math.hypot(normal[0], normal[1]), normal[2]));
  const node = cross([0, 0, 1], normal);
  return { inclination, ascendingNode: norm(node) < 1e-10 ? null : wrapDegrees(degrees(Math.atan2(node[1], node[0]))) };
}

export function surfacePosition(latitude: number, longitude: number, radius: number): Vec3 {
  const lat = latitude * RAD, lon = longitude * RAD;
  return scale([Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)], radius);
}

export function surfaceFrame(position: Vec3, polarLongitude: number) {
  const up = unit(position);
  const lon = Math.hypot(up[0], up[1]) < 1e-10 ? polarLongitude * RAD : Math.atan2(up[1], up[0]);
  const east: Vec3 = [-Math.sin(lon), Math.cos(lon), 0];
  return { up, east, north: unit(cross(up, east)) };
}
