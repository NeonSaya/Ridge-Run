import {
  CAMERA_WIDTH_PRESETS,
  DEFAULT_CAMERA_WIDTH,
  MAX_CAMERA_WIDTH,
  MIN_CAMERA_WIDTH,
} from "./constants";
import type { CameraState, CarState, GameState, JumpState, ViewState } from "./types";
import { clamp, lerp } from "./utils";

export function clampCameraWidth(cameraWidth: number): number {
  if (!Number.isFinite(cameraWidth)) return DEFAULT_CAMERA_WIDTH;
  return clamp(Math.round(cameraWidth), MIN_CAMERA_WIDTH, MAX_CAMERA_WIDTH);
}

export function cameraWidthTag(width: number): string {
  const w = clampCameraWidth(width);
  if (w <= 33) return "特写近景";
  if (w <= 38) return w === DEFAULT_CAMERA_WIDTH ? "默认近景" : "标准近景";
  if (w <= 43) return "均衡中景";
  return "广角远景";
}

export function computeBaseScale(viewportWidth: number, cameraWidth: number): number {
  const targetWidth = clampCameraWidth(cameraWidth);
  const safeWidth = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1;
  return safeWidth / targetWidth;
}

export function computeZoomMultiplier(
  vx: number,
  nitroActive: boolean,
): number {
  const speedZoom = 1 - clamp(Math.abs(vx) / 92, 0, 0.1);
  const nitroZoom = nitroActive ? 0.94 : 1;
  return speedZoom * nitroZoom;
}

export function effectiveCameraWidth(
  viewportWidth: number,
  scale: number,
  fallbackWidth = DEFAULT_CAMERA_WIDTH,
): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return fallbackWidth;
  if (!Number.isFinite(scale) || scale <= 0) return fallbackWidth;
  return Math.max(1, Math.round(viewportWidth / scale));
}

export function nextPresetCameraWidth(currentWidth: number): number {
  const current = clampCameraWidth(currentWidth);
  let nextIndex = CAMERA_WIDTH_PRESETS.findIndex((preset) => preset > current);
  if (nextIndex < 0) nextIndex = 0;
  return CAMERA_WIDTH_PRESETS[nextIndex]!;
}

export function computeTargetCamera(
  state: GameState,
  viewportWidth: number,
  viewportHeight: number,
  currentScale: number,
  baseScale: number,
  renderCar: Pick<CarState, "x" | "y" | "vx" | "crashed">,
  jump: Pick<JumpState, "nitroTime">,
): CameraState {
  const safeScale = currentScale > 0 ? currentScale : baseScale;
  const visW = viewportWidth / safeScale;
  const visH = viewportHeight / safeScale;
  if (state === "intro") {
    return {
      x: renderCar.x - visW * 0.18,
      y: renderCar.y - visH * 0.15,
      scale: baseScale,
    };
  }
  const look = clamp(renderCar.vx * 0.4, -visW * 0.17, visW * 0.22);
  const zoom = computeZoomMultiplier(
    renderCar.vx,
    jump.nitroTime > 0 && !renderCar.crashed,
  );
  return {
    x: renderCar.x + look,
    y: renderCar.y - visH * 0.13,
    scale: baseScale * zoom,
  };
}

export function stepCameraState(
  camera: CameraState,
  target: CameraState,
  state: GameState,
  dt: number,
): void {
  const posK = 1 - Math.exp(-dt * (state === "intro" ? 1.25 : 4.4));
  const scaleK = 1 - Math.exp(-dt * 2.3);
  camera.x = lerp(camera.x, target.x, posK);
  camera.y = lerp(camera.y, target.y, posK);
  camera.scale = lerp(camera.scale, target.scale, scaleK);
}

export function applyCameraView(
  view: ViewState,
  camera: CameraState,
  shake: number,
  time: number,
): void {
  view.x = camera.x + (Math.sin(time * 137) * shake * 6.5) / camera.scale;
  view.y = camera.y + (Math.cos(time * 107) * shake * 4.5) / camera.scale;
  view.scale = camera.scale;
}
