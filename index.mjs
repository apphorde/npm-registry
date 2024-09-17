import createServer from "@cloud-cli/http";
import { pack } from "tar-stream";
import { parse as parseJS } from "acorn";
import { join, parse } from "node:path";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  statSync,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";

const dataDir = process.env.DATA_PATH;
const cacheDir = process.env.CACHE_PATH;
const enableDebug = !!process.env.DEBUG;
const validMethods = ["GET"];
const log = enableDebug ? console.log : () => {};

if (!cacheDir) {
  throw new Error("CACHE_PATH must be defined");
}

if (!dataDir) {
  throw new Error("DATA_PATH must be defined");
}

createServer(async function (request, response) {
  if (validMethods.includes(request.method) === false) {
    log("invalid method", request.method);
    return notFound(response);
  }

  const host = request.headers["x-forwarded-for"];
  const url = new URL(request.url, "http://" + host);

  // NPM encodes the package name as /@foo%2fbar
  const parts = decodeURIComponent(url.pathname.slice(1)).split("/");

  // [@foo, bar] => manifest
  // [@foo, bar, 0.1.0.tgz] => tarball
  const [scope, name, requestedVersion] = parts;

  if (!validateScope(scope)) {
    log("invalid scope", scope);
    return notFound(response);
  }

  if (!validatePackageName(name)) {
    log("invalid package", name);
    return notFound(response);
  }

  // npm info @foo/bar
  if (!requestedVersion) {
    const manifest = await generateManifest(scope, name, host);

    if (!manifest) {
      log("invalid manifest", scope, name);
      return notFound(response);
    }

    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-expose-headers", "*");
    response.setHeader("cache-control", "no-cache, no-store, max-age=0");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(manifest));
    return;
  }

  // npm install @foo/bar
  // [workingDir]/@foo/bar/0.1.0.mjs > @foo/bar/0.1.0.tgz
  const version = parse(requestedVersion).name;
  if (!validateVersion(version)) {
    log("invalid version", requestedVersion);
    return notFound(response);
  }

  const folder = join(dataDir, scope, name);
  const file = join(folder, version + ".mjs");

  if (!existsSync(file)) {
    log("file not found", scope, name, version);
    return notFound(response);
  }

  response.setHeader("content-type", "application/octet-stream");
  response.setHeader("cache-control", "public, max-age=31536000, immutable");

  const tarFile = join(cacheDir, `${scope}__${name}-${version}`);

  if (!existsSync(tarFile)) {
    await generateTarFile(scope, name, version, file, tarFile);
  }

  createReadStream(tarFile).pipe(response);
});

async function generateTarFile(scope, name, version, source, tarFile) {
  log("generating tarfile", scope, name);

  const content = await readFile(source, "utf-8");
  const dependencies = await findDependencies(content);
  const manifest = JSON.stringify({
    name: `${scope}/${name}`,
    version,
    dependencies,
    exports: "./index.mjs",
  });

  const tar = pack();
  const outputStream = createWriteStream(tarFile);
  tar.pipe(outputStream);

  tar.entry({ name: "package/package.json" }, manifest);
  tar.entry({ name: "package/index.mjs" }, content);
  tar.finalize();

  return new Promise((ok) => outputStream.on("close", ok));
}

async function generateManifest(scope, name, host) {
  const folder = join(dataDir, scope, name);

  if (!existsSync(folder)) {
    return null;
  }

  const packageName = `${scope}/${name}`;
  const validVersions = (await readdir(folder, { withFileTypes: true }))
    .filter((f) => f.isFile())
    .map((f) => parse(f.name).name)
    .filter((v) => validateVersion(v))
    .sort();

  if (!validVersions.length) {
    return null;
  }

  const latestVersion = validVersions[validVersions.length - 1];
  const versionDates = Object.fromEntries(
    validVersions.map((v) => [
      v,
      new Date(statSync(join(folder, v + ".mjs")).ctimeMs).toISOString(),
    ])
  );

  const versions = Object.fromEntries(
    await Promise.all(
      validVersions.map(async (version) => [
        version,
        {
          name: packageName,
          version,
          description: "",
          dist: {
            tarball: new URL(
              `/${scope}/${name}/${version}.tgz`,
              "https://" + host
            ).toString(),
          },
          dependencies: await findDependenciesFromFile(
            join(folder, version + ".mjs")
          ),
        },
      ])
    )
  );

  return {
    name: packageName,
    description: "",
    "dist-tags": {
      latest: latestVersion,
    },
    versions,
    time: {
      created: versionDates[validVersions[0]],
      modified: versionDates[latestVersion],
      ...versionDates,
    },
  };
}

async function findDependenciesFromFile(file) {
  const content = await readFile(file, "utf8");
  return findDependencies(content);
}

async function findDependencies(content) {
  const ast = parseJS(content, { ecmaVersion: 2023, sourceType: "module" });
  const imports = ast.body.filter((n) => n.type === "ImportDeclaration");
  const names = imports.map((imp) => imp.source.value);
  const dependencies = names
    .filter((name) => !name.startsWith("node:"))
    .map((name) => {
      if (name.slice(1).includes('@')) {
        const [left, right] = name.slice(1).split('@');
        return [name.charAt(0) + left, right];
      }

      return [name, "latest"]
    });

  return Object.fromEntries(dependencies);
}

function notFound(response) {
  response.writeHead(404).end("Not found");
}

function validateScope(scope) {
  return scope && /^@[a-z]+$/.test(String(scope));
}

function validatePackageName(name) {
  return name && /^[a-z-]+$/.test(String(name));
}

function validateVersion(version) {
  return version && /^\d+\.\d+\.\d+$/.test(String(version));
}
