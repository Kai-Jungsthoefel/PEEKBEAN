// SPDX-License-Identifier: GPL-3.0-or-later
// Types of fetch-texlive.mjs for vite.config.ts.
export const pin: { repository: string; commit: string };
export function texliveDir(): string;
export function hasTexlive(dir?: string): boolean;
export function fetchTexlive(dir?: string): string;
