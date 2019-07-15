// From https://github.com/dropbox/dropbox-api-content-hasher/blob/master/js-node/dropbox-content-hasher.js
/**
 * Computes a hash using the same algorithm that the Dropbox API uses for the
 * the "content_hash" metadata field.
 *
 * The `digest()` method returns a raw binary representation of the hash.
 * The "content_hash" field in the Dropbox API is a hexadecimal-encoded version
 * of the digest.
 *
 * Example:
 *
 *     const fs = require('fs');
 *     const dch = require('dropbox-content-hasher');
 *
 *     const hasher = dch.create();
 *     const f = fs.createReadStream('some-file');
 *     f.on('data', function(buf) {
 *       hasher.update(buf);
 *     });
 *     f.on('end', function(err) {
 *       const hexDigest = hasher.digest('hex');
 *       console.log(hexDigest);
 *     });
 *     f.on('error', function(err) {
 *       console.error("Error reading from file: " + err);
 *       process.exit(1);
 *     });
 */

import { AssertionError } from 'assert';
import { createHash, Hash, HexBase64Latin1Encoding } from 'crypto';

const BLOCK_SIZE = 4 * 1024 * 1024;

class DropboxContentHasher {
  private overallHasher: Hash | null;
  private blockHasher: Hash | null;
  private blockPos: number;
  constructor(
    overallHasher: Hash = createHash('sha256'),
    blockHasher: Hash = createHash('sha256'),
    blockPos: number = 0,
  ) {
    this.overallHasher = overallHasher;
    this.blockHasher = blockHasher;
    this.blockPos = blockPos;
  }

  public digest(encoding: HexBase64Latin1Encoding) {
    if (this.overallHasher === null) {
      throw new AssertionError({ message: "can't use this object anymore; you already called digest()" });
    }

    if (this.blockPos > 0) {
      this.overallHasher.update((this.blockHasher as Hash).digest());
      this.blockHasher = null;
    }
    const r = this.overallHasher.digest(encoding);
    this.overallHasher = null; // Make sure we can't use this object anymore.
    return r;
  }
  public update(data: Buffer, inputEncoding?: string) {
    if (this.overallHasher === null) {
      throw new AssertionError({ message: "can't use this object anymore; you already called digest()" });
    }

    if (!Buffer.isBuffer(data)) {
      if (
        inputEncoding !== undefined &&
        inputEncoding !== 'utf8' &&
        inputEncoding !== 'ascii' &&
        inputEncoding !== 'latin1'
      ) {
        // The docs for the standard hashers say they only accept these three encodings.
        throw new Error("Invalid 'inputEncoding': " + JSON.stringify(inputEncoding));
      }
      data = Buffer.from(data, inputEncoding);
    }

    let offset = 0;
    while (offset < data.length) {
      if (this.blockPos === BLOCK_SIZE) {
        this.overallHasher.update((this.blockHasher as Hash).digest());
        this.blockHasher = createHash('sha256');
        this.blockPos = 0;
      }

      const spaceInBlock = BLOCK_SIZE - this.blockPos;
      const inputPartEnd = Math.min(data.length, offset + spaceInBlock);
      const inputPartLength = inputPartEnd - offset;
      (this.blockHasher as Hash).update(data.slice(offset, inputPartEnd));

      this.blockPos += inputPartLength;
      offset = inputPartEnd;
    }
  }
}

export { DropboxContentHasher, BLOCK_SIZE };
