// Serves public/{images,fonts,css} at /images/*, /fonts/*, /css/*, plus /favicon.ico from public/images and the
// crawler files at the site root (robots.txt, sitemap.xml, llms.txt, site.webmanifest) from public/.
import { join, resolve, sep } from "node:path";

export const PUBLIC_DIRS = ["images", "fonts", "css", "vendor"] as const;
export const ROOT_FILES = ["robots.txt", "sitemap.xml", "llms.txt", "site.webmanifest"] as const;

export function createStatic(publicRoot: string, production: boolean) {
    const cache = production ? "public, max-age=86400" : "no-cache";

    async function serve(relative: string): Promise<Response> {
        const path = resolve(publicRoot, relative);
        // Stay inside public/, and never serve the .gitkeep placeholders.
        if (!path.startsWith(publicRoot + sep) || path.endsWith(".gitkeep")) return new Response("Not found", { status: 404 });
        const file = Bun.file(path);
        if (!(await file.exists())) return new Response("Not found", { status: 404 });
        return new Response(file, { headers: { "cache-control": cache, "x-content-type-options": "nosniff" } });
    }

    const routes: Record<string, (req: Request) => Promise<Response>> = {
        "/favicon.ico": () => serve(join("images", "favicon.ico")),
    };
    for (const name of ROOT_FILES) routes[`/${name}`] = () => serve(name);
    for (const dir of PUBLIC_DIRS) {
        routes[`/${dir}/*`] = (req) => {
            let name: string;
            try {
                name = decodeURIComponent(new URL(req.url).pathname);
            } catch {
                return Promise.resolve(new Response("Not found", { status: 404 }));
            }
            return serve(name.slice(1));
        };
    }
    return routes;
}
