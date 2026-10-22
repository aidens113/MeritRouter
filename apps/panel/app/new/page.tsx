import path from "node:path";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getSy } from "@/lib/sy";
import { SetupScreen } from "@/components/setup";
import { Card, Mono } from "@/components/ui";
import { PageHeader } from "@/components/page-header";
import { NewProjectForm } from "@/components/client/new-project";

export const dynamic = "force-dynamic";
export const metadata = { title: "New project" };

/** Create a project; on success the form opens its overview at /p/<slug>. */
export default function NewProjectPage() {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const configDir = path.dirname(r.sy.cfg.configPath);
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href="/" className="inline-flex items-center gap-1 text-sm text-ink-3 hover:text-ink">
        <ArrowLeft size={14} aria-hidden /> Projects
      </Link>
      <PageHeader
        title="New project"
        description={
          <>
            A project groups repositories with their jobs, tasks, sessions, and knowledge. It is saved as <Mono>projects.&lt;slug&gt;</Mono> in <Mono>{r.sy.cfg.configPath}</Mono>; running workers pick it up within seconds.
          </>
        }
      />
      <Card className="p-4 sm:p-6">
        <NewProjectForm configDir={configDir} />
      </Card>
    </div>
  );
}
