import { Radar } from "lucide-react";
import { insights, MODALITIES } from "switchyard-router";
import { getSy } from "@/lib/sy";
import { toRow } from "@/lib/models";
import { SetupScreen } from "@/components/setup";
import { Card, Mono, PageHeader } from "@/components/ui";
import { ActionButton } from "@/components/client/actions";
import { ModelsTable } from "@/components/client/models-table";

export const dynamic = "force-dynamic";
export const metadata = { title: "Models" };

export default function ModelsPage() {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const sy = r.sy;
  const views = insights.modelsView(sy);
  const rows = views.map((v) => toRow(sy, v));
  return (
    <div>
      <PageHeader
        title="Models"
        description={
          <>
            Every model SwitchYard knows about, whether it can be used, and why. Click a model for its full eligibility, evidence, and controls. Manual entries come from <Mono>{sy.cfg.models.file ?? "no models file"}</Mono>.
          </>
        }
        actions={
          <ActionButton url="/api/scan" variant="primary" success="Scan finished">
            <Radar size={14} aria-hidden /> Scan now
          </ActionButton>
        }
      />
      <Card className="p-4">
        <ModelsTable rows={rows} profiles={Object.keys(sy.cfg.profiles)} modalities={[...MODALITIES]} />
      </Card>
    </div>
  );
}
