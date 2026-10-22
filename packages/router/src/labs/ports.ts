import net from "node:net";
import type { Db } from "../storage/db.js";
export function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => { const server = net.createServer(); server.once("error", () => resolve(false)); server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true))); });
}
/** Unique reservations serialize across owners; OS-bound ports are checked and skipped. */
export async function allocatePorts(db: Db, labId: string, names: string[], range: [
  number,
  number
]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    for (const name of names) {
      let found = false;
      for (let port = range[0]; port <= range[1]; port++) {
        const r = db.prepare("INSERT OR IGNORE INTO lab_ports (port,lab_id,name) VALUES (?,?,?)").run(port, labId, name);
        if (!r.changes)
          continue;
        if (await portAvailable(port)) {
          out[name] = port;
          found = true;
          break;
        }
        db.prepare("DELETE FROM lab_ports WHERE port=? AND lab_id=?").run(port, labId);
      }
      if (!found)
        throw new Error("lab port range exhausted");
    }
    return out;
  }
  catch (err) {
    db.prepare("DELETE FROM lab_ports WHERE lab_id=?").run(labId);
    throw err;
  }
}
