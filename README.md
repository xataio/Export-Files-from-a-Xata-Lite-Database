EXPORT ALL FILES FROM A XATA LITE DATABASE

In order to export all files from a Xata Lite database, please clone this repo and follow the steps below.

1. If your database is a pg-enabled database, export your database schema to your project directory by running the following command:

```bash
pg_dump \
  --no-acl \
  --no-owner \
  --no-table-access-method \
  --no-privileges \
  --schema=public \
  --host=<host-region> \
  --username=<workspace-id> \
  --dbname=<database-name>:<branch> \
  --password \
  --schema-only \
  > xata-schema.sql
```

2. Use the Xata Lite CLI to initialise your project, selecting the options listed below:

```bash
✗ xata init
🦋 Initializing project... We will ask you some questions.

You have a single workspace, using it by default: Example-workspace-xxxxxx
# [Xata] Configuration used by the CLI and the SDK
✔ Select a database or create a new one › pg-enabled-database
✔ Generate code and types from your Xata database › JavaScript import syntax
✔ Choose the output path for the generated code … src/xata.js
✔ Do you want to generate the TypeScript declarations? … yes
✔ How should we install the @xata.io/client package? › npm
```

4. In your cloned directory, run:

```bash
npm install
```

5. Add your Xata Lite database URL to the `.env` file as `XATA_DATABASE_URL`. Remove the branch name from the URL (for example, ":main").

4. Download files from the database using the appropriate script:

```bash
node download-files-from-pg-enabled-db.mjs
```
or
```bash
node download-files-from-non-pg-enabled-db.mjs
```
