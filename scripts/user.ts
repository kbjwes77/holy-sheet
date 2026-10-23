// Manage accounts from the server's shell (until Stripe sets plans):
//   bun scripts/user.ts list
//   bun scripts/user.ts plan <email> free|pro
//   bun scripts/user.ts admin <email> on|off
import { openDb, PLANS } from "../server/db.ts";

const db = openDb(process.env.DB_PATH ?? "data/gradelake.db");
const [cmd, email, value] = process.argv.slice(2);
const user = () => {
    const row = db.query("SELECT id FROM users WHERE email = ?").get((email ?? "").toLowerCase());
    if (!row) {
        console.error(`no user with email ${email}`);
        process.exit(1);
    }
};

if (cmd === "list") {
    for (const u of db.query("SELECT email, display_name, plan, is_admin FROM users ORDER BY id").all() as { email: string; display_name: string; plan: string; is_admin: number }[])
        console.log(`${u.email}\t${u.display_name}\t${u.plan}${u.is_admin ? "\tadmin" : ""}`);
} else if (cmd === "plan" && (PLANS as readonly string[]).includes(value ?? "")) {
    user();
    db.query("UPDATE users SET plan = ? WHERE email = ?").run(value!, email!.toLowerCase());
    console.log(`${email}: plan = ${value}`);
} else if (cmd === "admin" && (value === "on" || value === "off")) {
    user();
    db.query("UPDATE users SET is_admin = ? WHERE email = ?").run(value === "on" ? 1 : 0, email!.toLowerCase());
    console.log(`${email}: admin ${value}`);
} else {
    console.error("usage: bun scripts/user.ts list | plan <email> free|pro | admin <email> on|off");
    process.exit(1);
}
