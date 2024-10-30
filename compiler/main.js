// @ts-check
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, relative } from "path";
import { sync } from "glob";
import { transformFile } from "@swc/core";
import { build } from "esbuild";
import { copyFile, writeFile } from "fs/promises";
import { findWithoutExtension } from "./util/FindWithoutExtension.js";
import JSON5 from "json5";
import process from "process";
import BPManifestTemplate from "./templates/BPManifestTemplate.js";
import RPManifestTemplate from "./templates/RPManifestTemplate.js";

/**
 * @type {string | undefined}
 */
const rootDir = process.env["ROOT_DIR"];

if (!rootDir) {
    throw new Error(
        "ROOT_DIR environment variable not found. This is a regolith pipeline bug?",
    );
}
console.log("Exporting add-on in working directory: " + process.env.FILTER_DIR);

// Cambiamos el directorio a la raíz del proyecto con la variable de entorno ROOT_DIR (see: https://bedrock-oss.github.io/regolith/guide/custom-filters#filter-environment-variables)
process.chdir(rootDir);

/**
 * @type {import("./main.js").IRegolithConfig}
 */
// Leemos el archivo config.json, que contiene información sobre regolith y el addon.
const regolithConfig = JSON5.parse(readFileSync("config.json").toString());
// Leemos el archivo vermillion.addon.json dentro de la carpeta 'src/main/resources', que contiene información vital para la construcción del addon final y sus manifests
const vermillionAddon = JSON5.parse(
    readFileSync("src/main/resources/vermillion.addon.json").toString(),
);

// Obtenemos la propiedad packs de regolithConfig
const { packs } = regolithConfig;

// Ubicación de la carpeta de caché del filtro. Aquí se guardara información persistente como las UUIDs del add-on
// const filterCache = "./.filters/compiler/cache";

// Si la carpeta de cache no existe, la creamos con mkdirSync (recursive: true para que cree cualquier carpeta intermediaria, en este caso no debería de existir ninguna carpeta faltante; no obstante, se busca evadir cualquier tipo de error).
// if (!existsSync(filterCache)) {
//     mkdirSync(filterCache, { recursive: true });
// }

// Ubicación del archivo uuids.json, que contiene las UUIDs del add-on.
const UUIDCacheFile = join("uuids.json");
/**
 * @type {import("./main.js").IUUIDCache | undefined}
 */
// Parseamos a JSON el archivo de UUIDs, si este no existe, lo dejamos como undefined.
let UUIDCache = existsSync(UUIDCacheFile)
    ? JSON5.parse(readFileSync(UUIDCacheFile).toString())
    : undefined;

// Si UUIDCache es undefined, creamos las UUIDs que se usarán de ahora en adelante al compilar.
if (!UUIDCache) {
    UUIDCache = {
        RP: {
            header: randomUUID(),
            resources: randomUUID(),
        },
        BP: {
            header: randomUUID(),
            data: randomUUID(),
            script: randomUUID(),
        },
    };
    writeFileSync(
        UUIDCacheFile,
        "// This file was generated automatically. DO NOT modify it unless necessary.\n" +
        JSON.stringify(UUIDCache, null, 4),
    );
}

// Constante que contiene las rutas a los folders temporales que contienen los datos copiados del add-on, para posteriormente procesarlos según sea necesario.
const tmpPacks = {
    behaviorPack: ".regolith/tmp/BP",
    resourcePack: ".regolith/tmp/RP",
    dataPath: ".regolith/tmp/data",
};

// Constante que contiene los templates de manifest para el behavior y resource pack, posteriormente serán cambiados a las UUIDs en el caché y según la información del archivo vermillion.addon.json.
const manifests = {
    behaviorPack: BPManifestTemplate,
    resourcePack: RPManifestTemplate,
};

const packVersion = vermillionAddon.version + "+" + vermillionAddon.target;
const packEngine = vermillionAddon.engine
    .trim()
    .split(".")
    .map((/**@type  {string} */ v) => Number(v.trim()));

(async () => {
    if (vermillionAddon.packs.behavior) {
        // Cambiamos la información del template según el caché y el archivo vermillion.addon.json
        manifests.behaviorPack.header.uuid = UUIDCache.BP.header;
        manifests.behaviorPack.header.name = vermillionAddon.name;
        manifests.behaviorPack.header.description = vermillionAddon.description;
        manifests.behaviorPack.header.version = packVersion;

        manifests.behaviorPack.header.min_engine_version = packEngine;

        // Cambiamos la informacion del modulo 'data' del addon.
        manifests.behaviorPack.modules[0].uuid = UUIDCache.BP.data;
        manifests.behaviorPack.modules[0].version = packVersion;
        manifests.behaviorPack.modules[0].description =
            vermillionAddon.description;

        // Si 'scripts' es 'true' en vermillion.addon.json, cambiamos la información del modulo 'script' del addon.
        if (vermillionAddon.scripts.export) {
            manifests.behaviorPack.modules[1].uuid = UUIDCache.BP.script;
            manifests.behaviorPack.modules[1].version = packVersion;
            manifests.behaviorPack.modules[1].description =
                vermillionAddon.description;

            /**
             * Compilamos los scripts.
             */
            // Parseamos el archivo tsconfig.json
            const tsconfig = JSON5.parse(
                readFileSync("tsconfig.json").toString(),
            );

            const mainEntryPoint = vermillionAddon.scripts.entrypoints
                .map((/**@type {string}*/ entry) => `import "${entry}";\n`)
                .toString();

            const indexExists =
                existsSync(tmpPacks.dataPath + "/index.js") ||
                existsSync(tmpPacks.dataPath + "/index.ts");

            if (!indexExists) {
                writeFileSync(tmpPacks.dataPath + "/index.ts", mainEntryPoint);
                manifests.behaviorPack.modules[1].entry = "scripts/index.js";
            } else {
                writeFileSync(
                    tmpPacks.dataPath + "/___index___.ts",
                    mainEntryPoint,
                );
                manifests.behaviorPack.modules[1].entry =
                    "scripts/___index___.js";
            }

            const files = sync(".regolith/tmp/data/**/*.{ts,js}");

            let initialTime = Date.now();

            await Promise.all(
                files.map((file) =>
                    transformFile(file, {
                        jsc: {
                            parser: {
                                syntax: "typescript",
                                tsx: false,
                                decorators: true,
                            },
                            transform: {
                                legacyDecorator: true,
                                decoratorMetadata: true,
                            },
                            target: "esnext",
                            baseUrl: ".regolith/tmp/data",
                            paths: tsconfig.compilerOptions.paths,
                        },
                        sourceMaps: true,
                        module: {
                            type: "es6",
                            // @ts-ignore
                            resolveFully: true,
                        },
                    }).then((output) => {
                        const outPath = join(
                            tmpPacks.behaviorPack,
                            vermillionAddon.scripts.bundle
                                ? "../temp"
                                : "/scripts",
                            relative(tmpPacks.dataPath, file),
                        );
                        const outDir = dirname(outPath);

                        mkdirSync(outDir, { recursive: true });

                        if (output.map) {
                            writeFileSync(
                                outPath.replace(/\.ts$/, ".js.map"),
                                output.map,
                            );
                        }

                        writeFileSync(
                            outPath.replace(/\.ts$/, ".js"),
                            output.code,
                        );
                    }),
                ),
            )
                .then(() => {
                    console.log(
                        `Scripts compiled in ${Date.now() - initialTime}ms`,
                    );
                })
                .catch((error) => {
                    console.error(error);
                });

            if (vermillionAddon.scripts.bundle) {
                console.log("Started bundling the scripts");
                await build({
                    entryPoints: [
                        join(
                            tmpPacks.behaviorPack,
                            indexExists
                                ? "../temp/___index___.js"
                                : "../temp/index.js",
                        ),
                    ],
                    bundle: true,
                    minify: vermillionAddon.scripts.minify,
                    outfile: tmpPacks.behaviorPack + "/scripts/index.js",
                    platform: "node",
                    target: "es2020",
                    absWorkingDir: process.cwd(),
                    external: [
                        "@minecraft/server",
                        "@minecraft/server-ui",
                        "@minecraft/server-admin",
                        "@minecraft/server-gametest",
                        "@minecraft/server-net",
                        "@minecraft/server-common",
                        "@minecraft/server-editor",
                        "@minecraft/debug-utilities",
                        ...vermillionAddon.scripts.external,
                    ],
                    allowOverwrite: true,
                    format: "esm",
                    logLevel: "info",
                    tsconfig: "./tsconfig.json",
                    plugins: [],
                    sourcemap: true,
                    treeShaking: false,
                })
                    .catch((error) => {
                        console.error(error);
                    })
                    .then(() => { });

                manifests.behaviorPack.modules[1].entry = "scripts/index.js";
            }

            for (const moduleName in vermillionAddon.scripts.dependencies) {
                manifests.behaviorPack.dependencies.push({
                    module_name: moduleName,
                    version: vermillionAddon.scripts.dependencies[moduleName],
                });
            }
        } else {
            // Si 'scripts' es 'false' entonces borramos el modulo para evitar conflictos.
            manifests.behaviorPack.modules = [
                manifests.behaviorPack.modules[0],
            ];
        }

        if (vermillionAddon.packs.resource) {
            manifests.behaviorPack.dependencies.push({
                uuid: UUIDCache.RP.header,
                version: packVersion,
            });
        }

        // Escribimos el manifest del behavior pack.
        await writeFile(
            join(tmpPacks.behaviorPack, "manifest.json"),
            JSON.stringify(manifests.behaviorPack, null, 4),
        );
    }
    if (vermillionAddon.packs.resource) {
        manifests.resourcePack.header.uuid = UUIDCache.RP.header;
        manifests.resourcePack.header.name = vermillionAddon.name;
        manifests.resourcePack.header.description = vermillionAddon.description;

        manifests.resourcePack.header.version = packVersion;
        manifests.resourcePack.header.min_engine_version = packEngine;

        // Cambiamos la informacion del modulo 'resources' del addon.
        manifests.resourcePack.modules[0].uuid = UUIDCache.RP.resources;
        manifests.resourcePack.modules[0].description =
            vermillionAddon.description;
        manifests.resourcePack.modules[0].version = packVersion;

        if (vermillionAddon.packs.behavior) {
            manifests.resourcePack.dependencies.push({
                uuid: UUIDCache.BP.header,
                version: packVersion,
            });
        }

        // Escribimos el manifest del resource pack.
        await writeFile(
            join(tmpPacks.resourcePack, "manifest.json"),
            JSON.stringify(manifests.resourcePack, null, 4),
        );
    }

    // Si existe un archivo llamado "LICENSE" dentro de la raíz del proyecto, lo escribimos en el behavior y resoruce pack con extensión .txt
    if (existsSync("LICENSE")) {
        if (vermillionAddon.packs.behavior) {
            copyFile("LICENSE", join(tmpPacks.behaviorPack, "LICENSE.txt"));
        }
        if (vermillionAddon.packs.resource) {
            copyFile("LICENSE", join(tmpPacks.resourcePack, "LICENSE.txt"));
        }
    }

    // Si existe un archivo llamado "pack_icon" dentro de 'src/main/resources', usamos la funcion findWithoutExtension, para que pueda ser .jpg o .png, sin embargo, debería ser png xd
    const packIcon = findWithoutExtension("./src/main/resources/", "pack_icon");

    if (packIcon) {
        if (vermillionAddon.packs.behavior) {
            copyFile(packIcon.path, join(tmpPacks.behaviorPack, packIcon.baseName + packIcon.extension));
        }
        if (vermillionAddon.packs.resource) {
            copyFile(packIcon.path, join(tmpPacks.resourcePack, packIcon.baseName + packIcon.extension));
        }
    }
})();
