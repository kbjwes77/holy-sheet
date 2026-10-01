// Sheet geometry shared by the grader and every sheet generator. Dependency-free on purpose:
// `bun run build:shared` emits it as a plain ES module for the browser generator.
//
// Coordinates are canonical page units of 1/100 in, origin at the page's top-left corner.
// Columns and rows are 1-based, matching the codec's row numbers.

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Inclusive 1-based cell range. */
export interface CellRange {
    col1: number;
    col2: number;
    row1: number;
    row2: number;
}

export interface LayoutSpec {
    pageWidth: number;
    pageHeight: number;
    margin: number;
    cols: number;
    rows: number;
    cellW: number;
    cellH: number;
    /** Solid squares anchoring the full-page homography, in TL, TR, BR, BL order. */
    cornerSquares: readonly [CellRange, CellRange, CellRange, CellRange];
    /** QR area including quiet zone. */
    qrArea: CellRange;
    /** Side of the square QR symbol (no quiet zone), centred in `qrArea`, in page units. */
    qrSymbolSide: number;
    fields: {
        name: CellRange;
        period: CellRange;
        testName: CellRange;
        date: CellRange;
    };
    headerDividerRow: number;
    bodyFirstRow: number;
    bodyLastRow: number;
    marker: {
        col: number;
        /** Fractions of a cell. */
        widthCells: number;
        heightCells: number;
    };
    ring: {
        startCol: number;
        lastCol: number;
        maxChoices: number;
        /** Upper bound on ring pitch, in columns. */
        maxPitch: number;
        /** Diameter as a fraction of the cell width. */
        diameterCells: number;
        strokeWidth: number;
        /** Fill is measured inside this fraction of the ring radius. */
        innerRadiusFrac: number;
    };
}

const PAGE_W = 850;
const PAGE_H = 1100;
const MARGIN = 25;
const COLS = 46;
const ROWS = 60;

export const LAYOUT: LayoutSpec = {
    pageWidth: PAGE_W,
    pageHeight: PAGE_H,
    margin: MARGIN,
    cols: COLS,
    rows: ROWS,
    cellW: (PAGE_W - 2 * MARGIN) / COLS,
    cellH: (PAGE_H - 2 * MARGIN) / ROWS,
    cornerSquares: [
        { col1: 1, col2: 2, row1: 1, row2: 2 },
        { col1: 45, col2: 46, row1: 1, row2: 2 },
        { col1: 45, col2: 46, row1: 59, row2: 60 },
        { col1: 1, col2: 2, row1: 59, row2: 60 },
    ],
    qrArea: { col1: 37, col2: 44, row1: 1, row2: 8 },
    qrSymbolSide: 6 * ((PAGE_H - 2 * MARGIN) / ROWS),
    fields: {
        name: { col1: 4, col2: 35, row1: 2, row2: 4 },
        period: { col1: 4, col2: 9, row1: 6, row2: 8 },
        testName: { col1: 11, col2: 28, row1: 6, row2: 8 },
        date: { col1: 30, col2: 35, row1: 6, row2: 8 },
    },
    headerDividerRow: 9,
    bodyFirstRow: 10,
    bodyLastRow: 57,
    marker: { col: 1, widthCells: 1, heightCells: 0.5 },
    ring: {
        startCol: 4,
        lastCol: 44,
        maxChoices: 8,
        maxPitch: 8,
        diameterCells: 0.8,
        strokeWidth: 1.5,
        innerRadiusFrac: 0.7,
    },
};

export interface Point {
    x: number;
    y: number;
}

/** Left edge of a 1-based column. */
export function colX(col: number, L: LayoutSpec = LAYOUT): number {
    return L.margin + (col - 1) * L.cellW;
}

/** Top edge of a 1-based row. */
export function rowY(row: number, L: LayoutSpec = LAYOUT): number {
    return L.margin + (row - 1) * L.cellH;
}

export function cellCenter(col: number, row: number, L: LayoutSpec = LAYOUT): Point {
    return { x: colX(col, L) + L.cellW / 2, y: rowY(row, L) + L.cellH / 2 };
}

export function rangeRect(r: CellRange, L: LayoutSpec = LAYOUT): Rect {
    const x = colX(r.col1, L);
    const y = rowY(r.row1, L);
    return { x, y, w: colX(r.col2 + 1, L) - x, h: rowY(r.row2 + 1, L) - y };
}

export function rectCenter(r: Rect): Point {
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** The QR symbol's square, without quiet zone. */
export function qrSymbolRect(L: LayoutSpec = LAYOUT): Rect {
    const c = rectCenter(rangeRect(L.qrArea, L));
    const s = L.qrSymbolSide;
    return { x: c.x - s / 2, y: c.y - s / 2, w: s, h: s };
}

/** QR symbol corners in TL, TR, BR, BL order. */
export function qrSymbolCorners(L: LayoutSpec = LAYOUT): [Point, Point, Point, Point] {
    const r = qrSymbolRect(L);
    return [
        { x: r.x, y: r.y },
        { x: r.x + r.w, y: r.y },
        { x: r.x + r.w, y: r.y + r.h },
        { x: r.x, y: r.y + r.h },
    ];
}

export function markerRect(row: number, L: LayoutSpec = LAYOUT): Rect {
    const c = cellCenter(L.marker.col, row, L);
    const w = L.marker.widthCells * L.cellW;
    const h = L.marker.heightCells * L.cellH;
    return { x: c.x - w / 2, y: c.y - h / 2, w, h };
}

/** Ring pitch in columns for a question with `count` rings. */
export function ringPitch(count: number, L: LayoutSpec = LAYOUT): number {
    if (!Number.isInteger(count) || count < 1 || count > L.ring.maxChoices) {
        throw new RangeError(`ring count ${count} is outside 1–${L.ring.maxChoices}`);
    }
    if (count === 1) return 0;
    return Math.min(L.ring.maxPitch, Math.floor((L.ring.lastCol - L.ring.startCol) / (count - 1)));
}

/** 1-based columns of each ring's centre cell. */
export function ringCols(count: number, L: LayoutSpec = LAYOUT): number[] {
    const pitch = ringPitch(count, L);
    return Array.from({ length: count }, (_, i) => L.ring.startCol + i * pitch);
}

export function ringCenters(count: number, row: number, L: LayoutSpec = LAYOUT): Point[] {
    return ringCols(count, L).map((col) => cellCenter(col, row, L));
}

export function ringRadius(L: LayoutSpec = LAYOUT): number {
    return (L.ring.diameterCells * L.cellW) / 2;
}

export const CHOICE_LETTERS = "ABCDEFGH";
