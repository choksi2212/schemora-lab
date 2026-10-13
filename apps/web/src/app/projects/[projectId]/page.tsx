import { ProjectWorkspace } from '@/components/project-workspace';
export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ProjectWorkspace projectId={projectId} />;
}
