import { getSy } from "@/lib/sy";
import { connectionsView, syncConnections } from "@/lib/connections";
import { SetupScreen } from "@/components/setup";
import { PageHeader } from "@/components/page-header";
import { Connections } from "@/components/client/connections";

export const dynamic = "force-dynamic";
export const metadata = { title: "Connections" };

export default async function ConnectionsPage() {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  await syncConnections(r.sy);
  return <div className="space-y-6">
    <PageHeader title="Connections" description="Use MeritRouter from your editor or chat app through a local Ollama or OpenAI-compatible connection." />
    <Connections initial={connectionsView(r.sy)} />
  </div>;
}
