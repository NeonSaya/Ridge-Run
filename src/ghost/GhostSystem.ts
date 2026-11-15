import {
  GHOST_CODE_PREFIX,
  GHOST_MAX_FRAMES,
  GHOST_SAMPLE_INTERVAL,
  GHOST_SHARE_MAX_FRAMES,
  MAX_GHOST_DISTANCE,
  MAX_GHOST_SHARE_STRIDE_V1,
  MAX_GHOST_STRIDE,
  START_X,
  VEHICLE_ORDER,
} from "../constants";
import { dailySeedFor, dailyVehicleFor, isDateKey } from "../daily";
import type { GhostMode, GhostRecord, VehicleId } from "../types";
import { clamp, lerp } from "../utils";

export interface GhostFrame {
  x: number;
  y: number;
  angle: number;
}

export interface GhostPose extends GhostFrame {
  /** Horizontal speed in m/s between the two surrounding frames. */
  vx: number;
  /** True once the replay has reached its final stored frame. */
  finished: boolean;
}

export interface GhostMeta {
  mode: GhostMode;
  seed: number;
  dateKey?: string;
  vehicleId: VehicleId;
}

const MAX_PLAUSIBLE_STEP_X_COEFF = 120;
const MAX_PLAUSIBLE_STEP_Y_COEFF = 80;
const MIN_PLAUSIBLE_STEP_X = 60;
const MIN_PLAUSIBLE_STEP_Y = 40;

function quantize(value: number, scale: number): number {
  return Math.round(value * scale);
}

/** Keep angles on the unit circle so deltas stay inside an int16. */
function normalizeAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function frameOf(x: number, y: number, angle: number): GhostFrame {
  return { x, y, angle: normalizeAngle(angle) };
}

function shortestAngle(delta: number): number {
  return Math.atan2(Math.sin(delta), Math.cos(delta));
}

/* ---------- recording ---------- */

/**
 * Samples the live car at 6.7 Hz and doubles sample stride on overflow so
 * arbitrarily long runs stay within the 1200-frame budget without drift,
 * compression, or truncated endings.
 */
export class GhostRecorder {
  private meta: GhostMeta | null = null;
  private samples: GhostFrame[] = [];
  private stride = 1;
  private since = GHOST_SAMPLE_INTERVAL;
  private elapsed = 0;

  reset(meta: GhostMeta): void {
    this.meta = meta;
    this.samples = [];
    this.stride = 1;
    this.since = GHOST_SAMPLE_INTERVAL;
    this.elapsed = 0;
  }

  tick(dt: number, x: number, y: number, angle: number): void {
    if (!this.meta) return;
    const validDt = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this.elapsed += validDt;
    if (this.samples.length === 0) {
      this.samples.push(frameOf(x, y, angle));
      this.since = 0;
      return;
    }
    if (validDt <= 0) return;

    this.since += validDt;
    let step = GHOST_SAMPLE_INTERVAL * this.stride;
    while (this.since + 1e-9 >= step) {
      if (this.samples.length >= GHOST_MAX_FRAMES) {
        if (this.stride * 2 > MAX_GHOST_STRIDE) break;
        const compacted: GhostFrame[] = [];
        for (let i = 0; i < this.samples.length; i += 2) {
          compacted.push(this.samples[i]!);
        }
        this.samples = compacted;
        this.stride *= 2;
        // Deduct the pre-compaction step so the new sample stays anchored at
        // index 600 * (2 * oldStep) = 1200 * oldStep with zero timing shift.
        this.since = Math.max(0, this.since - step);
        step = GHOST_SAMPLE_INTERVAL * this.stride;
        this.samples.push(frameOf(x, y, angle));
      } else {
        this.since = Math.max(0, this.since - step);
        this.samples.push(frameOf(x, y, angle));
      }
    }
  }

  finish(
    distance: number,
    x: number,
    y: number,
    angle: number,
  ): GhostRecord | null {
    if (!this.meta) return null;
    const final = frameOf(x, y, angle);
    const last = this.samples[this.samples.length - 1];
    const step = GHOST_SAMPLE_INTERVAL * this.stride;
    const lastSampleTime = Math.max(0, this.samples.length - 1) * step;
    const turned =
      !last ||
      Math.abs(
        Math.atan2(
          Math.sin(last.angle - final.angle),
          Math.cos(last.angle - final.angle),
        ),
      ) > 0.01;
    const moved =
      !last ||
      Math.abs(last.x - final.x) > 0.001 ||
      Math.abs(last.y - final.y) > 0.001 ||
      turned;
    const heldAfterSample =
      this.samples.length < GHOST_MAX_FRAMES &&
      this.elapsed - lastSampleTime > 0.001;

    if (!last) {
      this.samples.push(final);
    } else if (moved || heldAfterSample) {
      if (this.samples.length >= GHOST_MAX_FRAMES) {
        if (this.stride * 2 <= MAX_GHOST_STRIDE) {
          const compacted: GhostFrame[] = [];
          for (let i = 0; i < this.samples.length; i += 2) {
            compacted.push(this.samples[i]!);
          }
          this.samples = compacted;
          this.stride *= 2;
          this.samples.push(final);
        } else {
          this.samples[this.samples.length - 1] = final;
        }
      } else {
        this.samples.push(final);
      }
    }

    const duration = Math.round(this.elapsed * 1000) / 1000;
    return {
      version: 1,
      mode: this.meta.mode,
      seed: this.meta.seed >>> 0,
      dateKey: this.meta.mode === "daily" ? this.meta.dateKey : undefined,
      vehicleId: this.meta.vehicleId,
      distance: Math.max(0, Math.round(distance)),
      frames: encodeFrames(this.samples),
      stride: this.stride,
      duration,
    };
  }
}

function encodeFrames(frames: GhostFrame[]): number[] {
  const out: number[] = [];
  let px = 0;
  let py = 0;
  let pa = 0;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    const qx = quantize(frame.x, 10);
    const qy = quantize(frame.y, 10);
    const qa = quantize(normalizeAngle(frame.angle), 100);
    if (i === 0) out.push(qx, qy, qa);
    else out.push(qx - px, qy - py, qa - pa);
    px = qx;
    py = qy;
    pa = qa;
  }
  return out;
}

/** Decode the flat delta array into absolute world-space frames. */
export function decodeGhostFrames(record: GhostRecord): GhostFrame[] {
  const data = record.frames;
  if (!Array.isArray(data) || data.length < 3) return [];
  const firstX = Number(data[0]);
  const firstY = Number(data[1]);
  const firstA = Number(data[2]);
  if (![firstX, firstY, firstA].every(Number.isFinite)) return [];

  const frames: GhostFrame[] = [
    { x: firstX / 10, y: firstY / 10, angle: firstA / 100 },
  ];
  let qx = firstX;
  let qy = firstY;
  let qa = firstA;
  const usable = data.length - (data.length % 3);
  for (let i = 3; i < usable; i += 3) {
    const dx = Number(data[i]);
    const dy = Number(data[i + 1]);
    const da = Number(data[i + 2]);
    if (![dx, dy, da].every(Number.isFinite)) return [];
    qx += dx;
    qy += dy;
    qa += da;
    if (Math.abs(qx) > 1e8 || Math.abs(qy) > 1e8 || Math.abs(qa) > 1e7) {
      return [];
    }
    frames.push({ x: qx / 10, y: qy / 10, angle: qa / 100 });
  }
  return frames;
}

/* ---------- playback ---------- */

export class GhostPlayback {
  readonly record: GhostRecord;
  private readonly frames: GhostFrame[];
  private readonly step: number;
  private readonly duration?: number;

  constructor(record: GhostRecord) {
    this.record = record;
    this.frames = decodeGhostFrames(record);
    const stride = Math.max(1, Math.floor(record.stride ?? 1));
    this.step = GHOST_SAMPLE_INTERVAL * stride;
    this.duration =
      typeof record.duration === "number" &&
      Number.isFinite(record.duration) &&
      record.duration >= 0
        ? record.duration
        : undefined;
  }

  get ready(): boolean {
    return this.frames.length > 0;
  }

  sample(time: number): GhostPose {
    const frames = this.frames;
    if (frames.length === 0) {
      return { x: START_X, y: 0, angle: 0, vx: 0, finished: true };
    }
    const clampedTime = Math.max(0, time);
    const lastIndex = frames.length - 1;
    if (lastIndex === 0) {
      const only = frames[0]!;
      const endTime = this.duration ?? 0;
      return {
        x: only.x,
        y: only.y,
        angle: only.angle,
        vx: 0,
        finished: clampedTime >= endTime,
      };
    }

    const penultimateTime = (lastIndex - 1) * this.step;
    const endTime =
      this.duration !== undefined
        ? Math.max(penultimateTime, this.duration)
        : lastIndex * this.step;

    if (clampedTime >= endTime) {
      const last = frames[lastIndex]!;
      return {
        x: last.x,
        y: last.y,
        angle: last.angle,
        vx: 0,
        finished: true,
      };
    }

    if (clampedTime >= penultimateTime) {
      const from = frames[lastIndex - 1]!;
      const to = frames[lastIndex]!;
      const tailStep = Math.max(1e-6, endTime - penultimateTime);
      const t = clamp((clampedTime - penultimateTime) / tailStep, 0, 1);
      return {
        x: lerp(from.x, to.x, t),
        y: lerp(from.y, to.y, t),
        angle: from.angle + shortestAngle(to.angle - from.angle) * t,
        vx: (to.x - from.x) / tailStep,
        finished: false,
      };
    }

    const position = clampedTime / this.step;
    const index = Math.min(lastIndex - 2, Math.floor(position));
    const from = frames[index]!;
    const to = frames[index + 1]!;
    const t = clamp(position - index, 0, 1);
    return {
      x: lerp(from.x, to.x, t),
      y: lerp(from.y, to.y, t),
      angle: from.angle + shortestAngle(to.angle - from.angle) * t,
      vx: (to.x - from.x) / this.step,
      finished: false,
    };
  }
}

/** Distance already covered by the ghost, capped at its recorded finish. */
export function ghostProgress(record: GhostRecord, pose: GhostPose): number {
  if (pose.finished) return record.distance;
  return clamp(pose.x - START_X, 0, record.distance);
}

/* ---------- compact URL-safe codec ---------- */

function fnv1a(bytes: ArrayLike<number>, end: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < end; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(
      ...Array.from(bytes.subarray(i, Math.min(i + chunk, bytes.length))),
    );
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const base = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base + "=".repeat((4 - (base.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch (_) {
    return null;
  }
}

interface QuantFrame {
  x: number;
  y: number;
  angle: number;
}

function quantizeFrame(frame: GhostFrame): QuantFrame {
  return {
    x: quantize(frame.x, 10),
    y: quantize(frame.y, 10),
    angle: quantize(normalizeAngle(frame.angle), 100),
  };
}

function clampInt16(value: number): number {
  return clamp(Math.round(value), -32768, 32767);
}

function encodeBinary(record: GhostRecord, maxFrames: number): string {
  const absolute = decodeGhostFrames(record);
  if (absolute.length === 0) return "";

  // The incoming record may already have been thinned: its frames then
  // represent `record.stride` sample ticks each. Keep that time base when
  // thinning again, otherwise a re-shared code replays too fast.
  const baseStride = Math.max(1, Math.floor(record.stride ?? 1));
  const thinStep = Math.max(1, Math.ceil(absolute.length / maxFrames));
  const encodedStride = clamp(baseStride * thinStep, 1, MAX_GHOST_STRIDE);
  const hasDuration =
    typeof record.duration === "number" &&
    Number.isFinite(record.duration) &&
    record.duration >= 0;
  const wireVersion = hasDuration
    ? 3
    : encodedStride > MAX_GHOST_SHARE_STRIDE_V1
      ? 2
      : 1;
  const kept: GhostFrame[] = [];
  for (let i = 0; i < absolute.length; i += thinStep) kept.push(absolute[i]!);
  const trueLast = absolute[absolute.length - 1]!;
  const keptLast = kept[kept.length - 1]!;
  if (keptLast !== trueLast) {
    if (kept.length >= maxFrames) kept.pop();
    kept.push(trueLast);
  }

  const bytes: number[] = [];
  const u8 = (value: number): void => {
    bytes.push(value & 0xff);
  };
  const u16 = (value: number): void => {
    u8(value);
    u8(value >>> 8);
  };
  const i16 = (value: number): void => {
    const v = clampInt16(value);
    u8(v & 0xff);
    u8((v >> 8) & 0xff);
  };
  const u32 = (value: number): void => {
    const v = value >>> 0;
    u8(v);
    u8(v >>> 8);
    u8(v >>> 16);
    u8(v >>> 24);
  };
  const i32 = (value: number): void => {
    const v = Math.round(value);
    u8(v & 0xff);
    u8((v >> 8) & 0xff);
    u8((v >> 16) & 0xff);
    u8((v >> 24) & 0xff);
  };

  u8(wireVersion);
  u8(record.mode === "daily" ? 1 : 0);
  u32(record.seed);
  const vehicleIndex = VEHICLE_ORDER.indexOf(record.vehicleId);
  u8(vehicleIndex >= 0 ? vehicleIndex : 0);
  if (wireVersion >= 2) u16(encodedStride);
  else u8(encodedStride);
  u32(Math.max(0, Math.round(record.distance)));
  u16(kept.length);
  if (wireVersion === 3) {
    u32(clamp(Math.round(record.duration! * 1000), 0, 0xffffffff));
  }

  if (record.mode === "daily") {
    const date = record.dateKey ?? "";
    const valid = isDateKey(date);
    for (let i = 0; i < 10; i++) u8(valid ? date.charCodeAt(i) : 0);
  }

  const quant = kept.map(quantizeFrame);
  let px = 0;
  let py = 0;
  let pa = 0;
  for (let i = 0; i < quant.length; i++) {
    const frame = quant[i]!;
    if (i === 0) {
      i32(frame.x);
      i32(frame.y);
      i16(frame.angle);
      px = frame.x;
      py = frame.y;
      pa = frame.angle;
    } else {
      const dx = clampInt16(frame.x - px);
      const dy = clampInt16(frame.y - py);
      const da = clampInt16(frame.angle - pa);
      i16(dx);
      i16(dy);
      i16(da);
      px += dx;
      py += dy;
      pa += da;
    }
  }

  const checksum = fnv1a(bytes, bytes.length) & 0xffff;
  u16(checksum);
  return toBase64Url(Uint8Array.from(bytes));
}

/** Serialise a record into a shareable `RR2.` code, thinned to 240 frames. */
export function encodeChallengeCode(record: GhostRecord): string {
  return `${GHOST_CODE_PREFIX}${encodeBinary(record, GHOST_SHARE_MAX_FRAMES)}`;
}

export const encodeGhostCode = encodeChallengeCode;

/** Pull the first `RR2.…` token out of a code, hash or full URL. */
export function extractGhostCode(input: string): string | null {
  if (typeof input !== "string" || input.length === 0) return null;
  let text = input.trim();
  try {
    text = decodeURIComponent(text);
  } catch (_) {
    /* keep the raw text when it is not percent-encoded */
  }
  const start = text.indexOf(GHOST_CODE_PREFIX);
  if (start < 0) return null;
  const rest = text.slice(start + GHOST_CODE_PREFIX.length);
  const match = /^[A-Za-z0-9_-]+/.exec(rest);
  if (!match) return null;
  return `${GHOST_CODE_PREFIX}${match[0]}`;
}

/** Validate and decode a challenge code. Any malformed input returns null. */
export function decodeChallengeCode(input: string): GhostRecord | null {
  try {
    return decodeChallengeCodeInner(input);
  } catch (_) {
    // Untrusted strings must never be able to throw out of the decoder.
    return null;
  }
}

function decodeChallengeCodeInner(input: string): GhostRecord | null {
  const token = extractGhostCode(input);
  if (!token) return null;
  const payload = token.slice(GHOST_CODE_PREFIX.length);
  const bytes = fromBase64Url(payload);
  if (!bytes || bytes.length < 16) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const wireVersion = view.getUint8(0);
  if (wireVersion < 1 || wireVersion > 3) return null;
  const modeByte = view.getUint8(1);
  if (modeByte > 1) return null;
  const mode: GhostMode = modeByte === 1 ? "daily" : "standard";
  const seed = view.getUint32(2, true);
  if (mode === "standard" && seed !== 0) return null;
  if (mode === "daily" && seed === 0) return null;
  const vehicleId = VEHICLE_ORDER[view.getUint8(6)];
  if (!vehicleId) return null;

  const baseHeader = wireVersion === 3 ? 19 : wireVersion === 2 ? 15 : 14;
  if (bytes.length < baseHeader + 12) return null;
  const stride =
    wireVersion >= 2 ? view.getUint16(7, true) : view.getUint8(7);
  if (stride < 1 || stride > MAX_GHOST_STRIDE) return null;
  const metaOffset = wireVersion >= 2 ? 9 : 8;
  const distance = view.getUint32(metaOffset, true);
  if (distance < 1 || distance > MAX_GHOST_DISTANCE) return null;
  const frameCount = view.getUint16(metaOffset + 4, true);
  if (frameCount < 1 || frameCount > GHOST_MAX_FRAMES) return null;
  const duration =
    wireVersion === 3 ? view.getUint32(15, true) / 1000 : undefined;

  // Validate the exact payload size before touching any frame/date bytes.
  const headerLength = baseHeader + (mode === "daily" ? 10 : 0);
  const expectedLength = headerLength + 10 + (frameCount - 1) * 6 + 2;
  if (bytes.length !== expectedLength) return null;

  let dateKey: string | undefined;
  if (mode === "daily") {
    let raw = "";
    for (let i = baseHeader; i < baseHeader + 10; i++) {
      const char = view.getUint8(i);
      if (char > 0) raw += String.fromCharCode(char);
    }
    if (!isDateKey(raw)) return null;
    dateKey = raw;
  }

  const storedChecksum = view.getUint16(expectedLength - 2, true);
  if ((fnv1a(bytes, expectedLength - 2) & 0xffff) !== storedChecksum) {
    return null;
  }

  let offset = headerLength;
  const firstX = view.getInt32(offset, true);
  const firstY = view.getInt32(offset + 4, true);
  const firstA = view.getInt16(offset + 8, true);
  offset += 10;
  if (Math.abs(firstX) > 1e8 || Math.abs(firstY) > 1e8) return null;

  const frames: number[] = [firstX, firstY, firstA];
  let qx = firstX;
  let qy = firstY;
  let qa = firstA;
  for (let i = 1; i < frameCount; i++) {
    const dx = view.getInt16(offset, true);
    const dy = view.getInt16(offset + 2, true);
    const da = view.getInt16(offset + 4, true);
    offset += 6;
    qx += dx;
    qy += dy;
    qa += da;
    if (Math.abs(qx) > 1e8 || Math.abs(qy) > 1e8 || Math.abs(qa) > 1e6) {
      return null;
    }
    frames.push(dx, dy, da);
  }

  const record: GhostRecord = {
    version: 1,
    mode,
    seed,
    dateKey,
    vehicleId,
    distance,
    frames,
    stride,
    ...(duration !== undefined ? { duration } : {}),
  };
  return isValidGhostPayload(record) ? record : null;
}

/** Read a `#challenge=RR2.…` (or full link) hash; null when absent/invalid. */
export function challengeFromHash(hash: string): GhostRecord | null {
  if (!hash) return null;
  const raw = hash.replace(/^#/, "");
  const direct = decodeChallengeCode(raw);
  if (direct) return direct;
  try {
    const params = new URLSearchParams(raw);
    const code = params.get("challenge");
    return code ? decodeChallengeCode(code) : null;
  } catch (_) {
    return null;
  }
}

/* ---------- persistence validation ---------- */

/**
 * Shared structural, bounds, velocity, and daily-fairness check used by both
 * challenge-code decoding and save hydration.
 */
function isValidGhostPayload(record: GhostRecord): boolean {
  if (record.mode !== "standard" && record.mode !== "daily") return false;
  if (!Number.isInteger(record.seed) || record.seed < 0 || record.seed > 0xffffffff) {
    return false;
  }
  if (record.mode === "standard" && record.seed !== 0) return false;
  if (record.mode === "daily") {
    if (!isDateKey(record.dateKey)) return false;
    if (record.seed !== dailySeedFor(record.dateKey)) return false;
    if (record.vehicleId !== dailyVehicleFor(record.seed)) return false;
  }
  if (!VEHICLE_ORDER.includes(record.vehicleId)) return false;
  if (
    !Number.isInteger(record.distance) ||
    record.distance < 1 ||
    record.distance > MAX_GHOST_DISTANCE
  ) {
    return false;
  }
  const stride = record.stride ?? 1;
  if (!Number.isInteger(stride) || stride < 1 || stride > MAX_GHOST_STRIDE) {
    return false;
  }

  const frames = decodeGhostFrames(record);
  if (frames.length === 0 || frames.length > GHOST_MAX_FRAMES) return false;

  const first = frames[0]!;
  if (
    first.x < 0 ||
    first.x > START_X + 30 ||
    Math.abs(first.y) > 100 ||
    Math.abs(first.angle) > 10
  ) {
    return false;
  }

  const step = GHOST_SAMPLE_INTERVAL * stride;
  if (record.duration !== undefined) {
    if (!Number.isFinite(record.duration) || record.duration < 0) return false;
    const penultimateTime = Math.max(0, frames.length - 2) * step;
    const maxDuration =
      frames.length === 1 ? step + 1 : frames.length * step + Math.max(1, step);
    if (record.duration + 0.002 < penultimateTime || record.duration > maxDuration) {
      return false;
    }
  }
  const maxStepDeltaX = Math.max(MIN_PLAUSIBLE_STEP_X, MAX_PLAUSIBLE_STEP_X_COEFF * step);
  const maxStepDeltaY = Math.max(MIN_PLAUSIBLE_STEP_Y, MAX_PLAUSIBLE_STEP_Y_COEFF * step);
  let maxFrameDist = Math.max(0, first.x - START_X);

  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1]!;
    const curr = frames[i]!;
    if (
      curr.x < -10 ||
      curr.x > MAX_GHOST_DISTANCE + START_X + 50 ||
      Math.abs(curr.y) > 500 ||
      Math.abs(curr.angle) > 10
    ) {
      return false;
    }
    if (
      Math.abs(curr.x - prev.x) > maxStepDeltaX ||
      Math.abs(curr.y - prev.y) > maxStepDeltaY
    ) {
      return false;
    }
    maxFrameDist = Math.max(maxFrameDist, curr.x - START_X);
  }

  if (maxFrameDist > record.distance + 5) return false;
  if (record.distance > maxFrameDist + maxStepDeltaX) return false;
  return true;
}

/**
 * Copy a raw saved record into a trusted `GhostRecord`, dropping anything
 * malformed. Used by storage migration so a corrupted ghost never crashes a
 * run.
 */
export function sanitizeGhostRecord(raw: unknown): GhostRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  if (Number(source.version) !== 1) return null;
  const mode: GhostMode | null =
    source.mode === "daily"
      ? "daily"
      : source.mode === "standard"
        ? "standard"
        : null;
  if (!mode) return null;
  const seed = Number(source.seed);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) return null;
  if (mode === "standard" && seed !== 0) return null;
  if (mode === "daily" && seed === 0) return null;
  const vehicleId = VEHICLE_ORDER.includes(source.vehicleId as VehicleId)
    ? (source.vehicleId as VehicleId)
    : null;
  if (!vehicleId) return null;
  const rawDistance = Number(source.distance);
  if (!Number.isFinite(rawDistance)) return null;
  const distance = Math.floor(rawDistance);
  if (distance < 1 || distance > MAX_GHOST_DISTANCE) return null;
  if (!Array.isArray(source.frames)) return null;
  if (source.frames.length < 3 || source.frames.length % 3 !== 0) return null;
  if (source.frames.length > GHOST_MAX_FRAMES * 3) return null;

  const frames: number[] = [];
  for (const value of source.frames) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    const rounded = Math.round(number);
    if (Math.abs(rounded) > 1e8) return null;
    frames.push(rounded);
  }

  const strideRaw = source.stride;
  const stride = strideRaw === undefined ? 1 : Number(strideRaw);
  if (!Number.isInteger(stride) || stride < 1 || stride > MAX_GHOST_STRIDE) {
    return null;
  }

  let duration: number | undefined;
  if (source.duration !== undefined) {
    if (typeof source.duration !== "number" || !Number.isFinite(source.duration) || source.duration < 0) {
      return null;
    }
    duration = Math.round(source.duration * 1000) / 1000;
  }

  let dateKey: string | undefined;
  if (mode === "daily") {
    if (!isDateKey(source.dateKey)) return null;
    dateKey = source.dateKey;
  } else if (typeof source.dateKey === "string") {
    dateKey = source.dateKey;
  }

  const record: GhostRecord = {
    version: 1,
    mode,
    seed: seed >>> 0,
    dateKey,
    vehicleId,
    distance,
    frames,
    stride,
    ...(duration !== undefined ? { duration } : {}),
  };
  return isValidGhostPayload(record) ? record : null;
}
