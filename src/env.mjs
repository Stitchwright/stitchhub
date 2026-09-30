// Reads the .env file next to package.json when there is one (the README's steps without Docker), so a bare
// `npm start` finds the variables. Variables already set win over the file. This is the first import of server.mjs:
// db.mjs and checker.mjs read their variables when they are loaded.
import path from "node:path";

try {
  process.loadEnvFile(path.join(import.meta.dirname, "..", ".env"));
} catch {
  // No .env file (Docker and Railway pass the variables in): nothing to read.
}
