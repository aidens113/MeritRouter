import Link from "next/link";
import { Card, EmptyState } from "@/components/ui";

export default function NotFound() {
  return (
    <Card>
      <EmptyState title="Not found" action={<Link href="/" className="text-sm text-accent-ink hover:underline">Back to the projects</Link>}>
        This page, project, task, or model does not exist. A project may be archived, a model removed by a scan, or an id mistyped.
      </EmptyState>
    </Card>
  );
}
