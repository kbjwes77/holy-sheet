// Seeded PRNG so fixtures are reproducible.
export class Rng {
    private s: number;
    constructor(seed: number) {
        this.s = seed >>> 0 || 1;
    }
    /** mulberry32, uniform in [0, 1) */
    next(): number {
        this.s = (this.s + 0x6d2b79f5) >>> 0;
        let t = this.s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    range(lo: number, hi: number): number {
        return lo + (hi - lo) * this.next();
    }
    int(lo: number, hiInclusive: number): number {
        return Math.floor(this.range(lo, hiInclusive + 1));
    }
    chance(p: number): boolean {
        return this.next() < p;
    }
    pick<T>(items: readonly T[]): T {
        return items[Math.floor(this.next() * items.length)]!;
    }
    /** Approximately normal (sum of uniforms). */
    gauss(mean = 0, sd = 1): number {
        let s = 0;
        for (let i = 0; i < 6; i++) s += this.next();
        return mean + (s - 3) * sd * Math.SQRT2;
    }
    shuffle<T>(items: T[]): T[] {
        for (let i = items.length - 1; i > 0; i--) {
            const j = Math.floor(this.next() * (i + 1));
            [items[i], items[j]] = [items[j]!, items[i]!];
        }
        return items;
    }
}
