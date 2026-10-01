// RFC 4180 CSV.
export function csvField(v: string | number): string {
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(fields: readonly (string | number)[]): string {
    return fields.map(csvField).join(",") + "\r\n";
}

export const CSV_HEADER = ["student_name", "score", "total", "percent"] as const;
