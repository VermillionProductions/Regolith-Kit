import fs from "fs"
import path from "path"

export function findWithoutExtension(directory, filename) {
    const files = fs.readdirSync(directory);

    for (const file of files) {
        const filePath = path.parse(file);
        const baseName = filePath.name;

        if (baseName === filename) {
            return { path: path.join(directory, file), baseName, extension: filePath.ext };
        }
    }

    return null;
}