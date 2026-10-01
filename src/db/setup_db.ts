import fs from "fs/promises";
import client from "./db.js";

const schema = await fs.readFile("./src/db/schema.sql", "utf-8");

await client.query(schema);

console.log("Database schema created");

await client.end();

