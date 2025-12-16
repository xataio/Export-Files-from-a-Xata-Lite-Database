import { getXataClient } from "./src/xata.js";
import "dotenv/config";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import pLimit from "p-limit";

const xata = getXataClient();

const API_KEY = process.env.XATA_API_KEY;
const DATABASE_URL = process.env.XATA_DATABASE_URL;
const BRANCH = process.env.XATA_BRANCH || "main";

if (!API_KEY || !DATABASE_URL) {
  console.error("❌ Missing XATA_API_KEY or XATA_DATABASE_URL in .env");
  process.exit(1);
}

/**
 * Fetch all tables and detect which ones contain file-type columns.
 */
async function getAllTablesWithFiles() {
  console.log("📡 Fetching full database schema...");

  const baseUrl = DATABASE_URL.includes(":")
    ? DATABASE_URL
    : `${DATABASE_URL}:${BRANCH}`;

  const res = await fetch(baseUrl, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(
      `❌ Failed to fetch database schema: ${res.status} ${res.statusText} (${baseUrl})`
    );
  }

  const data = await res.json();

  if (!data?.schema?.tables) {
    throw new Error(
      '❌ Schema format not recognized — missing "schema.tables"'
    );
  }

  const result = {};
  for (const table of data.schema.tables) {
    const fileColumns = (table.columns || [])
      .filter((col) => col.type === "file" || col.type === "file[]")
      .map((col) => col.name);

    if (fileColumns.length > 0) {
      result[table.name] = fileColumns;
    }
  }

  const tableCount = Object.keys(result).length;
  console.log(`📊 Found ${tableCount} tables with file columns.`);
  for (const [table, cols] of Object.entries(result)) {
    console.log(`  - ${table}: ${cols.join(", ")}`);
  }

  return result;
}

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
 * Main function: automatically detects all tables with file columns and downloads all files efficiently
 */
async function main() {
  try {
    const tablesWithFiles = await getAllTablesWithFiles();

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
