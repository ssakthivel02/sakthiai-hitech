import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, Clapperboard, Film, Image, Plus, RefreshCw, ShieldCheck } from "lucide-react";

export default function Creator() {
  const { isAuthenticated, loading } = useAuth();
  const [workspaceId, setWorkspaceId] = useState<number>();
  const [projectId, setProjectId] = useState<number>();
  const [projectName, setProjectName] = useState("Murugan Album Film");
  const [sceneTitle, setSceneTitle] = useState("Opening");
  const [shotTitle, setShotTitle] = useState("Murugan hero reveal");
  const [shotPrompt, setShotPrompt] = useState("Cinematic Murugan devotional film frame, respectful Tamil iconography, 16:9 composition");

  const workspaces = trpc.workspace.list.useQuery(undefined, { enabled: isAuthenticated });
  useEffect(() => {
    const id = workspaces.data?.[0]?.workspace.id;
    if (id) setWorkspaceId(id);
  }, [workspaces.data]);

  const creatorStatus = trpc.creator.status.useQuery(
    { workspaceId: workspaceId! },
    { enabled: Boolean(workspaceId) },
  );
  const projects = trpc.creator.workspace.listProjects.useQuery(
    { workspaceId: workspaceId! },
    { enabled: Boolean(workspaceId) },
  );
  useEffect(() => {
    if (!projectId && projects.data?.[0]?.id) setProjectId(projects.data[0].id);
  }, [projects.data, projectId]);

  const project = trpc.creator.workspace.getProject.useQuery(
    { workspaceId: workspaceId!, creatorProjectId: projectId! },
    { enabled: Boolean(workspaceId && projectId) },
  );
  const nextSceneIndex = useMemo(() => project.data?.scenes.length ?? 0, [project.data]);
  const selectedScene = project.data?.scenes[project.data.scenes.length - 1];
  const nextShotIndex = project.data?.shots.filter(shot => shot.sceneId === selectedScene?.id).length ?? 0;

  const createProject = trpc.creator.workspace.createProject.useMutation({
    onSuccess: created => {
      if (created?.id) setProjectId(created.id);
      projects.refetch();
    },
  });
  const createScene = trpc.creator.workspace.createScene.useMutation({ onSuccess: () => project.refetch() });
  const createShot = trpc.creator.workspace.createShot.useMutation({ onSuccess: () => project.refetch() });
  const submitImage = trpc.creator.submitImage.useMutation({ onSuccess: () => project.refetch() });
  const submitVideo = trpc.creator.submitVideo.useMutation({ onSuccess: () => project.refetch() });

  if (loading) return <div className="loading-screen">Loading Creator…</div>;
  if (!isAuthenticated) return <main className="landing"><h1>Creator requires an authenticated SakthiAI workspace.</h1><Link href="/">Return home</Link></main>;

  return (
    <main className="workspace" style={{ maxWidth: 1500, margin: "0 auto", padding: 24 }}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center", marginBottom: 20 }}>
        <div>
          <Link href="/"><Button variant="ghost" size="sm"><ArrowLeft size={16}/> Workspace</Button></Link>
          <div className="eyebrow">SAKTHIAI CREATOR · P0</div>
          <h2>Murugan film production workspace</h2>
          <p>Project → shots → generation jobs → timeline → governed review → final master.</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Badge variant="outline"><ShieldCheck size={14}/> Human approval required</Badge>
          <Badge variant="outline">{creatorStatus.data?.stage ?? "Runtime loading"}</Badge>
        </div>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 0.7fr) minmax(0, 2fr)", gap: 16 }}>
        <aside style={{ display: "grid", gap: 16, alignContent: "start" }}>
          <Card>
            <CardHeader><CardTitle>Creator projects</CardTitle></CardHeader>
            <CardContent style={{ display: "grid", gap: 10 }}>
              <Input value={projectName} onChange={event => setProjectName(event.target.value)} placeholder="Project name" />
              <Button disabled={!workspaceId || !projectName.trim() || createProject.isPending} onClick={() => createProject.mutate({ workspaceId: workspaceId!, name: projectName })}><Plus size={16}/> New Creator project</Button>
              <div className="list">
                {projects.data?.map(item => <button key={item.id} className="list-row" style={{ width: "100%", textAlign: "left", border: 0, cursor: "pointer" }} onClick={() => setProjectId(item.id)}><span>{item.name}</span><small>{item.status} · creatorProjectId {item.id}</small></button>)}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Provider evidence</CardTitle></CardHeader>
            <CardContent style={{ display: "grid", gap: 8 }}>
              {creatorStatus.data?.providers.map(provider => <div key={provider.provider} className="list-row"><span>{provider.provider}</span><small>{provider.configured ? "Configured — real output still requires evidence" : "Not configured"}</small></div>)}
              <small>No provider is considered operational merely because configuration is present.</small>
            </CardContent>
          </Card>
        </aside>

        <section style={{ display: "grid", gap: 16 }}>
          <Card>
            <CardHeader><CardTitle><Clapperboard size={18}/> Storyboard / shot graph</CardTitle></CardHeader>
            <CardContent style={{ display: "grid", gap: 16 }}>
              {!project.data ? <p>Select or create a Creator project.</p> : <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
                  <Input value={sceneTitle} onChange={event => setSceneTitle(event.target.value)} placeholder="Scene title" />
                  <Button disabled={!projectId || !sceneTitle.trim() || createScene.isPending} onClick={() => createScene.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, sceneIndex: nextSceneIndex, title: sceneTitle })}><Plus size={16}/> Scene</Button>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8 }}>
                  <Input value={shotTitle} onChange={event => setShotTitle(event.target.value)} placeholder="Shot title" />
                  <Input value={shotPrompt} onChange={event => setShotPrompt(event.target.value)} placeholder="Generation prompt" />
                  <Button disabled={!selectedScene || !shotTitle.trim() || createShot.isPending} onClick={() => createShot.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, sceneId: selectedScene!.id, shotIndex: nextShotIndex, title: shotTitle, prompt: shotPrompt })}><Plus size={16}/> Shot</Button>
                </div>
                <div style={{ display: "grid", gap: 8 }}>
                  {project.data.scenes.map(scene => <div key={scene.id} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12 }}><strong>{scene.sceneIndex + 1}. {scene.title}</strong><div style={{ display: "grid", gap: 8, marginTop: 10 }}>{project.data.shots.filter(shot => shot.sceneId === scene.id).map(shot => <div key={shot.id} className="list-row" style={{ alignItems: "center" }}><div><span>{shot.shotIndex + 1}. {shot.title}</span><small>{shot.status} · shotId {shot.id}</small></div><div style={{ display: "flex", gap: 6 }}><Button size="sm" variant="outline" disabled={submitImage.isPending} onClick={() => submitImage.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, shotId: shot.id, prompt: shot.prompt || shot.title, aspectRatio: "16:9", imageSize: "2K" })}><Image size={14}/> Image</Button><Button size="sm" variant="outline" disabled={submitVideo.isPending} onClick={() => submitVideo.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, shotId: shot.id, prompt: shot.prompt || shot.title, aspectRatio: "16:9", resolution: "1080p", durationSeconds: 8 })}><Film size={14}/> Video</Button></div></div>)}</div></div>)}
                </div>
              </>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle style={{ display: "flex", justifyContent: "space-between" }}>Generation jobs <Button size="sm" variant="ghost" onClick={() => project.refetch()}><RefreshCw size={14}/> Refresh</Button></CardTitle></CardHeader>
            <CardContent>
              <div className="list">{project.data?.generations.map(job => <div key={job.id} className="list-row"><span>#{job.id} · {job.kind} · {job.provider}</span><small>{job.status} · model {job.model}{job.outputAssetId ? ` · asset ${job.outputAssetId}` : ""}</small></div>)}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Timeline → Review → Export</CardTitle></CardHeader>
            <CardContent>
              <p>The runtime gates for approved audio, locked Tamil captions, deterministic FFmpeg candidate render, quality review, Tamil review, visual review and final-master promotion are mounted. This workspace will expose their editing controls next; it does not bypass any approval gate.</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}><Badge>Audio master</Badge><Badge>Caption lock</Badge><Badge>16:9 render</Badge><Badge>Quality gate</Badge><Badge>Tamil PASS</Badge><Badge>Visual PASS</Badge></div>
            </CardContent>
          </Card>
        </section>
      </div>
    </main>
  );
}
