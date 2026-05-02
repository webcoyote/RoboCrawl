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
sunLight.position.set(20, 40, 20);
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

// --- Arena ---
const ARENA = 50; // half-extent of square arena

const groundGeo = new THREE.PlaneGeometry(ARENA * 2, ARENA * 2, 20, 20);
const groundMat = new THREE.MeshStandardMaterial({ color: 0x2a3340 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// Grid overlay for tron-y vibe
const grid = new THREE.GridHelper(ARENA * 2, 40, 0x44ddff, 0x224466);
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material).opacity = 0.35;
grid.position.y = 0.01;
scene.add(grid);

// Walls around arena
const wallMat = new THREE.MeshStandardMaterial({ color: 0x44ddff, emissive: 0x2288aa, emissiveIntensity: 0.4 });
const wallHeight = 1.5;
const wallThickness = 1;
function addWall(x: number, z: number, w: number, d: number) {
  const geo = new THREE.BoxGeometry(w, wallHeight, d);
  const wall = new THREE.Mesh(geo, wallMat);
  wall.position.set(x, wallHeight / 2, z);
  wall.castShadow = true;
  wall.receiveShadow = true;
  scene.add(wall);
}
addWall(0, -ARENA, ARENA * 2 + wallThickness, wallThickness);
addWall(0, ARENA, ARENA * 2 + wallThickness, wallThickness);
addWall(-ARENA, 0, wallThickness, ARENA * 2 + wallThickness);
addWall(ARENA, 0, wallThickness, ARENA * 2 + wallThickness);

// --- Terrain features ---
// Solid obstacles that block player movement and bullets.
type Obstacle = { x: number; z: number; radius: number };
const obstacles: Obstacle[] = [];

const rockMat = new THREE.MeshStandardMaterial({ color: 0x4a5566, roughness: 0.9 });
const crystalMat = new THREE.MeshStandardMaterial({
  color: 0x66ffcc, emissive: 0x118866, emissiveIntensity: 0.7, roughness: 0.2,
});
const pylonMat = new THREE.MeshStandardMaterial({
  color: 0xff66aa, emissive: 0x661133, emissiveIntensity: 0.6,
});

function tryPlace(radius: number, minDistFromCenter: number): { x: number; z: number } | null {
  for (let attempt = 0; attempt < 30; attempt++) {
    const x = (Math.random() - 0.5) * (ARENA * 2 - 6);
    const z = (Math.random() - 0.5) * (ARENA * 2 - 6);
    if (Math.hypot(x, z) < minDistFromCenter) continue;
    let collides = false;
    for (const o of obstacles) {
      if (Math.hypot(x - o.x, z - o.z) < radius + o.radius + 1) { collides = true; break; }
    }
    if (!collides) return { x, z };
  }
  return null;
}

function spawnRock() {
  const radius = 0.9 + Math.random() * 0.8;
  const pos = tryPlace(radius, 6);
  if (!pos) return;
  const geo = new THREE.DodecahedronGeometry(radius, 0);
  const mesh = new THREE.Mesh(geo, rockMat);
  mesh.position.set(pos.x, radius * 0.6, pos.z);
  mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  obstacles.push({ x: pos.x, z: pos.z, radius: radius * 0.85 });
}

function spawnCrystal() {
  const radius = 0.5 + Math.random() * 0.4;
  const pos = tryPlace(radius, 6);
  if (!pos) return;
  const height = 1.8 + Math.random() * 1.2;
  const geo = new THREE.ConeGeometry(radius, height, 6);
  const mesh = new THREE.Mesh(geo, crystalMat);
  mesh.position.set(pos.x, height / 2, pos.z);
  mesh.rotation.y = Math.random() * Math.PI;
  mesh.castShadow = true;
  scene.add(mesh);
  obstacles.push({ x: pos.x, z: pos.z, radius: radius * 0.85 });
}

function spawnPylon() {
  const radius = 0.45;
  const pos = tryPlace(radius, 8);
  if (!pos) return;
  const height = 3.2;
  const geo = new THREE.CylinderGeometry(radius, radius * 1.3, height, 6);
  const mesh = new THREE.Mesh(geo, pylonMat);
  mesh.position.set(pos.x, height / 2, pos.z);
  mesh.castShadow = true;
  scene.add(mesh);
  // Glow cap
  const capGeo = new THREE.SphereGeometry(radius * 0.9, 12, 8);
  const cap = new THREE.Mesh(capGeo, crystalMat);
  cap.position.set(pos.x, height + 0.1, pos.z);
  scene.add(cap);
  obstacles.push({ x: pos.x, z: pos.z, radius: radius * 1.3 });
}

for (let i = 0; i < 12; i++) spawnRock();
for (let i = 0; i < 10; i++) spawnCrystal();
for (let i = 0; i < 6; i++) spawnPylon();

// --- Player ---
const playerRadius = 0.5;
const playerGroup = new THREE.Group();

const bodyGeo = new THREE.CapsuleGeometry(0.4, 0.9, 8, 16);
const bodyMat = new THREE.MeshStandardMaterial({ color: 0x33aaff, emissive: 0x114466, emissiveIntensity: 0.4 });
const body = new THREE.Mesh(bodyGeo, bodyMat);
body.castShadow = true;
body.position.y = 0.85;
playerGroup.add(body);

// Gun barrel (points along -Z by default within the group, we rotate the group to aim)
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
let playerHP = 5;
let score = 0;
let wave = 1;
let gameOver = false;
let paused = false;

// --- Input ---
const keys: Record<string, boolean> = {};
window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (gameOver && e.code === 'Enter') restart();
  else if (e.code === 'Escape' && !gameOver) togglePause();
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

// Mouse aim — track world-space cursor position projected onto the ground plane
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
type Bullet = { mesh: THREE.Mesh; vel: THREE.Vector3; life: number };
const bullets: Bullet[] = [];
const bulletGeo = new THREE.SphereGeometry(0.18, 8, 8);
const bulletMat = new THREE.MeshStandardMaterial({ color: 0xffee66, emissive: 0xffaa00, emissiveIntensity: 1.2 });
const bulletSpeed = 40;
const bulletLife = 1.5;
const fireInterval = 0.12;
let fireCooldown = 0;

function fireBullet(from: THREE.Vector3, dir: THREE.Vector3) {
  const mesh = new THREE.Mesh(bulletGeo, bulletMat);
  mesh.position.copy(from);
  mesh.position.y = 0.9;
  mesh.castShadow = true;
  scene.add(mesh);
  bullets.push({
    mesh,
    vel: dir.clone().setY(0).normalize().multiplyScalar(bulletSpeed),
    life: bulletLife,
  });
}

// --- Enemies ---
type Enemy = {
  mesh: THREE.Mesh;
  speed: number;
  hp: number;
  radius: number;
};
const enemies: Enemy[] = [];

const grunt = {
  geo: new THREE.BoxGeometry(0.9, 1.1, 0.9),
  mat: new THREE.MeshStandardMaterial({ color: 0xff4466, emissive: 0x551122, emissiveIntensity: 0.5 }),
};
const brute = {
  geo: new THREE.BoxGeometry(1.4, 1.6, 1.4),
  mat: new THREE.MeshStandardMaterial({ color: 0xaa22cc, emissive: 0x441155, emissiveIntensity: 0.5 }),
};

function spawnEnemyAtEdge() {
  // Choose random edge spawn outside player vicinity and not inside an obstacle.
  let x = 0, z = 0;
  for (let attempt = 0; attempt < 30; attempt++) {
    const side = Math.floor(Math.random() * 4);
    const t = (Math.random() - 0.5) * (ARENA * 2 - 4);
    if (side === 0) { x = t; z = -ARENA + 2; }
    else if (side === 1) { x = t; z = ARENA - 2; }
    else if (side === 2) { x = -ARENA + 2; z = t; }
    else { x = ARENA - 2; z = t; }
    if (Math.hypot(x - playerGroup.position.x, z - playerGroup.position.z) < 12) continue;
    let blocked = false;
    for (const o of obstacles) {
      if (Math.hypot(x - o.x, z - o.z) < o.radius + 1.2) { blocked = true; break; }
    }
    if (!blocked) break;
  }

  const isBrute = Math.random() < Math.min(0.15 + wave * 0.04, 0.5);
  const def = isBrute ? brute : grunt;
  const mesh = new THREE.Mesh(def.geo, def.mat);
  mesh.position.set(x, isBrute ? 0.8 : 0.55, z);
  mesh.castShadow = true;
  scene.add(mesh);
  enemies.push({
    mesh,
    speed: isBrute ? 3.2 + wave * 0.1 : 5.0 + wave * 0.15,
    hp: isBrute ? 3 : 1,
    radius: isBrute ? 0.9 : 0.55,
  });
}

function startWave() {
  const count = 6 + wave * 2;
  for (let i = 0; i < count; i++) spawnEnemyAtEdge();
}
startWave();

// --- HUD ---
const hpEl = document.getElementById('hp')!;
const scoreEl = document.getElementById('score')!;
const waveEl = document.getElementById('wave')!;
const overlayEl = document.getElementById('overlay')!;
function updateHud() {
  hpEl.textContent = `HP: ${playerHP}`;
  scoreEl.textContent = `Score: ${score}`;
  waveEl.textContent = `Wave: ${wave}`;
}
updateHud();

// --- Restart ---
function restart() {
  for (const e of enemies) scene.remove(e.mesh);
  enemies.length = 0;
  for (const b of bullets) scene.remove(b.mesh);
  bullets.length = 0;
  playerGroup.position.set(0, 0, 0);
  playerHP = 5;
  score = 0;
  wave = 1;
  gameOver = false;
  overlayEl.style.display = 'none';
  startWave();
  updateHud();
}

// --- Camera (Diablo-style 3/4 isometric) ---
const camOffset = new THREE.Vector3(0, 22, 18); // pitched-down view
function updateCamera() {
  camera.position.copy(playerGroup.position).add(camOffset);
  camera.lookAt(playerGroup.position.x, 0, playerGroup.position.z);
}
updateCamera();

// --- Game loop ---
const clock = new THREE.Clock();

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

// Push a circle out of any overlapping obstacles. Mutates pos.
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
    clock.getDelta(); // drain so we don't accumulate while paused
    renderer.render(scene, camera);
    return;
  }

  const dt = Math.min(clock.getDelta(), 0.05);

  if (!gameOver) {
    // --- Movement (camera-relative; in our top-down view that's just X/Z)
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

    const limit = ARENA - 1.2;
    playerGroup.position.x = clamp(playerGroup.position.x, -limit, limit);
    playerGroup.position.z = clamp(playerGroup.position.z, -limit, limit);

    resolveObstacles(playerGroup.position, playerRadius);

    // --- Aim: project mouse onto ground plane
    raycaster.setFromCamera(mouseNDC, camera);
    if (raycaster.ray.intersectPlane(groundPlane, aimWorld)) {
      const dx = aimWorld.x - playerGroup.position.x;
      const dz = aimWorld.z - playerGroup.position.z;
      const yaw = Math.atan2(dx, dz) + Math.PI; // gun points along -Z within group
      playerGroup.rotation.y = yaw;
    }

    // --- Shoot
    fireCooldown -= dt;
    if (mouseDown && fireCooldown <= 0) {
      const dir = new THREE.Vector3(aimWorld.x - playerGroup.position.x, 0, aimWorld.z - playerGroup.position.z);
      if (dir.lengthSq() > 0.001) {
        // Spawn at gun tip
        const muzzle = new THREE.Vector3(0, 0.95, -1.0).applyEuler(playerGroup.rotation).add(playerGroup.position);
        fireBullet(muzzle, dir);
        fireCooldown = fireInterval;
      }
    }

    // --- Bullets
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      b.mesh.position.x += b.vel.x * dt;
      b.mesh.position.z += b.vel.z * dt;
      b.life -= dt;

      let hit = false;
      // collide with enemies
      for (let j = enemies.length - 1; j >= 0; j--) {
        const e = enemies[j];
        const dx = b.mesh.position.x - e.mesh.position.x;
        const dz = b.mesh.position.z - e.mesh.position.z;
        if (dx * dx + dz * dz < (e.radius + 0.18) * (e.radius + 0.18)) {
          e.hp -= 1;
          hit = true;
          if (e.hp <= 0) {
            scene.remove(e.mesh);
            enemies.splice(j, 1);
            score += 10;
          }
          break;
        }
      }

      if (!hit && bulletHitsObstacle(b.mesh.position.x, b.mesh.position.z)) hit = true;

      const oob = Math.abs(b.mesh.position.x) > ARENA || Math.abs(b.mesh.position.z) > ARENA;
      if (hit || b.life <= 0 || oob) {
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

      // Touch damage
      if (dist < e.radius + playerRadius) {
        playerHP -= 1;
        // knock the enemy back so it doesn't drain HP every frame
        e.mesh.position.x -= (dx / dist) * 2;
        e.mesh.position.z -= (dz / dist) * 2;
        if (playerHP <= 0) {
          gameOver = true;
          overlayEl.innerHTML = `GAME OVER<br><span style="font-size:18px">Score: ${score} — Wave ${wave}<br>Press ENTER to restart</span>`;
          overlayEl.style.display = 'block';
        }
      }
    }

    // --- Wave progression
    if (enemies.length === 0) {
      wave += 1;
      startWave();
    }

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
