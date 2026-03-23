import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const root = process.cwd();
const outDir = path.join(root, "release");
const outNodeModules = path.join(outDir, "node_modules");
const withPortableNode = process.argv.includes("--with-node");
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
echo Starting vfsbot...
${runNode}
echo.
echo Process exited.
pause
`;
  fs.writeFileSync(path.join(outDir, "start.bat"), content, "utf8");
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
4) Double click start.bat.
`;
  fs.writeFileSync(path.join(outDir, "README.txt"), content, "utf8");
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
  cp(path.join(root, "node_modules"), outNodeModules);
  pruneNodeModules();
  copyPackageJsonForRuntime();

  const copiedEnv = copyIfExists(path.join(root, ".env"), path.join(outDir, ".env"));
  if (!copiedEnv) {
    copyIfExists(path.join(root, ".env.example"), path.join(outDir, ".env.example"));
  } else {
    copyIfExists(path.join(root, ".env"), path.join(outDir, ".env.example"));
  }

  if (withPortableNode) {
    await addPortableNodeRuntime();
  }

  writeStartBat(withPortableNode);
  writeReadme(withPortableNode);

  console.log("Release packed at:", outDir);
}

await main();
