/* =====================================================================
   KEEP THE FIRE ALIVE
   An emergent campfire. The player places fuel; the fire does the rest.

   How this file is organised
     1. Tuning numbers        every number you might want to change
     2. Environment           wind and moisture, drifting slowly
     3. Fuel                  one piece of leaf, twig, log or forest litter
     4. Spark                 a flying ember that carries real heat
     5. Simulation            THE TEN RULES live in Simulation.step()
     6. View                  draws the scene and the fire from the simulation
     7. Game                  input, HUD, win / lose screens, main loop

   The simulation (parts 1-5) never touches the page. The view (part 6)
   only READS the simulation. Nothing in this file says "make a big
   flame" or "start a wildfire": those are things that happen when many
   pieces each follow the same ten small rules.
   ===================================================================== */
'use strict';

/* =====================================================================
   1. TUNING NUMBERS
   ===================================================================== */

const NIGHT_SECONDS = 150;      // one night, 11:00 PM to 6:00 AM
const SIM_DT = 1 / 60;          // the simulation always advances in fixed steps

const AMBIENT = 12;             // night air temperature, in degrees C
const FLAME_TEMP = 850;         // nothing can be heated hotter than the flames themselves
const RING_R = 118;             // radius of the stone ring, in ground units
const GROUND_SQUASH = 0.5;      // the ground is drawn tilted: depth is squashed by half

// Rule 8 (oxygen): pieces closer than AIR_GAP crowd each other.
const AIR_GAP = 13;             // gap (edge to edge) below which pieces share air
const FREE_CROWD = 1.2;         // this much crowding costs nothing
const CHOKE = 0.30;             // oxygen lost per unit of crowding above that
const MIN_OXYGEN = 0.12;        // even a buried piece gets a little air

// Rules 3 and "moisture".
const DAMP_PENALTY = 1.1;       // fully damp fuel needs (1 + this) x the heat to ignite
const DRY_SHARE = 0.65;         // share of incoming heat that goes into drying damp fuel
const DRY_COST = 520;           // heat needed to dry a piece from soaked to bone dry
const ABSORB_TIME = 45;         // seconds for cold fuel to take on the air's moisture

// Rule 7 (wind).
const WIND_HEAT = 0.85;         // how strongly wind pushes heat downwind
const SPARK_WIND = 105;         // sideways speed (px/s) wind gives a spark at ground level
const SPARK_TOUCH = 5;          // a landing spark heats fuel within this gap

// Win / lose are only MEASUREMENTS of the simulation. They never change it.
const FIRE_OUT_SECONDS = 9;     // nothing burning for this long = the fire went out
const WILD_PIECES = 5;          // this many pieces burning outside the ring...
const WILD_SECONDS = 6;         // ...for this long = the fire spread into the forest

const START_INVENTORY = { leaf: 10, twig: 12, log: 7 };

/* Each material is the same kind of object with different numbers (rule:
   "different materials behave differently").

     ignite    temperature at which it catches fire
     sustain   below this a burning piece goes out
     peak      temperature at which it burns at full strength
     mass      thermal mass: how much heat it takes to warm it up
     cool      how fast it loses heat to the air (per second)
     burnTime  seconds of fuel at full burn
     selfHeat  burning ALONE with free air it settles at AMBIENT + selfHeat.
               For a log that is below `sustain`, so a lone log dies.
     heatOut   heat it gives a touching neighbour at full burn
     reach     distance (edge to edge) its heat carries
     sparks    sparks per second at full burn
     absorb    how much of the air's moisture it soaks up
     bulk      how much air it takes from its neighbours
     flame     flame size, for drawing only                              */
const MATERIALS = {
  leaf: {
    label: 'dry leaf', radius: 8,
    ignite: 150, sustain: 100, peak: 330, mass: 1.0, cool: 0.90, burnTime: 4.5,
    selfHeat: 340, heatOut: 300, reach: 34, sparks: 2.6, absorb: 1.0, bulk: 0.12, flame: 0.62,
  },
  twig: {
    label: 'twig', radius: 9,
    ignite: 215, sustain: 165, peak: 420, mass: 3.0, cool: 0.36, burnTime: 24,
    selfHeat: 185, heatOut: 420, reach: 44, sparks: 0.9, absorb: 0.8, bulk: 0.28, flame: 0.85,
  },
  log: {
    label: 'log', radius: 16,
    ignite: 320, sustain: 250, peak: 600, mass: 9, cool: 0.072, burnTime: 56,
    selfHeat: 205, heatOut: 600, reach: 58, sparks: 0.7, absorb: 0.6, bulk: 1.0, flame: 1.25,
  },
  // Forest-floor material outside the ring. Same rules, smaller numbers.
  litter: {
    label: 'leaf litter', radius: 6,
    ignite: 120, sustain: 90, peak: 300, mass: 0.7, cool: 0.95, burnTime: 5,
    selfHeat: 330, heatOut: 290, reach: 32, sparks: 0.5, absorb: 1.0, bulk: 0.1, flame: 0.5,
  },
  twiglet: {
    label: 'tiny twig', radius: 6,
    ignite: 195, sustain: 150, peak: 380, mass: 1.8, cool: 0.5, burnTime: 9,
    selfHeat: 200, heatOut: 300, reach: 32, sparks: 0.3, absorb: 0.85, bulk: 0.15, flame: 0.6,
  },
};

/* ---- small helpers ---- */
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const rand = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));

/* =====================================================================
   2. ENVIRONMENT
   Wind and moisture are sums of slow sine waves with random starting
   points. They drift smoothly, never jump, and every night is different.
   ===================================================================== */
class Environment {
  constructor() {
    this.time = 0;
    this.phase = [rand(6.28), rand(6.28), rand(6.28), rand(6.28), rand(6.28)];
    this.baseMoisture = rand(0.2, 0.36);
    this.update(0);
  }

  get progress() { return clamp(this.time / NIGHT_SECONDS, 0, 1); }   // 0 = 11 PM, 1 = 6 AM

  update(dt) {
    this.time += dt;
    const t = this.time, p = this.phase;
    // Wind: negative blows left, positive blows right. Range -1..1.
    // The night starts fairly still and the wind finds its strength over the first minute.
    this.wind = clamp(
      0.60 * Math.sin(t / 21 + p[0]) +
      0.30 * Math.sin(t / 8.3 + p[1]) +
      0.12 * Math.sin(t / 3.1 + p[2]), -1, 1) * (0.35 + 0.65 * smooth(5, 55, t));
    // Moisture: 0 = bone dry air, 1 = soaking. Dew builds slightly toward dawn.
    this.moisture = clamp(
      this.baseMoisture +
      0.13 * Math.sin(t / 37 + p[3]) +
      0.05 * Math.sin(t / 13 + p[4]) +
      0.12 * this.progress, 0.05, 0.9);
  }
}

/* =====================================================================
   3. FUEL
   One piece of something that can burn. Position is in "ground units":
   (0, 0) is the middle of the stone ring, x is left/right, y is depth.
   ===================================================================== */
class Fuel {
  constructor(type, x, y, env, ground = false) {
    this.type = type;
    this.m = MATERIALS[type];
    this.x = x;
    this.y = y;
    this.ground = ground;                    // true = forest litter, the player cannot move it

    // --- the state the rules work on ---
    this.temp = AMBIENT;                     // rule 1: every piece has a temperature
    this.fuel = 1;                           // 1 = untouched, 0 = all burnt
    this.damp = env ? env.moisture * this.m.absorb : 0;
    this.burning = false;
    this.ash = false;

    // --- recomputed every step ---
    this.oxygen = 1;                         // rule 8
    this.crowd = 0;
    this.heatIn = 0;                         // heat arriving this step from neighbours
    this.sparkHeat = 0;                      // heat delivered by sparks that landed on it
    this.intensity = 0;                      // 0..1, how strongly it is burning right now
    this.output = 0;                         // heat it is giving to neighbours

    // --- bookkeeping ---
    this.held = false;                       // the player is carrying it
    this.ashAge = 0;
    this.seed = Math.random();               // for drawing and flicker only
    this.angle = rand(-0.55, 0.55);
  }

  /** Rule "moisture": damp fuel needs to get hotter before it catches. */
  get igniteAt() { return this.m.ignite * (1 + DAMP_PENALTY * this.damp); }

  get outsideRing() { return Math.hypot(this.x, this.y) > RING_R + 4; }
}

/* =====================================================================
   4. SPARK
   A spark is BOTH a simulated object and the thing you see. It has a
   height (z) above the ground, cools as it flies, and gives whatever
   heat it has left to the fuel it lands on.
   ===================================================================== */
class Spark {
  constructor(source, env) {
    const m = source.m;
    this.size = 0.4 + 1.2 * Math.pow(Math.random(), 4);     // most are tiny, a few are big embers
    this.heat = 260 * this.size * this.size;                // big embers carry far more heat
    this.heat0 = this.heat;
    this.coolTime = 0.9 + 1.1 * this.size;                  // and stay hot longer
    this.x = source.x + rand(-m.radius, m.radius);
    this.y = source.y + rand(-m.radius, m.radius) * 0.6;
    this.z = 6 + rand(10) * m.flame;
    // A hotter, stronger-burning piece throws its sparks higher.
    this.vz = 110 + rand(90) + 90 * source.intensity;
    this.vx = rand(-22, 22) + env.wind * 30;
    this.vy = rand(-16, 16);
    this.age = 0;
    this.dead = false;
    this.landed = false;
    this.px = this.x; this.py = this.y; this.pz = this.z;   // previous position, for the trail
  }

  update(dt, env) {
    this.px = this.x; this.py = this.y; this.pz = this.z;
    this.age += dt;
    // Rule 7: wind pushes sparks sideways, harder the higher they are.
    const windSpeed = env.wind * (SPARK_WIND + this.z * 0.75);
    this.vx += (windSpeed - this.vx) * 1.6 * dt;
    this.vx += rand(-40, 40) * dt;
    this.vy += (rand(-40, 40) - this.vy * 0.8) * dt;
    // Thrown upward, slowed by the air, then drifting back down.
    this.vz -= (150 + this.vz) * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.z += this.vz * dt;
    this.heat *= Math.exp(-dt / this.coolTime);
    if (this.z <= 0) { this.z = 0; this.landed = true; }
  }
}

/* =====================================================================
   5. SIMULATION
   ===================================================================== */
class Simulation {
  /** halfWidth / depth describe how much ground is visible, for scattering litter. */
  constructor(halfWidth = 560, depthBack = -150, depthFront = 150) {
    this.env = new Environment();
    this.pieces = [];
    this.sparks = [];
    this.inventory = { ...START_INVENTORY };
    this.state = 'playing';                  // 'playing' | 'won' | 'out' | 'wildfire'
    this.outTimer = 0;
    this.wildTimer = 0;
    this.outsideBurning = 0;
    this.totalOutput = 0;
    this.events = [];                        // "ignite" / "land" notes for the view to draw
    this.bounds = { halfWidth, depthBack, depthFront };
    this.scatterLitter();
    this.buildStartingFire();
  }

  /* ---------- setup ---------- */

  /** The player starts with a small twig fire already lit. */
  buildStartingFire() {
    const start = [
      ['twig', -14, -3], ['twig', 13, -6], ['twig', 1, 13], ['twig', -2, -20],
      ['leaf', 1, -3],
    ];
    for (const [type, x, y] of start) {
      const p = new Fuel(type, x, y, null);
      p.temp = p.m.peak * 0.8;
      p.burning = true;
      this.pieces.push(p);
    }
  }

  /** Scatter patches of dry forest-floor material outside the ring.
      These are ordinary Fuel objects: nothing treats them specially. */
  scatterLitter() {
    const { halfWidth, depthBack, depthFront } = this.bounds;
    const place = (type, x, y) => {
      if (Math.hypot(x, y) < RING_R + 30) return;                    // keep the camp clearing bare
      if (Math.abs(x) > halfWidth || y < depthBack || y > depthFront) return;
      if (insideTent(x, y)) return;
      this.pieces.push(new Fuel(type, x, y, this.env, true));
    };
    const patches = Math.round(halfWidth / 34);
    for (let i = 0; i < patches; i++) {
      const cx = rand(-halfWidth, halfWidth), cy = rand(depthBack, depthFront);
      const n = 6 + Math.floor(rand(9));
      const spread = rand(12, 19);
      for (let k = 0; k < n; k++) {
        const a = rand(6.28), r = spread * Math.sqrt(Math.random()) * 1.6;
        place(Math.random() < 0.2 ? 'twiglet' : 'litter', cx + Math.cos(a) * r * 1.3, cy + Math.sin(a) * r);
      }
    }
    for (let i = 0; i < patches * 2; i++) {                          // loose single pieces between patches
      place(Math.random() < 0.25 ? 'twiglet' : 'litter', rand(-halfWidth, halfWidth), rand(depthBack, depthFront));
    }
  }

  /** The ONLY thing the player can do: put a piece of fuel somewhere. */
  addFuel(type, x, y) {
    if (this.inventory[type] <= 0) return null;
    this.inventory[type]--;
    const p = new Fuel(type, x, y, this.env);   // new fuel is as damp as the night air
    this.pieces.push(p);
    return p;
  }

  /* ---------- one step of the world ---------- */

  step(dt) {
    const env = this.env;
    env.update(dt);
    const pieces = this.pieces;

    // Pieces that take part in the physics: not ash, not in the player's hand.
    const live = [];
    for (const p of pieces) {
      if (p.ash) { p.ashAge += dt; continue; }
      p.crowd = 0;
      p.heatIn = 0;
      if (!p.held) live.push(p);
    }

    /* ---- Pairs of neighbours: crowding (rule 8) and heat transfer (rule 2) ---- */
    for (let i = 0; i < live.length; i++) {
      const a = live[i];
      for (let j = i + 1; j < live.length; j++) {
        const b = live[j];
        const dx = b.x - a.x;
        if (dx > 100 || dx < -100) continue;
        const dy = b.y - a.y;
        if (dy > 100 || dy < -100) continue;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const gap = Math.max(0, dist - a.m.radius - b.m.radius);   // edge-to-edge distance

        // RULE 8. Fuel packed too closely shares its air.
        if (gap < AIR_GAP) {
          const closeness = 1 - gap / AIR_GAP;
          a.crowd += closeness * b.m.bulk;
          b.crowd += closeness * a.m.bulk;
        }

        // RULE 2. Burning fuel heats nearby fuel; less with distance.
        // RULE 7. Wind pushes that heat downwind.
        const nx = dist > 0.001 ? dx / dist : 0;                   // direction a -> b, left/right
        if (a.output > 0 && gap < a.m.reach) {
          const falloff = 1 - gap / a.m.reach;
          b.heatIn += a.output * falloff * falloff * clamp(1 + WIND_HEAT * env.wind * nx, 0.25, 2);
        }
        if (b.output > 0 && gap < b.m.reach) {
          const falloff = 1 - gap / b.m.reach;
          a.heatIn += b.output * falloff * falloff * clamp(1 - WIND_HEAT * env.wind * nx, 0.25, 2);
        }
      }
    }

    /* ---- Each piece on its own ---- */
    let burningCount = 0, outside = 0, total = 0;
    for (const p of pieces) {
      if (p.ash) continue;
      const m = p.m;

      // RULE 1. Everything slowly loses heat to the night air.
      p.temp += (AMBIENT - p.temp) * m.cool * dt;

      // RULE 3. Incoming heat dries damp fuel first; only the rest warms it.
      let heat = (p.heatIn * dt + p.sparkHeat) / m.mass;           // degrees gained this step
      p.sparkHeat = 0;
      heat *= clamp(1 - p.temp / FLAME_TEMP, 0, 1);                // hot fuel soaks up less
      if (heat > 0 && p.damp > 0) {
        const drying = Math.min(heat * DRY_SHARE, p.damp * DRY_COST);
        p.damp -= drying / DRY_COST;
        heat -= drying;
      }
      p.temp += heat;

      // Cold fuel slowly takes on (or gives back) the moisture of the air.
      if (!p.burning && p.temp < 50) {
        p.damp += (env.moisture * m.absorb - p.damp) * dt / ABSORB_TIME;
      }

      // RULE 8, second half: crowding becomes an oxygen factor between 0 and 1.
      p.oxygen = clamp(1 - CHOKE * Math.max(0, p.crowd - FREE_CROWD), MIN_OXYGEN, 1);

      // RULE 4. Fuel ignites when it gets hot enough.
      if (!p.burning && !p.held && p.temp >= p.igniteAt) {
        p.burning = true;
        this.events.push({ kind: 'ignite', x: p.x, y: p.y });
      }

      if (p.burning) {
        // RULE 5. Burning produces heat and uses up fuel. Both need oxygen.
        const tail = Math.min(1, p.fuel / 0.15);                   // fades out as the fuel runs low
        p.temp += m.cool * m.selfHeat * p.oxygen * tail * dt;
        p.damp = Math.max(0, p.damp - 0.4 * dt);
        const hot = clamp((p.temp - m.sustain) / (m.peak - m.sustain), 0, 1);
        const flicker = 0.9 + 0.1 * Math.sin(env.time * (7 + p.seed * 6) + p.seed * 40);
        p.intensity = p.oxygen * tail * (0.3 + 0.7 * hot) * flicker;
        p.output = m.heatOut * p.intensity;
        p.fuel -= (dt / m.burnTime) * Math.max(0.3, p.oxygen * (0.45 + 0.55 * hot));

        // RULE 6. Burning fuel sometimes throws a spark. More in wind.
        if (Math.random() < m.sparks * p.intensity * (1 + 0.8 * Math.abs(env.wind)) * dt) {
          this.sparks.push(new Spark(p, env));
        }

        // RULE 9. It stops burning if it runs out of fuel or gets too cold.
        if (p.fuel <= 0) {
          p.fuel = 0; p.burning = false; p.ash = true; p.intensity = 0; p.output = 0;
        } else if (p.temp < m.sustain) {
          p.burning = false; p.intensity = 0; p.output = 0;        // still fuel left: can relight
        }
      } else {
        p.intensity = 0;
        p.output = 0;
      }

      if (p.burning) {
        burningCount++;
        total += p.output;
        if (p.outsideRing) outside++;
      }
    }

    /* ---- Sparks ---- */
    for (const s of this.sparks) {
      s.update(dt, env);
      if (s.landed) {
        // RULE 10. A spark gives its remaining heat to the fuel it lands on.
        let best = null, bestGap = SPARK_TOUCH;
        for (const p of live) {
          const gap = Math.hypot(p.x - s.x, p.y - s.y) - p.m.radius;
          if (gap < bestGap) { bestGap = gap; best = p; }
        }
        if (best) best.sparkHeat += s.heat;
        if (s.heat > 40) this.events.push({ kind: 'land', x: s.x, y: s.y, heat: s.heat, hit: !!best });
        s.dead = true;
      } else if (s.heat < 4 || s.age > 9) {
        s.dead = true;
      }
    }
    this.sparks = this.sparks.filter(s => !s.dead);

    // Player ash blows away after a while; scorched litter stays as a mark.
    this.pieces = pieces.filter(p => !(p.ash && !p.ground && p.ashAge > 45));

    /* ---- Measure the result. These checks only OBSERVE; they change nothing. ---- */
    this.burningCount = burningCount;
    this.outsideBurning = outside;
    this.totalOutput = total;
    if (this.state !== 'playing') return;

    this.outTimer = burningCount === 0 ? this.outTimer + dt : 0;
    this.wildTimer = outside >= WILD_PIECES ? this.wildTimer + dt : Math.max(0, this.wildTimer - dt * 0.5);

    if (this.wildTimer >= WILD_SECONDS) this.state = 'wildfire';
    else if (this.outTimer >= FIRE_OUT_SECONDS) this.state = 'out';
    else if (env.time >= NIGHT_SECONDS) this.state = 'won';
  }
}

/* The tent sits behind and to the left of the fire. Litter is not placed under it. */
const TENT = { x: -300, y: -112, w: 150 };
function insideTent(x, y) {
  return Math.abs(x - TENT.x) < TENT.w * 0.8 && y > TENT.y - 190 && y < TENT.y + 62;
}

/* The simulation can run without a browser (this is how it was tested and tuned). */
if (typeof module !== 'undefined') {
  module.exports = { Simulation, Fuel, Spark, Environment, MATERIALS, RING_R, NIGHT_SECONDS, SIM_DT };
}

/* =====================================================================
   6. VIEW
   Everything below draws. It reads the simulation and never changes it.
   Flames, smoke and glow are particles spawned FROM each burning piece,
   in proportion to how strongly that piece is actually burning, so the
   shape of the fire is whatever the fuel happens to be doing.
   ===================================================================== */
if (typeof document !== 'undefined') {

  /** A small repeatable random generator so trees and stars stay put on resize. */
  function seeded(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** A soft round dot, pre-drawn once and stamped many times (fast). */
  function makeBlob(r, g, b, hardness = 0.0, size = 64) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const x = c.getContext('2d');
    const grd = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grd.addColorStop(0, `rgba(${r},${g},${b},1)`);
    if (hardness > 0) grd.addColorStop(hardness, `rgba(${r},${g},${b},0.75)`);
    grd.addColorStop(0.55 + hardness * 0.3, `rgba(${r},${g},${b},0.22)`);
    grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
    x.fillStyle = grd;
    x.fillRect(0, 0, size, size);
    return c;
  }

  const SPRITE = {
    core: makeBlob(255, 226, 150, 0.25),
    mid: makeBlob(255, 112, 30, 0.15),
    outer: makeBlob(200, 48, 16, 0.05),
    spark: makeBlob(255, 190, 110, 0.3, 32),
    smoke: makeBlob(150, 152, 165, 0.1),
    glow: makeBlob(255, 132, 48, 0, 128),
    moonlight: makeBlob(196, 208, 255, 0, 128),
  };

  /* ---------- drawing a piece of fuel ---------- */

  const BASE_COLOR = {
    leaf: [176, 122, 52], litter: [120, 96, 52], twig: [128, 92, 58], twiglet: [104, 80, 54], log: [108, 72, 44],
  };

  /** Colour tells you the state: damp is darker and bluer, burnt is charred. */
  function pieceColor(p, light) {
    let [r, g, b] = BASE_COLOR[p.type];
    const damp = clamp(p.damp * 1.6, 0, 0.75);
    r = lerp(r, r * 0.42, damp); g = lerp(g, g * 0.5, damp); b = lerp(b, b * 0.75 + 12, damp);
    const char = p.ash ? 1 : clamp((1 - p.fuel) * 1.15, 0, 1);
    r = lerp(r, 26, char); g = lerp(g, 22, char); b = lerp(b, 22, char);
    if (p.ash) { r = 46; g = 44; b = 46; }
    const k = light;
    return `rgb(${(r * k) | 0},${(g * k) | 0},${(b * k) | 0})`;
  }

  /** Trace the outline of a piece centred on (0,0). Used by the game and by the inventory icons. */
  function tracePiece(ctx, type, seed, scale = 1) {
    ctx.beginPath();
    if (type === 'log') {
      const L = 25 * scale, R = 7.5 * scale;
      ctx.moveTo(-L + R, -R);
      ctx.lineTo(L - R, -R); ctx.arc(L - R, 0, R, -Math.PI / 2, Math.PI / 2);
      ctx.lineTo(-L + R, R); ctx.arc(-L + R, 0, R, Math.PI / 2, -Math.PI / 2);
      ctx.closePath();
    } else if (type === 'twig' || type === 'twiglet') {
      const L = (type === 'twig' ? 17 : 9) * scale;
      const bend = (seed - 0.5) * 8 * scale;
      ctx.moveTo(-L, bend * 0.4);
      ctx.quadraticCurveTo(0, -bend, L, bend * 0.2);
      ctx.moveTo(L * 0.15, -bend * 0.45);
      ctx.lineTo(L * 0.55, -bend * 0.4 - 6 * scale * (seed > 0.5 ? 1 : -1));
    } else {
      const L = (type === 'leaf' ? 9.5 : 6) * scale, Wd = L * (0.42 + seed * 0.2);
      ctx.moveTo(-L, 0);
      ctx.quadraticCurveTo(-L * 0.1, -Wd * 1.5, L, 0);
      ctx.quadraticCurveTo(-L * 0.1, Wd * 1.5, -L, 0);
      ctx.closePath();
    }
  }

  function strokeOrFill(ctx, type, color, scale = 1) {
    if (type === 'twig' || type === 'twiglet') {
      ctx.lineCap = 'round';
      ctx.lineWidth = (type === 'twig' ? 3.4 : 2) * scale;
      ctx.strokeStyle = color;
      ctx.stroke();
    } else {
      ctx.fillStyle = color;
      ctx.fill();
    }
  }

  /* ---------- the view ---------- */

  class View {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.flames = [];
      this.smoke = [];
      this.flashes = [];
      this.debug = false;
      this.fps = 60;
      this.resize();
    }

    /** The scene is laid out in "logical" units and scaled to fit the window. */
    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cw = window.innerWidth, ch = window.innerHeight;
      let scale = ch / 720;
      if (cw / scale < 900) scale = cw / 900;          // narrow window: fit the width instead
      this.scale = scale;
      this.W = cw / scale;
      this.H = ch / scale;
      this.canvas.width = Math.round(cw * dpr);
      this.canvas.height = Math.round(ch * dpr);
      this.pixel = scale * dpr;
      this.horizon = Math.round(this.H * 0.55);
      this.cx = this.W / 2;
      this.cy = this.horizon + Math.min(128, (this.H - this.horizon) * 0.4);
      this.buildScenery();
    }

    /* ground units <-> screen */
    sx(x) { return this.cx + x; }
    sy(y) { return this.cy + y * GROUND_SQUASH; }
    toGround(px, py) { return { x: px / this.scale - this.cx, y: (py / this.scale - this.cy) / GROUND_SQUASH }; }
    /** How far back / forward the visible ground goes, in ground units. */
    get depthBack() { return (this.horizon + 26 - this.cy) / GROUND_SQUASH; }
    get depthFront() { return (this.H - 118 - this.cy) / GROUND_SQUASH; }

    /* ---------- things drawn once and reused ---------- */

    buildScenery() {
      const W = Math.ceil(this.W), H = Math.ceil(this.H), hz = this.horizon;
      const layer = () => {
        const c = document.createElement('canvas');
        c.width = Math.round(W * this.pixel); c.height = Math.round(H * this.pixel);
        const x = c.getContext('2d'); x.scale(this.pixel, this.pixel);
        return [c, x];
      };

      // Stars
      const rs = seeded(7);
      this.stars = [];
      for (let i = 0; i < 170; i++) {
        this.stars.push({ x: rs(), y: rs() * rs(), r: 0.5 + rs() * 1.1, phase: rs() * 6.28, speed: 0.4 + rs() * 1.6 });
      }

      // Pine trees, two layers of silhouettes
      const pine = (x, baseX, baseY, h, r) => {
        const w = h * (0.2 + r() * 0.07);
        x.beginPath();
        x.moveTo(baseX, baseY - h);
        const tiers = 5 + Math.floor(r() * 3);
        for (let i = 1; i <= tiers; i++) {
          const y = baseY - h + (h * 0.94 * i) / tiers;
          const tw = w * (i / tiers) * (0.85 + r() * 0.3);
          x.lineTo(baseX + tw, y);
          x.lineTo(baseX + tw * 0.45, y - h * 0.035);
        }
        x.lineTo(baseX + w * 0.1, baseY - h * 0.05);
        x.lineTo(baseX + w * 0.1, baseY + 6);
        x.lineTo(baseX - w * 0.1, baseY + 6);
        x.lineTo(baseX - w * 0.1, baseY - h * 0.05);
        for (let i = tiers; i >= 1; i--) {
          const y = baseY - h + (h * 0.94 * i) / tiers;
          const tw = w * (i / tiers) * (0.85 + r() * 0.3);
          x.lineTo(baseX - tw * 0.45, y - h * 0.035);
          x.lineTo(baseX - tw, y);
        }
        x.closePath();
        x.fill();
      };
      const forest = (seed, color, hMin, hMax, gap, baseOffset) => {
        const [c, x] = layer();
        const r = seeded(seed);
        x.fillStyle = color;
        for (let px = -40; px < W + 60; px += gap * (0.5 + r())) {
          // leave the sky open a little above the campsite so the fire reads clearly
          const centre = 1 - Math.exp(-Math.pow((px - W / 2) / (W * 0.16), 2));
          pine(x, px, hz + baseOffset + r() * 10, lerp(hMin, hMax, r()) * (0.72 + 0.28 * centre), r);
        }
        x.fillRect(0, hz + baseOffset, W, 20);
        return c;
      };
      this.treesFar = forest(11, '#0b1322', 110, 190, 46, 0);
      this.treesNear = forest(23, '#04070c', 150, 280, 78, 10);

      // Ground
      const [g, x] = layer();
      const grd = x.createLinearGradient(0, hz, 0, H);
      grd.addColorStop(0, '#161d16'); grd.addColorStop(0.45, '#232a1c'); grd.addColorStop(1, '#1a2016');
      x.fillStyle = grd;
      x.fillRect(0, hz, W, H - hz);
      // the trodden clearing around the fire
      const cl = x.createRadialGradient(this.cx, this.cy, 20, this.cx, this.cy, 420);
      cl.addColorStop(0, 'rgba(86,68,48,0.85)'); cl.addColorStop(0.45, 'rgba(70,58,40,0.5)'); cl.addColorStop(1, 'rgba(60,52,36,0)');
      x.save(); x.translate(this.cx, this.cy); x.scale(1, GROUND_SQUASH); x.translate(-this.cx, -this.cy);
      x.fillStyle = cl; x.fillRect(this.cx - 440, this.cy - 440, 880, 880);
      x.restore();
      const rg = seeded(5);
      for (let i = 0; i < 1400; i++) {                         // speckle
        const px = rg() * W, py = hz + 14 + rg() * (H - hz);
        const v = 30 + rg() * 50;
        x.fillStyle = `rgba(${v + 18},${v + 12},${v - 6},${0.10 + rg() * 0.16})`;
        x.fillRect(px, py, 1 + rg() * 2.4, 1 + rg() * 1.2);
      }
      for (let i = 0; i < 260; i++) {                          // grass tufts, away from the fire
        const px = rg() * W, py = hz + 22 + rg() * (H - hz - 22);
        if (Math.hypot(px - this.cx, (py - this.cy) / GROUND_SQUASH) < 230 && rg() < 0.9) continue;
        x.strokeStyle = `rgba(${52 + rg() * 30},${74 + rg() * 34},${44},0.55)`;
        x.lineWidth = 1;
        x.beginPath();
        for (let k = -1; k <= 1; k++) { x.moveTo(px + k * 2, py); x.lineTo(px + k * 4 + rg() * 2, py - 5 - rg() * 6); }
        x.stroke();
      }
      this.ground = g;

      // Stones of the fire ring
      const rr = seeded(3);
      this.stones = [];
      const n = 15;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rr() * 0.12;
        this.stones.push({
          x: Math.cos(a) * (RING_R + rr() * 5), y: Math.sin(a) * (RING_R + rr() * 5),
          w: 19 + rr() * 9, h: 11 + rr() * 5, tilt: (rr() - 0.5) * 0.5, shade: 0.8 + rr() * 0.35,
        });
      }

      // Crescent moon
      const mc = document.createElement('canvas'); mc.width = mc.height = 96;
      const mx = mc.getContext('2d');
      mx.fillStyle = '#f1ead6'; mx.beginPath(); mx.arc(48, 48, 26, 0, 6.29); mx.fill();
      mx.globalCompositeOperation = 'destination-out';
      mx.beginPath(); mx.arc(60, 42, 24, 0, 6.29); mx.fill();
      this.moon = mc;
    }

    /* ---------- particles (visual only) ---------- */

    /** Spawn flame and smoke from each burning piece, in proportion to how it burns. */
    emit(sim, dt) {
      const wind = sim.env.wind;
      for (const p of sim.pieces) {
        if (p.ash || p.held) continue;
        const m = p.m;
        const px = this.sx(p.x), py = this.sy(p.y);
        const along = p.type === 'log' ? 20 : m.radius;            // logs burn along their length

        if (p.burning) {
          // More intensity -> more particles, bigger, faster, longer-lived = taller flame.
          const rate = (p.ground ? 30 : 46) * m.flame * (0.25 + p.intensity);
          let n = rate * dt; n = Math.floor(n) + (Math.random() < n % 1 ? 1 : 0);
          for (let i = 0; i < n && this.flames.length < 1800; i++) {
            const o = rand(-along, along);
            this.flames.push({
              x: px + Math.cos(p.angle) * o + rand(-3, 3),
              y: py + Math.sin(p.angle) * o * 0.5 - rand(2, 7),
              vx: rand(-9, 9) + wind * 26,
              vy: -(28 + 88 * p.intensity * m.flame) * rand(0.6, 1.1),
              age: 0,
              life: (0.3 + 0.55 * p.intensity) * rand(0.6, 1.15),
              size: (5 + 8.5 * m.flame) * (0.55 + 0.6 * p.intensity) * rand(0.75, 1.15),
              phase: rand(6.28),
            });
          }
          // A choked fire (little oxygen) smokes more than a clean one.
          const smokeRate = (0.6 + 3.2 * (1 - p.oxygen) + 0.8 * p.intensity) * m.flame;
          if (Math.random() < smokeRate * dt && this.smoke.length < 220) this.puff(px, py - 22 * m.flame * p.intensity, wind, 0.085, 13 * m.flame);
        } else if (p.temp > 95 && Math.random() < 0.9 * dt && this.smoke.length < 220) {
          // Hot but unlit fuel smoulders or steams.
          this.puff(px, py - 5, wind, 0.06, 7 + m.radius * 0.4);
        }
      }
    }

    puff(x, y, wind, alpha, size) {
      this.smoke.push({ x: x + rand(-6, 6), y, vx: rand(-6, 6) + wind * 14, vy: -rand(20, 36), age: 0, life: rand(2.6, 4.6), size, alpha });
    }

    updateParticles(sim, dt) {
      const wind = sim.env.wind, t = sim.env.time;
      for (const f of this.flames) {
        f.age += dt;
        // Rule 7 again, visually: wind bends every flame particle the same way.
        f.vx += wind * 250 * dt + Math.sin(t * 9 + f.phase + f.y * 0.06) * 85 * dt;
        f.vy -= 30 * dt;
        f.x += f.vx * dt;
        f.y += f.vy * dt;
      }
      this.flames = this.flames.filter(f => f.age < f.life);
      for (const s of this.smoke) {
        s.age += dt;
        s.vx += (wind * 46 - s.vx) * 0.7 * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
      }
      this.smoke = this.smoke.filter(s => s.age < s.life);
      for (const e of sim.events) {
        if (e.kind === 'land') this.flashes.push({ x: e.x, y: e.y, age: 0, life: 0.45, r: clamp(e.heat / 30, 3, 13) });
        else if (e.kind === 'ignite') this.flashes.push({ x: e.x, y: e.y, age: 0, life: 0.35, r: 16 });
      }
      sim.events.length = 0;
      for (const f of this.flashes) f.age += dt;
      this.flashes = this.flashes.filter(f => f.age < f.life);
    }

    /* ---------- one frame ---------- */

    draw(sim, drag) {
      const ctx = this.ctx, W = this.W, H = this.H, hz = this.horizon;
      const env = sim.env, t = env.time, p = env.progress;
      const dawn = smooth(0.68, 1, p);
      ctx.setTransform(this.pixel, 0, 0, this.pixel, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;

      /* --- sky: deep night, slowly warming toward sunrise --- */
      const mix = (a, b) => `rgb(${lerp(a[0], b[0], dawn) | 0},${lerp(a[1], b[1], dawn) | 0},${lerp(a[2], b[2], dawn) | 0})`;
      const sky = ctx.createLinearGradient(0, 0, 0, hz + 20);
      sky.addColorStop(0, mix([4, 7, 18], [34, 50, 92]));
      sky.addColorStop(0.6, mix([9, 15, 34], [108, 106, 138]));
      sky.addColorStop(1, mix([17, 26, 50], [232, 154, 112]));
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, W, hz + 20);

      const starFade = (1 - dawn) * (1 - dawn);
      ctx.fillStyle = '#eef0ff';
      for (const s of this.stars) {
        const tw = 0.55 + 0.45 * Math.sin(t * s.speed + s.phase);
        ctx.globalAlpha = starFade * tw * 0.85;
        ctx.fillRect(s.x * W, s.y * (hz - 60), s.r, s.r);
      }
      // moon, drifting down toward the trees through the night
      const mx = W * (0.74 + 0.1 * p), my = 70 + 150 * p * p;
      ctx.globalAlpha = 0.32 * (1 - dawn * 0.8);
      ctx.drawImage(SPRITE.moonlight, mx - 85, my - 85, 170, 170);
      ctx.globalAlpha = 0.95 * (1 - dawn * 0.6);
      ctx.drawImage(this.moon, mx - 30, my - 30, 60, 60);
      // dawn glow behind the trees
      if (dawn > 0) {
        ctx.globalAlpha = dawn * 0.75;
        const gx = W * 0.27;
        const dg = ctx.createRadialGradient(gx, hz + 10, 0, gx, hz + 10, W * 0.55);
        dg.addColorStop(0, 'rgba(255,196,130,1)'); dg.addColorStop(0.35, 'rgba(250,150,110,0.5)'); dg.addColorStop(1, 'rgba(250,150,110,0)');
        ctx.fillStyle = dg;
        ctx.fillRect(0, 0, W, hz + 20);
      }
      ctx.globalAlpha = 1;

      /* --- trees (they lean a hair with the wind) and ground --- */
      const sway = env.wind * 0.006 + Math.sin(t * 0.7) * 0.0015;
      ctx.save();
      ctx.transform(1, 0, -sway, 1, sway * hz, 0);
      ctx.globalAlpha = 0.9;
      ctx.drawImage(this.treesFar, 0, 0, W, H);
      ctx.globalAlpha = 1;
      ctx.restore();
      ctx.save();
      ctx.transform(1, 0, -sway * 1.6, 1, sway * 1.6 * (hz + 10), 0);
      ctx.drawImage(this.treesNear, 0, 0, W, H);
      ctx.restore();
      ctx.drawImage(this.ground, 0, 0, W, H);

      // night lies over the ground and lifts toward morning
      const dark = lerp(0.6, 0.2, dawn);
      const shade = ctx.createLinearGradient(0, hz, 0, hz + 60);
      shade.addColorStop(0, `rgba(3,6,14,${Math.min(1, dark + 0.35)})`);
      shade.addColorStop(1, `rgba(3,6,16,${dark})`);
      ctx.fillStyle = shade;
      ctx.fillRect(0, hz, W, H - hz);
      const light = lerp(0.62, 0.95, dawn);                     // how bright unlit objects look

      /* --- firelight on the ground: one soft pool per burning piece.
             The big warm glow is just these pools adding up. --- */
      const burning = sim.pieces.filter(q => q.burning && !q.held);
      ctx.globalCompositeOperation = 'lighter';
      for (const q of burning) {
        const r = 46 + 13 * Math.sqrt(q.output);
        ctx.globalAlpha = clamp(0.03 + q.output / 4200, 0, 0.17);
        ctx.drawImage(SPRITE.glow, this.sx(q.x) - r, this.sy(q.y) - r * 0.5, r * 2, r);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;

      /** Firelight reaching a point on the ground, 0..1 (used to light stones and the tent). */
      const lightAt = (x, y, reach) => {
        let sum = 0;
        for (const q of burning) {
          const d2 = (q.x - x) * (q.x - x) + (q.y - y) * (q.y - y);
          sum += q.output / (1 + d2 / (reach * reach));
        }
        return clamp(sum / 1500, 0, 1);
      };

      this.drawTent(ctx, light, lightAt(TENT.x + 60, TENT.y, 230), dawn);

      /* --- stones and fuel, drawn back to front --- */
      const things = [];
      for (const s of this.stones) things.push({ y: s.y, stone: s });
      for (const q of sim.pieces) if (!q.held) things.push({ y: q.y + (q.ash ? -400 : 0), piece: q });
      things.sort((a, b) => a.y - b.y);
      for (const th of things) {
        if (th.stone) this.drawStone(ctx, th.stone, light, lightAt(th.stone.x * 0.86, th.stone.y * 0.86, 70));
        else this.drawPiece(ctx, th.piece, light, t);
      }

      /* --- smoke --- */
      for (const s of this.smoke) {
        const a = s.age / s.life;
        const size = s.size * (1 + a * 3.2);
        ctx.globalAlpha = s.alpha * Math.sin(Math.PI * Math.min(1, a * 1.15)) * lerp(1, 1.5, dawn);
        ctx.drawImage(SPRITE.smoke, s.x - size, s.y - size, size * 2, size * 2);
      }

      /* --- flames: additive, so overlapping particles burn white-hot --- */
      ctx.globalCompositeOperation = 'lighter';
      for (const f of this.flames) {
        const a = f.age / f.life;
        const size = f.size * (1 - a * 0.7);
        ctx.globalAlpha = 0.3 * (1 - a);
        ctx.drawImage(a < 0.5 ? SPRITE.mid : SPRITE.outer, f.x - size * 0.8, f.y - size * 1.5, size * 1.6, size * 3);
        if (a < 0.4) {                                   // young particles have a bright heart
          ctx.globalAlpha = 0.34 * (1 - a / 0.4);
          const c = size * 0.5;
          ctx.drawImage(SPRITE.core, f.x - c * 0.8, f.y - c * 1.3, c * 1.6, c * 2.6);
        }
      }

      /* --- sparks: the same objects the simulation is moving --- */
      for (const s of sim.sparks) {
        const hot = clamp(s.heat / s.heat0 * 1.4, 0, 1);
        const x = this.sx(s.x), y = this.sy(s.y) - s.z;
        const r = (1.1 + 1.9 * s.size) * (0.5 + 0.5 * hot);
        ctx.globalAlpha = 0.35 * hot;
        ctx.strokeStyle = '#ff9a4a';
        ctx.lineWidth = 0.8 + s.size * 0.8;
        ctx.beginPath(); ctx.moveTo(this.sx(s.px), this.sy(s.py) - s.pz); ctx.lineTo(x, y); ctx.stroke();
        ctx.globalAlpha = 0.95 * hot;
        ctx.drawImage(SPRITE.spark, x - r * 2, y - r * 2, r * 4, r * 4);
      }
      for (const f of this.flashes) {
        const a = f.age / f.life, r = f.r * (0.6 + a);
        ctx.globalAlpha = 0.7 * (1 - a);
        ctx.drawImage(SPRITE.spark, this.sx(f.x) - r, this.sy(f.y) - r * 0.6, r * 2, r * 1.2);
      }

      /* --- warm air above each burning piece --- */
      for (const q of burning) {
        const r = 30 + 9.5 * Math.sqrt(q.output);
        ctx.globalAlpha = clamp(q.output / 9000, 0, 0.06);
        ctx.drawImage(SPRITE.glow, this.sx(q.x) - r, this.sy(q.y) - r * 1.25, r * 2, r * 2);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;

      /* --- the piece in the player's hand --- */
      if (drag) {
        const ok = drag.valid;
        const x = drag.px / this.scale, y = drag.py / this.scale;
        ctx.globalAlpha = ok ? 0.28 : 0;
        ctx.fillStyle = '#000';
        ctx.beginPath(); ctx.ellipse(x, y + 12, drag.m.radius * 1.5, drag.m.radius * 0.6, 0, 0, 6.29); ctx.fill();
        ctx.globalAlpha = ok ? 1 : 0.5;
        ctx.save();
        ctx.translate(x, y - 4);
        ctx.rotate(drag.angle);
        tracePiece(ctx, drag.type, drag.seed);
        strokeOrFill(ctx, drag.type, pieceColor(drag.ref, 1));
        ctx.restore();
        ctx.globalAlpha = 1;
      }

      /* --- soft dark corners --- */
      const vg = ctx.createRadialGradient(this.cx, this.cy - 60, H * 0.35, this.cx, this.cy - 60, Math.max(W, H) * 0.75);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, `rgba(0,0,6,${lerp(0.6, 0.3, dawn)})`);
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, W, H);

      if (this.debug) this.drawDebug(ctx, sim);
    }

    drawStone(ctx, s, light, lit) {
      const x = this.sx(s.x), y = this.sy(s.y);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(s.tilt * 0.4);
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.beginPath(); ctx.ellipse(0, s.h * 0.22, s.w * 0.56, s.h * 0.34, 0, 0, 6.29); ctx.fill();
      // Firelight warms the whole stone; the side facing the fire is brightest.
      const v = 58 * s.shade * light;
      ctx.fillStyle = `rgb(${(v + lit * 70) | 0},${(v * 1.02 + lit * 30) | 0},${(v * 1.1 + lit * 6) | 0})`;
      ctx.beginPath(); ctx.ellipse(0, -s.h * 0.2, s.w * 0.5, s.h * 0.58, 0, 0, 6.29); ctx.fill();
      if (lit > 0.01) {
        const d = Math.hypot(s.x, s.y) || 1;
        ctx.globalAlpha = lit * 0.5;
        ctx.fillStyle = '#e08a45';
        ctx.beginPath();
        ctx.ellipse(-s.x / d * s.w * 0.2, -s.h * 0.24 - s.y / d * s.h * 0.2, s.w * 0.26, s.h * 0.3, 0, 0, 6.29);
        ctx.fill();
      }
      ctx.restore();
    }

    drawPiece(ctx, p, light, t) {
      const x = this.sx(p.x), y = this.sy(p.y);
      ctx.save();
      ctx.translate(x, y);
      if (p.ash) {                                               // a flat grey smudge
        ctx.globalAlpha = p.ground ? 0.75 : clamp(1 - (p.ashAge - 30) / 15, 0, 1) * 0.85;
        ctx.fillStyle = p.ground ? 'rgb(14,13,13)' : `rgb(${(54 * light) | 0},${(52 * light) | 0},${(54 * light) | 0})`;
        ctx.beginPath(); ctx.ellipse(0, 0, p.m.radius * 1.25, p.m.radius * 0.55, p.angle, 0, 6.29); ctx.fill();
        ctx.restore();
        return;
      }
      if (!p.ground || p.type === 'twiglet') {                   // contact shadow
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath(); ctx.ellipse(0, 3, p.m.radius * 1.5, p.m.radius * 0.5, p.angle * 0.5, 0, 6.29); ctx.fill();
      }
      ctx.scale(1, p.type === 'log' ? 0.86 : 0.7);               // lying on tilted ground
      ctx.rotate(p.angle);
      tracePiece(ctx, p.type, p.seed);
      strokeOrFill(ctx, p.type, pieceColor(p, light));
      if (p.type === 'log') {                                    // bark lines and the cut end
        ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(-14, -2.5); ctx.lineTo(8, -3); ctx.moveTo(-9, 2.5); ctx.lineTo(13, 2); ctx.stroke();
        const k = light * (1 - clamp((1 - p.fuel) * 1.1, 0, 0.85));
        ctx.fillStyle = `rgb(${(150 * k) | 0},${(112 * k) | 0},${(74 * k) | 0})`;
        ctx.beginPath(); ctx.ellipse(18, 0, 4.2, 6.6, 0, 0, 6.29); ctx.fill();
      }
      // Heat shows as an ember glow that grows as the piece nears ignition.
      const warm = p.burning ? 0.55 + 0.45 * p.intensity : smooth(55, p.igniteAt, p.temp) * 0.9;
      if (warm > 0.02) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = warm * (p.burning ? 0.62 + 0.14 * Math.sin(t * 11 + p.seed * 30) : 0.7);
        tracePiece(ctx, p.type, p.seed);
        strokeOrFill(ctx, p.type, p.burning ? '#ff7a22' : '#c8370e');
      }
      ctx.restore();
    }

    drawTent(ctx, light, lit, dawn) {
      const x = this.sx(TENT.x), y = this.sy(TENT.y) + 26, w = TENT.w, h = 96;
      const tone = (r, g, b) => {
        const k = light * 0.72;
        return `rgb(${(r * k + lit * 120) | 0},${(g * k + lit * 62) | 0},${(b * k + lit * 22) | 0})`;
      };
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.beginPath(); ctx.ellipse(x + 8, y + 2, w * 0.72, 12, 0, 0, 6.29); ctx.fill();
      // far side, in shadow
      const k = light * 0.5;
      ctx.fillStyle = `rgb(${(92 * k) | 0},${(84 * k) | 0},${(78 * k) | 0})`;
      ctx.beginPath(); ctx.moveTo(x - w * 0.62, y - 6); ctx.lineTo(x - w * 0.2, y - h); ctx.lineTo(x + w * 0.05, y - h + 6); ctx.lineTo(x - w * 0.3, y); ctx.closePath(); ctx.fill();
      // the face turned toward the fire
      ctx.fillStyle = tone(132, 118, 100);
      ctx.beginPath(); ctx.moveTo(x - w * 0.3, y); ctx.lineTo(x + w * 0.05, y - h + 6); ctx.lineTo(x + w * 0.52, y - 2); ctx.closePath(); ctx.fill();
      // door
      ctx.fillStyle = `rgba(6,8,12,${0.85 - dawn * 0.2})`;
      ctx.beginPath(); ctx.moveTo(x + w * 0.02, y - 1); ctx.lineTo(x + w * 0.06, y - h * 0.62); ctx.lineTo(x + w * 0.22, y - 1.5); ctx.closePath(); ctx.fill();
      // guy line
      ctx.strokeStyle = `rgba(190,170,140,${0.12 + lit * 0.3})`; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(x + w * 0.05, y - h + 6); ctx.lineTo(x + w * 0.78, y + 6); ctx.stroke();
    }

    /** Press D: show the numbers behind the fire. Point at a piece for its full readout. */
    drawDebug(ctx, sim) {
      ctx.save();
      ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 5]);
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';                 // the safe ring
      ctx.beginPath(); ctx.ellipse(this.cx, this.cy, RING_R, RING_R * GROUND_SQUASH, 0, 0, 6.29); ctx.stroke();

      // which piece is under the pointer?
      let hover = null, hoverD = 22;
      if (this.pointer) {
        const g = this.toGround(this.pointer.x, this.pointer.y);
        for (const p of sim.pieces) {
          if (p.ash) continue;
          const d = Math.hypot(p.x - g.x, (p.y - g.y) * GROUND_SQUASH);
          if (d < hoverD) { hoverD = d; hover = p; }
        }
      }
      for (const p of sim.pieces) {
        if (p.ash) continue;
        const x = this.sx(p.x), y = this.sy(p.y);
        if (p.burning || p === hover) {                          // how far this piece's heat reaches
          const r = p.m.radius + p.m.reach;
          ctx.strokeStyle = p === hover ? 'rgba(255,255,255,0.7)' : 'rgba(255,150,60,0.3)';
          ctx.beginPath(); ctx.ellipse(x, y, r, r * GROUND_SQUASH, 0, 0, 6.29); ctx.stroke();
        }
        if (p.ground && p.temp < 40 && p !== hover) continue;
        ctx.fillStyle = p.burning ? '#ffe0b0' : '#c4d0f0';       // temperature above every warm piece
        ctx.fillText(`${p.temp | 0}°`, x, y - p.m.radius - 6);
      }
      ctx.setLineDash([]);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#c4d0f0';
      const rows = [
        'DEBUG   press D to hide, point at a piece to inspect it',
        `burning ${sim.burningCount}    of which outside the ring ${sim.outsideBurning}`,
        `fire-out timer ${sim.outTimer.toFixed(1)} / ${FIRE_OUT_SECONDS} s    wildfire timer ${sim.wildTimer.toFixed(1)} / ${WILD_SECONDS} s`,
        `total heat ${sim.totalOutput | 0}    sparks ${sim.sparks.length}    flame particles ${this.flames.length}    ${this.fps | 0} fps`,
        `wind ${sim.env.wind.toFixed(2)}    moisture ${(sim.env.moisture * 100) | 0}%`,
      ];
      if (hover) {
        const m = hover.m;
        rows.push('',
          `${m.label}${hover.burning ? '  (burning)' : ''}`,
          `temperature ${hover.temp | 0}°    ignites at ${hover.igniteAt | 0}°    goes out below ${m.sustain}°`,
          `oxygen factor ${hover.oxygen.toFixed(2)}    crowding ${hover.crowd.toFixed(2)}`,
          `fuel left ${(hover.fuel * 100) | 0}%    dampness ${(hover.damp * 100) | 0}%`,
          `heat arriving ${hover.heatIn | 0}    heat given off ${hover.output | 0}    heat reach ${m.reach}`);
      }
      const top = 140 / this.scale;
      rows.forEach((row, i) => ctx.fillText(row, 30 / this.scale, top + i * 14));
      ctx.restore();
    }
  }

  /* =====================================================================
     7. GAME  (input, HUD, main loop)
     ===================================================================== */
  const $ = id => document.getElementById(id);
  const canvas = $('scene');
  const view = new View(canvas);
  let sim, drag = null, lastTime = 0, acc = 0, shownState = '', placedOnce = false;

  const ENDINGS = {
    won: ['You made it to sunrise', 'The fire burned all night.'],
    out: ['The fire went out', 'Nothing was left burning. Fuel that sits alone, too far from heat or packed too tight for air, dies.'],
    wildfire: ['The fire spread into the forest', 'Sparks found dry ground outside the ring and the fire fed itself from there.'],
  };

  function newGame() {
    sim = new Simulation(Math.min(view.W / 2 - 24, 620), view.depthBack, view.depthFront);
    view.flames.length = view.smoke.length = view.flashes.length = 0;
    drag = null; acc = 0; shownState = ''; placedOnce = false;
    $('ending').hidden = true;
    document.body.classList.remove('ended');
    updateHud();
  }

  /* ---------- HUD ---------- */

  function clockText(progress) {
    const minutes = Math.floor(23 * 60 + progress * 7 * 60) % (24 * 60);
    const h24 = Math.floor(minutes / 60), mm = String(minutes % 60).padStart(2, '0');
    return `${h24 % 12 === 0 ? 12 : h24 % 12}:${mm} ${h24 >= 12 ? 'PM' : 'AM'}`;
  }

  function updateHud() {
    const env = sim.env;
    $('clock').textContent = clockText(env.progress);
    const w = env.wind, strength = Math.abs(w);
    $('wind-arrow').style.transform = `scaleX(${w < 0 ? -1 : 1})`;
    $('wind-arrow').style.opacity = 0.35 + 0.65 * strength;
    $('wind-arrow').style.width = `${14 + 26 * strength}px`;
    $('wind-value').textContent = strength.toFixed(2);
    $('moisture-value').textContent = `${Math.round(env.moisture * 100)}%`;
    for (const type of Object.keys(START_INVENTORY)) {
      const el = document.querySelector(`.fuel[data-type="${type}"]`);
      el.querySelector('.count').textContent = `× ${sim.inventory[type]}`;
      el.classList.toggle('empty', sim.inventory[type] <= 0);
    }
    // One quiet line of guidance, only when something needs saying.
    let hint = '';
    if (sim.state === 'playing') {
      if (sim.wildTimer > 0.5) hint = 'The fire is spreading outside the ring';
      else if (sim.outsideBurning > 0) hint = 'A spark has caught outside the ring';
      else if (sim.outTimer > 1.5) hint = 'Nothing is burning';
      else if (!placedOnce && env.time > 1.5) hint = 'Drag fuel into the stone ring';
    }
    const hintEl = $('hint');
    if (hintEl.dataset.text !== hint) {
      hintEl.dataset.text = hint;
      if (hint) hintEl.textContent = hint;
      hintEl.classList.toggle('show', !!hint);
      hintEl.classList.toggle('danger', sim.wildTimer > 0.5);
    }
    if (sim.state !== 'playing' && shownState !== sim.state) {
      shownState = sim.state;
      const [title, text] = ENDINGS[sim.state];
      $('ending-title').textContent = title;
      $('ending-text').textContent = text;
      $('ending').hidden = false;
      $('ending').dataset.state = sim.state;
      document.body.classList.add('ended');
      cancelDrag();
    }
  }

  /* The inventory icons are drawn with the same code as the pieces in the game. */
  function drawIcons() {
    for (const el of document.querySelectorAll('.fuel canvas')) {
      const type = el.parentElement.dataset.type;
      const c = el.getContext('2d'), dpr = Math.min(window.devicePixelRatio || 1, 2);
      el.width = 64 * dpr; el.height = 44 * dpr;
      c.scale(dpr, dpr);
      const fake = { type, fuel: 1, damp: 0, ash: false };
      const spots = type === 'leaf' ? [[24, 25, -0.5, 0.3], [38, 19, 0.5, 0.7], [37, 30, -0.1, 0.5]]
        : type === 'twig' ? [[32, 19, 0.25, 0.2], [32, 28, -0.2, 0.8]]
        : [[32, 22, -0.08, 0.5]];
      for (const [x, y, a, seed] of spots) {
        c.save(); c.translate(x, y); c.rotate(a);
        tracePiece(c, type, seed, type === 'log' ? 1.05 : 1.15);
        strokeOrFill(c, type, pieceColor(fake, 1.25), type === 'log' ? 1.05 : 1.15);
        if (type === 'log') {
          c.strokeStyle = 'rgba(0,0,0,0.3)'; c.lineWidth = 1;
          c.beginPath(); c.moveTo(-14, -2.5); c.lineTo(8, -3); c.moveTo(-9, 2.5); c.lineTo(13, 2); c.stroke();
          c.fillStyle = 'rgb(188,142,96)'; c.beginPath(); c.ellipse(19, 0, 4.4, 6.9, 0, 0, 6.29); c.fill();
        }
        c.restore();
      }
    }
  }

  /* ---------- dragging fuel ---------- */

  /** Can fuel be put down here? Only on open ground. */
  function validSpot(px, py, target) {
    if (target !== canvas) return false;
    const g = view.toGround(px, py);
    return g.y >= view.depthBack && g.y <= view.depthFront + 30 && !insideTent(g.x, g.y);
  }

  /** The unlit, player-placed piece under the pointer, if any. Burning fuel is locked. */
  function pieceAt(px, py) {
    const g = view.toGround(px, py);
    let best = null, bestD = Infinity;
    for (const p of sim.pieces) {
      if (p.ground || p.ash || p.burning) continue;
      const d = Math.hypot(p.x - g.x, (p.y - g.y) * GROUND_SQUASH) - p.m.radius;
      if (d < 10 && d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  function startDrag(e, type, piece) {
    if (sim.state !== 'playing') return;
    e.preventDefault();
    const ref = piece || { type, fuel: 1, damp: sim.env.moisture * MATERIALS[type].absorb, ash: false };
    drag = {
      type, piece, ref, m: MATERIALS[type],
      px: e.clientX, py: e.clientY, valid: false,
      angle: piece ? piece.angle : rand(-0.55, 0.55), seed: piece ? piece.seed : Math.random(),
    };
    if (piece) piece.held = true;          // lifted off the ground: it stops trading heat
    document.body.classList.add('dragging');
    moveDrag(e);
  }

  function moveDrag(e) {
    if (!drag) return;
    drag.px = e.clientX; drag.py = e.clientY;
    drag.valid = validSpot(e.clientX, e.clientY, document.elementFromPoint(e.clientX, e.clientY));
  }

  function endDrag(e) {
    if (!drag) return;
    moveDrag(e);
    if (drag.valid && sim.state === 'playing') {
      const g = view.toGround(drag.px, drag.py);
      if (drag.piece) { drag.piece.x = g.x; drag.piece.y = g.y; }
      else {
        const p = sim.addFuel(drag.type, g.x, g.y);
        if (p) { p.angle = drag.angle; p.seed = drag.seed; }
      }
      placedOnce = true;
    }
    cancelDrag();
  }

  function cancelDrag() {
    if (!drag) return;
    if (drag.piece) drag.piece.held = false;     // an invalid drop puts the piece back where it was
    drag = null;
    document.body.classList.remove('dragging');
  }

  for (const el of document.querySelectorAll('.fuel')) {
    el.addEventListener('pointerdown', e => {
      if (sim.inventory[el.dataset.type] > 0) startDrag(e, el.dataset.type, null);
    });
  }
  canvas.addEventListener('pointerdown', e => {
    const p = pieceAt(e.clientX, e.clientY);
    if (p) startDrag(e, p.type, p);
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag) canvas.style.cursor = sim.state === 'playing' && pieceAt(e.clientX, e.clientY) ? 'grab' : '';
  });
  window.addEventListener('pointermove', e => { view.pointer = { x: e.clientX, y: e.clientY }; moveDrag(e); });
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', cancelDrag);
  window.addEventListener('blur', cancelDrag);

  $('restart').addEventListener('click', newGame);
  $('again').addEventListener('click', newGame);
  window.addEventListener('keydown', e => {
    if (e.key === 'd' || e.key === 'D') view.debug = !view.debug;
  });
  window.addEventListener('resize', () => { view.resize(); drawIcons(); });

  /* ---------- main loop ---------- */

  function frame(now) {
    const dt = Math.min(0.1, (now - lastTime) / 1000 || 0);
    lastTime = now;
    view.fps = lerp(view.fps, dt > 0 ? 1 / dt : 60, 0.05);

    // The simulation advances in fixed steps so it behaves the same on any screen.
    // After the game ends it keeps running: the fire (or the forest) carries on by the same rules.
    acc += dt;
    let steps = 0;
    while (acc >= SIM_DT && steps < 5) {
      if (sim.state === 'won') sim.env.time = Math.min(sim.env.time, NIGHT_SECONDS);   // hold the clock at 6:00
      sim.step(SIM_DT);
      view.emit(sim, SIM_DT);
      acc -= SIM_DT;
      steps++;
    }
    if (steps === 5) acc = 0;
    view.updateParticles(sim, dt);
    view.draw(sim, drag);
    updateHud();
    requestAnimationFrame(frame);
  }

  newGame();
  drawIcons();
  // Handy for exploring in the browser console: campfire.sim.pieces, campfire.sim.env ...
  window.campfire = { get sim() { return sim; }, view };
  requestAnimationFrame(t => { lastTime = t; requestAnimationFrame(frame); });
}
