import type { RequestCaptureView } from "meritrouter";
import { Badge, Callout, Card, CardHeader, KeyValue } from "./ui";

function Text({ value }: { value: unknown }) {
  return <pre className="max-h-80 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-3 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">{typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "No content recorded."}</pre>;
}

/** Captured model content is escaped text. No previews, remote images or HTML rendering. */
export function RequestCapturePanel({ capture }: { capture: RequestCaptureView | null }) {
  if (!capture || (capture.availability === "unavailable" && capture.unavailableReason === "not_captured")) return null;
  if (capture.availability === "unavailable") return <Callout title="Request capture unavailable">{capture.unavailableReason?.replaceAll("_", " ") ?? "Capture data is unavailable"}. Any session-journal evidence below is a separate historical record.</Callout>;
  const input = capture.input;
  return <div className="min-w-0 space-y-4" data-request-capture={capture.availability}>
    <Callout title={capture.availability === "complete" ? "Captured model request" : "Partial model request capture"}>These are the normalized selected-endpoint inputs and observed response, captured for this physical request. Provider serialization and server defaults can differ. This is not the raw HTTP body or proof the task was accepted. Model content can contain private project data.</Callout>
    <Card><CardHeader title="Captured request input" description="Captured before provider invocation. Dispatch intent does not prove the provider received the request." /><div className="min-w-0 space-y-4 p-4">
      <KeyValue items={[["Dispatch", capture.dispatch.replaceAll("_", " ")], ["Model", input?.model ?? "Unavailable"], ["Maximum output tokens", input?.maxTokens ?? "Unavailable"], ["Temperature", input?.temperature ?? "Provider default"], ["Tool choice", input?.toolChoice ?? "Provider default"], ["Stored bytes", capture.storedBytes], ["Expires", capture.expiresAt ? new Date(capture.expiresAt).toISOString() : "Unavailable"]]} />
      {input?.messages.map(message => <details key={message.index} open={message.index === 0} className="min-w-0 rounded-lg border border-line p-3"><summary className="cursor-pointer text-sm"><Badge>{message.role}</Badge> Message {message.index + 1}</summary><div className="mt-3 space-y-3"><Text value={message.content} />{message.toolCallId ? <p className="break-all text-xs">Tool call: {message.toolCallId}</p> : null}{message.toolCalls?.map((call, i) => <div key={i}><p className="mb-1 break-all text-xs">{call.name} / {call.id}</p><Text value={call.arguments} /></div>)}</div></details>)}
      {input?.tools?.length ? <details className="min-w-0"><summary className="cursor-pointer text-sm">Tool definitions ({input.tools.length})</summary><div className="mt-3 space-y-3">{input.tools.map((tool, i) => <div key={i}><p className="mb-1 break-all text-sm">{tool.name}</p><Text value={tool.description} /><Text value={tool.parameters} /></div>)}</div></details> : null}
      {input?.responseFormat ? <details><summary className="cursor-pointer text-sm">Response format</summary><Text value={input.responseFormat} /></details> : null}
      {input?.webSearch ? <details><summary className="cursor-pointer text-sm">Search options</summary><Text value={input.webSearch} /></details> : null}
    </div></Card>
    <Card><CardHeader title="Captured observed response" description="Observed model output can be rejected later by routing or task verification." /><div className="min-w-0 space-y-3 p-4"><KeyValue items={[["Outcome", capture.outcome?.kind ?? "Unknown"], ["Finish reason", capture.output?.finishReason ?? "Not recorded"], ["HTTP status", capture.outcome?.httpStatus ?? "Not recorded"], ["Error kind", capture.outcome?.errorKind ?? "None recorded"], ["Policy violation", capture.outcome?.policyViolation ? "Yes" : "None recorded"]]} /><Text value={capture.output?.content} />{capture.output?.toolCalls.map((call, i) => <div key={i}><p className="mb-1 break-all text-sm">{call.name} / {call.id}</p><Text value={call.arguments} /></div>)}</div></Card>
    {capture.omissions.length ? <details className="min-w-0 rounded-lg border border-line p-3"><summary className="cursor-pointer text-sm text-warn-ink">Capture omissions ({capture.omissions.length})</summary><Text value={capture.omissions} /></details> : null}
  </div>;
}
