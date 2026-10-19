import type { ComponentType, ReactNode } from "react";
import { AudioLines, Ban, CircleCheck, CircleDashed, FileText, Image as ImageIcon, ShieldAlert, Trash2, TriangleAlert, Type, Video } from "lucide-react";
import type { ModelEndpoint } from "switchyard-router";
import { Badge, type Tone } from "./ui";

export type StatusKey = "active" | "pending_confirmation" | "disabled" | "removed" | "quarantined";

export const STATUS_LABEL: Record<StatusKey, string> = {
  active: "Active",
  pending_confirmation: "Needs confirmation",
  disabled: "Disabled",
  removed: "Removed",
  quarantined: "Quarantined",
};

export function statusKey(ep: Pick<ModelEndpoint, "status">, quarantined: string | null): StatusKey {
  return quarantined ? "quarantined" : ep.status;
}

export function StatusBadge({ status, title }: { status: StatusKey; title?: string }) {
  const map: Record<StatusKey, { tone: Tone; icon: ReactNode }> = {
    active: { tone: "good", icon: <CircleCheck size={12} aria-hidden /> },
    pending_confirmation: { tone: "warn", icon: <TriangleAlert size={12} aria-hidden /> },
    disabled: { tone: "neutral", icon: <Ban size={12} aria-hidden /> },
    removed: { tone: "neutral", icon: <Trash2 size={12} aria-hidden /> },
    quarantined: { tone: "bad", icon: <ShieldAlert size={12} aria-hidden /> },
  };
  const m = map[status];
  return (
    <Badge tone={m.tone} icon={m.icon} {...(title ? { title } : {})}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}

export type ParamsInfo = { source: string; confidence: string; confirmed: boolean };

export function provenance(p: ParamsInfo): { label: string; tone: Tone; detail: string } {
  if (p.confidence === "exact") {
    const from = p.source === "huggingface" ? "Hugging Face" : p.source === "override" ? "your override" : p.source === "manual" ? "manual entry" : p.source;
    return { label: `Exact (${from})`, tone: "good", detail: `Exact parameter count from ${from}.` };
  }
  if (p.confidence === "agreed") return { label: "Agreed", tone: "good", detail: "Independent sources agree on the parameter count." };
  if (p.confidence === "heuristic")
    return p.confirmed
      ? { label: "From name (confirmed)", tone: "accent", detail: "Parsed from the model name or description and confirmed by you." }
      : { label: "From name only", tone: "warn", detail: "Parsed from the model name or description only: confirm it before the model is used." };
  return { label: "Unknown", tone: "bad", detail: "No source reports a parameter count." };
}

export function ProvenanceBadge({ params }: { params: ParamsInfo }) {
  const p = provenance(params);
  return (
    <Badge tone={p.tone} title={p.detail} icon={params.confidence === "unknown" ? <CircleDashed size={12} aria-hidden /> : undefined}>
      {p.label}
    </Badge>
  );
}

const MODALITY_ICON: Record<string, { icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>; label: string }> = {
  text: { icon: Type, label: "Text" },
  image: { icon: ImageIcon, label: "Images" },
  audio: { icon: AudioLines, label: "Audio" },
  video: { icon: Video, label: "Video" },
  file: { icon: FileText, label: "Files" },
};

export function Modalities({ list, showLabels = false }: { list: string[]; showLabels?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1" aria-label={`Reads ${list.join(", ")}`}>
      {list.map((m) => {
        const def = MODALITY_ICON[m];
        const Icon = def?.icon ?? Type;
        return (
          <span key={m} title={def?.label ?? m} className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-2">
            <Icon size={12} aria-hidden />
            {showLabels ? (def?.label ?? m) : <span className="sr-only">{def?.label ?? m}</span>}
          </span>
        );
      })}
    </span>
  );
}
