export function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
export function rand(min, max) { return delay(Math.floor(min + Math.random() * (max - min))); }
