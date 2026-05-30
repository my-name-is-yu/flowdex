import { mkdir, open, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ArtifactRecord } from "../types.js";
import { sha256Bytes } from "../util/hash.js";

export class ArtifactStore {
  constructor(readonly root: string) {}

  async write(content: Uint8Array | string, mediaType: string, producer?: string): Promise<ArtifactRecord> {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    const sha256 = sha256Bytes(bytes);
    const directory = path.join(this.root, "sha256");
    await mkdir(directory, { recursive: true });
    const finalPath = path.join(directory, sha256);
    const tempPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(tempPath, "w");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, finalPath).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") {
        await writeFile(tempPath, "");
        return;
      }
      throw error;
    });
    const size = (await stat(finalPath)).size;
    const record: ArtifactRecord = {
      id: sha256,
      sha256,
      mediaType,
      size,
      path: finalPath,
      redactionStatus: "none"
    };
    if (producer !== undefined) record.producer = producer;
    return record;
  }
}
