// Beispiel: Zahnradabmessungen berechnen
export interface Gear {
  module: number; // Modul in mm
  teeth: number;
}

export function pitchDiameter({ module, teeth }: Gear): number {
  return module * teeth;
}

export function tipDiameter(gear: Gear): number {
  return pitchDiameter(gear) + 2 * gear.module;
}

const gear: Gear = { module: 1.5, teeth: 18 };
console.log(`Teilkreis: ${pitchDiameter(gear)} mm, Kopfkreis: ${tipDiameter(gear)} mm`);
