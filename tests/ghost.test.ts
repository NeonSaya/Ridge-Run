import test from "node:test";
import assert from "node:assert/strict";
import {
  GHOST_CODE_PREFIX,
  GHOST_MAX_FRAMES,
  GHOST_SAMPLE_INTERVAL,
  MAX_GHOST_DISTANCE,
  START_X,
  VEHICLE_ORDER,
} from "../src/constants.ts";
import { dailySeedFor, dailyVehicleFor } from "../src/daily.ts";
import {
  GhostPlayback,
  GhostRecorder,
  challengeFromHash,
  decodeChallengeCode,
  encodeChallengeCode,
  ghostProgress,
  sanitizeGhostRecord,
} from "../src/ghost/GhostSystem.ts";
import {
  embedChallengeInPng,
  extractChallengeFromPng,
} from "../src/ui/PosterGenerator.ts";
import type { GhostRecord } from "../src/types.ts";

function buildLegacyWireCode(options: {
  wireVersion: 1 | 2;
  mode: "standard" | "daily";
  seed: number;
  vehicleId: "rally" | "moto" | "truck";
  stride: number;
  distance: number;
  dateKey?: string;
  frames: Array<{ x: number; y: number; angle: number }>;
}): string {
  const bytes: number[] = [];
  const u8 = (v: number): void => {
    bytes.push(v & 0xff);
  };
  const u16 = (v: number): void => {
    u8(v);
    u8(v >>> 8);
  };
  const i16 = (v: number): void => {
    const c = Math.max(-32768, Math.min(32767, Math.round(v)));
    u8(c & 0xff);
    u8((c >> 8) & 0xff);
  };
  const u32 = (v: number): void => {
    const u = v >>> 0;
    u8(u);
    u8(u >>> 8);
    u8(u >>> 16);
    u8(u >>> 24);
  };
  const i32 = (v: number): void => {
    const r = Math.round(v);
    u8(r & 0xff);
    u8((r >> 8) & 0xff);
    u8((r >> 16) & 0xff);
    u8((r >> 24) & 0xff);
  };

  u8(options.wireVersion);
  u8(options.mode === "daily" ? 1 : 0);
  u32(options.seed);
  u8(VEHICLE_ORDER.indexOf(options.vehicleId));
  if (options.wireVersion === 2) u16(options.stride);
  else u8(options.stride);
  u32(options.distance);
  u16(options.frames.length);

  if (options.mode === "daily") {
    const dk = options.dateKey ?? "2026-11-15";
    for (let i = 0; i < 10; i++) u8(dk.charCodeAt(i));
  }

  let px = 0;
  let py = 0;
  let pa = 0;
  options.frames.forEach((f, idx) => {
    const qx = Math.round(f.x * 10);
    const qy = Math.round(f.y * 10);
    const qa = Math.round(f.angle * 100);
    if (idx === 0) {
      i32(qx);
      i32(qy);
      i16(qa);
      px = qx;
      py = qy;
      pa = qa;
    } else {
      const dx = qx - px;
      const dy = qy - py;
      const da = qa - pa;
      i16(dx);
      i16(dy);
      i16(da);
      px += dx;
      py += dy;
      pa += da;
    }
  });

  let hash = 0x811c9dc5;
  for (const b of bytes) {
    hash ^= b;
    hash = Math.imul(hash, 0x01000193);
  }
  u16((hash >>> 0) & 0xffff);

  const bin = String.fromCharCode(...bytes);
  const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${GHOST_CODE_PREFIX}${b64}`;
}

test("ghost recorder & v3 codec preserve exact duration and final pose", () => {
  const recorder = new GhostRecorder();
  recorder.reset({ mode: "standard", seed: 0, vehicleId: "rally" });

  let x = START_X;
  const totalTime = 12.42;
  const dt = 0.02;
  for (let t = 0; t < totalTime; t += dt) {
    x += 12 * dt;
    recorder.tick(dt, x, Math.sin(t) * 1.2, 0.08 * Math.cos(t));
  }
  const finalX = x + 0.1;
  const finalY = -1.4;
  const finalAngle = 0.25;
  const record = recorder.finish(Math.floor(finalX - START_X), finalX, finalY, finalAngle);
  assert.ok(record);
  assert.equal(record.stride, 1);
  assert.ok(Math.abs((record.duration ?? 0) - totalTime) <= 0.03);

  const code = encodeChallengeCode(record);
  assert.ok(code.startsWith("RR2."));
  const decoded = decodeChallengeCode(code);
  assert.ok(decoded);
  assert.equal(decoded.mode, "standard");
  assert.equal(decoded.vehicleId, "rally");
  assert.equal(decoded.distance, record.distance);
  assert.equal(decoded.duration, record.duration);

  const playback = new GhostPlayback(decoded);
  assert.equal(playback.ready, true);
  const beforeEnd = playback.sample((decoded.duration ?? 0) - 0.05);
  assert.equal(beforeEnd.finished, false);
  const atEnd = playback.sample(decoded.duration ?? 0);
  assert.equal(atEnd.finished, true);
  assert.ok(Math.abs(atEnd.x - finalX) < 0.15);
  assert.ok(Math.abs(atEnd.y - finalY) < 0.15);
  assert.equal(ghostProgress(decoded, atEnd), decoded.distance);
});

test("long runs exceeding 1200 frames compact via stride doubling without finish drift", () => {
  const recorder = new GhostRecorder();
  const dateKey = "2026-11-15";
  const seed = dailySeedFor(dateKey);
  const vehicleId = dailyVehicleFor(seed);
  recorder.reset({ mode: "daily", seed, dateKey, vehicleId });

  const dt = 0.05;
  const durationSeconds = 420; // 7 minutes -> 2800 samples at 0.15s -> stride 4
  let x = START_X;
  for (let t = 0; t < durationSeconds; t += dt) {
    x += 8 * dt;
    recorder.tick(dt, x, 0.5, 0.02);
  }
  const dist = Math.floor(x - START_X);
  const record = recorder.finish(dist, x, 0.5, 0.02);
  assert.ok(record);
  assert.ok(record.frames.length / 3 <= GHOST_MAX_FRAMES);
  assert.ok((record.stride ?? 1) >= 4);
  assert.ok(Math.abs((record.duration ?? 0) - durationSeconds) < 0.1);

  const shareCode = encodeChallengeCode(record);
  const decoded = decodeChallengeCode(shareCode);
  assert.ok(decoded);
  assert.equal(decoded.mode, "daily");
  assert.equal(decoded.dateKey, dateKey);
  assert.equal(decoded.seed, seed);
  assert.equal(decoded.vehicleId, vehicleId);
  assert.ok((decoded.stride ?? 1) >= record.stride!);
  assert.equal(decoded.duration, record.duration);

  const playback = new GhostPlayback(decoded);
  // Not finished partway through the 7-minute run
  assert.equal(playback.sample(300).finished, false);
  // Finishes at the exact recorded duration
  const donePose = playback.sample(durationSeconds);
  assert.equal(donePose.finished, true);
  assert.equal(ghostProgress(decoded, donePose), decoded.distance);
});

test("decodes legacy v1 and v2 wire challenge codes", () => {
  const frames = [
    { x: START_X, y: 0, angle: 0 },
    { x: START_X + 6, y: 0.4, angle: 0.05 },
    { x: START_X + 12, y: 0.9, angle: 0.02 },
  ];

  const v1Code = buildLegacyWireCode({
    wireVersion: 1,
    mode: "standard",
    seed: 0,
    vehicleId: "moto",
    stride: 2,
    distance: 12,
    frames,
  });
  const decodedV1 = decodeChallengeCode(v1Code);
  assert.ok(decodedV1);
  assert.equal(decodedV1.vehicleId, "moto");
  assert.equal(decodedV1.stride, 2);
  assert.equal(decodedV1.distance, 12);
  assert.equal(decodedV1.duration, undefined);

  const v2Date = "2026-11-12";
  const v2Seed = dailySeedFor(v2Date);
  const v2Vehicle = dailyVehicleFor(v2Seed);
  const v2Code = buildLegacyWireCode({
    wireVersion: 2,
    mode: "daily",
    seed: v2Seed,
    vehicleId: v2Vehicle,
    stride: 512,
    distance: 12,
    dateKey: v2Date,
    frames,
  });
  const decodedV2 = decodeChallengeCode(v2Code);
  assert.ok(decodedV2);
  assert.equal(decodedV2.mode, "daily");
  assert.equal(decodedV2.stride, 512);
  assert.equal(decodedV2.dateKey, v2Date);

  // Also test hash extraction with % encoding and surrounding URL
  const hashRecord = challengeFromHash(`#challenge=${encodeURIComponent(v1Code)}`);
  assert.ok(hashRecord);
  assert.equal(hashRecord.distance, 12);
  assert.equal(challengeFromHash("#challenge=RR2.INVALID!!"), null);
});

test("rejects corrupt, truncated, mismatched, and implausible challenge codes", () => {
  const recorder = new GhostRecorder();
  recorder.reset({ mode: "standard", seed: 0, vehicleId: "rally" });
  recorder.tick(0.15, START_X + 5, 0, 0);
  const rec = recorder.finish(20, START_X + 20, 0, 0)!;
  const valid = encodeChallengeCode(rec);

  // Flip a character in the payload
  const mid = Math.floor(valid.length / 2);
  const flippedChar = valid[mid] === "A" ? "B" : "A";
  const corrupted = `${valid.slice(0, mid)}${flippedChar}${valid.slice(mid + 1)}`;
  assert.equal(decodeChallengeCode(corrupted), null);

  // Truncated token
  assert.equal(decodeChallengeCode(valid.slice(0, -4)), null);
  assert.equal(decodeChallengeCode("garbage-string"), null);
  assert.equal(decodeChallengeCode(""), null);

  // Daily mode with mismatched vehicle / seed rejected by sanitizeGhostRecord
  const bogusDaily: GhostRecord = {
    version: 1,
    mode: "daily",
    seed: 123456,
    dateKey: "2026-11-15",
    vehicleId: "rally",
    distance: 50,
    frames: [Math.round(START_X * 10), 0, 0, 500, 0, 0],
    stride: 1,
  };
  assert.equal(sanitizeGhostRecord(bogusDaily), null);

  // Huge teleport / implausible distance rejected
  const bogusTeleport: GhostRecord = {
    version: 1,
    mode: "standard",
    seed: 0,
    vehicleId: "rally",
    distance: MAX_GHOST_DISTANCE + 100,
    frames: [Math.round(START_X * 10), 0, 0, 100, 0, 0],
  };
  assert.equal(sanitizeGhostRecord(bogusTeleport), null);

  const sampleStep = GHOST_SAMPLE_INTERVAL;
  assert.ok(sampleStep > 0);
});

test("poster PNG tEXt chunk embeds and extracts full challenge code losslessly", () => {
  // Minimal valid PNG skeleton: signature + 13-byte IHDR + 0-byte IEND
  const minimalPng = new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10,
    0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 144, 119, 83, 222,
    0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
  ]);
  const code = "RR2.TEST_CHALLENGE_CODE_12345";
  const embedded = embedChallengeInPng(minimalPng, code);
  assert.ok(embedded.length > minimalPng.length);
  assert.equal(extractChallengeFromPng(embedded), code);
  assert.equal(extractChallengeFromPng(minimalPng), null);
  assert.equal(extractChallengeFromPng(new Uint8Array([1, 2, 3, 4])), null);
});
