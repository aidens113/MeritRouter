import { openDatabase } from "../../dist/storage/db.js";
import { ProviderCapacity } from "../../dist/gateway/capacity.js";
const [storage, platform, leaseText, settingsText] = process.argv.slice(2);
const db = openDatabase(storage);
try {
  const lease = JSON.parse(leaseText), capacity = new ProviderCapacity();
  capacity.attach(db, () => JSON.parse(settingsText), () => 120000);
  const result = capacity.tryAcquire({ id: "independent-fixture", leases: [lease], taskIds: [lease.taskId], leaseOwner: lease.owner, priority: 0, since: null }, platform);
  process.stdout.write(JSON.stringify(result));
  if (!("full" in result)) capacity.release(result);
} finally { db.close(); }
