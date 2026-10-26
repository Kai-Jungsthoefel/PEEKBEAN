// SPDX-License-Identifier: GPL-3.0-or-later
// Adapted from SOMA's view cube (github.com/Kai-Jungsthoefel/SOMA, app/src/renderer/viewcube.ts, GPL-3.0),
// with a light color scheme and German labels.
import * as THREE from 'three';

/** What the cube needs from the viewer. */
export interface CubeHost {
  camera(): THREE.Camera;
  target(): THREE.Vector3;
  /** View from this direction (from the pivot towards the camera), animated; pivot and distance stay. */
  orient(dir: THREE.Vector3): void;
  /** Rotate around the pivot: angle around the up axis and towards it (radians). */
  orbit(dTheta: number, dPhi: number): void;
}

/** CAD convention: Z up, front is -Y. */
const FACES: { n: [number, number, number]; up: [number, number, number]; text: string; bg: string }[] = [
  { n: [0, 0, 1], up: [0, 1, 0], text: 'TOP', bg: '#f7f8fa' },
  { n: [0, 0, -1], up: [0, -1, 0], text: 'BOTTOM', bg: '#f7f8fa' },
  { n: [0, -1, 0], up: [0, 0, 1], text: 'FRONT', bg: '#eef0f3' },
  { n: [0, 1, 0], up: [0, 0, 1], text: 'BACK', bg: '#eef0f3' },
  { n: [1, 0, 0], up: [0, 0, 1], text: 'RIGHT', bg: '#e6e9ed' },
  { n: [-1, 0, 0], up: [0, 0, 1], text: 'LEFT', bg: '#e6e9ed' },
];
/** Border between the middle and the rim of a face; the cube spans -1 … 1, edges and corners lie outside. */
const EDGE = 0.62;
const SIZE = 104; // CSS pixels
const DRAG_PX = 3;
const AXES: { dir: [number, number, number]; color: string; label: string }[] = [
  { dir: [1, 0, 0], color: '#d9443c', label: 'X' },
  { dir: [0, 1, 0], color: '#3e9a48', label: 'Y' },
  { dir: [0, 0, 1], color: '#2f7fd6', label: 'Z' },
];

/** Direction in words for the tooltip: "Top front right". */
function dirName(s: number[]): string {
  const parts = [s[2] > 0 ? 'top' : s[2] < 0 ? 'bottom' : '', s[1] < 0 ? 'front' : s[1] > 0 ? 'back' : '', s[0] > 0 ? 'right' : s[0] < 0 ? 'left' : ''].filter(Boolean);
  const t = parts.join(' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * View cube as in CAD programs: a small scene of its own that turns with the camera. Clicking a face, edge or corner
 * (3 × 3 fields per face, 26 directions) turns the view there, dragging rotates freely.
 */
export class ViewCube {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-2.05, 2.05, 2.05, -2.05, 0.1, 20);
  private faces: THREE.Mesh[] = [];
  private textures: { tex: THREE.CanvasTexture; draw: () => void }[] = [];
  private hl = new THREE.Group();
  private hoverKey = '';
  private raycaster = new THREE.Raycaster();

  constructor(
    private el: HTMLElement,
    private host: CubeHost,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(SIZE, SIZE);
    this.renderer.setClearColor(0x000000, 0);
    el.appendChild(this.renderer.domElement);
    this.build();
    this.installPointer();
    // Labels look right only with the app font; redraw once it has loaded.
    void document.fonts?.ready.then(() => {
      for (const t of this.textures) {
        t.draw();
        t.tex.needsUpdate = true;
      }
      this.render();
    });
  }

  private build(): void {
    for (const f of FACES) {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const draw = () => {
        const g = c.getContext('2d')!;
        g.fillStyle = f.bg;
        g.fillRect(0, 0, 256, 256);
        g.fillStyle = '#525b66';
        g.font = '600 46px "IBM Plex Sans", "Segoe UI", sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(f.text, 128, 132);
      };
      draw();
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      this.textures.push({ tex, draw });
      // Orient the 2 × 2 plane: right = up × normal, so the label reads upright when seen from that side.
      const n = new THREE.Vector3(...f.n);
      const up = new THREE.Vector3(...f.up);
      const right = up.clone().cross(n);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: tex }));
      m.applyMatrix4(new THREE.Matrix4().makeBasis(right, up, n).setPosition(n));
      m.userData.normal = n;
      this.faces.push(m);
      this.scene.add(m);
    }
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(2.01, 2.01, 2.01)),
      new THREE.LineBasicMaterial({ color: 0xaab2bc }),
    );
    this.scene.add(edges, this.hl);
    // Axes at the left front bottom corner: X red, Y green, Z blue.
    const o = new THREE.Vector3(-1.02, -1.02, -1.02);
    for (const a of AXES) {
      const d = new THREE.Vector3(...a.dir);
      const g = new THREE.BufferGeometry().setFromPoints([o, o.clone().addScaledVector(d, 2.4)]);
      this.scene.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: a.color })));
      const lc = document.createElement('canvas');
      lc.width = lc.height = 64;
      const lg = lc.getContext('2d')!;
      lg.fillStyle = a.color;
      lg.font = '700 44px "IBM Plex Sans", "Segoe UI", sans-serif';
      lg.textAlign = 'center';
      lg.textBaseline = 'middle';
      lg.fillText(a.label, 32, 34);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(lc), depthTest: false }));
      sp.position.copy(o).addScaledVector(d, 2.66);
      sp.scale.setScalar(0.38);
      this.scene.add(sp);
    }
  }

  /** After every frame of the viewer: same view direction as the main camera. */
  render(): void {
    const cam = this.host.camera();
    const dir = cam.position.clone().sub(this.host.target());
    if (dir.lengthSq() < 1e-18) return;
    this.cam.position.copy(dir.normalize().multiplyScalar(6));
    this.cam.up.copy(cam.up);
    this.cam.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.cam);
  }

  dispose(): void {
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.Sprite) {
        o.geometry.dispose();
        const material = o.material as THREE.Material & { map?: THREE.Texture };
        material.map?.dispose();
        material.dispose();
      }
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  /** Field under the pointer as a direction with components -1, 0, 1 (middle of a face, edge or corner). */
  private regionAt(clientX: number, clientY: number): number[] | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.cam);
    const hit = this.raycaster.intersectObjects(this.faces, false)[0];
    if (!hit) return null;
    const p = hit.point;
    const n = hit.object.userData.normal as THREE.Vector3;
    return [p.x, p.y, p.z].map((v, k) => (n.getComponent(k) !== 0 ? n.getComponent(k) : v > EDGE ? 1 : v < -EDGE ? -1 : 0));
  }

  private installPointer(): void {
    const c = this.renderer.domElement;
    c.style.touchAction = 'none';
    let down: { x: number; y: number; lx: number; ly: number; dragged: boolean } | null = null;
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      down = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, dragged: false };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (down) {
        if (!down.dragged && Math.hypot(e.clientX - down.x, e.clientY - down.y) > DRAG_PX) {
          down.dragged = true;
          this.setHover(null);
        }
        if (down.dragged) {
          // Like dragging in the viewer: dragging right turns the model right.
          const k = (2 * Math.PI) / (SIZE * 3);
          this.host.orbit(-(e.clientX - down.lx) * k, -(e.clientY - down.ly) * k);
          down.lx = e.clientX;
          down.ly = e.clientY;
        }
        return;
      }
      this.setHover(this.regionAt(e.clientX, e.clientY));
    });
    c.addEventListener('pointerup', (e) => {
      const d = down;
      down = null;
      if (!d || d.dragged) return;
      const s = this.regionAt(e.clientX, e.clientY);
      if (s) this.host.orient(new THREE.Vector3(s[0], s[1], s[2]));
    });
    c.addEventListener('pointerleave', () => {
      if (!down) this.setHover(null);
    });
  }

  /** Highlights the matching one of the 3 × 3 fields on every face that belongs to the direction. */
  private setHover(s: number[] | null): void {
    const key = s ? s.join(',') : '';
    if (key === this.hoverKey) return;
    this.hoverKey = key;
    for (const o of [...this.hl.children]) {
      this.hl.remove(o);
      (o as THREE.Mesh).geometry.dispose();
      ((o as THREE.Mesh).material as THREE.Material).dispose();
    }
    this.el.title = s ? `${dirName(s)}: click to view from there. Drag to rotate.` : 'Click a face, edge or corner to view from there. Drag to rotate the view.';
    if (s) {
      const range = (v: number): [number, number] => (v < 0 ? [-1, -EDGE] : v > 0 ? [EDGE, 1] : [-EDGE, EDGE]);
      for (let a = 0; a < 3; a++) {
        if (!s[a]) continue;
        const [b, c] = [0, 1, 2].filter((k) => k !== a);
        const [b0, b1] = range(s[b]);
        const [c0, c1] = range(s[c]);
        const corner = (vb: number, vc: number) => {
          const v = [0, 0, 0];
          v[a] = s[a] * 1.004;
          v[b] = vb;
          v[c] = vc;
          return v;
        };
        const pos = [...corner(b0, c0), ...corner(b1, c0), ...corner(b1, c1), ...corner(b0, c0), ...corner(b1, c1), ...corner(b0, c1)];
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        this.hl.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xf29a38, transparent: true, opacity: 0.55, side: THREE.DoubleSide })));
      }
    }
    this.renderer.domElement.style.cursor = s ? 'pointer' : 'grab';
    this.render();
  }
}
