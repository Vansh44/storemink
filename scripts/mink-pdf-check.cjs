// Parse untrusted PDFs outside the server heap. No document actions are executed.
// Parent caps stdin, heap and wall time and never logs parser error details.
// Standalone Node child, intentionally outside the Next bundler.
/* eslint-disable @typescript-eslint/no-require-imports */
const {
  PDFDocument,
  PDFDict,
  PDFName,
  PDFArray,
  PDFStream,
} = require("pdf-lib");
// Pinned parser's typed-array decompression buffers are external to V8's heap.
// Cap them explicitly as well as isolating heap/wall time in the parent.
const DecodeStream = require("pdf-lib/cjs/core/streams/DecodeStream").default;
const ensureBuffer = DecodeStream.prototype.ensureBuffer;
let decodedAllocation = 0;
DecodeStream.prototype.ensureBuffer = function (requested) {
  if (
    !Number.isSafeInteger(requested) ||
    requested < 0 ||
    requested > 8 * 1024 * 1024 ||
    this.minBufferLength > 8 * 1024 * 1024
  )
    throw new Error("PDF expansion limit");
  let capacity = Math.max(512, this.minBufferLength);
  while (capacity < requested) capacity *= 2;
  decodedAllocation += Math.max(0, capacity - this.buffer.length);
  if (decodedAllocation > 32 * 1024 * 1024)
    throw new Error("PDF expansion budget");
  return ensureBuffer.call(this, requested);
};
const chunks = [];
let size = 0;
process.stdin.on("data", (chunk) => {
  size += chunk.length;
  if (size > 2 * 1024 * 1024) process.exit(1);
  chunks.push(chunk);
});
process.stdin.on("end", async () => {
  try {
    const doc = await PDFDocument.load(Buffer.concat(chunks), {
      throwOnInvalidObject: true,
      updateMetadata: false,
    });
    const pages = doc.getPageCount();
    if (doc.isEncrypted || pages < 1 || pages > 10) throw new Error();
    const forbidden = new Set([
      "JS",
      "JavaScript",
      "OpenAction",
      "AA",
      "Launch",
      "EmbeddedFiles",
      "XFA",
      "RichMedia",
      "AcroForm",
    ]);
    const pending = doc.context
      .enumerateIndirectObjects()
      .map((entry) => entry[1]);
    const visited = new Set();
    while (pending.length) {
      const object = pending.pop();
      if (visited.has(object)) continue;
      visited.add(object);
      if (visited.size > 100000) throw new Error();
      if (object instanceof PDFArray) pending.push(...object.asArray());
      if (object instanceof PDFStream) pending.push(object.dict);
      if (object instanceof PDFDict) {
        for (const key of object.keys())
          if (forbidden.has(key.decodeText())) throw new Error();
        const action = object.get(PDFName.of("S"));
        if (action instanceof PDFName && forbidden.has(action.decodeText()))
          throw new Error();
        pending.push(...object.values());
      }
    }
    process.stdout.write(String(pages));
  } catch {
    process.exitCode = 1;
  }
});
