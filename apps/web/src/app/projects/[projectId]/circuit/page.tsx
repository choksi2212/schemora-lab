import { CircuitWorkspace } from '@/components/circuit-workspace';

export default async function CircuitPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <CircuitWorkspace projectId={projectId} />;
}
