// Mapeo RA de Geonotas: dibujar líneas de control sobre la imagen de la cámara, calzada con el relieve.
// Se carga con import() solo al tocar 📷 RA (three.js pesa ~800 KB; el resto de la app no lo necesita).
// El motor es una COPIA del de GeoLente (app.js, 2026-11): sensores, suavizado 1€, relieve Terrarium con
// decodificador PNG propio, perfil de crestas y rayo hacia el DEM. Copia, no vínculo (mismo criterio que
// el trazador de planos): si se mejora allá, se trae a mano.
// Marco local: x = este, y = arriba, z = -norte (m, relativo al origen). La cámara mira hacia -z al norte.
import * as THREE from './three/three.module.min.js';
import { LineSegments2 } from './three/lines/LineSegments2.js';
import { LineSegmentsGeometry } from './three/lines/LineSegmentsGeometry.js';
import { LineMaterial } from './three/lines/LineMaterial.js';
import { Line2 } from './three/lines/Line2.js';
import { LineGeometry } from './three/lines/LineGeometry.js';

const R_TIERRA = 6371000, REFRACCION = 0.13, FOV_DEF = 68, OJO = 1.7;
const ALCANCE = 12000;   // relieve fino (z12, ~30 m): donde se dibuja
const LEJOS = 40000;     // relieve grueso (z10): solo para el perfil del horizonte
const DEM_CACHE = 'geonotas-dem';   // la misma caché de teselas que la Vista 3D: lo bajado sirve sin señal
const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

const leer = k => { try { return localStorage.getItem('geonotas:ra-' + k); } catch { return null; } };
const guardar = (k, v) => { try { localStorage.setItem('geonotas:ra-' + k, v); } catch { } };
const envolver = a => ((a % 360) + 540) % 360 - 180;
const fmtDist = m => m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 2 : 1).replace('.', ',') + ' km';
const h = (t, a = {}, ...c) => {
  const e = document.createElement(t);
  for (const k in a) { if (k === 'class') e.className = a[k]; else if (k.startsWith('on')) e.addEventListener(k.slice(2), a[k]); else if (a[k] != null && a[k] !== false) e.setAttribute(k, a[k]); }
  c.flat().forEach(x => e.append(x && x.nodeType ? x : document.createTextNode(x ?? '')));
  return e;
};

// ------------------------------------------------------------------ estado (un solo RA abierto a la vez)
let R = null;

// ------------------------------------------------------------------ proyección local
function setOrigen(lat, lon) {
  const f = lat * D2R;
  R.O = { lat, lon, mLat: 111132.92 - 559.82 * Math.cos(2 * f) + 1.175 * Math.cos(4 * f), mLon: 111412.84 * Math.cos(f) - 93.5 * Math.cos(3 * f) };
}
const aEN = (lon, lat) => [(lon - R.O.lon) * R.O.mLon, (lat - R.O.lat) * R.O.mLat];
const aLL = (e, n) => [R.O.lon + e / R.O.mLon, R.O.lat + n / R.O.mLat];

// ------------------------------------------------------------------ relieve (teselas Terrarium)
const lon2tx = (lon, z) => (lon + 180) / 360 * 2 ** z;
const lat2ty = (lat, z) => { const r = lat * D2R; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z; };
// Decodificador PNG mínimo (8 bits, RGB o RGBA). No se usa canvas.getImageData porque Brave (y otros
// navegadores con protección anti-huella) le suman ruido a los píxeles: en Terrarium ±1 en el rojo son ±256 m.
async function decodificarPNG(buf) {
  const dv = new DataView(buf), idat = [];
  let p = 8, w = 0, hh = 0, bd = 0, ct = 0;
  while (p + 8 <= buf.byteLength) {
    const len = dv.getUint32(p), tipo = String.fromCharCode(dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6), dv.getUint8(p + 7));
    if (tipo === 'IHDR') { w = dv.getUint32(p + 8); hh = dv.getUint32(p + 12); bd = dv.getUint8(p + 16); ct = dv.getUint8(p + 17); }
    else if (tipo === 'IDAT') idat.push(new Uint8Array(buf, p + 8, len));
    else if (tipo === 'IEND') break;
    p += 12 + len;
  }
  if (bd !== 8 || (ct !== 2 && ct !== 6)) throw new Error('PNG no soportado');
  const raw = new Uint8Array(await new Response(new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const bpp = ct === 6 ? 4 : 3, st = w * bpp, out = new Uint8Array(hh * st);
  for (let y = 0; y < hh; y++) {
    const f = raw[y * (st + 1)], src = y * (st + 1) + 1, o = y * st;
    for (let x = 0; x < st; x++) {
      const a = x >= bpp ? out[o + x - bpp] : 0, b = y ? out[o - st + x] : 0, c = x >= bpp && y ? out[o - st + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[o + x] = v & 255;
    }
  }
  return { w, h: hh, bpp, px: out };
}
async function teselaPNG(z, x, y) {
  const url = TERRARIUM.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  let cache = null;
  try { cache = await caches.open(DEM_CACHE); const hit = await cache.match(url); if (hit) return decodificarPNG(await hit.arrayBuffer()); } catch { }
  const r = await fetch(url, { mode: 'cors' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  if (cache) { try { await cache.put(url, r.clone()); } catch { } }
  return decodificarPNG(await r.arrayBuffer());
}
async function mosaico(z, Rad, avance) {
  const [lonW, latS] = aLL(-Rad, -Rad), [lonE, latN] = aLL(Rad, Rad);
  const x0 = Math.floor(lon2tx(lonW, z)), x1 = Math.floor(lon2tx(lonE, z));
  const y0 = Math.floor(lat2ty(latN, z)), y1 = Math.floor(lat2ty(latS, z));
  const nx = x1 - x0 + 1, ny = y1 - y0 + 1, W = nx * 256;
  const data = new Float32Array(nx * ny * 65536).fill(NaN);
  let fallidas = 0;
  const trabajos = [];
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) trabajos.push([tx, ty]);
  await Promise.all(trabajos.map(async ([tx, ty]) => {
    try {
      const png = await teselaPNG(z, tx, ty), px = png.px, bpp = png.bpp;
      const ox = (tx - x0) * 256, oy = (ty - y0) * 256;
      for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
        const k = (j * 256 + i) * bpp;
        data[(oy + j) * W + ox + i] = px[k] * 256 + px[k + 1] + px[k + 2] / 256 - 32768;
      }
    } catch { fallidas++; }
    avance?.();
  }));
  const pxm = 40075016.7 * Math.cos(R.O.lat * D2R) / 2 ** z / 256;
  return { z, x0, y0, nx, ny, data, fallidas, pxm, n: trabajos.length };
}
function contarTeselas(z, Rad) {
  const [a, b] = aLL(-Rad, -Rad), [c, d] = aLL(Rad, Rad);
  return (Math.floor(lon2tx(c, z)) - Math.floor(lon2tx(a, z)) + 1) * (Math.floor(lat2ty(b, z)) - Math.floor(lat2ty(d, z)) + 1);
}
function muestrear(M, lon, lat) {
  if (!M) return NaN;
  const W = M.nx * 256, H = M.ny * 256;
  const fx = lon2tx(lon, M.z) * 256 - M.x0 * 256 - 0.5, fy = lat2ty(lat, M.z) * 256 - M.y0 * 256 - 0.5;
  if (fx < 0 || fy < 0 || fx > W - 1.001 || fy > H - 1.001) return NaN;
  const i = fx | 0, j = fy | 0, u = fx - i, v = fy - j, d = M.data;
  const a = d[j * W + i], b = d[j * W + i + 1], c = d[(j + 1) * W + i], e = d[(j + 1) * W + i + 1];
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + e * u) * v;
}
// cota real (sin curvatura): primero el mosaico fino, fuera de él el grueso; null si no hay dato
function cota(lon, lat) {
  let v = muestrear(R.DEM, lon, lat);
  if (!Number.isFinite(v)) v = muestrear(R.DEM2, lon, lat);
  return Number.isFinite(v) ? v : null;
}
// altura en el marco local, con curvatura terrestre y refracción (lo que de verdad ve la cámara)
function hLocal(e, n) {
  const [lon, lat] = aLL(e, n);
  return (cota(lon, lat) ?? 0) - (1 - REFRACCION) * (e * e + n * n) / (2 * R_TIERRA);
}

// ------------------------------------------------------------------ escena
function fovVertical() {
  const v = R.video, sw = R.ov.clientWidth, sh = R.ov.clientHeight;
  const vw = v.videoWidth || 1080, vh = v.videoHeight || 1920;
  const esc = Math.max(sw / vw, sh / vh), dw = vw * esc, dh = vh * esc;
  const f = (Math.max(dw, dh) / 2) / Math.tan(R.fovLargo * D2R / 2);
  return 2 * Math.atan((sh / 2) / f) * R2D;
}
function ajustarTamano() {
  if (!R?.renderer) return;
  const w = R.ov.clientWidth, hh = R.ov.clientHeight;
  R.renderer.setSize(w, hh, false);
  R.camera.aspect = w / hh; R.camera.fov = fovVertical(); R.camera.updateProjectionMatrix();
  R.scene.traverse(o => o.material?.resolution?.set(w, hh));
}
// Malla de profundidad invisible: tapa las líneas que quedan detrás de un cerro. Sin los primeros
// 300 m: el DEM de 30 m bajo los pies taparía todo lo que se mira hacia abajo.
function construirProfundidad() {
  if (R.prof) { R.scene.remove(R.prof); R.prof.geometry.dispose(); }
  const N = 241, A = ALCANCE, paso = 2 * A / (N - 1), c = R.camera.position;
  const pos = new Float32Array(N * N * 3), idx = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    // 20 m bajo el DEM: la malla (100 m entre nodos) es más gruesa que las líneas, que siguen el DEM
    // cada 25 m; así solo las tapa un cerro de verdad, no una faceta de la malla
    const e = -A + i * paso, n = A - j * paso, k = (j * N + i) * 3;
    pos[k] = e; pos[k + 1] = hLocal(e, n) - 20; pos[k + 2] = -n;
  }
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
    const e = -A + (i + 0.5) * paso, n = A - (j + 0.5) * paso;
    if (!R.sinCamara && Math.hypot(e - c.x, n + c.z) < 300) continue;   // visible (sin cámara) va entera: es el paisaje
    const a = j * N + i; idx.push(a, a + N, a + 1, a + 1, a + N, a + N + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(idx);
  // Sin cámara (escritorio, simulación, permiso negado) la malla se ve, sombreada: es la única imagen
  // sobre la que alinear y dibujar. Con cámara solo escribe profundidad.
  let mat;
  if (R.sinCamara) {
    g.computeVertexNormals();
    mat = new THREE.MeshLambertMaterial({ color: 0x9a9283 });
    if (!R.luces) { R.luces = true; R.scene.add(new THREE.HemisphereLight(0xdfe8f0, 0x3a332a, 1.6)); const d = new THREE.DirectionalLight(0xffffff, 1.4); d.position.set(-1, 1.2, 0.6); R.scene.add(d); }
  } else mat = new THREE.MeshBasicMaterial({ colorWrite: false });
  R.prof = new THREE.Mesh(g, mat);
  R.prof.renderOrder = 0; R.prof.position.y = 0;
  R.scene.add(R.prof); R.profPos = c.clone();
  if (R.sinCamara && !R.lejosMesh) construirLejano();
}
// Sin cámara también se dibuja el relieve lejano (grueso, hasta 40 km): es lo que la línea de
// crestas recorre en el horizonte. Con hueco donde ya está la malla fina.
function construirLejano() {
  const N = 161, A = LEJOS, paso = 2 * A / (N - 1), pos = new Float32Array(N * N * 3), idx = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const e = -A + i * paso, n = A - j * paso, k = (j * N + i) * 3;
    pos[k] = e; pos[k + 1] = hLocal(e, n) - 3; pos[k + 2] = -n;
  }
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
    const e = -A + (i + 0.5) * paso, n = A - (j + 0.5) * paso;
    if (Math.abs(e) < ALCANCE * 0.97 && Math.abs(n) < ALCANCE * 0.97) continue;
    const a = j * N + i; idx.push(a, a + N, a + 1, a + 1, a + N, a + N + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  R.lejosMesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0x8f97a0 }));
  R.scene.add(R.lejosMesh);
}

// Perfil de crestas (como PeakVisor): es la referencia para calzar el dibujo con los cerros reales.
const MARGEN_OJO = 6;
async function calcularPerfil() {
  const tok = ++R.tokPerfil;
  const c = R.camera.position.clone(), L = LEJOS * 0.97, NCOL = 2400, cols = new Array(NCOL);
  const ds = []; for (let d = 200; d < L * 1.42; d += d < ALCANCE ? R.DEM.pxm * 0.9 : R.DEM2.pxm * 0.9) ds.push(d);
  const ojoY = c.y + MARGEN_OJO;
  for (let i0 = 0; i0 < NCOL; i0 += 120) {
    for (let i = i0; i < Math.min(NCOL, i0 + 120); i++) {
      const az = i / NCOL * 2 * Math.PI, se = Math.sin(az), co = Math.cos(az), pts = [];
      let maxT = -Infinity, vis = true, ult = null, cand = null, hondo = 0;
      // una cresta cuenta solo si lo que tapa queda al menos 25 m bajo la visual (evita lomitas y fondos de valle)
      const acepta = (cd, d) => cd && cd.d > 150 && hondo >= 25 && d > cd.d * 1.04;
      for (const d of ds) {
        const e = c.x + se * d, n = -c.z + co * d;
        if (Math.abs(e) > L || Math.abs(n) > L) break;
        const hh = hLocal(e, n), t = (hh - ojoY) / d;
        if (t >= maxT) {
          if (!vis && acepta(cand, d)) pts.push(cand);
          cand = null; maxT = t; vis = true; ult = { d, h: hh, e, n, t };
        } else {
          if (vis) { cand = ult; vis = false; hondo = 0; }
          hondo = Math.max(hondo, (maxT - t) * d);
        }
      }
      if (!vis && acepta(cand, Infinity)) { cand.cielo = true; pts.push(cand); }
      cols[i] = pts;
    }
    await new Promise(r => setTimeout(r, 0));
    if (!R || tok !== R.tokPerfil) return;
  }
  for (let i = 0; i < NCOL; i++) {
    const sig = cols[(i + 1) % NCOL];
    for (const p of cols[i]) {
      let mejor = null, md = 1e9;
      for (const q of sig) {
        if (q.prev) continue;
        const rd = Math.abs(q.d - p.d) / p.d, dt = Math.abs(q.t - p.t);
        if (rd < 0.09 && dt < 0.012 && rd + dt * 8 < md) { md = rd + dt * 8; mejor = q; }
      }
      if (mejor) { p.next = mejor; mejor.prev = p; }
    }
  }
  const pos = [], col = [], posC = [], colC = [];
  for (let i = 0; i < NCOL; i++) for (const p0 of cols[i]) {
    if (p0.prev || p0.hecho) continue;
    const cadena = [p0]; p0.hecho = true;
    let q = p0.next; while (q && !q.hecho) { q.hecho = true; cadena.push(q); q = q.next; }
    if (q === p0) cadena.push(p0);
    if (cadena.length < 7) continue;
    for (let k = 0; k < cadena.length - 1; k++) {
      const a = cadena[k], b2 = cadena[k + 1], cielo = a.cielo && b2.cielo;
      const b = cielo ? 1 : Math.max(0.45, 1 - a.d / (LEJOS * 1.3));
      (cielo ? posC : pos).push(a.e, a.h + 2, -a.n, b2.e, b2.h + 2, -b2.n);
      (cielo ? colC : col).push(b, b, b, b, b, b);
    }
  }
  if (R.perfil) { R.scene.remove(R.perfil); R.perfil.traverse(x => { x.geometry?.dispose(); x.material?.dispose(); }); }
  R.perfil = new THREE.Group();
  for (const [P, C, ancho] of [[pos, col, 1.6], [posC, colC, 2.6]]) {
    if (!P.length) continue;
    const g = new LineSegmentsGeometry(); g.setPositions(P); g.setColors(C);
    // borde oscuro bajo la línea blanca: se lee sobre cielo claro y sobre roca oscura
    const mb = new LineMaterial({ color: 0x0b1018, linewidth: ancho + 2.4, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false });
    const m = new LineMaterial({ vertexColors: true, linewidth: ancho, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
    for (const [mat, orden] of [[mb, 5], [m, 6]]) {
      mat.resolution.set(R.ov.clientWidth, R.ov.clientHeight);
      const l = new LineSegments2(g, mat); l.renderOrder = orden; R.perfil.add(l);
    }
  }
  R.scene.add(R.perfil);
}

// Una polilínea sobre el terreno (lat/lon) → puntos 3D cada ~25 m, colgados 4 m sobre el DEM
function trazaSobreTerreno(geom) {
  const out = [];
  for (let i = 0; i < geom.length; i++) {
    const [e, n] = aEN(geom[i][1], geom[i][0]);
    if (i) {
      const [e0, n0] = aEN(geom[i - 1][1], geom[i - 1][0]), d = Math.hypot(e - e0, n - n0), k = Math.max(1, Math.ceil(d / 25));
      for (let s = 1; s < k; s++) { const ee = e0 + (e - e0) * s / k, nn = n0 + (n - n0) * s / k; out.push(ee, hLocal(ee, nn) + 4, -nn); }
    }
    out.push(e, hLocal(e, n) + 4, -n);
  }
  return out;
}
function lineaThree(pos, color, ancho, orden) {
  const g = new LineGeometry(); g.setPositions(pos);
  const grp = new THREE.Group();
  const mb = new LineMaterial({ color: 0x0b1018, linewidth: ancho + 2.5, transparent: true, opacity: 0.5, depthWrite: false });
  const m = new LineMaterial({ color: new THREE.Color(color), linewidth: ancho, depthWrite: false });
  for (const [mat, o] of [[mb, orden], [m, orden + 1]]) {
    mat.resolution.set(R.ov.clientWidth, R.ov.clientHeight);
    const l = new Line2(g, mat); l.renderOrder = o; l.computeLineDistances(); grp.add(l);
  }
  return grp;
}
function pintarLineasProyecto() {
  if (R.grLineas) { R.scene.remove(R.grLineas); R.grLineas.traverse(x => { x.geometry?.dispose(); x.material?.dispose(); }); }
  R.grLineas = new THREE.Group();
  for (const ln of R.datos.lineas) {
    if (!ln.geom || ln.geom.length < 2) continue;
    const pos = trazaSobreTerreno(ln.geom); if (pos.length < 6) continue;
    R.grLineas.add(lineaThree(pos, ln.color || '#c0392b', 3, 2));
  }
  R.scene.add(R.grLineas);
}
function pintarDibujo() {
  if (R.grDibujo) { R.scene.remove(R.grDibujo); R.grDibujo.traverse(x => { x.geometry?.dispose(); x.material?.dispose(); }); R.grDibujo = null; }
  if (R.verts.length > 1) {
    R.grDibujo = lineaThree(trazaSobreTerreno(R.verts.map(v => [v.lat, v.lon])), '#facc15', 4, 3);
    R.scene.add(R.grDibujo);
  }
  // marcadores de vértice (HTML, como los puntos): color = confiabilidad
  R.capaV.textContent = '';
  R.verts.forEach(v => {
    const [e, n] = aEN(v.lon, v.lat);
    v._p = new THREE.Vector3(e, (v.z ?? hLocal(e, n)) - (1 - REFRACCION) * (e * e + n * n) / (2 * R_TIERRA) * (v.z != null ? 1 : 0) + 3, -n);
    v._el = h('div', { class: 'ra-v ' + (v.pt ? 'pt' : v.calidad) });
    R.capaV.append(v._el);
  });
  pintarPie();
}

// ------------------------------------------------------------------ rayo desde la pantalla hacia el terreno
function rayoTerreno(x, y) {
  const w = R.ov.clientWidth, hh = R.ov.clientHeight, c = R.camera.position;
  R.camera.updateMatrixWorld();   // unproject usa matrixWorld: sin esto vale la del último cuadro dibujado
  const dir = new THREE.Vector3(x / w * 2 - 1, 1 - y / hh * 2, 0.5).unproject(R.camera).sub(c).normalize();
  // Los primeros 150 m solo cuentan mirando claramente hacia abajo: el DEM de 30 m bajo los pies
  // (laderas, errores de metros) tapa la visual y todo toque caería a unos metros de uno.
  const cercaVale = dir.y < -0.12;
  let d = 20, prev = 0, hit = null, enterrado = false;
  while (d < LEJOS) {
    const p = c.clone().addScaledVector(dir, d);
    if (Math.abs(p.x) > LEJOS || Math.abs(p.z) > LEJOS) break;
    const bajo = hLocal(p.x, -p.z) > p.y;
    if (bajo && d < 150 && !cercaVale) { enterrado = true; prev = d; d += 10; continue; }
    if (bajo && enterrado) { hit = p; break; }   // a 150 m sigue bajo el terreno: es un cerro de verdad, justo enfrente
    enterrado = false;
    if (bajo) {
      let a = prev, b = d;
      for (let k = 0; k < 14; k++) { const m = (a + b) / 2, q = c.clone().addScaledVector(dir, m); if (hLocal(q.x, -q.z) > q.y) b = m; else a = m; }
      hit = c.clone().addScaledVector(dir, b); break;
    }
    prev = d; d += 8 + d * 0.008;
  }
  if (!hit) return null;
  const e = hit.x, n = -hit.z, [lon, lat] = aLL(e, n);
  // ángulo entre la visual y la ladera: una visual rasante (pocos grados) mueve el punto cientos de
  // metros con un error mínimo de orientación
  const s = 20, gx = (hLocal(e + s, n) - hLocal(e - s, n)) / (2 * s), gy = (hLocal(e, n + s) - hLocal(e, n - s)) / (2 * s);
  const nor = new THREE.Vector3(-gx, 1, gy).normalize();
  const rasante = Math.asin(Math.min(1, Math.abs(dir.dot(nor)))) * R2D;
  const dist = Math.hypot(e - c.x, n + c.z);
  const calidad = dist > 5000 || rasante < 6 ? 'malo' : dist > 2500 || rasante < 15 ? 'medio' : 'bueno';
  return { lat, lon, z: cota(lon, lat), dist: Math.round(dist), rasante: Math.round(rasante), calidad };
}

// ------------------------------------------------------------------ sensores (copiado de GeoLente)
const zee = new THREE.Vector3(0, 0, 1), eul = new THREE.Euler(), q0 = new THREE.Quaternion(), q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const yAx = new THREE.Vector3(0, 1, 0), xAx = new THREE.Vector3(1, 0, 0);
const _qa = new THREE.Quaternion(), _qy = new THREE.Quaternion(), _qp = new THREE.Quaternion();
function quatDispositivo(alpha, beta, gamma, orient, out) {
  eul.set(beta, alpha, -gamma, 'YXZ'); out.setFromEuler(eul); out.multiply(q1); out.multiply(q0.setFromAxisAngle(zee, -orient)); return out;
}
function rumboDe(q) { const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q); return Math.atan2(f.x, -f.z) * R2D; }
// S.qBase: orientación de los sensores ya corregida al norte verdadero (brújula iOS + declinación),
// SIN el ajuste del usuario. El ajuste (yaw/pitch) se aplica en cada cuadro encima, así sirve también
// con la imagen fija.
function onOrientacion(ev, absoluto) {
  const S = R?.S; if (!S || ev.alpha == null) return;
  if (!absoluto && S.absoluto && ev.webkitCompassHeading == null) return;
  const angReal = screen.orientation?.angle ?? window.orientation ?? 0;
  quatDispositivo(ev.alpha * D2R, ev.beta * D2R, ev.gamma * D2R, angReal * D2R, _qa);
  let extra = 0;
  if (ev.webkitCompassHeading != null) { // iOS: alpha es relativo; se corrige con la brújula (teléfono vertical)
    const acc = ev.webkitCompassAccuracy;
    if (ev.beta > 40 && ev.beta < 140 && !(acc < 0)) {
      const off = envolver(ev.webkitCompassHeading - rumboDe(_qa));
      S.iosN = (S.iosN || 0) + 1;
      const k = S.iosOff == null ? 1 : S.iosN < 40 ? 0.25 : acc > 25 ? 0.015 : 0.05;
      S.iosOff = S.iosOff == null ? off : S.iosOff + envolver(off - S.iosOff) * k;
    }
    extra = S.iosOff ?? 0; S.precision = acc; S.absoluto = true;
  } else if (absoluto) S.absoluto = true;
  _qy.setFromAxisAngle(yAx, -(extra + S.decl) * D2R);
  S.qObj.copy(_qy).multiply(_qa);
  if (!S.tiene) S.qDisp.copy(S.qObj);
  S.tiene = true;
}

// ------------------------------------------------------------------ bucle
const _qu = new THREE.Quaternion();
function bucle(t) {
  if (!R) return;
  R.raf = requestAnimationFrame(bucle);
  const S = R.S, dt = R.tPrev ? Math.min(t - R.tPrev, 100) / 1000 : 0; R.tPrev = t;
  if (S.tiene) {
    // suavizado por tiempo y adaptativo (filtro 1€): quieto filtra el temblor, al girar sigue al video
    if (!R.fija) { const dif = S.qDisp.angleTo(S.qObj) * R2D, k = dt ? 1 - Math.exp(-2 * Math.PI * (1 + 15 * dif) * dt) : 1; S.qDisp.slerp(S.qObj, k); }
    _qy.setFromAxisAngle(yAx, -R.ajuste.yaw * D2R); _qp.setFromAxisAngle(xAx, R.ajuste.pitch * D2R);
    R.camera.quaternion.copy(_qy).multiply(_qu.copy(S.qDisp)).multiply(_qp);
  } else {
    // sin sensores (o simulación): se apunta con el dedo; el ajuste es la propia vista
    R.camera.rotation.set(R.ajuste.pitch * D2R, -R.ajuste.yaw * D2R, 0, 'YXZ');
  }
  if (!R.listo) return;
  R.renderer.render(R.scene, R.camera);
  posicionarMarcas();
  if (t - (R.tHud || 0) > 200) { R.tHud = t; const r = (rumboDe(R.camera.quaternion) + 360) % 360; R.chipRumbo.textContent = '🧭 ' + Math.round(r) + '° ' + ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(r / 45) % 8]; }
}
const _v = new THREE.Vector3();
function proyectar(p) {
  R.camera.updateMatrixWorld();
  _v.copy(p).project(R.camera);
  if (_v.z > 1 || _v.z < -1) return null;
  return [(_v.x + 1) / 2 * R.ov.clientWidth, (1 - _v.y) / 2 * R.ov.clientHeight];
}
function posicionarMarcas() {
  for (const p of R.puntos) {
    const s = proyectar(p.pos);
    if (!s) { p.el.style.display = 'none'; p.scr = null; continue; }
    p.el.style.display = ''; p.el.style.transform = `translate(${s[0]}px,${s[1]}px)`; p.scr = s;
  }
  for (const v of R.verts) {
    if (!v._el) continue;
    const s = proyectar(v._p);
    if (!s) { v._el.style.display = 'none'; continue; }
    v._el.style.display = ''; v._el.style.transform = `translate(${s[0]}px,${s[1]}px)`;
  }
}

// ------------------------------------------------------------------ interfaz
const CSS = `
.ra-ov{position:fixed;inset:0;z-index:4050;background:#0b1016;overflow:hidden;color:#eef4ee;font:13px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;touch-action:none;-webkit-user-select:none;user-select:none}
.ra-ov video,.ra-ov .ra-foto{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.ra-ov .ra-gl{position:absolute;inset:0;width:100%;height:100%;display:block}
.ra-capa{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.ra-pt{position:absolute;left:0;top:0;will-change:transform}
.ra-pt i{position:absolute;left:-8px;top:-8px;width:16px;height:16px;border-radius:50%;background:#16a34a;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.6)}
.ra-pt span{position:absolute;left:12px;top:-9px;white-space:nowrap;font-size:12px;font-weight:600;text-shadow:0 1px 3px #000,0 0 2px #000}
.ra-v{position:absolute;left:-6px;top:-6px;width:12px;height:12px;border-radius:50%;border:2px solid #111;background:#fff;will-change:transform}
.ra-v.medio{background:#f59e0b}.ra-v.malo{background:#ef4444}
.ra-v.pt{left:-8px;top:-8px;width:16px;height:16px;background:#16a34a;border-color:#fff}
.ra-ov.ra-sincam{background:linear-gradient(#5d7da0,#b9c9d6 55%,#b9c9d6)}
.ra-top{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;gap:6px;padding:calc(8px + env(safe-area-inset-top)) 10px 14px;background:linear-gradient(rgba(0,0,0,.6),transparent)}
.ra-top b{font-size:15px;margin-right:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ra-chip{background:rgba(16,21,26,.78);border:1px solid #33404c;border-radius:99px;padding:5px 10px;font-size:12px;white-space:nowrap}
.ra-chip.aviso{border-color:#e8a33d;color:#ffd58a}
.ra-btn{min-height:44px;min-width:44px;border-radius:10px;border:1px solid #c9d2c9;background:#eef3ee;color:#13201a;font:600 13px system-ui,sans-serif;padding:8px 14px;cursor:pointer}
.ra-btn.sec{background:rgba(28,36,44,.92);color:#eef4ee;border-color:#3a4856}
.ra-btn.pri{background:#2f7d55;color:#fff;border-color:#2f7d55}
.ra-btn[disabled]{opacity:.4;pointer-events:none}
.ra-fija{position:absolute;top:calc(64px + env(safe-area-inset-top));left:50%;transform:translateX(-50%);background:#e8a33d;color:#1b1206;font-weight:700;border-radius:99px;padding:5px 12px;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.4)}
.ra-pie{position:absolute;left:8px;right:8px;bottom:calc(8px + env(safe-area-inset-bottom));background:rgba(16,21,26,.93);border:1px solid #33404c;border-radius:14px;padding:10px;display:flex;flex-direction:column;gap:8px;box-shadow:0 8px 24px rgba(0,0,0,.5)}
@media(min-width:760px){.ra-pie{left:50%;right:auto;transform:translateX(-50%);width:540px}}
.ra-seg{display:flex;background:#0f151b;border-radius:10px;padding:3px;gap:3px}
.ra-seg button{flex:1;min-height:40px;border:0;border-radius:8px;background:none;color:#9fb0c0;font:600 13px system-ui,sans-serif;cursor:pointer}
.ra-seg button.on{background:#eef3ee;color:#13201a}
.ra-txt{color:#9fb0c0;font-size:12.5px}
.ra-txt b{color:#fff}
.ra-fila{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.ra-fila .crece{flex:1 1 auto}
.ra-tam{display:flex;align-items:center;gap:4px;background:#0f151b;border-radius:10px;padding:2px}
.ra-tam span{min-width:64px;text-align:center;font-size:12px;color:#cfd8df}
.ra-carga{position:absolute;inset:0;z-index:3;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:rgba(11,16,22,.9);text-align:center;padding:24px;font-size:14px;line-height:1.5}
@media(max-width:480px){.ra-pie .ra-fila .ra-btn{flex:1 1 auto;padding:6px 8px}.ra-largo{display:none}}
`;

function construirUI() {
  if (!document.getElementById('ra-css')) document.head.append(h('style', { id: 'ra-css' }, CSS));
  R.video = h('video', { playsinline: '', muted: '', autoplay: '' }); R.video.muted = true;
  R.foto = h('canvas', { class: 'ra-foto' }); R.foto.style.display = 'none';
  R.canvas = h('canvas', { class: 'ra-gl' });
  R.capaP = h('div', { class: 'ra-capa' }); R.capaV = h('div', { class: 'ra-capa' });
  R.chipGps = h('span', { class: 'ra-chip' }, '📡 …');
  R.chipRumbo = h('span', { class: 'ra-chip' }, '🧭 …');
  R.avisoFija = h('div', { class: 'ra-fija' }, '📌 Imagen fija'); R.avisoFija.style.display = 'none';
  R.pie = h('div', { class: 'ra-pie' });
  R.carga = h('div', { class: 'ra-carga' }, h('div', {}, 'Abriendo la cámara…'));
  R.ov = h('div', { class: 'ra-ov', role: 'dialog', 'aria-label': 'Mapeo con realidad aumentada' },
    R.video, R.foto, R.canvas, R.capaP, R.capaV,
    h('div', { class: 'ra-top' }, h('b', {}, '📷 Mapeo RA'), R.chipGps, R.chipRumbo,
      h('button', { class: 'ra-btn sec', 'aria-label': 'Cerrar', onclick: () => cerrar() }, '✕')),
    R.avisoFija, R.pie, R.carga);
  document.body.append(R.ov);
  instalarGestos();
}
function msgCarga(t) { if (!R?.carga) return; if (t == null) { R.carga.remove(); R.carga = null; return; } R.carga.firstChild.textContent = t; }

function pintarPie() {
  if (!R?.pie) return;
  const p = R.pie; p.textContent = '';
  const seg = h('div', { class: 'ra-seg', role: 'tablist' },
    h('button', { class: R.modo === 'alinear' ? 'on' : '', role: 'tab', onclick: () => fijarModo('alinear') }, '1 · Alinear'),
    h('button', { class: R.modo === 'dibujar' ? 'on' : '', role: 'tab', onclick: () => fijarModo('dibujar') }, '2 · Dibujar'));
  p.append(seg);
  if (R.modo === 'alinear') {
    const x = Math.tan(FOV_DEF * D2R / 2) / Math.tan(R.fovLargo * D2R / 2);
    p.append(h('div', { class: 'ra-txt' }, 'Arrastra hasta que la ', h('b', {}, 'línea blanca'), ' calce con las crestas; − + ajusta la altura.'));
    p.append(h('div', { class: 'ra-fila' },
      h('div', { class: 'ra-tam' },
        h('button', { class: 'ra-btn sec', 'aria-label': 'Relieve más bajo', onclick: () => escalar(1 / 1.04) }, '−'),
        h('span', { title: 'Tamaño del relieve' }, '×' + x.toFixed(2).replace('.', ',')),
        h('button', { class: 'ra-btn sec', 'aria-label': 'Relieve más alto', onclick: () => escalar(1.04) }, '+')),
      h('button', { class: 'ra-btn sec', title: 'Volver al ajuste inicial', 'aria-label': 'Restablecer ajuste', onclick: restablecer }, '↺'),
      h('span', { class: 'crece' }),
      R.fija ? h('button', { class: 'ra-btn sec', onclick: soltar }, '▶ En vivo')
             : h('button', { class: 'ra-btn pri', onclick: fijar }, '📌 Fijar')));
  } else {
    const n = R.verts.length, ult = R.verts[n - 1];
    let largo = 0; for (let i = 1; i < n; i++) { const [a, b] = aEN(R.verts[i - 1].lon, R.verts[i - 1].lat), [c, d] = aEN(R.verts[i].lon, R.verts[i].lat); largo += Math.hypot(c - a, d - b); }
    const dudosos = R.verts.filter(v => !v.pt && v.calidad !== 'bueno').length;
    p.append(h('div', { class: 'ra-txt' }, n
      ? [h('b', {}, n + ' vértice' + (n > 1 ? 's' : '')), n > 1 ? ' · ' + fmtDist(largo) + ' en planta' : '',
         ult && !ult.pt ? ' · último a ' + fmtDist(ult.dist) : ult?.pt ? ' · en ' + ult.nombre : '',
         dudosos ? ' · ' + dudosos + ' poco confiable' + (dudosos > 1 ? 's' : '') : '']
      : 'Toca el cerro donde va cada vértice. Toca un punto verde para pasar exactamente por él.'));
    p.append(h('div', { class: 'ra-fila' },
      h('button', { class: 'ra-btn sec', 'aria-label': 'Deshacer', disabled: !n, onclick: deshacer }, '↶', h('span', { class: 'ra-largo' }, ' Deshacer')),
      h('button', { class: 'ra-btn sec', disabled: !n, onclick: descartar }, 'Descartar'),
      h('span', { class: 'crece' }),
      h('button', { class: 'ra-btn pri', disabled: n < 2, onclick: terminar }, '✓ Terminar')));
  }
}
function fijarModo(m) {
  if (m === R.modo) return;
  R.modo = m;
  if (m === 'dibujar' && !R.fija) fijar(); // con el teléfono en la mano el dedo tiembla: se dibuja sobre la imagen fija
  pintarPie();
}
function escalar(f) {
  const x = Math.max(0.5, Math.min(4, Math.tan(FOV_DEF * D2R / 2) / Math.tan(R.fovLargo * D2R / 2) * f));
  R.fovLargo = 2 * Math.atan(Math.tan(FOV_DEF * D2R / 2) / x) * R2D;
  guardar('fov', R.fovLargo.toFixed(2)); ajustarTamano(); pintarPie();
}
function restablecer() {
  R.fovLargo = FOV_DEF; R.ajuste.yaw = R.S.tiene ? 0 : R.ajuste.yaw; R.ajuste.pitch = 0;
  guardar('fov', FOV_DEF); guardar('yaw', 0); guardar('pitch', 0);
  ajustarTamano(); pintarPie();
}
// La imagen fija se copia a un canvas: video.pause() deja negro en algunos teléfonos
function fijar() {
  if (R.fija) return;
  const v = R.video, c = R.foto, w = R.ov.clientWidth, hh = R.ov.clientHeight;
  if (v.videoWidth) {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    c.width = Math.round(w * dpr); c.height = Math.round(hh * dpr);
    const esc = Math.max(c.width / v.videoWidth, c.height / v.videoHeight), dw = v.videoWidth * esc, dh = v.videoHeight * esc;
    c.getContext('2d').drawImage(v, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
    c.style.display = ''; v.pause();
  }
  R.fija = true; R.avisoFija.style.display = '';
  pintarPie();
}
function soltar() {
  if (!R.fija) return;
  R.fija = false; R.foto.style.display = 'none'; R.avisoFija.style.display = 'none';
  if (R.video.srcObject) R.video.play().catch(() => { });
  R.S.qDisp.copy(R.S.qObj);
  if (R.modo === 'dibujar' && !R.verts.length) R.modo = 'alinear';
  pintarPie();
}

function agregarVertice(x, y) {
  // ¿tocó un punto de control? (28 px de tolerancia, el dedo no es un puntero)
  let mejor = null, md = 28;
  for (const p of R.puntos) if (p.scr) { const d = Math.hypot(p.scr[0] - x, p.scr[1] - y); if (d < md) { md = d; mejor = p; } }
  let v;
  if (mejor) {
    if (R.verts.length && R.verts[R.verts.length - 1].pt === mejor.id) return;
    const c = R.camera.position, [e, n] = aEN(mejor.lon, mejor.lat);
    v = { lat: mejor.lat, lon: mejor.lon, z: mejor.cota ?? cota(mejor.lon, mejor.lat), pt: mejor.id, nombre: mejor.nombre, dist: Math.round(Math.hypot(e - c.x, n + c.z)), rasante: null, calidad: 'bueno' };
  } else {
    v = rayoTerreno(x, y);
    if (!v) { R.ctx.toast('Ahí no hay terreno: toca sobre un cerro'); return; }
  }
  R.verts.push(v);
  if (v.calidad === 'malo') R.ctx.toast('Visual rasante o lejana: ese vértice es poco confiable');
  pintarDibujo();
}
function deshacer() { R.verts.pop(); pintarDibujo(); }
function descartar() { if (R.verts.length > 1 && !confirm('¿Descartar la línea que estás dibujando?')) return; R.verts = []; pintarDibujo(); }
async function terminar() {
  if (R.verts.length < 2) return;
  const c = R.camera.position, [lon, lat] = aLL(c.x, -c.z);
  const ok = await R.ctx.terminar({
    verts: R.verts.map(v => ({ lat: v.lat, lon: v.lon, z: v.z, pt: v.pt || null, dist: v.dist, rasante: v.rasante, calidad: v.calidad })),
    estacion: { lat, lon, gps: R.gpsAcc ?? null },
    ajuste: { yaw: +R.ajuste.yaw.toFixed(2), pitch: +R.ajuste.pitch.toFixed(2), fov: +R.fovLargo.toFixed(2), brujula: R.S.tiene },
  });
  if (!R) return;
  if (ok) { R.verts = []; R.datos = await R.ctx.datos(); prepararPuntos(); pintarLineasProyecto(); pintarDibujo(); }
}

function instalarGestos() {
  const ov = R.ov; let arr = null, pinza = null;
  const enControl = e => e.target.closest('.ra-top, .ra-pie, .ra-carga');
  ov.addEventListener('pointerdown', e => {
    if (enControl(e) || pinza) return;
    arr = { x: e.clientX, y: e.clientY, t: performance.now(), yaw: R.ajuste.yaw, pitch: R.ajuste.pitch, mov: false };
    try { ov.setPointerCapture(e.pointerId); } catch { }
  });
  ov.addEventListener('pointermove', e => {
    if (!arr || pinza) return;
    const dx = e.clientX - arr.x, dy = e.clientY - arr.y;
    if (!arr.mov && Math.hypot(dx, dy) < 8) return;
    arr.mov = true;
    if (R.modo !== 'alinear') return;
    const gpp = R.camera.fov / R.ov.clientHeight; // grados por píxel
    R.ajuste.yaw = arr.yaw - dx * gpp; R.ajuste.pitch = Math.max(-45, Math.min(45, arr.pitch + (R.S.tiene ? -dy : dy) * gpp));
  });
  const fin = e => {
    if (!arr) return;
    const tap = !arr.mov && performance.now() - arr.t < 600;
    if (R.modo === 'alinear' && arr.mov) { guardar('yaw', R.ajuste.yaw.toFixed(2)); guardar('pitch', R.ajuste.pitch.toFixed(2)); }
    if (tap && R.modo === 'dibujar' && R.listo) { const r = R.ov.getBoundingClientRect(); agregarVertice(e.clientX - r.left, e.clientY - r.top); }
    arr = null;
  };
  ov.addEventListener('pointerup', fin);
  ov.addEventListener('pointercancel', () => { arr = null; });
  // pellizco = tamaño del relieve (solo alineando)
  ov.addEventListener('touchstart', e => { if (e.touches.length === 2 && R.modo === 'alinear') { arr = null; pinza = { d: Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY), f: R.fovLargo }; } }, { passive: true });
  ov.addEventListener('touchmove', e => {
    if (!pinza || e.touches.length !== 2) return;
    const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    R.fovLargo = Math.max(18, Math.min(110, pinza.f * pinza.d / d)); ajustarTamano();
  }, { passive: true });
  ov.addEventListener('touchend', e => { if (pinza && e.touches.length < 2) { pinza = null; guardar('fov', R.fovLargo.toFixed(2)); pintarPie(); } });
  R.onResize = () => ajustarTamano(); addEventListener('resize', R.onResize);
}

function prepararPuntos() {
  R.capaP.textContent = '';
  R.puntos = (R.datos.puntos || []).map(p => {
    const [e, n] = aEN(p.lon, p.lat);
    if (Math.hypot(e, n) > ALCANCE) return null;
    const z = p.cota ?? cota(p.lon, p.lat) ?? 0;
    const pos = new THREE.Vector3(e, z - (1 - REFRACCION) * (e * e + n * n) / (2 * R_TIERRA) + 2, -n);
    const el = h('div', { class: 'ra-pt' }, h('i'), h('span', {}, p.nombre || ''));
    R.capaP.append(el);
    return { ...p, pos, el, scr: null };
  }).filter(Boolean);
}

// ------------------------------------------------------------------ abrir / cerrar
function obtenerPosicion(precisa, espera) {
  return new Promise((ok, mal) => {
    if (!navigator.geolocation) return mal(new Error('Sin geolocalización'));
    navigator.geolocation.getCurrentPosition(p => ok(p.coords), mal, { enableHighAccuracy: precisa, timeout: espera, maximumAge: precisa ? 10000 : 300000 });
  });
}
async function iniciarCamara() {
  const st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
  const tr = st.getVideoTracks()[0];
  // algunos teléfonos abren con zoom digital: sin zoom el campo visual se parece más al supuesto
  try { const cap = tr.getCapabilities?.(); if (cap?.zoom && cap.zoom.min <= 1 && cap.zoom.max >= 1 && tr.getSettings().zoom !== 1) await tr.applyConstraints({ advanced: [{ zoom: 1 }] }); } catch { }
  R.video.srcObject = st; await R.video.play();
  R.video.addEventListener('loadedmetadata', ajustarTamano); R.video.addEventListener('resize', ajustarTamano);
}

// ctx: { toast, declinacion(lat,lon), datos() → {puntos:[{id,lat,lon,nombre,cota}], lineas:[{geom,color}]},
//        terminar(res) → Promise<boolean> (true = guardada), permisoOri: Promise|null, sim: {lat,lon,rumbo}|null, alCerrar() }
export async function abrir(ctx) {
  if (R) return;
  R = { ctx, modo: 'alinear', fija: false, verts: [], puntos: [], listo: false, tokPerfil: 0,
    fovLargo: +(leer('fov') || FOV_DEF), ajuste: { yaw: +(leer('yaw') || 0), pitch: +(leer('pitch') || 0) },
    S: { qDisp: new THREE.Quaternion(), qObj: new THREE.Quaternion(), tiene: false, absoluto: false, iosOff: null, precision: null, decl: 0 } };
  construirUI();
  pintarPie();
  const sim = ctx.sim;
  // 1) sensores: el permiso de iPhone ya se pidió dentro del toque (ctx.permisoOri)
  if (!sim) {
    try { if (ctx.permisoOri) await ctx.permisoOri; } catch { }
    R.onOriAbs = e => onOrientacion(e, true); R.onOri = e => onOrientacion(e, !!e.absolute);
    if ('ondeviceorientationabsolute' in window) addEventListener('deviceorientationabsolute', R.onOriAbs);
    addEventListener('deviceorientation', R.onOri);
  }
  // 2) cámara: no es fatal (sin cámara se dibuja sobre fondo oscuro y se apunta con el dedo)
  let sinCamara = !!sim;
  if (!sim) {
    try {
      if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('https');
      await iniciarCamara();
    } catch (e) { console.warn('RA cámara:', e); sinCamara = true; }
  }
  if (!R) return;
  // 3) posición
  let c = null;
  if (sim) c = { latitude: sim.lat, longitude: sim.lon, accuracy: 5 };
  else {
    msgCarga('Buscando tu ubicación…');
    try { c = await obtenerPosicion(true, 15000); }
    catch { try { msgCarga('El GPS tarda: probando una ubicación aproximada…'); c = await obtenerPosicion(false, 12000); } catch { } }
  }
  if (!R) return;
  if (!c) { ctx.toast('Sin ubicación: la RA necesita el GPS'); cerrar(); return; }
  R.gpsAcc = c.accuracy;
  R.chipGps.textContent = '📡 ±' + Math.round(c.accuracy) + ' m';
  R.chipGps.classList.toggle('aviso', c.accuracy > 30);
  setOrigen(c.latitude, c.longitude);
  try { R.S.decl = ctx.declinacion(c.latitude, c.longitude) || 0; } catch { R.S.decl = 0; }
  // 4) relieve
  const total = contarTeselas(12, ALCANCE * 1.05) + contarTeselas(10, LEJOS * 1.02);
  let hechas = 0; const avance = () => msgCarga('Cargando el relieve… ' + Math.round(++hechas / total * 100) + ' %');
  msgCarga('Cargando el relieve…');
  const [cerca, lejos] = await Promise.all([mosaico(12, ALCANCE * 1.05, avance), mosaico(10, LEJOS * 1.02, avance)]);
  if (!R) return;
  R.DEM = cerca; R.DEM2 = lejos;
  if (cerca.fallidas === cerca.n) { ctx.toast('No se pudo bajar el relieve (¿sin señal?). Ábrelo una vez con conexión en esta zona.'); cerrar(); return; }
  if (cerca.fallidas + lejos.fallidas) ctx.toast('Faltaron ' + (cerca.fallidas + lejos.fallidas) + ' teselas de relieve: puede haber zonas planas falsas');
  // 5) escena
  R.sinCamara = sinCamara;
  if (sinCamara) R.ov.classList.add('ra-sincam');
  R.renderer = new THREE.WebGLRenderer({ canvas: R.canvas, antialias: true, alpha: true });
  R.renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); R.renderer.setClearColor(0x000000, 0);
  R.scene = new THREE.Scene();
  R.camera = new THREE.PerspectiveCamera(60, 1, 5, LEJOS * 1.5); R.camera.rotation.order = 'YXZ';
  R.camera.position.set(0, hLocal(0, 0) + OJO, 0);
  if (sim) R.ajuste = { yaw: sim.rumbo || 0, pitch: 0 };
  ajustarTamano();
  construirProfundidad();
  R.datos = await ctx.datos();
  if (!R) return;
  prepararPuntos(); pintarLineasProyecto();
  R.listo = true; msgCarga(null);
  R.raf = requestAnimationFrame(bucle);
  calcularPerfil();
  if (sinCamara && !sim) ctx.toast('Sin cámara: se dibuja sobre fondo oscuro. La cámara necesita https y permiso.');
  // 6) GPS en vivo: la estación sigue al geólogo mientras la imagen no esté fija
  if (!sim && navigator.geolocation) R.gpsWatch = navigator.geolocation.watchPosition(p => {
    if (!R?.listo) return;
    R.gpsAcc = p.coords.accuracy;
    R.chipGps.textContent = '📡 ±' + Math.round(p.coords.accuracy) + ' m'; R.chipGps.classList.toggle('aviso', p.coords.accuracy > 30);
    if (R.fija) return; // la imagen fija corresponde al lugar donde se tomó
    const [e, n] = aEN(p.coords.longitude, p.coords.latitude);
    if (Math.hypot(e, n) > ALCANCE * 0.6) { ctx.toast('Te alejaste del relieve cargado: cierra y vuelve a abrir la RA'); return; }
    if (Math.hypot(e - R.camera.position.x, n + R.camera.position.z) > 25) {
      R.camera.position.set(e, hLocal(e, n) + OJO, -n);
      if (R.camera.position.distanceTo(R.profPos) > 150) construirProfundidad();
      calcularPerfil();
    }
  }, () => { }, { enableHighAccuracy: true, maximumAge: 5000 });
  setTimeout(() => { if (R?.listo && !sim && !R.S.tiene) { ctx.toast('El navegador no entrega la brújula: apunta arrastrando con el dedo'); pintarPie(); } }, 3500);
}

export function cerrar() {
  if (!R) return;
  if (R.verts.length > 1 && !confirm('Hay una línea sin terminar. ¿Salir igual?')) return;
  const r = R; R = null;
  cancelAnimationFrame(r.raf);
  if (r.gpsWatch != null) navigator.geolocation.clearWatch(r.gpsWatch);
  if (r.onOriAbs) removeEventListener('deviceorientationabsolute', r.onOriAbs);
  if (r.onOri) removeEventListener('deviceorientation', r.onOri);
  if (r.onResize) removeEventListener('resize', r.onResize);
  r.video.srcObject?.getTracks().forEach(t => t.stop());
  try { r.scene?.traverse(x => { x.geometry?.dispose(); x.material?.dispose(); }); r.renderer?.dispose(); } catch { }
  r.ov.remove();
  r.ctx.alCerrar?.();
}
export const abierto = () => !!R;
// solo para pruebas (smoke / consola): estado interno y el rayo, sin tocar la interfaz
export const _prueba = () => R && { verts: R.verts, modo: R.modo, fija: R.fija, ajuste: R.ajuste, perfil: R.perfil?.children.length || 0,
  rayo: (x, y) => rayoTerreno(x, y), tocar: (x, y) => agregarVertice(x, y) };
