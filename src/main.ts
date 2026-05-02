import * as THREE from 'three';

// --- Scene setup ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101820);
scene.fog = new THREE.Fog(0x101820, 40, 90);

const aspect = window.innerWidth / window.innerHeight;
const camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 200);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// --- Lighting ---
scene.add(new THREE.AmbientLight(0x6680aa, 0.55));

const sunLight = new THREE.DirectionalLight(0xfff0d8, 1.0);
sunLight.castShadow = true;
sunLight.shadow.mapSize.width = 2048;
sunLight.shadow.mapSize.height = 2048;
sunLight.shadow.camera.near = 0.5;
sunLight.shadow.camera.far = 120;
sunLight.shadow.camera.left = -60;
sunLight.shadow.camera.right = 60;
sunLight.shadow.camera.top = 60;
sunLight.shadow.camera.bottom = -60;
scene.add(sunLight);
// We aim the directional light at the player; both light + target follow.
sunLight.target = new THREE.Object3D();
scene.add(sunLight.target);

// --- World ---
// Lane is bounded on X, infinite on Z. Forward is -Z (the camera looks toward +Z).
const LANE_HALF = 25;          // X half-extent (corridor width)
const TILE_LEN = 100;           // Z length of each ground/grid tile
const STREAM_AHEAD = 90;        // spawn terrain/enemies up to this far ahead of player (in -Z)
const STREAM_BEHIND = 40;       // keep things this far behind before recycling/despawning
const CHUNK_LEN = 20;           // terrain chunk length on Z

// --- Ground & grid (two tiles that leapfrog along Z) ---
const groundMat = new THREE.MeshStandardMaterial({ color: 0x2a3340 });
const groundGeo = new THREE.PlaneGeometry(LANE_HALF * 2, TILE_LEN, 10, 20);

type GroundTile = { ground: THREE.Mesh; grid: THREE.GridHelper; centerZ: number };
const groundTiles: GroundTile[] = [];

function makeGroundTile(centerZ: number): GroundTile {
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, 0, centerZ);
  ground.receiveShadow = true;
  scene.add(ground);

  // GridHelper is square; we use one with TILE_LEN side and crop visually via fog.
  const grid = new THREE.GridHelper(TILE_LEN, 20, 0x44ddff, 0x224466);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.35;
  grid.position.set(0, 0.01, centerZ);
  scene.add(grid);

  return { ground, grid, centerZ };
}
groundTiles.push(makeGroundTile(0));
groundTiles.push(makeGroundTile(-TILE_LEN));

// --- Walls (long strips, also recycled along Z) ---
const wallMat = new THREE.MeshStandardMaterial({ color: 0x44ddff, emissive: 0x2288aa, emissiveIntensity: 0.4 });
const wallHeight = 1.5;
const wallThickness = 1;
const wallGeo = new THREE.BoxGeometry(wallThickness, wallHeight, TILE_LEN);

type WallTile = { left: THREE.Mesh; right: THREE.Mesh; centerZ: number };
const wallTiles: WallTile[] = [];

function makeWallTile(centerZ: number): WallTile {
  const left = new THREE.Mesh(wallGeo, wallMat);
  left.position.set(-LANE_HALF, wallHeight / 2, centerZ);
  left.castShadow = true;
  left.receiveShadow = true;
  scene.add(left);
  const right = new THREE.Mesh(wallGeo, wallMat);
  right.position.set(LANE_HALF, wallHeight / 2, centerZ);
  right.castShadow = true;
  right.receiveShadow = true;
  scene.add(right);
  return { left, right, centerZ };
}
wallTiles.push(makeWallTile(0));
wallTiles.push(makeWallTile(-TILE_LEN));

// --- Terrain features ---
type Obstacle = { mesh: THREE.Mesh; extras: THREE.Mesh[]; x: number; z: number; radius: number };
const obstacles: Obstacle[] = [];

const rockMat = new THREE.MeshStandardMaterial({ color: 0x4a5566, roughness: 0.9 });
const crystalMat = new THREE.MeshStandardMaterial({
  color: 0x66ffcc, emissive: 0x118866, emissiveIntensity: 0.7, roughness: 0.2,
});
const pylonMat = new THREE.MeshStandardMaterial({
  color: 0xff66aa, emissive: 0x661133, emissiveIntensity: 0.6,
});

// White box with red cross — used for the six faces of the health pickup.
function makeHealthCrossTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  // White background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  // Thin border so seams between faces read clearly
  ctx.strokeStyle = '#cccccc';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, size - 4, size - 4);
  // Red cross
  ctx.fillStyle = '#dd1122';
  const t = size * 0.22;     // arm thickness
  const m = (size - t) / 2;  // margin to center the bar
  const inset = size * 0.14; // shorten arms slightly so cross floats inside the face
  ctx.fillRect(m, inset, t, size - inset * 2);          // vertical bar
  ctx.fillRect(inset, m, size - inset * 2, t);          // horizontal bar
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
const healthCrossTexture = makeHealthCrossTexture();
const healthMat = new THREE.MeshStandardMaterial({
  map: healthCrossTexture,
  emissive: 0xffffff,
  emissiveMap: healthCrossTexture,
  emissiveIntensity: 0.25,
  roughness: 0.6,
});

// --- Seeded RNG (mulberry32) ---
// Returns a function that yields deterministic floats in [0, 1).
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Mix two 32-bit values into a single seed (xmur3-ish).
function mixSeed(a: number, b: number): number {
  let h = (a ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ b, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

// Per-level base seed; reseeded on restart so each run is reproducible.
let baseSeed = (Math.random() * 0xffffffff) >>> 0;

// Track which Z chunks have been generated. Chunks are indexed by floor(z / CHUNK_LEN).
const generatedChunks = new Set<number>();

// Collision check is restricted to obstacles already placed *in this chunk* during this
// generation pass, so each chunk's layout depends only on its own seed (not on which
// neighbors happen to be loaded). `placedInChunk` is the running list for this chunk.
function tryPlaceInChunk(
  rng: () => number,
  chunkIndex: number,
  radius: number,
  avoidNearOrigin: boolean,
  placedInChunk: { x: number; z: number; radius: number }[],
): { x: number; z: number } | null {
  const zMin = chunkIndex * CHUNK_LEN;
  for (let attempt = 0; attempt < 20; attempt++) {
    const x = (rng() - 0.5) * (LANE_HALF * 2 - 4);
    const z = zMin + rng() * CHUNK_LEN;
    if (avoidNearOrigin && Math.hypot(x, z) < 6) continue;
    let collides = false;
    for (const p of placedInChunk) {
      if (Math.hypot(x - p.x, z - p.z) < radius + p.radius + 1) { collides = true; break; }
    }
    if (!collides) return { x, z };
  }
  return null;
}

type Placed = { x: number; z: number; radius: number };

function spawnRockInChunk(rng: () => number, chunkIndex: number, avoidNearOrigin: boolean, placed: Placed[]) {
  const radius = 0.9 + rng() * 0.8;
  const pos = tryPlaceInChunk(rng, chunkIndex, radius, avoidNearOrigin, placed);
  if (!pos) return;
  const geo = new THREE.DodecahedronGeometry(radius, 0);
  const mesh = new THREE.Mesh(geo, rockMat);
  mesh.position.set(pos.x, radius * 0.6, pos.z);
  mesh.rotation.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  const collisionRadius = radius * 0.85;
  obstacles.push({ mesh, extras: [], x: pos.x, z: pos.z, radius: collisionRadius });
  placed.push({ x: pos.x, z: pos.z, radius: collisionRadius });
}

function spawnCrystalInChunk(rng: () => number, chunkIndex: number, avoidNearOrigin: boolean, placed: Placed[]) {
  const radius = 0.5 + rng() * 0.4;
  const pos = tryPlaceInChunk(rng, chunkIndex, radius, avoidNearOrigin, placed);
  if (!pos) return;
  const height = 1.8 + rng() * 1.2;
  const geo = new THREE.ConeGeometry(radius, height, 6);
  const mesh = new THREE.Mesh(geo, crystalMat);
  mesh.position.set(pos.x, height / 2, pos.z);
  mesh.rotation.y = rng() * Math.PI;
  mesh.castShadow = true;
  scene.add(mesh);
  const collisionRadius = radius * 0.85;
  obstacles.push({ mesh, extras: [], x: pos.x, z: pos.z, radius: collisionRadius });
  placed.push({ x: pos.x, z: pos.z, radius: collisionRadius });
}

function spawnPylonInChunk(rng: () => number, chunkIndex: number, avoidNearOrigin: boolean, placed: Placed[]) {
  const radius = 0.45;
  const pos = tryPlaceInChunk(rng, chunkIndex, radius, avoidNearOrigin, placed);
  if (!pos) return;
  const height = 3.2;
  const geo = new THREE.CylinderGeometry(radius, radius * 1.3, height, 6);
  const mesh = new THREE.Mesh(geo, pylonMat);
  mesh.position.set(pos.x, height / 2, pos.z);
  mesh.castShadow = true;
  scene.add(mesh);
  const capGeo = new THREE.SphereGeometry(radius * 0.9, 12, 8);
  const cap = new THREE.Mesh(capGeo, crystalMat);
  cap.position.set(pos.x, height + 0.1, pos.z);
  scene.add(cap);
  const collisionRadius = radius * 1.3;
  obstacles.push({ mesh, extras: [cap], x: pos.x, z: pos.z, radius: collisionRadius });
  placed.push({ x: pos.x, z: pos.z, radius: collisionRadius });
}

// --- Health pickups ---
type HealthPickup = {
  mesh: THREE.Mesh;
  x: number;
  z: number;
  radius: number;
  heal: number;
  bobPhase: number;
};
const healthPickups: HealthPickup[] = [];

function spawnHealthInChunk(rng: () => number, chunkIndex: number, avoidNearOrigin: boolean, placed: Placed[], big: boolean) {
  const size = big ? 1.4 : 0.7;
  const heal = big ? 8 : 3;
  const pos = tryPlaceInChunk(rng, chunkIndex, size, avoidNearOrigin, placed);
  if (!pos) return;
  const geo = new THREE.BoxGeometry(size, size, size);
  const mesh = new THREE.Mesh(geo, healthMat);
  mesh.position.set(pos.x, size / 2 + 0.5, pos.z);
  mesh.rotation.y = rng() * Math.PI;
  mesh.castShadow = true;
  scene.add(mesh);
  healthPickups.push({
    mesh, x: pos.x, z: pos.z,
    radius: size * 0.7,
    heal,
    bobPhase: rng() * Math.PI * 2,
  });
  // Reserve placement footprint so other chunk items don't overlap, but don't add
  // to `obstacles` (the player should walk through pickups).
  placed.push({ x: pos.x, z: pos.z, radius: size * 0.9 });
}

// --- Weapon power-up pickups ---
type PowerPickup = {
  mesh: THREE.Mesh;
  x: number;
  z: number;
  radius: number;
  power: PowerType;
  bobPhase: number;
};
const powerPickups: PowerPickup[] = [];
const POWER_TYPES: PowerType[] = [
  'doubleShot', 'tripleShot', 'swirlShot', 'laserRay',
  'bigGrenade', 'multiGrenade', 'multiExplosion', 'powerShot',
];

function spawnPowerInChunk(rng: () => number, chunkIndex: number, avoidNearOrigin: boolean, placed: Placed[]) {
  const size = 1.0;
  const pos = tryPlaceInChunk(rng, chunkIndex, size, avoidNearOrigin, placed);
  if (!pos) return;
  const power = POWER_TYPES[Math.floor(rng() * POWER_TYPES.length)];
  const info = POWER_INFO[power];
  const mat = new THREE.MeshStandardMaterial({
    color: info.color, emissive: info.color, emissiveIntensity: 0.7, roughness: 0.4,
  });
  const geo = new THREE.BoxGeometry(size, size, size);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(pos.x, size / 2 + 0.6, pos.z);
  mesh.rotation.y = rng() * Math.PI;
  mesh.castShadow = true;
  scene.add(mesh);

  // Small marker ring on top so the player can spot it from afar.
  const ringGeo = new THREE.TorusGeometry(size * 0.55, 0.06, 6, 16);
  const ringMat = new THREE.MeshBasicMaterial({ color: info.color, transparent: true, opacity: 0.9, fog: false });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = size * 0.7;
  mesh.add(ring);

  powerPickups.push({
    mesh, x: pos.x, z: pos.z,
    radius: size * 0.7,
    power,
    bobPhase: rng() * Math.PI * 2,
  });
  placed.push({ x: pos.x, z: pos.z, radius: size * 0.9 });
}

function generateChunk(chunkIndex: number) {
  if (generatedChunks.has(chunkIndex)) return;
  generatedChunks.add(chunkIndex);
  // Each chunk gets its own deterministic RNG keyed by (baseSeed, chunkIndex).
  const rng = makeRng(mixSeed(baseSeed, chunkIndex));
  // Skip the spawn-area chunk so the player doesn't start clipped into terrain.
  const avoidNearOrigin = chunkIndex === 0 || chunkIndex === -1;
  const rocks = 2 + Math.floor(rng() * 2);
  const crystals = 1 + Math.floor(rng() * 2);
  const pylons = rng() < 0.6 ? 1 : 0;
  // Health: small ones common, big ones rare.
  const smallHealth = rng() < 0.5 ? 1 : 0;
  const bigHealth = rng() < 0.12 ? 1 : 0;
  const power = rng() < 0.18 ? 1 : 0;
  const placed: Placed[] = [];
  for (let i = 0; i < rocks; i++) spawnRockInChunk(rng, chunkIndex, avoidNearOrigin, placed);
  for (let i = 0; i < crystals; i++) spawnCrystalInChunk(rng, chunkIndex, avoidNearOrigin, placed);
  for (let i = 0; i < pylons; i++) spawnPylonInChunk(rng, chunkIndex, avoidNearOrigin, placed);
  for (let i = 0; i < smallHealth; i++) spawnHealthInChunk(rng, chunkIndex, avoidNearOrigin, placed, false);
  for (let i = 0; i < bigHealth; i++) spawnHealthInChunk(rng, chunkIndex, avoidNearOrigin, placed, true);
  for (let i = 0; i < power; i++) spawnPowerInChunk(rng, chunkIndex, avoidNearOrigin, placed);
}

function despawnObstacle(o: Obstacle) {
  scene.remove(o.mesh);
  o.mesh.geometry.dispose();
  for (const x of o.extras) {
    scene.remove(x);
    x.geometry.dispose();
  }
}

// --- Red mist (encroaches from behind) ---
// `mistEdgeZ` is the leading (front) edge in world Z. Player is "inside the mist"
// when player.z >= mistEdgeZ (i.e. behind the edge). Forward in this game is -Z.
const MIST_INITIAL_OFFSET = 30;   // start this far behind the player
const MIST_BASE_SPEED = 1.25;      // m/s forward
const MIST_RAMP_PER_METER = 0.005; // mist gets faster as you go further
const MIST_MAX_DISTANCE = 60;      // never trail farther than this behind player
const MIST_DAMAGE_INTERVAL = 0.5;  // seconds between damage ticks while inside
let mistEdgeZ = MIST_INITIAL_OFFSET;
let mistDamageTimer = 0;

// Visual: a few horizontal slabs of varying height stacked above the ground inside
// the mist region, plus a glowing leading line at the boundary. Vertex colors
// fade alpha to 0 at the front edge so it dissolves smoothly.
const MIST_DEPTH = 60;        // how far back the mist visually extends
const MIST_HEIGHTS = [0.05, 1.0, 2.0]; // stack at multiple Y values for volumetric feel
const mistGroup = new THREE.Group();
scene.add(mistGroup);

function makeMistSlab(yPos: number, opacityScale: number): THREE.Mesh {
  // Plane lies in the XZ plane; width spans the lane, depth = MIST_DEPTH along +Z
  // (so its front edge is at local z=0 and back edge at z=+MIST_DEPTH).
  // We'll position the slab so local z=0 sits at the mist front edge.
  const geo = new THREE.PlaneGeometry(LANE_HALF * 2, MIST_DEPTH, 1, 8);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, MIST_DEPTH / 2);

  // Per-vertex alpha via vertex colors (alpha channel stored in color via separate attribute).
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    const t = Math.min(1, z / MIST_DEPTH);     // 0 at front edge, 1 at back
    const alpha = Math.pow(t, 1.4) * opacityScale;
    colors[i * 4 + 0] = 1.0;       // r
    colors[i * 4 + 1] = 0.15;      // g
    colors[i * 4 + 2] = 0.2;       // b
    colors[i * 4 + 3] = alpha;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 4));

  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = yPos;
  return mesh;
}
const mistSlabs = MIST_HEIGHTS.map((y, i) => {
  const slab = makeMistSlab(y, 0.55 - i * 0.12);
  mistGroup.add(slab);
  return slab;
});

// Bright leading line at the boundary so the player can read where it is.
const mistEdgeLineMat = new THREE.MeshBasicMaterial({
  color: 0xff5566, transparent: true, opacity: 0.9, depthWrite: false, fog: false,
});
const mistEdgeLineGeo = new THREE.PlaneGeometry(LANE_HALF * 2, 0.4);
const mistEdgeLine = new THREE.Mesh(mistEdgeLineGeo, mistEdgeLineMat);
mistEdgeLine.rotation.x = -Math.PI / 2;
mistEdgeLine.position.y = 0.06;
mistGroup.add(mistEdgeLine);
void mistSlabs;

// --- Player ---
const playerRadius = 0.5;
const playerGroup = new THREE.Group();

const bodyGeo = new THREE.CapsuleGeometry(0.4, 0.9, 8, 16);
const bodyMat = new THREE.MeshStandardMaterial({ color: 0x33aaff, emissive: 0x114466, emissiveIntensity: 0.4 });
const body = new THREE.Mesh(bodyGeo, bodyMat);
body.castShadow = true;
body.position.y = 0.85;
playerGroup.add(body);

const gunGeo = new THREE.BoxGeometry(0.18, 0.18, 0.7);
const gunMat = new THREE.MeshStandardMaterial({ color: 0xffcc44, emissive: 0x885500, emissiveIntensity: 0.6 });
const gun = new THREE.Mesh(gunGeo, gunMat);
gun.castShadow = true;
gun.position.set(0, 0.95, -0.55);
playerGroup.add(gun);

playerGroup.position.set(0, 0, 0);
scene.add(playerGroup);

// --- Player state ---
const playerVel = new THREE.Vector3();
const playerSpeed = 14;
const MAX_HP = 25;
const OVERHEAL_CAP = Math.floor(MAX_HP * 1.5);
const OVERHEAL_DECAY_PER_SEC = 0.25; // points/sec while above MAX_HP
let playerHP = MAX_HP;
let overhealRemainder = 0; // sub-integer carry so decay is smooth across frames
let score = 0;
let playerHitFlash = 0;
const PLAYER_BASE_EMISSIVE = bodyMat.emissiveIntensity;
const PLAYER_BASE_COLOR = bodyMat.color.getHex();
let maxDistance = 0;       // furthest forward (-Z) the player has reached
let gameOver = false;
let paused = false;

// --- Input ---
const keys: Record<string, boolean> = {};
window.addEventListener('keydown', (e) => {
  const wasDown = keys[e.code];
  keys[e.code] = true;
  if (gameOver && e.code === 'Enter') restart();
  else if (e.code === 'Escape' && !gameOver) togglePause();
  else if (e.code === 'KeyE' && !wasDown && !gameOver && !paused) throwGrenade();
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });

function togglePause() {
  paused = !paused;
  if (paused) {
    overlayEl.innerHTML = `PAUSED<br><span style="font-size:18px">Press ESC to resume</span>`;
    overlayEl.style.display = 'block';
  } else {
    overlayEl.style.display = 'none';
  }
}

// Mouse aim
const mouseNDC = new THREE.Vector2(0, 0);
const aimWorld = new THREE.Vector3();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const raycaster = new THREE.Raycaster();
let mouseDown = false;

renderer.domElement.addEventListener('mousemove', (e) => {
  const rect = renderer.domElement.getBoundingClientRect();
  mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
});
renderer.domElement.addEventListener('mousedown', () => { mouseDown = true; });
window.addEventListener('mouseup', () => { mouseDown = false; });
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

// --- Bullets ---
type Bullet = {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  damage: number;
  pierce: number;       // remaining pierce-throughs (0 = stop on first hit)
  hitSet?: Set<unknown>;// for piercing: enemies already hit by this bullet
  swirl?: { startX: number; startZ: number; fwdX: number; fwdZ: number; t: number; angularSpeed: number; radius: number };
};
const bullets: Bullet[] = [];
const bulletGeo = new THREE.SphereGeometry(0.18, 8, 8);
const bulletMat = new THREE.MeshStandardMaterial({ color: 0xffee66, emissive: 0xffaa00, emissiveIntensity: 1.2 });
const powerBulletGeo = new THREE.SphereGeometry(0.32, 12, 10);
const powerBulletMat = new THREE.MeshStandardMaterial({ color: 0xff66ff, emissive: 0xff22ff, emissiveIntensity: 1.6 });
const bulletSpeed = 40;
const bulletLife = 1.5;
const fireInterval = 0.12;
let fireCooldown = 0;

function fireBullet(from: THREE.Vector3, dir: THREE.Vector3, opts: Partial<Bullet> = {}) {
  const geo = opts.pierce && opts.pierce > 0 ? powerBulletGeo : bulletGeo;
  const mat = opts.pierce && opts.pierce > 0 ? powerBulletMat : bulletMat;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(from);
  mesh.position.y = 0.9;
  mesh.castShadow = true;
  scene.add(mesh);
  bullets.push({
    mesh,
    vel: dir.clone().setY(0).normalize().multiplyScalar(bulletSpeed),
    life: opts.life ?? bulletLife,
    damage: opts.damage ?? 1,
    pierce: opts.pierce ?? 0,
    hitSet: opts.pierce ? new Set() : undefined,
    swirl: opts.swirl,
  });
}

// --- Power-ups ---
type PowerType =
  | 'doubleShot'
  | 'tripleShot'
  | 'swirlShot'
  | 'laserRay'
  | 'bigGrenade'
  | 'multiGrenade'
  | 'multiExplosion'
  | 'powerShot';

let currentPower: PowerType | null = null;

const POWER_INFO: Record<PowerType, { color: number; label: string }> = {
  doubleShot:     { color: 0x44ddff, label: 'DOUBLE'  },
  tripleShot:     { color: 0x66ff88, label: 'TRIPLE'  },
  swirlShot:      { color: 0xffaa22, label: 'SWIRL'   },
  laserRay:       { color: 0xff2266, label: 'LASER'   },
  bigGrenade:     { color: 0xff8800, label: 'BIG GRENADE' },
  multiGrenade:   { color: 0x88ff44, label: 'MULTI GRENADE' },
  multiExplosion: { color: 0xff00aa, label: 'MULTI BLAST' },
  powerShot:      { color: 0xffee00, label: 'POWER SHOT' },
};

function clearPower() {
  if (!currentPower) return;
  currentPower = null;
  updateHud();
}

// --- Laser ray (instant beam, used by laserRay power) ---
type LaserBeam = { line: THREE.Line; mat: THREE.LineBasicMaterial; age: number; duration: number };
const laserBeams: LaserBeam[] = [];
function spawnLaserBeam(x1: number, z1: number, x2: number, z2: number) {
  const mat = new THREE.LineBasicMaterial({ color: 0xff2266, transparent: true, opacity: 1, fog: false });
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(x1, 0.9, z1),
    new THREE.Vector3(x2, 0.9, z2),
  ]);
  const line = new THREE.Line(geo, mat);
  scene.add(line);
  laserBeams.push({ line, mat, age: 0, duration: 0.18 });
}
function updateLaserBeams(dt: number) {
  for (let i = laserBeams.length - 1; i >= 0; i--) {
    const lb = laserBeams[i];
    lb.age += dt;
    const t = Math.min(1, lb.age / lb.duration);
    lb.mat.opacity = 1 - t;
    if (t >= 1) {
      scene.remove(lb.line);
      lb.line.geometry.dispose();
      lb.mat.dispose();
      laserBeams.splice(i, 1);
    }
  }
}

// Fire weapon based on current power-up.
function fireWeapon() {
  const dir = new THREE.Vector3(aimWorld.x - playerGroup.position.x, 0, aimWorld.z - playerGroup.position.z);
  if (dir.lengthSq() < 0.001) return;
  dir.setY(0).normalize();
  const muzzle = new THREE.Vector3(0, 0.95, -1.0).applyEuler(playerGroup.rotation).add(playerGroup.position);
  // Perpendicular for spreads
  const perp = new THREE.Vector3(-dir.z, 0, dir.x);

  switch (currentPower) {
    case 'doubleShot': {
      const off = 0.4;
      fireBullet(muzzle.clone().addScaledVector(perp, off), dir);
      fireBullet(muzzle.clone().addScaledVector(perp, -off), dir);
      break;
    }
    case 'tripleShot': {
      fireBullet(muzzle, dir);
      const spread = 0.18; // radians
      const cs = Math.cos(spread), sn = Math.sin(spread);
      const left  = new THREE.Vector3(dir.x * cs - dir.z * sn, 0, dir.x * sn + dir.z * cs);
      const right = new THREE.Vector3(dir.x * cs + dir.z * sn, 0, -dir.x * sn + dir.z * cs);
      fireBullet(muzzle, left);
      fireBullet(muzzle, right);
      break;
    }
    case 'swirlShot': {
      // Two bullets that curl around the aim axis in opposite directions.
      const swirlA = { startX: muzzle.x, startZ: muzzle.z, fwdX: dir.x, fwdZ: dir.z, t: 0, angularSpeed: 14, radius: 1.4 };
      const swirlB = { startX: muzzle.x, startZ: muzzle.z, fwdX: dir.x, fwdZ: dir.z, t: 0, angularSpeed: -14, radius: 1.4 };
      fireBullet(muzzle, dir, { swirl: swirlA, life: 1.8 });
      fireBullet(muzzle, dir, { swirl: swirlB, life: 1.8 });
      break;
    }
    case 'laserRay': {
      // Instant ray. March from player along dir, hit first obstacle/wall, damage
      // every enemy whose body is within `beamHalf` of the line up to the hit point.
      const startX = playerGroup.position.x;
      const startZ = playerGroup.position.z;
      const beamHalf = 0.6;
      const maxLen = STREAM_AHEAD;
      // Find end-point: closest obstacle hit, or wall, or maxLen.
      let endLen = maxLen;
      // X-walls
      if (Math.abs(dir.x) > 0.001) {
        const tx = ((dir.x > 0 ? LANE_HALF : -LANE_HALF) - startX) / dir.x;
        if (tx > 0 && tx < endLen) endLen = tx;
      }
      // Obstacles
      for (const o of obstacles) {
        const ox = o.x - startX;
        const oz = o.z - startZ;
        const proj = ox * dir.x + oz * dir.z;
        if (proj < 0 || proj > endLen) continue;
        const perpDist = Math.abs(ox * dir.z - oz * dir.x);
        if (perpDist < o.radius + 0.1) endLen = proj;
      }
      const endX = startX + dir.x * endLen;
      const endZ = startZ + dir.z * endLen;
      // Damage enemies along beam.
      for (let i = enemies.length - 1; i >= 0; i--) {
        const e = enemies[i];
        const ex = e.mesh.position.x - startX;
        const ez = e.mesh.position.z - startZ;
        const proj = ex * dir.x + ez * dir.z;
        if (proj < 0 || proj > endLen) continue;
        const perpDist = Math.abs(ex * dir.z - ez * dir.x);
        if (perpDist > beamHalf + e.radius) continue;
        e.hp -= 2;
        e.hitFlash = 0.18;
        if (e.hp <= 0) {
          scene.remove(e.mesh);
          (e.mesh.material as THREE.MeshStandardMaterial).dispose();
          enemies.splice(i, 1);
          score += e.scoreValue;
        }
      }
      spawnLaserBeam(startX, startZ, endX, endZ);
      break;
    }
    case 'powerShot': {
      // High damage, pierces up to 4 enemies.
      fireBullet(muzzle, dir, { damage: 4, pierce: 4, life: 2.0 });
      break;
    }
    default: {
      fireBullet(muzzle, dir);
    }
  }
}

// --- Grenades ---
type Grenade = {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  fuse: number;     // seconds until detonation
  big?: boolean;
  multiExplode?: boolean;
};
const grenades: Grenade[] = [];
const grenadeGeo = new THREE.SphereGeometry(0.22, 12, 10);
const grenadeMat = new THREE.MeshStandardMaterial({
  color: 0x224422, emissive: 0x113311, emissiveIntensity: 0.4, roughness: 0.6,
});
const GRENADE_FUSE = 1.4;
const GRENADE_THROW_SPEED = 12;
const GRENADE_THROW_UP = 9;
const GRENADE_GRAVITY = -22;
const GRENADE_BOUNCE = 0.4;
const GRENADE_GROUND_FRICTION = 0.7;
const GRENADE_RADIUS = 6;
const GRENADE_DAMAGE = 6; // damage applied at center; falls off with distance

const GRENADE_COOLDOWN = 0.6;
let grenadeCooldown = 0;

// Explosion visuals
type Explosion = {
  mesh: THREE.Mesh;
  light: THREE.PointLight;
  age: number;
  duration: number;
  finalScale: number;
};
const explosions: Explosion[] = [];
const explosionGeo = new THREE.SphereGeometry(1, 16, 12);
const explosionMat = new THREE.MeshBasicMaterial({
  color: 0xffaa33, transparent: true, opacity: 0.9, depthWrite: false, fog: false,
});

// Spawn a single grenade with throw kinematics. `dirX/dirZ` is unit forward in XZ.
// `extra` lets variants override blast/scale/secondary behavior.
type GrenadeExtra = { big?: boolean; multiExplode?: boolean };
function spawnGrenade(dirX: number, dirZ: number, extra: GrenadeExtra = {}) {
  const big = !!extra.big;
  const scale = big ? 1.8 : 1.0;
  const geo = big ? new THREE.SphereGeometry(0.22 * scale, 12, 10) : grenadeGeo;
  const mat = big ? grenadeMat.clone() : grenadeMat;
  if (big) (mat as THREE.MeshStandardMaterial).color.setHex(0xff8800);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.position.set(
    playerGroup.position.x + dirX * 0.7,
    1.0,
    playerGroup.position.z + dirZ * 0.7,
  );
  scene.add(mesh);

  grenades.push({
    mesh,
    vel: new THREE.Vector3(dirX * GRENADE_THROW_SPEED, GRENADE_THROW_UP, dirZ * GRENADE_THROW_SPEED),
    fuse: GRENADE_FUSE,
    big,
    multiExplode: !!extra.multiExplode,
  });
}

function throwGrenade() {
  if (grenadeCooldown > 0) return;
  grenadeCooldown = GRENADE_COOLDOWN;

  // Forward direction from player rotation.
  const yaw = playerGroup.rotation.y;
  const dirX = -Math.sin(yaw);
  const dirZ = -Math.cos(yaw);

  switch (currentPower) {
    case 'bigGrenade':
      spawnGrenade(dirX, dirZ, { big: true });
      break;
    case 'multiGrenade': {
      // Three grenades in a small spread.
      spawnGrenade(dirX, dirZ);
      const a = 0.35;
      const cs = Math.cos(a), sn = Math.sin(a);
      spawnGrenade(dirX * cs - dirZ * sn, dirX * sn + dirZ * cs);
      spawnGrenade(dirX * cs + dirZ * sn, -dirX * sn + dirZ * cs);
      break;
    }
    case 'multiExplosion':
      spawnGrenade(dirX, dirZ, { multiExplode: true });
      break;
    default:
      spawnGrenade(dirX, dirZ);
  }
}

function spawnExplosion(x: number, z: number, scale = 1) {
  const mat = explosionMat.clone();
  const mesh = new THREE.Mesh(explosionGeo, mat);
  mesh.position.set(x, 0.6, z);
  mesh.scale.setScalar(0.5 * scale);
  scene.add(mesh);

  const light = new THREE.PointLight(0xffaa33, 8 * scale, GRENADE_RADIUS * 2.5 * scale, 2);
  light.position.set(x, 1.5, z);
  scene.add(light);

  explosions.push({ mesh, light, age: 0, duration: 0.45, finalScale: GRENADE_RADIUS * scale });
}

function explodeAt(x: number, z: number, radius: number, damage: number, selfDamageCap: number) {
  spawnExplosion(x, z, radius / GRENADE_RADIUS);
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    const dx = e.mesh.position.x - x;
    const dz = e.mesh.position.z - z;
    const d = Math.hypot(dx, dz);
    if (d > radius + e.radius) continue;
    const falloff = Math.max(0, 1 - d / radius);
    const dmg = Math.max(1, Math.round(damage * falloff));
    e.hp -= dmg;
    e.hitFlash = 0.18;
    if (e.hp <= 0) {
      scene.remove(e.mesh);
      (e.mesh.material as THREE.MeshStandardMaterial).dispose();
      enemies.splice(i, 1);
      score += e.scoreValue;
    }
  }
  const pdx = playerGroup.position.x - x;
  const pdz = playerGroup.position.z - z;
  const pd = Math.hypot(pdx, pdz);
  if (pd < radius) {
    const falloff = 1 - pd / radius;
    const dmg = Math.max(1, Math.round(selfDamageCap * falloff));
    damagePlayer(dmg);
  }
}

function detonateGrenade(g: Grenade) {
  const x = g.mesh.position.x;
  const z = g.mesh.position.z;
  if (g.big) {
    explodeAt(x, z, GRENADE_RADIUS * 1.7, GRENADE_DAMAGE * 1.6, 4);
  } else if (g.multiExplode) {
    // Primary blast plus four secondaries spread around it.
    explodeAt(x, z, GRENADE_RADIUS, GRENADE_DAMAGE, 3);
    const r = 4;
    const seeds = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
    for (const a of seeds) {
      explodeAt(x + Math.cos(a) * r, z + Math.sin(a) * r, GRENADE_RADIUS * 0.7, GRENADE_DAMAGE * 0.7, 2);
    }
  } else {
    explodeAt(x, z, GRENADE_RADIUS, GRENADE_DAMAGE, 3);
  }
}

// Push a grenade out of a vertical-cylinder collider (centered at cx,cz with radius r)
// and reflect its XZ velocity along the surface normal. Returns true on hit.
const GRENADE_BODY_RADIUS = 0.22;
function bounceOffCircle(g: Grenade, cx: number, cz: number, r: number): boolean {
  const dx = g.mesh.position.x - cx;
  const dz = g.mesh.position.z - cz;
  const minDist = r + GRENADE_BODY_RADIUS;
  const distSq = dx * dx + dz * dz;
  if (distSq >= minDist * minDist || distSq < 1e-6) return false;
  const dist = Math.sqrt(distSq);
  const nx = dx / dist;
  const nz = dz / dist;
  // Push out to surface
  g.mesh.position.x = cx + nx * minDist;
  g.mesh.position.z = cz + nz * minDist;
  // Reflect the inward component of the XZ velocity
  const vDotN = g.vel.x * nx + g.vel.z * nz;
  if (vDotN < 0) {
    g.vel.x -= (1 + GRENADE_BOUNCE) * vDotN * nx;
    g.vel.z -= (1 + GRENADE_BOUNCE) * vDotN * nz;
  }
  return true;
}

function updateGrenades(dt: number) {
  if (grenadeCooldown > 0) grenadeCooldown -= dt;

  for (let i = grenades.length - 1; i >= 0; i--) {
    const g = grenades[i];
    g.fuse -= dt;

    // Integrate.
    g.vel.y += GRENADE_GRAVITY * dt;
    g.mesh.position.x += g.vel.x * dt;
    g.mesh.position.y += g.vel.y * dt;
    g.mesh.position.z += g.vel.z * dt;

    // Ground bounce.
    const groundY = 0.22;
    if (g.mesh.position.y < groundY) {
      g.mesh.position.y = groundY;
      g.vel.y = -g.vel.y * GRENADE_BOUNCE;
      g.vel.x *= GRENADE_GROUND_FRICTION;
      g.vel.z *= GRENADE_GROUND_FRICTION;
      if (Math.abs(g.vel.y) < 0.4) g.vel.y = 0;
    }

    // Side wall clamp on X.
    const limit = LANE_HALF - 0.5;
    if (g.mesh.position.x > limit) { g.mesh.position.x = limit; g.vel.x = -g.vel.x * GRENADE_BOUNCE; }
    if (g.mesh.position.x < -limit) { g.mesh.position.x = -limit; g.vel.x = -g.vel.x * GRENADE_BOUNCE; }

    // Bounce off terrain (cheap broad-phase: skip far-away obstacles).
    for (const o of obstacles) {
      if (Math.abs(o.z - g.mesh.position.z) > 4 || Math.abs(o.x - g.mesh.position.x) > 4) continue;
      bounceOffCircle(g, o.x, o.z, o.radius);
    }
    // Bounce off enemies (only those low enough to interact with the grenade).
    for (const e of enemies) {
      if (Math.abs(e.mesh.position.z - g.mesh.position.z) > 3 || Math.abs(e.mesh.position.x - g.mesh.position.x) > 3) continue;
      bounceOffCircle(g, e.mesh.position.x, e.mesh.position.z, e.radius);
    }

    // Tumble visually.
    g.mesh.rotation.x += dt * 6;
    g.mesh.rotation.z += dt * 4;

    if (g.fuse <= 0) {
      detonateGrenade(g);
      scene.remove(g.mesh);
      grenades.splice(i, 1);
    }
  }

  for (let i = explosions.length - 1; i >= 0; i--) {
    const ex = explosions[i];
    ex.age += dt;
    const t = Math.min(1, ex.age / ex.duration);
    const scale = 0.5 + t * ex.finalScale;
    ex.mesh.scale.setScalar(scale);
    (ex.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t);
    ex.light.intensity = 8 * (1 - t);
    if (t >= 1) {
      scene.remove(ex.mesh);
      (ex.mesh.material as THREE.MeshBasicMaterial).dispose();
      scene.remove(ex.light);
      explosions.splice(i, 1);
    }
  }
}

// --- Enemies ---
type Enemy = {
  mesh: THREE.Mesh;
  speed: number;
  hp: number;
  maxHp: number;
  radius: number;
  scoreValue: number;
  hitFlash: number;
  baseEmissive: number;
};
const enemies: Enemy[] = [];

type EnemyTier = {
  geo: THREE.BufferGeometry;
  mat: THREE.MeshStandardMaterial;
  baseRadius: number;
  baseHeight: number;
  baseSpeed: number;
  baseHp: number;
  scoreValue: number;
};

const grunt: EnemyTier = {
  geo: new THREE.BoxGeometry(1, 1, 1),
  mat: new THREE.MeshStandardMaterial({ color: 0xff4466, emissive: 0x551122, emissiveIntensity: 0.5 }),
  baseRadius: 0.55, baseHeight: 1.1, baseSpeed: 5.0, baseHp: 1, scoreValue: 10,
};
const brute: EnemyTier = {
  geo: new THREE.BoxGeometry(1, 1, 1),
  mat: new THREE.MeshStandardMaterial({ color: 0xaa22cc, emissive: 0x441155, emissiveIntensity: 0.5 }),
  baseRadius: 0.9, baseHeight: 1.6, baseSpeed: 3.2, baseHp: 3, scoreValue: 25,
};
const titan: EnemyTier = {
  geo: new THREE.BoxGeometry(1, 1, 1),
  mat: new THREE.MeshStandardMaterial({ color: 0xff9922, emissive: 0x663300, emissiveIntensity: 0.6 }),
  baseRadius: 1.4, baseHeight: 2.2, baseSpeed: 2.4, baseHp: 8, scoreValue: 60,
};

// Spawn an enemy somewhere in the streamed-in band ahead of the player.
function spawnEnemyAhead() {
  // Ahead of player: more likely far ahead (so they appear out of fog).
  // Difficulty scales with maxDistance.
  const difficulty = maxDistance / 200; // 0 at start, 1 at 200m forward, etc.

  let x = 0, z = 0;
  let placed = false;
  for (let attempt = 0; attempt < 25; attempt++) {
    x = (Math.random() - 0.5) * (LANE_HALF * 2 - 4);
    // Mostly ahead (player moves toward -Z). Sometimes spawn beside player.
    const aheadBias = Math.random();
    const dz = aheadBias < 0.85
      ? -(20 + Math.random() * (STREAM_AHEAD - 20)) // 20..STREAM_AHEAD ahead
      : (Math.random() - 0.5) * 30;                  // beside, on either side
    z = playerGroup.position.z + dz;

    // Don't spawn on top of the player.
    if (Math.hypot(x - playerGroup.position.x, z - playerGroup.position.z) < 12) continue;

    let blocked = false;
    for (const o of obstacles) {
      if (Math.abs(o.z - z) > 5) continue;
      if (Math.hypot(x - o.x, z - o.z) < o.radius + 1.2) { blocked = true; break; }
    }
    if (!blocked) { placed = true; break; }
  }
  if (!placed) return;

  const r = Math.random();
  const titanChance = Math.min(0.05 + difficulty * 0.15, 0.25);
  const bruteChance = Math.min(0.2 + difficulty * 0.25, 0.5);
  let tier: EnemyTier;
  if (r < titanChance) tier = titan;
  else if (r < titanChance + bruteChance) tier = brute;
  else tier = grunt;

  const sizeMul = 0.85 + Math.random() * 0.4;
  const radius = tier.baseRadius * sizeMul;
  const height = tier.baseHeight * sizeMul;
  const hp = Math.max(1, Math.round(tier.baseHp * Math.pow(sizeMul, 3)));
  const speed = (tier.baseSpeed / sizeMul) + difficulty * 1.5;

  const mat = tier.mat.clone();
  const mesh = new THREE.Mesh(tier.geo, mat);
  mesh.scale.set(radius * 2, height, radius * 2);
  mesh.position.set(x, height / 2, z);
  mesh.castShadow = true;
  scene.add(mesh);
  enemies.push({
    mesh, speed, hp, maxHp: hp, radius,
    scoreValue: Math.round(tier.scoreValue * Math.pow(sizeMul, 2)),
    hitFlash: 0, baseEmissive: mat.emissiveIntensity,
  });
}

// Streaming maintenance: generate chunks in range; despawn obstacles/enemies far from player.
function streamWorld() {
  const pz = playerGroup.position.z;
  // Player moves in -Z; "ahead" means smaller (more negative) z values.
  // Symmetric keep-band so backing up regenerates terrain.
  const minZ = pz - STREAM_AHEAD;
  const maxZ = pz + STREAM_AHEAD;
  const minChunk = Math.floor(minZ / CHUNK_LEN);
  const maxChunk = Math.floor(maxZ / CHUNK_LEN);
  for (let c = minChunk; c <= maxChunk; c++) generateChunk(c);

  // Despawn obstacles outside the keep-band; forget their chunks so they regenerate
  // if the player returns.
  for (let i = obstacles.length - 1; i >= 0; i--) {
    const o = obstacles[i];
    if (o.z < minZ - CHUNK_LEN || o.z > maxZ + CHUNK_LEN) {
      despawnObstacle(o);
      generatedChunks.delete(Math.floor(o.z / CHUNK_LEN));
      obstacles.splice(i, 1);
    }
  }
  // Also forget any "empty" chunks that drifted out of range, so a future visit
  // re-rolls their contents (rather than leaving them permanently empty).
  for (const c of generatedChunks) {
    if (c < minChunk - 1 || c > maxChunk + 1) generatedChunks.delete(c);
  }

  // Despawn enemies far in any direction.
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (Math.abs(e.mesh.position.z - pz) > STREAM_AHEAD + 10) {
      scene.remove(e.mesh);
      (e.mesh.material as THREE.MeshStandardMaterial).dispose();
      enemies.splice(i, 1);
    }
  }

  // Despawn health pickups outside the keep-band (chunk regen will recreate them).
  for (let i = healthPickups.length - 1; i >= 0; i--) {
    const p = healthPickups[i];
    if (p.z < minZ - CHUNK_LEN || p.z > maxZ + CHUNK_LEN) {
      scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      generatedChunks.delete(Math.floor(p.z / CHUNK_LEN));
      healthPickups.splice(i, 1);
    }
  }
  // Despawn power pickups outside the keep-band.
  for (let i = powerPickups.length - 1; i >= 0; i--) {
    const p = powerPickups[i];
    if (p.z < minZ - CHUNK_LEN || p.z > maxZ + CHUNK_LEN) {
      scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      (p.mesh.material as THREE.MeshStandardMaterial).dispose();
      for (const child of p.mesh.children) {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          (child.material as THREE.MeshBasicMaterial).dispose();
        }
      }
      generatedChunks.delete(Math.floor(p.z / CHUNK_LEN));
      powerPickups.splice(i, 1);
    }
  }

  // Position ground/wall tiles symmetrically around the player so they're always
  // visible in front and behind, regardless of movement direction.
  // Tile k (k=0,1,...) is centered at: round(pz / TILE_LEN) * TILE_LEN + offset[k]
  const baseZ = Math.round(pz / TILE_LEN) * TILE_LEN;
  const offsets = [0, -TILE_LEN]; // one tile under player, one ahead
  // If player is moving forward (-Z) put the second tile ahead; if moving back, put it behind.
  // Simpler: place tiles symmetrically — one under, one in the direction away from baseZ.
  // We have 2 tiles, so just place them at baseZ and baseZ - TILE_LEN if player is ahead of base,
  // else baseZ and baseZ + TILE_LEN.
  const secondOffset = pz <= baseZ ? -TILE_LEN : TILE_LEN;
  offsets[1] = secondOffset;

  for (let i = 0; i < groundTiles.length; i++) {
    const t = groundTiles[i];
    t.centerZ = baseZ + offsets[i];
    t.ground.position.z = t.centerZ;
    t.grid.position.z = t.centerZ;
  }
  for (let i = 0; i < wallTiles.length; i++) {
    const w = wallTiles[i];
    w.centerZ = baseZ + offsets[i];
    w.left.position.z = w.centerZ;
    w.right.position.z = w.centerZ;
  }
}

const damageFlashEl = document.getElementById('damageFlash')!;
let damageFlashTimer = 0;

function damagePlayer(n: number) {
  if (gameOver) return;
  playerHP = Math.max(0, playerHP - n);
  playerHitFlash = 0.25;
  damageFlashTimer = 0.25;
  damageFlashEl.style.opacity = '1';
  if (playerHP <= 0) killPlayer();
}

function killPlayer() {
  if (gameOver) return;
  gameOver = true;
  overlayEl.innerHTML = `GAME OVER<br><span style="font-size:18px">Score: ${score} — Distance: ${Math.floor(maxDistance)}m<br>Press ENTER to restart</span>`;
  overlayEl.style.display = 'block';
}

function updatePlayerDamageVisuals(dt: number) {
  if (playerHitFlash > 0) {
    playerHitFlash -= dt;
    const t = Math.max(0, playerHitFlash / 0.25); // 1 -> 0
    bodyMat.emissiveIntensity = PLAYER_BASE_EMISSIVE + t * 3.0;
    bodyMat.emissive.setHex(0xff2233);
    bodyMat.color.setHex(0xff5577);
    if (playerHitFlash <= 0) {
      bodyMat.emissiveIntensity = PLAYER_BASE_EMISSIVE;
      bodyMat.emissive.setHex(0x114466);
      bodyMat.color.setHex(PLAYER_BASE_COLOR);
    }
  }
  if (damageFlashTimer > 0) {
    damageFlashTimer -= dt;
    if (damageFlashTimer <= 0) damageFlashEl.style.opacity = '0';
  }
}

function updateHealthPickups(dt: number) {
  for (let i = healthPickups.length - 1; i >= 0; i--) {
    const p = healthPickups[i];
    p.bobPhase += dt * 1.8;
    p.mesh.position.y = p.radius + 0.5 + Math.sin(p.bobPhase) * 0.15;
    p.mesh.rotation.y += dt * 0.8;

    const dx = p.x - playerGroup.position.x;
    const dz = p.z - playerGroup.position.z;
    if (dx * dx + dz * dz < (p.radius + playerRadius + 0.2) * (p.radius + playerRadius + 0.2)) {
      playerHP = Math.min(OVERHEAL_CAP, playerHP + p.heal);
      scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      healthPickups.splice(i, 1);
    }
  }

  // Overheal decays back down to MAX_HP at OVERHEAL_DECAY_PER_SEC, smoothed via
  // a sub-integer carry so HUD HP ticks down at the right rate.
  if (playerHP > MAX_HP) {
    overhealRemainder += OVERHEAL_DECAY_PER_SEC * dt;
    while (overhealRemainder >= 1 && playerHP > MAX_HP) {
      playerHP -= 1;
      overhealRemainder -= 1;
    }
    if (playerHP <= MAX_HP) overhealRemainder = 0;
  } else {
    overhealRemainder = 0;
  }
}

function updatePowerPickups(dt: number) {
  for (let i = powerPickups.length - 1; i >= 0; i--) {
    const p = powerPickups[i];
    p.bobPhase += dt * 1.6;
    p.mesh.position.y = p.radius + 0.6 + Math.sin(p.bobPhase) * 0.2;
    p.mesh.rotation.y += dt * 1.2;

    const dx = p.x - playerGroup.position.x;
    const dz = p.z - playerGroup.position.z;
    if (dx * dx + dz * dz < (p.radius + playerRadius + 0.2) * (p.radius + playerRadius + 0.2)) {
      currentPower = p.power;
      scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      (p.mesh.material as THREE.MeshStandardMaterial).dispose();
      // Dispose ring child too.
      for (const child of p.mesh.children) {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          (child.material as THREE.MeshBasicMaterial).dispose();
        }
      }
      powerPickups.splice(i, 1);
      updateHud();
    }
  }
}

function updateMist(dt: number) {
  // Speed grows with distance traveled.
  const speed = MIST_BASE_SPEED + Math.max(0, maxDistance) * MIST_RAMP_PER_METER;
  mistEdgeZ -= speed * dt; // forward = -Z

  // Snap up to player if it falls too far behind (mist always closes in).
  const minEdgeZ = playerGroup.position.z + MIST_MAX_DISTANCE;
  if (mistEdgeZ > minEdgeZ) mistEdgeZ = minEdgeZ;

  // Position visuals: leading edge of slabs at mistEdgeZ, extending toward +Z.
  mistGroup.position.z = mistEdgeZ;

  // Damage tick if player is inside the mist (i.e. behind its leading edge).
  if (playerGroup.position.z >= mistEdgeZ) {
    mistDamageTimer -= dt;
    if (mistDamageTimer <= 0) {
      mistDamageTimer = MIST_DAMAGE_INTERVAL;
      damagePlayer(1);
    }
  } else {
    // Tiny leak so first tick after entering doesn't take a full interval.
    mistDamageTimer = Math.min(mistDamageTimer + dt * 0.5, MIST_DAMAGE_INTERVAL);
  }
}

// --- Enemy spawn pacing ---
let spawnTimer = 0;
function updateEnemySpawning(dt: number) {
  spawnTimer -= dt;
  // Target population scales with distance traveled.
  const targetCount = Math.min(8 + Math.floor(maxDistance / 30), 30);
  if (spawnTimer <= 0 && enemies.length < targetCount) {
    spawnEnemyAhead();
    spawnTimer = Math.max(0.25, 1.2 - maxDistance / 400);
  }
}

// --- HUD ---
const hpEl = document.getElementById('hp')!;
const scoreEl = document.getElementById('score')!;
const distEl = document.getElementById('wave')!; // reuse existing element
const powerEl = document.getElementById('power')!;
const overlayEl = document.getElementById('overlay')!;
function updateHud() {
  hpEl.textContent = `HP: ${playerHP}`;
  scoreEl.textContent = `Score: ${score}`;
  distEl.textContent = `Distance: ${Math.floor(maxDistance)}m`;
  if (currentPower) {
    const info = POWER_INFO[currentPower];
    powerEl.textContent = `Power: ${info.label}`;
    powerEl.style.color = '#' + info.color.toString(16).padStart(6, '0');
    powerEl.style.display = 'block';
  } else {
    powerEl.style.display = 'none';
  }
}
updateHud();

// --- Restart ---
function restart() {
  for (const e of enemies) {
    scene.remove(e.mesh);
    (e.mesh.material as THREE.MeshStandardMaterial).dispose();
  }
  enemies.length = 0;
  for (const b of bullets) scene.remove(b.mesh);
  bullets.length = 0;
  for (const o of obstacles) despawnObstacle(o);
  obstacles.length = 0;
  for (const p of healthPickups) {
    scene.remove(p.mesh);
    p.mesh.geometry.dispose();
  }
  healthPickups.length = 0;
  for (const p of powerPickups) {
    scene.remove(p.mesh);
    p.mesh.geometry.dispose();
    (p.mesh.material as THREE.MeshStandardMaterial).dispose();
    for (const child of p.mesh.children) {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.MeshBasicMaterial).dispose();
      }
    }
  }
  powerPickups.length = 0;
  for (const lb of laserBeams) {
    scene.remove(lb.line);
    lb.line.geometry.dispose();
    lb.mat.dispose();
  }
  laserBeams.length = 0;
  currentPower = null;
  for (const g of grenades) scene.remove(g.mesh);
  grenades.length = 0;
  for (const ex of explosions) {
    scene.remove(ex.mesh);
    (ex.mesh.material as THREE.MeshBasicMaterial).dispose();
    scene.remove(ex.light);
  }
  explosions.length = 0;
  grenadeCooldown = 0;
  generatedChunks.clear();
  // New base seed per level — but chunks within the level remain reproducible.
  baseSeed = (Math.random() * 0xffffffff) >>> 0;

  playerGroup.position.set(0, 0, 0);
  playerHP = MAX_HP;
  overhealRemainder = 0;
  playerHitFlash = 0;
  damageFlashTimer = 0;
  damageFlashEl.style.opacity = '0';
  bodyMat.emissiveIntensity = PLAYER_BASE_EMISSIVE;
  bodyMat.emissive.setHex(0x114466);
  bodyMat.color.setHex(PLAYER_BASE_COLOR);
  score = 0;
  maxDistance = 0;
  gameOver = false;
  mistEdgeZ = MIST_INITIAL_OFFSET;
  mistDamageTimer = 0;
  overlayEl.style.display = 'none';
  streamWorld();
  updateHud();
}

// Initial world population
streamWorld();

// --- Camera (Diablo-style 3/4 isometric, follows player on X and Z) ---
const camOffset = new THREE.Vector3(0, 22, 18);
function updateCamera() {
  camera.position.copy(playerGroup.position).add(camOffset);
  camera.lookAt(playerGroup.position.x, 0, playerGroup.position.z);

  // Light follows player so shadows are always near them.
  sunLight.position.set(playerGroup.position.x + 20, 40, playerGroup.position.z + 20);
  sunLight.target.position.set(playerGroup.position.x, 0, playerGroup.position.z);
  sunLight.target.updateMatrixWorld();
}
updateCamera();

// --- Game loop ---
const clock = new THREE.Clock();

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

function resolveObstacles(pos: { x: number; z: number }, radius: number) {
  for (const o of obstacles) {
    const dx = pos.x - o.x;
    const dz = pos.z - o.z;
    const minDist = radius + o.radius;
    const distSq = dx * dx + dz * dz;
    if (distSq < minDist * minDist && distSq > 0.0001) {
      const dist = Math.sqrt(distSq);
      const push = (minDist - dist) / dist;
      pos.x += dx * push;
      pos.z += dz * push;
    }
  }
  return pos;
}

function bulletHitsObstacle(x: number, z: number) {
  for (const o of obstacles) {
    const dx = x - o.x;
    const dz = z - o.z;
    if (dx * dx + dz * dz < (o.radius + 0.18) * (o.radius + 0.18)) return true;
  }
  return false;
}

function animate() {
  requestAnimationFrame(animate);

  if (paused) {
    clock.getDelta();
    renderer.render(scene, camera);
    return;
  }

  const dt = Math.min(clock.getDelta(), 0.05);

  if (!gameOver) {
    // --- Movement
    const moveDir = new THREE.Vector3();
    if (keys['KeyW'] || keys['ArrowUp']) moveDir.z -= 1;
    if (keys['KeyS'] || keys['ArrowDown']) moveDir.z += 1;
    if (keys['KeyA'] || keys['ArrowLeft']) moveDir.x -= 1;
    if (keys['KeyD'] || keys['ArrowRight']) moveDir.x += 1;
    if (moveDir.lengthSq() > 0) moveDir.normalize();

    playerVel.x = moveDir.x * playerSpeed;
    playerVel.z = moveDir.z * playerSpeed;

    playerGroup.position.x += playerVel.x * dt;
    playerGroup.position.z += playerVel.z * dt;

    // Clamp X only; Z is unbounded.
    const limit = LANE_HALF - 1.2;
    playerGroup.position.x = clamp(playerGroup.position.x, -limit, limit);

    resolveObstacles(playerGroup.position, playerRadius);

    // Track furthest forward distance (player moves in -Z).
    const forward = -playerGroup.position.z;
    if (forward > maxDistance) maxDistance = forward;

    // --- Aim
    raycaster.setFromCamera(mouseNDC, camera);
    if (raycaster.ray.intersectPlane(groundPlane, aimWorld)) {
      const dx = aimWorld.x - playerGroup.position.x;
      const dz = aimWorld.z - playerGroup.position.z;
      const yaw = Math.atan2(dx, dz) + Math.PI;
      playerGroup.rotation.y = yaw;
    }

    // --- Shoot
    fireCooldown -= dt;
    if (mouseDown && fireCooldown <= 0) {
      fireWeapon();
      fireCooldown = currentPower === 'laserRay' ? 0.4
        : currentPower === 'powerShot' ? 0.25
        : fireInterval;
    }

    // --- Bullets
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      // Swirl: parametric path = start + forward·speed·t + perp·sin(ωt)·radius.
      if (b.swirl) {
        const sw = b.swirl;
        sw.t += dt;
        const px = -sw.fwdZ; // perpendicular in XZ
        const pz = sw.fwdX;
        const wobble = Math.sin(sw.t * sw.angularSpeed) * sw.radius;
        b.mesh.position.x = sw.startX + sw.fwdX * bulletSpeed * 0.5 * sw.t + px * wobble;
        b.mesh.position.z = sw.startZ + sw.fwdZ * bulletSpeed * 0.5 * sw.t + pz * wobble;
      } else {
        b.mesh.position.x += b.vel.x * dt;
        b.mesh.position.z += b.vel.z * dt;
      }
      b.life -= dt;

      let hit = false;
      for (let j = enemies.length - 1; j >= 0; j--) {
        const e = enemies[j];
        if (b.hitSet && b.hitSet.has(e)) continue;
        const dx = b.mesh.position.x - e.mesh.position.x;
        const dz = b.mesh.position.z - e.mesh.position.z;
        if (dx * dx + dz * dz < (e.radius + 0.18) * (e.radius + 0.18)) {
          e.hp -= b.damage;
          e.hitFlash = 0.12;
          if (b.pierce > 0 && b.hitSet) {
            b.hitSet.add(e);
            b.pierce -= 1;
          } else {
            hit = true;
          }
          if (e.hp <= 0) {
            scene.remove(e.mesh);
            (e.mesh.material as THREE.MeshStandardMaterial).dispose();
            enemies.splice(j, 1);
            score += e.scoreValue;
          }
          if (hit) break;
        }
      }

      if (!hit && bulletHitsObstacle(b.mesh.position.x, b.mesh.position.z)) hit = true;

      // X out-of-bounds (hit a side wall) or far behind player.
      const oobX = Math.abs(b.mesh.position.x) > LANE_HALF;
      const oobZ = Math.abs(b.mesh.position.z - playerGroup.position.z) > STREAM_AHEAD;
      if (hit || b.life <= 0 || oobX || oobZ) {
        scene.remove(b.mesh);
        bullets.splice(i, 1);
      }
    }

    // --- Enemies chase player
    for (const e of enemies) {
      const dx = playerGroup.position.x - e.mesh.position.x;
      const dz = playerGroup.position.z - e.mesh.position.z;
      const dist = Math.hypot(dx, dz) || 1;
      e.mesh.position.x += (dx / dist) * e.speed * dt;
      e.mesh.position.z += (dz / dist) * e.speed * dt;
      resolveObstacles(e.mesh.position, e.radius);
      e.mesh.rotation.y += dt * 2;

      if (e.hitFlash > 0) {
        e.hitFlash -= dt;
        const mat = e.mesh.material as THREE.MeshStandardMaterial;
        mat.emissiveIntensity = e.baseEmissive + (e.hitFlash > 0 ? 2.5 : 0);
        if (e.hitFlash <= 0) mat.emissiveIntensity = e.baseEmissive;
      }

      if (dist < e.radius + playerRadius) {
        e.mesh.position.x -= (dx / dist) * 2;
        e.mesh.position.z -= (dz / dist) * 2;
        damagePlayer(1);
        clearPower();
      }
    }

    streamWorld();
    updateMist(dt);
    updateHealthPickups(dt);
    updatePowerPickups(dt);
    updateGrenades(dt);
    updateLaserBeams(dt);
    updateEnemySpawning(dt);
    updatePlayerDamageVisuals(dt);

    updateHud();
    updateCamera();
  }

  renderer.render(scene, camera);
}

animate();

// --- Resize ---
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
