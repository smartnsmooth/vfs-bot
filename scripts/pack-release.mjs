import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = process.cwd();
const outDir = path.join(root, "release");
const outNodeModules = path.join(outDir, "node_modules");
const withPortableNode = process.argv.includes("--with-node");
const skipObfuscate = process.argv.includes("--no-obfuscate");
const nodeVersion = process.env.NODE_PORTABLE_VERSION ?? "v20.19.0";
const nodeZipName = `node-${nodeVersion}-win-x64.zip`;
const nodeZipUrl = `https://nodejs.org/dist/${nodeVersion}/${nodeZipName}`;
const cacheDir = path.join(os.tmpdir(), "vfsbot-release-cache");
const cachedNodeZipPath = path.join(cacheDir, nodeZipName);

function rmIfExists(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function cp(src, dst) {
  fs.cpSync(src, dst, { recursive: true, force: true });
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyIfExists(src, dst) {
  if (!fs.existsSync(src)) return false;
  cp(src, dst);
  return true;
}

function walkFiles(dir, ext) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(full, ext));
    else if (ent.name.endsWith(ext)) out.push(full);
  }
  return out;
}

/** Remove TypeScript emit artifacts that make reverse-engineering trivial. */
function stripSourceArtifacts(distDir) {
  for (const f of walkFiles(distDir, ".map")) rmIfExists(f);
  for (const f of walkFiles(distDir, ".ts")) {
    if (f.endsWith(".d.ts")) rmIfExists(f);
  }
}

/** Bake PACKAGED=true into release JS before obfuscation. */
function bakeReleaseMarkers(distDir) {
  let packagedHits = 0;
  for (const file of walkFiles(distDir, ".js")) {
    let src = fs.readFileSync(file, "utf8");
    if (!src.includes("/*@@P@@*/")) continue;
    const next = src.replace(/false\s*;\s*\/\*@@P@@\*\//g, "true; /*@@P@@*/");
    if (next !== src) {
      fs.writeFileSync(file, next, "utf8");
      packagedHits += 1;
    }
  }
  console.log(`Release bake: packagedFlag files=${packagedHits}`);
}

function obfuscateDist(distDir) {
  let JavaScriptObfuscator;
  try {
    JavaScriptObfuscator = require("javascript-obfuscator");
  } catch {
    throw new Error(
      "javascript-obfuscator is required for release packing. Run: npm i -D javascript-obfuscator",
    );
  }

  const jsFiles = walkFiles(distDir, ".js");
  console.log(`Obfuscating ${jsFiles.length} JS file(s) in release/dist ...`);
  for (const file of jsFiles) {
    const source = fs.readFileSync(file, "utf8");
    const result = JavaScriptObfuscator.obfuscate(source, {
      compact: true,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 0.75,
      deadCodeInjection: false,
      debugProtection: false,
      disableConsoleOutput: false,
      identifierNamesGenerator: "hexadecimal",
      renameGlobals: false,
      selfDefending: false,
      stringArray: true,
      stringArrayEncoding: ["base64"],
      stringArrayThreshold: 0.8,
      splitStrings: true,
      splitStringsChunkLength: 8,
      transformObjectKeys: true,
      unicodeEscapeSequence: false,
      target: "node",
    });
    fs.writeFileSync(file, result.getObfuscatedCode(), "utf8");
  }
}

function writeStartBat(usePortableNode) {
  const runNode = usePortableNode
    ? `set "NODE_EXE=%~dp0node\\node.exe"
if not exist "%NODE_EXE%" (
  echo Portable Node runtime is missing: "%NODE_EXE%"
  pause
  exit /b 1
)
"%NODE_EXE%" dist\\index.js`
    : `node dist\\index.js`;

  const content = `@echo off
setlocal
cd /d "%~dp0"
echo Starting vfsbot (single instance)...
${runNode}
echo.
echo Process exited.
pause
`;
  fs.writeFileSync(path.join(outDir, "start.bat"), content, "utf8");
}

function writeStartClusterBat(usePortableNode) {
  const runNode = usePortableNode
    ? `set "NODE_EXE=%~dp0node\\node.exe"
if not exist "%NODE_EXE%" (
  echo Portable Node runtime is missing: "%NODE_EXE%"
  pause
  exit /b 1
)
"%NODE_EXE%" dist\\cluster.js`
    : `node dist\\cluster.js`;

  const content = `@echo off
setlocal
cd /d "%~dp0"
echo Starting vfsbot cluster (multi-instance)...
${runNode}
echo.
echo Process exited.
pause
`;
  fs.writeFileSync(path.join(outDir, "start-cluster.bat"), content, "utf8");
}

function writeReadme(usePortableNode) {
  const nodeLine = usePortableNode
    ? "2) Node.js install is NOT required (portable runtime included in .\\node)."
    : "2) Install Node.js 20+.";
  const content = `vfsbot release

How to run:
1) Install Google Chrome.
${nodeLine}
3) Put your .env in this folder (copy .env.example to .env and edit).
4) Double click start.bat (single instance) OR start-cluster.bat (multiple instances).

Note: For cluster mode, set the number of instances from the setup form UI.
`;
  fs.writeFileSync(path.join(outDir, "README.txt"), content, "utf8");
}

/** Keys / prefixes that must never ship to the client (gate path + your private bypass). */
const CLIENT_ENV_DENY = [
  /^FIREBASE_/i,
  /^FIRESTORE_/i,
  /^REMOTE_RUN_/i,
  /^VFS_DEV_BYPASS_RUN_GATE$/i,
  /^VFS_RELEASE$/i,
  /^VFS_OPAQUE_PING_URL$/i,
  /^VFS_GATE_PROXY_URL$/i,
  /^GOOGLE_APPLICATION_CREDENTIALS$/i,
];

function isDeniedEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    if (/firebase|firestore|remote run gate|REMOTE_RUN|FIRESTORE_VFS|bypass_run|OPAQUE|GATE_PROXY/i.test(trimmed)) {
      return true;
    }
    return false;
  }
  const key = trimmed.split("=", 1)[0].trim();
  return CLIENT_ENV_DENY.some((re) => re.test(key));
}

function sanitizeEnvText(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !isDeniedEnvLine(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd() + "\n";
}

function writeSanitizedEnv(srcPath, destPath) {
  if (!fs.existsSync(srcPath)) return false;
  const sanitized = sanitizeEnvText(fs.readFileSync(srcPath, "utf8"));
  fs.writeFileSync(destPath, sanitized, "utf8");
  return true;
}

function copyPackageJsonForRuntime() {
  const pkgPath = path.join(root, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const runtimePkg = {
    name: pkg.name,
    version: pkg.version,
    private: true,
    main: "dist/index.js",
    dependencies: pkg.dependencies ?? {},
  };
  fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify(runtimePkg, null, 2), "utf8");
}

function pruneNodeModules() {
  rmIfExists(path.join(outNodeModules, ".bin"));
  rmIfExists(path.join(outNodeModules, "typescript"));
  rmIfExists(path.join(outNodeModules, "ts-node"));
  rmIfExists(path.join(outNodeModules, "@types"));
}

function downloadFile(url, targetPath) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`Download failed: HTTP ${res.statusCode ?? "unknown"} for ${url}`));
        res.resume();
        return;
      }
      ensureDir(path.dirname(targetPath));
      const file = fs.createWriteStream(targetPath);
      res.pipe(file);
      file.on("finish", () => {
        file.close(() => resolve());
      });
      file.on("error", reject);
    });
    req.on("error", reject);
  });
}

async function addPortableNodeRuntime() {
  const portableNodeDir = path.join(outDir, "node");
  const expandedDir = path.join(outDir, "__node_extracted");

  if (!fs.existsSync(cachedNodeZipPath)) {
    console.log(`Downloading portable Node runtime: ${nodeZipUrl}`);
    await downloadFile(nodeZipUrl, cachedNodeZipPath);
  } else {
    console.log(`Using cached portable Node zip: ${cachedNodeZipPath}`);
  }

  rmIfExists(expandedDir);
  ensureDir(expandedDir);
  const psCmd = `Expand-Archive -Path '${cachedNodeZipPath.replace(/'/g, "''")}' -DestinationPath '${expandedDir.replace(/'/g, "''")}' -Force`;
  execSync(`powershell -NoProfile -NonInteractive -Command "${psCmd}"`, { stdio: "inherit" });

  const extractedRoot = path.join(expandedDir, `node-${nodeVersion}-win-x64`);
  if (!fs.existsSync(path.join(extractedRoot, "node.exe"))) {
    throw new Error(`Portable Node extraction failed: node.exe missing under ${extractedRoot}`);
  }

  rmIfExists(portableNodeDir);
  cp(extractedRoot, portableNodeDir);
  rmIfExists(expandedDir);
}

async function main() {
  if (!fs.existsSync(path.join(root, "dist", "index.js"))) {
    throw new Error("Build output not found. Run npm run build first.");
  }

  rmIfExists(outDir);
  ensureDir(outDir);

  cp(path.join(root, "dist"), path.join(outDir, "dist"));
  stripSourceArtifacts(path.join(outDir, "dist"));
  bakeReleaseMarkers(path.join(outDir, "dist"));
  if (!skipObfuscate) {
    obfuscateDist(path.join(outDir, "dist"));
  } else {
    console.log("Skipping obfuscation (--no-obfuscate).");
  }

  cp(path.join(root, "node_modules"), outNodeModules);
  pruneNodeModules();
  copyPackageJsonForRuntime();

  // Ship client env without Firebase / gate keys (path is hardcoded + obfuscated in dist).
  const rootEnv = path.join(root, ".env");
  const rootExample = path.join(root, ".env.example");
  if (fs.existsSync(rootEnv)) {
    writeSanitizedEnv(rootEnv, path.join(outDir, ".env"));
    writeSanitizedEnv(rootEnv, path.join(outDir, ".env.example"));
  } else if (fs.existsSync(rootExample)) {
    writeSanitizedEnv(rootExample, path.join(outDir, ".env.example"));
  }

  if (withPortableNode) {
    await addPortableNodeRuntime();
  }

  writeStartBat(withPortableNode);
  writeStartClusterBat(withPortableNode);
  writeReadme(withPortableNode);

  console.log("Release packed at:", outDir);
}

await main();
