// The real grading CLI with the model calls mocked: names come from a JSON map of page-1 file →
// name at $MOCK_NAMES, and written answers (when $MOCK_RESPONSES is set) from a JSON map of
// "<file>|<0-based question>" → text, graded with mockPoints. Lets the web grader's server tests
// drive a real CLI subprocess offline.
import { readFileSync } from "node:fs";
import { mockPoints } from "../../gen/dummy.ts";
import { main } from "../../src/cli.ts";

const names: Record<string, string> = JSON.parse(readFileSync(process.env.MOCK_NAMES!, "utf8"));
const responses: Record<string, string> | null = process.env.MOCK_RESPONSES ? JSON.parse(readFileSync(process.env.MOCK_RESPONSES, "utf8")) : null;
process.exitCode = await main(process.argv.slice(2), {
    nameReader: {
        async readName(_png, file) {
            const name = names[file];
            if (!name) throw new Error(`no name for ${file}`);
            return name;
        },
    },
    ...(responses
        ? {
              responseGrader: {
                  async readResponse(_png, file, question) {
                      return { text: responses[`${file}|${question}`] ?? "", legible: true };
                  },
                  async gradeResponse(key, text) {
                      return { points: mockPoints(text, key.points), feedback: `mock grade for "${text}"` };
                  },
              },
          }
        : {}),
});
