// A stand-in for grade.ts in the grading-limit tests. What it does comes from words in the zip's
// file name (its first argument): "requests" reports model requests on stderr, as the CLI does
// before calling any model; "prompt" asks for an answer key, so the job waits on the teacher;
// "hold" stays running. A held or prompting run ends on a line of stdin or when it is killed.
import { basename } from "node:path";
import { keyPrompt, requestsLine } from "../../src/report.ts";

const name = basename(process.argv[2] ?? "");
if (name.includes("requests")) process.stderr.write(`${requestsLine(0, 3)}\n`);
if (name.includes("prompt")) process.stderr.write(keyPrompt(1));
if (name.includes("hold") || name.includes("prompt")) {
    for await (const _line of console) break;
}
process.stdout.write("student_name,score,total,percent\r\n");
