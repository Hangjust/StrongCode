import { link, mkdir, open, rm, unlink } from "node:fs/promises";
import https from "node:https";
import type { ArtifactFileSystem, ArtifactHttpClient } from "./artifacts";

export const nodeArtifactHttpClient: ArtifactHttpClient = {
  open(url, signal) {
    return new Promise((resolve, reject) => {
      const request = https.request(url, {
        method: "GET",
        signal,
        headers: { "accept-encoding": "identity", "user-agent": "StrongCode artifact verifier" }
      }, response => resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: response,
        cancel: () => response.destroy()
      }));
      request.once("error", reject);
      request.end();
    });
  }
};

export const nodeArtifactFileSystem: ArtifactFileSystem = {
  async mkdir(directory) {
    await mkdir(directory, { recursive: true });
  },
  async openExclusive(filePath) {
    const handle = await open(filePath, "wx", 0o600);
    let position = 0;
    return {
      async write(chunk) {
        let offset = 0;
        while (offset < chunk.byteLength) {
          const result = await handle.write(chunk, offset, chunk.byteLength - offset, position);
          offset += result.bytesWritten;
          position += result.bytesWritten;
        }
      },
      async sync() { await handle.sync(); },
      async close() { await handle.close(); }
    };
  },
  async publishExclusive(temporaryPath, destinationPath) {
    await link(temporaryPath, destinationPath);
    await unlink(temporaryPath);
  },
  async remove(filePath) {
    await rm(filePath, { force: true });
  }
};
