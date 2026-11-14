import net from "node:net";

/** In-process clamd INSTREAM server: replies FOUND for the EICAR marker, OK otherwise. Test-only. */
export function startFakeClamd() {
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const header = Buffer.from("zINSTREAM\0");
      if (buffer.length < header.length || !buffer.subarray(0, header.length).equals(header)) return;
      let offset = header.length; const parts: Buffer[] = [];
      while (buffer.length >= offset + 4) {
        const length = buffer.readUInt32BE(offset); offset += 4;
        if (length === 0) { socket.write(Buffer.concat(parts).toString("utf8").includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE") ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0"); return; }
        if (buffer.length < offset + length) return;
        parts.push(buffer.subarray(offset, offset + length)); offset += length;
      }
    });
    socket.on("error", () => undefined);
  });
  return new Promise<{ server: net.Server; port: number }>(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as net.AddressInfo).port })));
}
