// The real grading CLI with OCR mocked: names come from a JSON map of page-1 file → name at
// $MOCK_NAMES. Lets the web grader's server tests drive a real CLI subprocess offline.
import { readFileSync } from "node:fs";
import { main } from "../../src/cli.ts";

const names: Record<string, string> = JSON.parse(readFileSync(process.env.MOCK_NAMES!, "utf8"));
process.exitCode = await main(process.argv.slice(2), {
    nameReader: {
        async readName(_png, file) {
            const name = names[file];
            if (!name) throw new Error(`no name for ${file}`);
            return name;
        },
    },
});
