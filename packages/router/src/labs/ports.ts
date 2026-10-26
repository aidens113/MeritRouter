import net from "node:net";
import { z } from "zod";
import type { Db } from "../storage/db.js";
import { readStoreIdentity } from "../projects/store-identity.js";
import type { ProjectLabPortReservations } from "./port-reservations.js";
export function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}
/** Unique reservations serialize across owners; OS-bound ports are checked and skipped. */
export async function allocatePorts(db: Db, labId: string, names: string[], range: [
  number,
  number
], authority?:ProjectLabPortReservations): Promise<Record<string, number>> {
  z.string().min(1).max(256).parse(labId);
  z.array(z.string().min(1).max(256)).max(256).refine(values=>new Set(values).size===values.length).parse(names);
  z.tuple([z.number().int().min(1).max(65535),z.number().int().min(1).max(65535)]).refine(([start,end])=>start<=end).parse(range);
  const identity=readStoreIdentity(db);
  if(identity?.role==="coordination"||identity?.role==="project"&&(!authority||!authority.usesDatabase(db))||authority&&!authority.usesDatabase(db))throw new Error("Project Lab allocation requires explicit shared port authority");
  const out: Record<string, number> = {};
  try {
    for (const name of names) {
      const prior=authority?.current(labId,name);
      if(prior!==undefined&&prior!==null){
        if(prior<range[0]||prior>range[1])throw new Error("Retained Lab port is outside configured range");
        authority!.reserve(labId,name,prior);
        if(await portAvailable(prior)){db.prepare("INSERT OR IGNORE INTO lab_ports(port,lab_id,name) VALUES(?,?,?)").run(prior,labId,name);if(!db.prepare("SELECT 1 FROM lab_ports WHERE port=? AND lab_id=? AND name=?").get(prior,labId,name))throw new Error("Local Lab port projection conflicts with its global owner");out[name]=prior;continue;}
        authority!.release(labId,name);
        db.prepare("DELETE FROM lab_ports WHERE port=? AND lab_id=? AND name=?").run(prior,labId,name);
      }
      let found = false;
      for (let port = range[0]; port <= range[1]; port++) {
        if(authority&&!authority.reserve(labId,name,port))continue;
        const r = db.prepare("INSERT OR IGNORE INTO lab_ports (port,lab_id,name) VALUES (?,?,?)").run(port, labId, name);
        if (!r.changes){
          const owned=db.prepare("SELECT 1 FROM lab_ports WHERE port=? AND lab_id=? AND name=?").get(port,labId,name);
          if(owned&&authority){if(await portAvailable(port)){out[name]=port;found=true;break;}db.prepare("DELETE FROM lab_ports WHERE port=? AND lab_id=? AND name=?").run(port,labId,name);}
          authority?.release(labId,name);
          continue;
        }
        if (await portAvailable(port)) {
          out[name] = port;
          found = true;
          break;
        }
        db.prepare("DELETE FROM lab_ports WHERE port=? AND lab_id=?").run(port, labId);
        authority?.release(labId,name);
      }
      if (!found)
        throw new Error("lab port range exhausted");
    }
    return out;
  }
  catch (err) {
    authority?.release(labId);
    db.prepare("DELETE FROM lab_ports WHERE lab_id=?").run(labId);
    throw err;
  }
}
