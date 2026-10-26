// SPDX-License-Identifier: GPL-3.0-or-later
// Parses DXF and builds the scene for dxf-viewer off the main thread.
import { DxfViewer } from 'dxf-viewer';
import { DxfScene } from 'dxf-viewer/src/DxfScene.js';
import { limitHatchDensity } from './hatch-limit';

const hatches = limitHatchDensity(DxfScene);
const build = DxfScene.prototype.Build;
DxfScene.prototype.Build = async function (this: InstanceType<typeof DxfScene>, ...args: Parameters<typeof build>) {
  hatches.filled = 0;
  await build.apply(this, args);
  if (hatches.filled) console.info(`[dxf] ${hatches.filled} very dense hatches drawn as solid fill`);
};

DxfViewer.SetupWorker();
