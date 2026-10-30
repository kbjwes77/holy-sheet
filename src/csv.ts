// RFC 4180 CSV.
export function csvField(v: string | number): string {
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(fields: readonly (string | number)[]): string {
    return fields.map(csvField).join(",") + "\r\n";
}

export const CSV_HEADER = ["student_name", "score", "total", "percent"] as const;

/** Columns per free-response question (1-based `n`): its points, the transcript and the grading reason. */
export const freeColumns = (n: number) => [`q${n}_points`, `q${n}_response`, `q${n}_feedback`];
export const FREE_COLUMN_RE = /^q(\d+)_(points|response|feedback)$/;

/** The header: the summary columns, then each free-response question's (0-based indexes in `free`). */
export function csvHeader(free: readonly number[]): string[] {
    return [...CSV_HEADER, ...free.flatMap((i) => freeColumns(i + 1))];
}

/** A graded student's fields under `csvHeader(free)`. */
export function gradedRowFields(
    r: { name: string; score: number; total: number; percent: string; responses: readonly { index: number; points: number; text: string; feedback: string }[] },
    free: readonly number[],
): (string | number)[] {
    const by = new Map(r.responses.map((x) => [x.index, x]));
    return [r.name, r.score, r.total, r.percent, ...free.flatMap((i) => (by.has(i) ? [by.get(i)!.points, by.get(i)!.text, by.get(i)!.feedback] : ["", "", ""]))];
}

/** A score as a percent of `total`, formatted like the grader's `percent` column. */
export const percentText = (score: number, total: number): string => (total ? Math.round((score / total) * 1000) / 10 : 0).toFixed(1);

/**
 * The grader's CSV with `curves[i]` points added to data row i's score and its percent recomputed.
 * A curve sets the points given on top of the graded score, so applying one never stacks.
 */
export function applyCurves(csv: string, curves: readonly number[]): string {
    if (!curves.some(Boolean)) return csv;
    const [header, ...body] = parseCsv(csv);
    if (!header) return csv;
    return [
        header,
        ...body.map((fields, i) => {
            const curve = curves[i] ?? 0;
            if (!curve) return fields;
            const score = Number(fields[1]) + curve;
            const out = [...fields];
            out[1] = String(score);
            out[3] = percentText(score, Number(fields[2]));
            return out;
        }),
    ]
        .map(csvRow)
        .join("");
}

/** Parses RFC 4180 CSV (CRLF or LF line ends) into rows of fields. A trailing newline adds no row. */
export function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let quoted = false;
    let i = 0;
    const endField = () => {
        row.push(field);
        field = "";
    };
    while (i < text.length) {
        const ch = text[i]!;
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 2;
                    continue;
                }
                quoted = false;
            } else field += ch;
            i++;
            continue;
        }
        if (ch === '"' && field === "") quoted = true;
        else if (ch === ",") endField();
        else if (ch === "\n" || ch === "\r") {
            endField();
            rows.push(row);
            row = [];
            if (ch === "\r" && text[i + 1] === "\n") i++;
        } else field += ch;
        i++;
    }
    if (quoted) throw new Error("unterminated quoted field");
    if (field !== "" || row.length) {
        endField();
        rows.push(row);
    }
    return rows;
}
