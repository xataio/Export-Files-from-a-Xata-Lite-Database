import { XataClient } from "./src/xata.js";
import "dotenv/config";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import pLimit from "p-limit";

const API_KEY = process.env.XATA_API_KEY;
const DATABASE_URL = process.env.XATA_DATABASE_URL;
const BRANCH = process.env.XATA_BRANCH || "main";
const SCHEMA_FILE = process.env.XATA_SCHEMA_FILE || "./xata-schema.sql";

const xata = new XataClient({ apiKey: API_KEY, branch: BRANCH });

if (!API_KEY || !DATABASE_URL) {
  console.error("❌ Missing XATA_API_KEY or XATA_DATABASE_URL in .env");
  process.exit(1);
}

if (!fs.existsSync(SCHEMA_FILE)) {
  console.error(`❌ Schema file not found: ${SCHEMA_FILE}`);
  process.exit(1);
}

/**
 * Parse SQL schema file to detect tables with Xata file columns.
 */
function parseSchemaForFileTables(schemaFile) {
  console.log(`🧩 Reading schema from "${schemaFile}"...`);
  const sql = fs.readFileSync(schemaFile, "utf-8");

  // Match CREATE TABLE statements
  const tableRegex =
    /CREATE TABLE\s+(?:public\.)?"?([\w-]+)"?\s*\(([\s\S]*?)\);/g;
  const result = {};

  let match;
  while ((match = tableRegex.exec(sql)) !== null) {
    const tableName = match[1];
    const tableBody = match[2];
    const fileColumns = [];

    // Split table body by lines to make it easier to parse
    const lines = tableBody.split("\n");

    for (const rawLine of lines) {
      const line = rawLine.trim();

      // Skip constraints or empty lines
      if (!line || line.toLowerCase().startsWith("constraint")) continue;

      // Match something like: colname xata.xata_file_array or "colname" xata.xata_file
      const colMatch = line.match(/^"?(.*?)"?\s+([a-zA-Z0-9\._]+)/);
      if (!colMatch) continue;

      const colName = colMatch[1].trim();
      const colType = colMatch[2].trim().toLowerCase();

      if (colType.includes("xata.xata_file") || colType.includes("xata_file")) {
        fileColumns.push(colName);
      }
    }

    if (fileColumns.length > 0) {
      result[tableName] = fileColumns;
    }
  }

  const tableCount = Object.keys(result).length;
  console.log(`📊 Found ${tableCount} tables with file columns.`);
  for (const [table, cols] of Object.entries(result)) {
    console.log(`  - ${table}: ${cols.join(", ")}`);
  }

  return result;
}

/**
 * Download all files from a table. Skip tables that already have download directories.
 */
async function downloadFilesFromTable(tableName, fileColumns, concurrency = 5) {
  console.log(`\n📦 Fetching records from "${tableName}"...`);

  if (!fileColumns.length) {
    console.log(`ℹ️ No file columns specified. Skipping.`);
    return;
  }

  const table = xata.db[tableName];
  if (!table) {
    console.warn(`⚠️ Table "${tableName}" not found. Skipping.`);
    return;
  }

  const baseDir = path.resolve(`./file-downloads/${tableName}`);
  fs.mkdirSync(baseDir, { recursive: true });

  const existingFiles = fs
    .readdirSync(baseDir)
    .filter((f) => f !== ".DS_Store");
  if (existingFiles.length > 0) {
    console.log(
      `⏭ Table "${tableName}" already has downloaded files (${existingFiles.length}). Skipping entire table.`
    );
    return;
  }

  const columns = fileColumns.flatMap((col) => [
    `${col}.name`,
    `${col}.signedUrl`,
  ]);

  let fileCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const limit = pLimit(concurrency);

  /** Retry wrapper */
  async function retry(fn, label, retries = 2) {
    try {
      return await fn();
    } catch (err) {
      if (retries <= 0) throw err;
      console.warn(`⚠️ Retry for ${label}, attempts left: ${retries}`);
      await new Promise((r) => setTimeout(r, 500));
      return retry(fn, label, retries - 1);
    }
  }

  /** Download a single file safely */
  async function downloadFile(file, recordId, colName) {
    const ext = path.extname(file.name);
    const base = path.basename(file.name, ext);
    const newName = `${base}__${recordId}${ext}`;
    const filePath = path.join(baseDir, newName);

    if (fs.existsSync(filePath)) {
      console.log(`⏭ Already exists, skipping: ${newName}`);
      skippedCount++;
      return true;
    }

    const label = `${newName} (record ${recordId})`;

    // Try signedUrl from record
    if (file.signedUrl) {
      try {
        const res = await retry(() => fetch(file.signedUrl), label);
        if (res.ok && res.body) {
          await new Promise((resolve, reject) => {
            const stream = fs.createWriteStream(filePath);
            res.body.pipe(stream);
            res.body.on("error", reject);
            stream.on("finish", resolve);
          });
          console.log(`✅ Saved (signedUrl): ${label}`);
          fileCount++;
          return true;
        }
      } catch (err) {
        console.warn(`⚠️ SignedUrl fetch failed for ${label}: ${err.message}`);
      }
    }

    // Fallback: signedUrl fetch via REST/curl if signedUrl is null in record
    if (!file.signedUrl) {
      try {
        const res = await fetch(
          `${DATABASE_URL}/tables/${tableName}/data/${recordId}?columns=${colName}.signedUrl`,
          {
            headers: { Authorization: `Bearer ${API_KEY}` },
          }
        );
        if (res.ok) {
          const json = await res.json();
          const fetchedFile = Array.isArray(json[colName])
            ? json[colName][0]
            : json[colName];
          if (fetchedFile?.signedUrl) {
            const signedRes = await retry(
              () => fetch(fetchedFile.signedUrl),
              label
            );
            if (signedRes.ok && signedRes.body) {
              await new Promise((resolve, reject) => {
                const stream = fs.createWriteStream(filePath);
                signedRes.body.pipe(stream);
                signedRes.body.on("error", reject);
                stream.on("finish", resolve);
              });
              console.log(`✅ Saved (fetched signedUrl): ${label}`);
              fileCount++;
              return true;
            }
          }
        }
      } catch (err) {
        console.warn(
          `⚠️ REST signedUrl fetch failed for ${label}: ${err.message}`
        );
      }
    }

    console.warn(`❌ Could NOT download ${label}`);
    failedCount++;
    return false;
  }

  // Pagination loop
  let page = await table
    .select(columns)
    .getPaginated({ pagination: { size: 20 }, consistency: "eventual" });

  while (page && page.records.length > 0) {
    console.log(`📄 Processing ${page.records.length} records...`);

    for (const record of page.records) {
      for (const col of fileColumns) {
        const value = record[col];
        if (!value) continue;
        const files = Array.isArray(value) ? value : [value];

        const tasks = files.map((file) =>
          limit(() => downloadFile(file, record.xata_id, col))
        );
        await Promise.all(tasks);
      }
    }

    const more = page.meta?.page?.more;
    if (!more) break;
    page = await page.nextPage();
  }

  console.log(`\n🎉 Finished downloading files for "${tableName}"`);
  console.log(`   ✔ Successfully downloaded: ${fileCount}`);
  console.log(`   ⏭ Skipped (already exists): ${skippedCount}`);
  console.log(`   ❌ Failed:                 ${failedCount}`);
}

/**
 * Main entry
 */
async function main() {
  try {
    const tablesWithFiles = parseSchemaForFileTables(SCHEMA_FILE);

    if (Object.keys(tablesWithFiles).length === 0) {
      console.log("ℹ️ No tables with file columns found. Exiting.");
      return;
    }

    for (const [tableName, fileColumns] of Object.entries(tablesWithFiles)) {
      try {
        await downloadFilesFromTable(tableName, fileColumns);
      } catch (err) {
        console.error(`❌ Error processing table "${tableName}":`, err.message);
      }
    }

    console.log("\n✅ All downloads complete.");
  } catch (err) {
    console.error("❌ Fatal error:", err.message);
  }
}

await main();
