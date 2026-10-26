// Example: gear dimensions
export interface Gear {
  module: number; // module in mm
  teeth: number;
}

export function pitchDiameter({ module, teeth }: Gear): number {
  return module * teeth;
}

export function tipDiameter(gear: Gear): number {
  return pitchDiameter(gear) + 2 * gear.module;
}

const gear: Gear = { module: 1.5, teeth: 18 };
console.log(`Pitch diameter: ${pitchDiameter(gear)} mm, tip diameter: ${tipDiameter(gear)} mm`);
