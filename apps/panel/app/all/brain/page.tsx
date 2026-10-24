import Link from "next/link";
import { getSy } from "@/lib/sy";
import { SetupScreen } from "@/components/setup";
import { PageHeader } from "@/components/page-header";
import { BrainMemory } from "@/components/client/brain-memory";

export const dynamic = "force-dynamic";
export const metadata = { title: "Global preferences" };

export default function GlobalBrainPage() {
  const result = getSy();
  if (!result.sy) return <SetupScreen error={result.error} configPath={result.configPath} />;
  return <div className="space-y-6"><PageHeader title="Global preferences" description="Your explicit instructions across projects. Preferences retain their scope, source, revisions and revocation history." actions={<Link href="/all/knowledge" className="text-sm text-accent-ink">Global Knowledge →</Link>} /><BrainMemory base="/all" globalOnly /></div>;
}
