// SPDX-License-Identifier: GPL-3.0-or-later
// GeoJSON as RFC 7946 has it: one FeatureCollection in WGS84 longitude and latitude, polygons by the right-hand rule.
// Several layers go into the one collection, with an attribute naming each feature's layer. Values per track point
// stay as togeojson writes them, in "coordinateProperties".
import { layerAttribute, rightHand, ticker, type FeatureLayer } from './model';

/** The file in pieces, one per feature: a single string could pass the length JavaScript allows for large files. */
export function writeGeoJson(layers: FeatureLayer[], name: string, progress?: (fraction: number) => void): string[] {
  const key = layerAttribute(layers);
  const tick = ticker(layers.reduce((sum, layer) => sum + layer.features.length, 0), progress);
  // One feature per line: much smaller than indented JSON and still readable.
  const pieces = [`{"type":"FeatureCollection","name":${JSON.stringify(name)},"features":[\n`];
  for (const layer of layers) {
    for (const feature of layer.features) {
      let properties = key ? { [key]: layer.name, ...feature.properties } : feature.properties;
      if (feature.vertexValues && !('coordinateProperties' in properties)) properties = { ...properties, coordinateProperties: feature.vertexValues };
      if (pieces.length > 1) pieces.push(',\n');
      pieces.push(JSON.stringify({ type: 'Feature', properties, geometry: feature.geometry && rightHand(feature.geometry) }));
      tick();
    }
  }
  pieces.push('\n]}\n');
  return pieces;
}
