/* 3D view (three.js, ui/vendor/three): STL, OBJ, GLB / GLTF, PLY and 3MF. Rotate with the left mouse button, move
   with the right one, zoom with the wheel; views front / top / side / 3D; wireframe; measurements (size, volume,
   surface, triangles) for 3D printing; a PNG of the view. Draws only when something changes (no busy loop).
   window.View3D.open(box, url, ext, {background, onError}) → Promise<view> with
   view.stats, view.setWire(on), view.setView(name), view.setBackground(css), view.png() → Promise<Blob>, view.dispose() */
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {STLLoader} from 'three/addons/loaders/STLLoader.js';
import {OBJLoader} from 'three/addons/loaders/OBJLoader.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {PLYLoader} from 'three/addons/loaders/PLYLoader.js';
import {ThreeMFLoader} from 'three/addons/loaders/3MFLoader.js';

const MODEL_COLOR = 0x8b9dc3;

async function load(url, ext) {
  const solid = geo => {
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({color: MODEL_COLOR, roughness: .55, metalness: .05, vertexColors: !!geo.getAttribute('color'), side: THREE.DoubleSide});
    return new THREE.Mesh(geo, mat);
  };
  if (ext === 'glb' || ext === 'gltf') return (await new GLTFLoader().loadAsync(url)).scene;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (ext === 'obj') {
    const obj = new OBJLoader().parse(await res.text());
    obj.traverse(o => { if (o.isMesh && (!o.material || o.material.type === 'MeshPhongMaterial')) o.material = new THREE.MeshStandardMaterial({color: MODEL_COLOR, roughness: .55, side: THREE.DoubleSide}); });
    return obj;
  }
  const buf = await res.arrayBuffer();
  if (ext === 'stl') return solid(new STLLoader().parse(buf));
  if (ext === 'ply') return solid(new PLYLoader().parse(buf));
  if (ext === '3mf') {
    const g = new ThreeMFLoader().parse(buf);
    g.traverse(o => { if (o.isMesh) { o.material.side = THREE.DoubleSide; } });
    return g;
  }
  throw new Error('format ' + ext);
}

/* Size, volume (closed surfaces; signed tetrahedra), surface and triangles, in the model's own units. */
function measure(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root), size = box.getSize(new THREE.Vector3());
  let volume = 0, area = 0, tris = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3();
  root.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    const pos = o.geometry.getAttribute('position'), idx = o.geometry.getIndex(), m = o.matrixWorld;
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i + 2 < n; i += 3) {
      const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(m); b.fromBufferAttribute(pos, i1).applyMatrix4(m); c.fromBufferAttribute(pos, i2).applyMatrix4(m);
      volume += a.dot(ab.copy(b).cross(c)) / 6;
      area += ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() / 2;
      tris++;
    }
  });
  return {x: size.x, y: size.z, z: size.y, volume: Math.abs(volume), area, triangles: tris};
}

async function open(box, url, ext, opts = {}) {
  const renderer = new THREE.WebGLRenderer({antialias: true, preserveDrawingBuffer: true});
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  box.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x666677, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(1, 2, 1.5); scene.add(sun);
  const back = new THREE.DirectionalLight(0xffffff, .5); back.position.set(-1.5, .5, -1); scene.add(back);
  const camera = new THREE.PerspectiveCamera(40, 1, .01, 1e6);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  let frame = 0;
  const render = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => renderer.render(scene, camera)); };
  controls.addEventListener('change', render);
  const setBackground = css => { scene.background = new THREE.Color(css || '#2a2a2a'); render(); };
  setBackground(opts.background);

  const model = await load(url, ext);
  // 3D-printing files are "Z up": stand them upright (three.js is "Y up").
  if (ext === 'stl' || ext === '3mf') model.rotation.x = -Math.PI / 2;
  const holder = new THREE.Group(); holder.add(model); scene.add(holder);
  holder.updateMatrixWorld(true);
  // On the floor, centred.
  const bb = new THREE.Box3().setFromObject(holder), center = bb.getCenter(new THREE.Vector3());
  model.position.sub(new THREE.Vector3(center.x, bb.min.y, center.z));
  holder.updateMatrixWorld(true);
  const stats = measure(holder);
  const radius = Math.max(1e-6, new THREE.Box3().setFromObject(holder).getBoundingSphere(new THREE.Sphere()).radius);
  const step = Math.pow(10, Math.floor(Math.log10(radius))), grid = new THREE.GridHelper(step * 20, 20, 0x888888, 0x555555);
  grid.material.transparent = true; grid.material.opacity = .45; scene.add(grid);
  const target = new THREE.Vector3(0, radius * .6, 0);
  camera.near = radius / 1000; camera.far = radius * 1000; camera.updateProjectionMatrix();
  const VIEWS = {front: [0, 0, 1], top: [0, 1, 0.0001], side: [1, 0, 0], iso: [1, .8, 1.2]};
  function setView(name) {
    const d = new THREE.Vector3(...(VIEWS[name] || VIEWS.iso)).normalize().multiplyScalar(radius * 3.2);
    camera.position.copy(target).add(d); controls.target.copy(target); controls.update(); render();
  }
  setView('iso');

  const resize = () => {
    const w = Math.max(1, box.clientWidth), h = Math.max(1, box.clientHeight);
    renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); render();
  };
  const ro = new ResizeObserver(resize); ro.observe(box); resize();

  return {
    stats,
    setView,
    setBackground,
    setWire(on) { model.traverse(o => { if (o.isMesh) [].concat(o.material).forEach(m => { m.wireframe = on; }); }); render(); },
    png() { renderer.render(scene, camera); return new Promise(r => renderer.domElement.toBlob(r, 'image/png')); },
    dispose() {
      ro.disconnect(); controls.dispose(); cancelAnimationFrame(frame);
      scene.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) [].concat(o.material).forEach(m => { if (m.map) m.map.dispose(); m.dispose(); }); });
      renderer.dispose(); renderer.domElement.remove();
    }
  };
}

window.View3D = {open, measure};
window.dispatchEvent(new Event('view3d-ready'));
