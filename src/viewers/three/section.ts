// SPDX-License-Identifier: GPL-3.0-or-later
// Section view: one clipping plane along X, Y or Z. Faces seen from behind (the inside of a solid that the cut opens
// up) are drawn in the cap color, so the cut surface reads as filled without computing cap geometry.
import * as THREE from 'three';
import { h, setPressed } from '../../core/dom';
import { icon } from '../../core/icons';

export interface SectionHost {
  renderer: THREE.WebGLRenderer;
  /** Materials of all parts (cut and capped). */
  partMaterials(): THREE.Material[];
  /** Materials that are cut but not capped, e.g. edge lines. */
  lineMaterials(): THREE.Material[];
  /** Bounding box of the model in world coordinates. */
  box(): THREE.Box3;
  toFile(world: THREE.Vector3): THREE.Vector3;
  unit: string;
  requestRender(): void;
}

type Axis = 'x' | 'y' | 'z';
const AXES: Record<Axis, THREE.Vector3> = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const CAP_COLOR = new THREE.Color('#e0782f');
const STEPS = 1000;

const num = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/^-/, '−');

/** Adds the cap color to a material's shader once; `uSection` switches it on and off. */
function prepare(material: THREE.Material, uniform: { value: number }): void {
  if (material.userData.sectionReady) return;
  material.userData.sectionReady = true;
  material.userData.sideBeforeSection = material.side;
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    shader.uniforms.uSection = uniform;
    shader.uniforms.uSectionCap = { value: CAP_COLOR };
    shader.fragmentShader = `uniform float uSection;\nuniform vec3 uSectionCap;\n${shader.fragmentShader}`.replace(
      '#include <dithering_fragment>',
      '#include <dithering_fragment>\n\tif (uSection > 0.5 && !gl_FrontFacing) gl_FragColor = vec4(uSectionCap, 1.0);',
    );
  };
  const key = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${key?.() ?? ''}|section`;
  material.needsUpdate = true;
}

export class SectionTool {
  readonly button: HTMLButtonElement;
  readonly card = h('div', { class: 'float mcard', hidden: true });
  private active = false;
  private axis: Axis = 'z';
  private flipped = false;
  private fraction = 0.5;
  private readonly plane = new THREE.Plane();
  private readonly uniform = { value: 0 };
  private readonly slider = h('input', { type: 'range', min: '0', max: String(STEPS), value: String(STEPS / 2), class: 'sec-range', 'aria-label': 'Position of the section plane' });
  private readonly position = h('span', { class: 'v' });

  constructor(private readonly host: SectionHost) {
    this.button = h('button', { type: 'button', class: 'btn sm pin', title: 'Section view', onclick: () => this.setActive(!this.active) }, icon('layers', 14), 'Section');
    setPressed(this.button, false);
    this.slider.addEventListener('input', () => {
      this.fraction = Number(this.slider.value) / STEPS;
      this.apply();
    });
    this.render();
  }

  setActive(on: boolean): void {
    this.active = on;
    setPressed(this.button, on);
    this.card.hidden = !on;
    this.host.renderer.localClippingEnabled = on;
    for (const m of this.host.partMaterials()) {
      prepare(m, this.uniform);
      // Back faces must be drawn to show the cut; restore the file's choice afterwards.
      m.side = on ? THREE.DoubleSide : (m.userData.sideBeforeSection as THREE.Side);
      m.clippingPlanes = on ? [this.plane] : null;
      m.needsUpdate = true;
    }
    for (const m of this.host.lineMaterials()) {
      m.clippingPlanes = on ? [this.plane] : null;
      m.needsUpdate = true;
    }
    this.uniform.value = on ? 1 : 0;
    this.apply();
  }

  /** The model changed orientation or size: keep the cut at the same relative depth. */
  refresh(): void {
    if (this.active) this.apply();
  }

  private apply(): void {
    const box = this.host.box();
    const axis = AXES[this.axis];
    const min = box.min.dot(axis);
    const max = box.max.dot(axis);
    const at = min + (max - min) * this.fraction;
    // Points with a negative distance to the plane are cut away: keep below the cut, or above it when flipped.
    this.plane.normal.copy(axis).multiplyScalar(this.flipped ? 1 : -1);
    this.plane.constant = this.flipped ? -at : at;
    const center = box.getCenter(new THREE.Vector3());
    center.setComponent(['x', 'y', 'z'].indexOf(this.axis), at);
    // Name the cut in file coordinates: which file axis lies along the chosen view axis.
    const p = this.host.toFile(center);
    const direction = this.host.toFile(center.clone().add(axis)).sub(p);
    const index = [0, 1, 2].reduce((best, i) => (Math.abs(direction.getComponent(i)) > Math.abs(direction.getComponent(best)) ? i : best), 0);
    this.position.textContent = `${'XYZ'[index]} = ${num(p.getComponent(index))}${this.host.unit ? ` ${this.host.unit}` : ''}`;
    this.host.requestRender();
  }

  private render(): void {
    const axisButton = (axis: Axis) =>
      h('button', { type: 'button', 'aria-checked': String(this.axis === axis), role: 'radio', onclick: () => {
        this.axis = axis;
        this.render();
        this.apply();
      } }, axis.toUpperCase());
    this.card.replaceChildren(
      h(
        'div',
        { class: 'float-hd' },
        icon('layers', 14),
        h('b', {}, 'Section'),
        h('span', { class: 'grow' }),
        h('button', { type: 'button', class: 'hb', title: 'Close section view', 'aria-label': 'Close section view', onclick: () => this.setActive(false) }, icon('close', 13, 2)),
      ),
      h(
        'div',
        { class: 'mc-body' },
        h('div', { class: 'sec-row' }, h('span', { class: 'c3' }, 'Plane normal to'), h('div', { class: 'seg', role: 'radiogroup' }, axisButton('x'), axisButton('y'), axisButton('z'))),
        this.slider,
        h('div', { class: 'mc-row' }, h('span', {}, 'Position'), this.position),
        h('label', { class: 'sec-flip' }, h('input', { type: 'checkbox', checked: this.flipped, onchange: (e: Event) => {
          this.flipped = (e.target as HTMLInputElement).checked;
          this.apply();
        } }), 'Show the other side'),
      ),
    );
  }

  dispose(): void {
    if (this.active) this.setActive(false);
  }
}
