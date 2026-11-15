import { CHUNK, MAGNET_RADIUS, START_X } from "./constants";
import { getWorldSeed, heightAt } from "./physics/terrain";
import type { CarState, Item } from "./types";
import { mulberry32, TAU } from "./utils";

export function pickupRadius(type: Item["type"]): number {
  if (type === "fuel") return 1.95;
  if (type === "coin") return 1.55;
  return 1.9;
}

export function generateChunkItems(chunk: number, items: Item[]): void {
  const rng = mulberry32(
    (((chunk + 7) * 0x9e3779b1) ^ getWorldSeed()) >>> 0,
  );
  const baseX = START_X + chunk * CHUNK;
  let coinStart = Number.POSITIVE_INFINITY;
  let fuelX = Number.POSITIVE_INFINITY;

  if (chunk % 2 === 1) {
    const count = 3 + Math.floor(rng() * 3);
    const start = baseX + 7 + rng() * 15;
    coinStart = start;
    const lift = 1.08 + rng() * 0.5;
    for (let i = 0; i < count; i++) {
      const x = start + i * 3.15;
      const arc = Math.sin((i / Math.max(1, count - 1)) * Math.PI) * 1.55;
      items.push({
        type: "coin",
        x,
        y: heightAt(x) - lift - arc,
        vx: 0,
        vy: 0,
        phase: rng() * TAU,
        alive: true,
      });
    }
  }

  if (chunk === 1 || (chunk > 3 && chunk % 4 === 1)) {
    const x = baseX + 13 + rng() * 17;
    fuelX = x;
    items.push({
      type: "fuel",
      x,
      y: heightAt(x) - 1.15,
      vx: 0,
      vy: 0,
      phase: rng() * TAU,
      alive: true,
    });
  }

  // Turbo cylinder: from the 2nd chunk onward, in the climb-in section.
  if (chunk >= 1 && rng() < 0.35) {
    const x = baseX + 4 + rng() * 11;
    if (Math.abs(x - fuelX) > 5.5) {
      items.push({
        type: "nitro",
        x,
        y: heightAt(x) - 1.2,
        vx: 0,
        vy: 0,
        phase: rng() * TAU,
        alive: true,
      });
    }
  }

  // Magnet beacon: just ahead of a coin ribbon, so it charges before the arc.
  if (Number.isFinite(coinStart) && rng() < 0.25) {
    const x = Math.max(baseX + 3, coinStart - 8 - rng() * 4);
    if (Math.abs(x - fuelX) > 5.5) {
      items.push({
        type: "magnet",
        x,
        y: heightAt(x) - 1.55,
        vx: 0,
        vy: 0,
        phase: rng() * TAU,
        alive: true,
      });
    }
  }
}

export function ensureChunksAhead(
  carX: number,
  chunkCursor: number,
  items: Item[],
): number {
  let cursor = chunkCursor;
  const target = carX + 310;
  while (START_X + cursor * CHUNK < target) {
    generateChunkItems(cursor, items);
    cursor++;
  }
  if (items.length > 500) {
    let write = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (item.alive && item.x > carX - 55) {
        items[write++] = item;
      }
    }
    items.length = write;
  }
  return cursor;
}

export function updateWorldItems(
  items: Item[],
  car: Pick<CarState, "x" | "y" | "crashed">,
  magnetActive: boolean,
  dt: number,
  onCollect: (item: Item) => void,
): void {
  let pruned = false;
  const pullK = 1 - Math.exp(-dt * 10);
  const damp = Math.exp(-dt * 1.8);
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (!item.alive) {
      pruned = true;
      continue;
    }
    if (item.x < car.x - 60) {
      item.alive = false;
      pruned = true;
      continue;
    }
    if (!car.crashed) {
      if (magnetActive && item.type === "coin") {
        const dx = car.x - item.x;
        const dy = car.y - item.y;
        const dist = Math.hypot(dx, dy);
        if (dist < MAGNET_RADIUS && dist > 0.001) {
          const pull = 30 + (MAGNET_RADIUS - dist) * 8;
          item.vx += ((dx / dist) * pull - item.vx) * pullK;
          item.vy += ((dy / dist) * pull - item.vy) * pullK;
        }
      }
      if (item.vx !== 0 || item.vy !== 0) {
        item.x += item.vx * dt;
        item.y += item.vy * dt;
        item.vx *= damp;
        item.vy *= damp;
      }
      const dx = item.x - car.x;
      const dy = item.y - car.y;
      const radius = pickupRadius(item.type);
      if (dx * dx + dy * dy < radius * radius) onCollect(item);
    }
  }
  if (pruned && Math.random() < 0.06) {
    let write = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (item.alive) items[write++] = item;
    }
    items.length = write;
  }
}
