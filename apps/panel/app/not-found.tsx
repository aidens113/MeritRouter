import Link from "next/link";
import { Card, EmptyState } from "@/components/ui";

export default function NotFound() {
  return (
    <Card>
      <EmptyState title="Not found" action={<Link href="/" className="text-sm text-accent-ink hover:underline">Back to the overview</Link>}>
        This page, task, or model does not exist. A model may have been removed by a scan, or a task id may be mistyped.
      </EmptyState>
    </Card>
  );
}
