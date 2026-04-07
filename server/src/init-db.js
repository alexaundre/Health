// 初始化 SQLite 数据库
import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, "..", "data", "health.db");

import { mkdirSync } from "fs";
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
const schema = readFileSync(join(__dirname, "..", "schema.sql"), "utf8");
db.exec(schema);
console.log("✓ DB initialized:", DB_PATH);
db.close();
