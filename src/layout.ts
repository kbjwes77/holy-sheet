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
    /**
     * QR area including quiet zone. Its top row is row 0, the page margin above the corner squares,
     * so the symbol's top edge is level with theirs.
     */
    qrArea: CellRange;
    /** Side of the square QR symbol (no quiet zone), centred in `qrArea`, in page units. */
    qrSymbolSide: number;
    /** Page 1: printed test name, above the handwritten fields (not read by the grader). Fixed at two rows. */
    titleArea: CellRange;
    /** Handwritten boxes on page 1; only `name` is read (OCR). */
    fields: {
        name: CellRange;
        period: CellRange;
        date: CellRange;
    };
    /** Page 1 only: one line of marking instructions, under the fields. */
    instructionsRow: number;
    /** First question row on page 1, one blank row below the instructions. */
    firstRowPage1: number;
    /** Later pages (no title or fields): the first bubble row, the first a marker can use below the corner square. */
    firstRowContinued: number;
    /**
     * Later pages: the highest row the first question's prompt may start on, beside the top-left
     * corner square, so that its first choice can land on `firstRowContinued`.
     */
    topRowContinued: number;
    /** Rows above this sit beside the QR, so text there stops short of it. */
    qrClearRow: number;
    /** Last question row; one empty row keeps markers clear of the bottom corner squares. */
    bodyLastRow: number;
    /**
     * Questions print in two columns where they fit. The left column runs from `promptCol` to
     * `leftLastCol` with its bubbles in `ring.col`, the same bubble column as full-width questions.
     * The right column starts at `right.promptCol` with its bubbles in `right.ringCol`, and starts no
     * higher than `qrClearRow`, below the QR. A hairline in `dividerCol` separates them.
     */
    columns: {
        leftLastCol: number;
        dividerCol: number;
        right: { promptCol: number; ringCol: number };
    };
    marker: {
        col: number;
        /** Fractions of a cell. */
        widthCells: number;
        heightCells: number;
    };
    /** Column where question prompts start. */
    promptCol: number;
    /** Choice bubbles: one per choice, centred in this column (the left one) on the choice's own grid row. */
    ring: {
        col: number;
        maxChoices: number;
        /** Diameter as a fraction of the cell width. */
        diameterCells: number;
        strokeWidth: number;
        /** Fill is measured inside this fraction of the ring radius. */
        innerRadiusFrac: number;
    };
    /**
     * A separate answer sheet: one row per question from ANSWER_FIRST_ROW, its bubbles side by
     * side, in blocks spread evenly from `firstCol` to `lastCol` (see `answerGridGeometry`).
     * Its bubbles are bigger than the question pages', to hold a printed letter.
     */
    answer: {
        firstCol: number;
        lastCol: number;
        diameterCells: number;
        /** Centre-to-centre distance of a row's bubbles, in cell widths. */
        pitchCells: number;
        /** Room for the question number, right-aligned before a block's first bubble, in page units. */
        numberW: number;
        numberGap: number;
        /** The narrowest space between blocks, in cell widths. */
        blockGapCells: number;
        maxBlocks: number;
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
    qrArea: { col1: 37, col2: 44, row1: 0, row2: 7 },
    qrSymbolSide: 6 * ((PAGE_H - 2 * MARGIN) / ROWS),
    titleArea: { col1: 4, col2: 35, row1: 1, row2: 2 },
    fields: {
        name: { col1: 4, col2: 23, row1: 4, row2: 6 },
        period: { col1: 25, col2: 28, row1: 4, row2: 6 },
        date: { col1: 30, col2: 35, row1: 4, row2: 6 },
    },
    instructionsRow: 7,
    firstRowPage1: 9,
    // Row 3 has no bubbles, like row 58: a marker right under a corner square can merge with it.
    firstRowContinued: 4,
    topRowContinued: 1,
    qrClearRow: 8,
    bodyLastRow: 57,
    columns: {
        leftLastCol: 22,
        dividerCol: 24,
        right: { promptCol: 26, ringCol: 27 },
    },
    marker: { col: 1, widthCells: 1, heightCells: 0.5 },
    promptCol: 4,
    ring: {
        col: 5,
        maxChoices: 8,
        diameterCells: 0.6,
        strokeWidth: 1.5,
        innerRadiusFrac: 0.7,
    },
    answer: {
        firstCol: 3,
        lastCol: 44,
        diameterCells: 0.72,
        pitchCells: 1.2,
        numberW: 22,
        numberGap: 6,
        blockGapCells: 1,
        maxBlocks: 6,
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

/**
 * Right edge for question text on grid row `row`: the right corner squares' column, or, beside
 * the QR, one column short of the QR area.
 */
export function textRightEdge(row: number, L: LayoutSpec = LAYOUT): number {
    return row < L.qrClearRow ? colX(L.qrArea.col1 - 1, L) : colX(L.cornerSquares[1].col1, L);
}

/** Which bubble column a question uses: 0 for full width and the left column, 1 for the right column. */
export type BubbleColumn = 0 | 1;

/** The grid column holding the bubbles of bubble column `column`. */
export function ringCol(column: BubbleColumn, L: LayoutSpec = LAYOUT): number {
    return column ? L.columns.right.ringCol : L.ring.col;
}

/** Centre of the choice bubble on grid row `row` in bubble column `column`. */
export function bubbleCenter(row: number, column: BubbleColumn = 0, L: LayoutSpec = LAYOUT): Point {
    return cellCenter(ringCol(column, L), row, L);
}

export function ringRadius(L: LayoutSpec = LAYOUT): number {
    return (L.ring.diameterCells * L.cellW) / 2;
}

export function answerRingRadius(L: LayoutSpec = LAYOUT): number {
    return (L.answer.diameterCells * L.cellW) / 2;
}

export interface AnswerGridGeometry {
    /** Blocks across the page. */
    blocks: number;
    /** Width of a block's number and bubbles. */
    blockW: number;
    /** Left edge of block `b` (0-based): where its numbers' room starts. */
    blockX(b: number): number;
    /** Centre x of bubble `j` (0 = A) in block `b`. */
    bubbleX(b: number, j: number): number;
}

/**
 * Where an answer sheet's blocks go when a row holds up to `slots` bubbles: as many blocks as fit
 * between `answer.firstCol` and `answer.lastCol` (at most `answer.maxBlocks`), each centred in an
 * equal share of that width.
 */
export function answerGridGeometry(slots: number, L: LayoutSpec = LAYOUT): AnswerGridGeometry {
    const A = L.answer;
    const r = answerRingRadius(L);
    const pitch = A.pitchCells * L.cellW;
    const left = colX(A.firstCol, L);
    const width = colX(A.lastCol + 1, L) - left;
    const gap = A.blockGapCells * L.cellW;
    const blockW = A.numberW + A.numberGap + (slots - 1) * pitch + 2 * r;
    const blocks = Math.max(1, Math.min(A.maxBlocks, Math.floor((width + gap) / (blockW + gap))));
    const share = width / blocks;
    const blockX = (b: number) => left + b * share + (share - blockW) / 2;
    return { blocks, blockW, blockX, bubbleX: (b, j) => blockX(b) + A.numberW + A.numberGap + r + j * pitch };
}

/** Centre of bubble `j` of a question in block `block` on an answer sheet page, on grid row `row`. */
export function answerBubbleCenter(block: number, j: number, row: number, slots: number, L: LayoutSpec = LAYOUT): Point {
    const g = answerGridGeometry(slots, L);
    return { x: g.bubbleX(block, j), y: rowY(row, L) + L.cellH / 2 };
}

/**
 * The page rectangle of a free-response box over grid rows [row, row + rows): full width, from
 * the prompt column to the right corner squares' column.
 */
export function responseBoxRect(row: number, rows: number, L: LayoutSpec = LAYOUT): Rect {
    const x = colX(L.promptCol, L);
    return { x, y: rowY(row, L), w: colX(L.cornerSquares[1].col1, L) - x, h: rows * L.cellH };
}

/** Grid rows per handwriting line of a free-response box. */
export const ROWS_PER_LINE = 2;

export const CHOICE_LETTERS = "ABCDEFGH";
