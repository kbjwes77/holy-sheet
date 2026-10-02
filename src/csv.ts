// RFC 4180 CSV.
export function csvField(v: string | number): string {
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(fields: readonly (string | number)[]): string {
    return fields.map(csvField).join(",") + "\r\n";
}

export const CSV_HEADER = ["student_name", "score", "total", "percent"] as const;

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
