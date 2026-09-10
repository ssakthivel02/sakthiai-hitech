import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, Clapperboard, Film, Image, Plus, RefreshCw, ShieldCheck, Upload, Play, RotateCcw, Ban, CheckCircle2 } from "lucide-react";

type CueDraft = { startMs: number; endMs: number; text: string; language: "ta" | "en" };
type TimelineDraft = { assetId: number; shotId?: number; startMs: number; endMs: number; track: 1; sortOrder: number };

const qualityDimensionIds = [
  "VQ-CONTENT-01",
  "VQ-TEMPORAL-01",
  "VQ-IDENTITY-01",
  "VQ-VISUAL-01",
  "VQ-CAMERA-01",
  "VQ-AUDIO-01",
  "VQ-TEXT-01",
  "VQ-DELIVERY-01",
] as const;

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("CREATOR_FILE_READ_FAILED"));
    reader.onload = () => resolve(String(reader.result ?? "").split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "");
}

export default function Creator() {
  const { isAuthenticated, loading } = useAuth();
  const [workspaceId, setWorkspaceId] = useState<number>();
  const [projectId, setProjectId] = useState<number>();
  const [projectName, setProjectName] = useState("Murugan Album Film");
  const [sceneTitle, setSceneTitle] = useState("Opening");
  const [shotTitle, setShotTitle] = useState("Murugan hero reveal");
  const [shotPrompt, setShotPrompt] = useState("Cinematic Murugan devotional film frame, respectful Tamil iconography, 16:9 composition");
  const [audioFile, setAudioFile] = useState<File>();
  const [audioApproved, setAudioApproved] = useState(false);
  const [captionText, setCaptionText] = useState("");
  const [captionStartMs, setCaptionStartMs] = useState(0);
  const [captionEndMs, setCaptionEndMs] = useState(3000);
  const [cueDrafts, setCueDrafts] = useState<CueDraft[]>([]);
  const [timelineDrafts, setTimelineDrafts] = useState<TimelineDraft[]>([]);
  const [reviewNotes, setReviewNotes] = useState("Human review completed against the approved Murugan audio, Tamil text and visual reference intent.");
  const [sourcePrompt, setSourcePrompt] = useState("Approved Murugan storyboard and shot prompts in this Creator project.");
  const [criticalDefects, setCriticalDefects] = useState("");
  const [qualityScores, setQualityScores] = useState<Record<(typeof qualityDimensionIds)[number], number>>(() => Object.fromEntries(qualityDimensionIds.map(id => [id, 5])) as Record<(typeof qualityDimensionIds)[number], number>);

  const workspaces = trpc.workspace.list.useQuery(undefined, { enabled: isAuthenticated });
  useEffect(() => {
    const id = workspaces.data?.[0]?.workspace.id;
    if (id) setWorkspaceId(id);
  }, [workspaces.data]);

  const creatorStatus = trpc.creator.status.useQuery({ workspaceId: workspaceId! }, { enabled: Boolean(workspaceId) });
  const projects = trpc.creator.workspace.listProjects.useQuery({ workspaceId: workspaceId! }, { enabled: Boolean(workspaceId) });
  useEffect(() => {
    if (!projectId && projects.data?.[0]?.id) setProjectId(projects.data[0].id);
  }, [projects.data, projectId]);

  const project = trpc.creator.workspace.getProject.useQuery(
    { workspaceId: workspaceId!, creatorProjectId: projectId! },
    { enabled: Boolean(workspaceId && projectId), refetchInterval: 10_000 },
  );

  const nextSceneIndex = useMemo(() => project.data?.scenes.length ?? 0, [project.data]);
  const selectedScene = project.data?.scenes[project.data.scenes.length - 1];
  const nextShotIndex = project.data?.shots.filter(shot => shot.sceneId === selectedScene?.id).length ?? 0;
  const activeTimeline = project.data?.timelines?.[0];
  const renderAssets = project.data?.assets?.filter(asset => asset.assetType === "RENDER") ?? [];
  const latestRenderAsset = renderAssets[0];
  const approvedVisualAssets = project.data?.assets?.filter(asset => (asset.assetType === "IMAGE" || asset.assetType === "VIDEO") && asset.reviewDecision === "APPROVED") ?? [];

  useEffect(() => {
    if (!activeTimeline) return;
    const existingCues = project.data?.captionCues?.filter(cue => cue.timelineId === activeTimeline.id) ?? [];
    setCueDrafts(existingCues.map(cue => ({ startMs: cue.startMs, endMs: cue.endMs, text: cue.text, language: cue.language })));
    const existingItems = project.data?.timelineItems?.filter(item => item.timelineId === activeTimeline.id) ?? [];
    setTimelineDrafts(existingItems.map(item => ({ assetId: item.assetId, shotId: item.shotId ?? undefined, startMs: item.startMs, endMs: item.endMs, track: 1, sortOrder: item.sortOrder })));
  }, [activeTimeline?.id, project.data?.captionCues?.length, project.data?.timelineItems?.length]);

  const createProject = trpc.creator.workspace.createProject.useMutation({ onSuccess: created => { if (created?.id) setProjectId(created.id); projects.refetch(); } });
  const createScene = trpc.creator.workspace.createScene.useMutation({ onSuccess: () => project.refetch() });
  const createShot = trpc.creator.workspace.createShot.useMutation({ onSuccess: () => project.refetch() });
  const submitImage = trpc.creator.submitImage.useMutation({ onSuccess: () => project.refetch() });
  const submitVideo = trpc.creator.submitVideo.useMutation({ onSuccess: () => project.refetch() });
  const retryGeneration = trpc.creator.retryGeneration.useMutation({ onSuccess: () => project.refetch() });
  const cancelGeneration = trpc.creator.cancelGeneration.useMutation({ onSuccess: () => project.refetch() });
  const ingestAudio = trpc.creator.audio.ingestApprovedMaster.useMutation({ onSuccess: () => { setAudioFile(undefined); setAudioApproved(false); project.refetch(); } });
  const saveCues = trpc.creator.audio.replaceCaptionCues.useMutation({ onSuccess: () => project.refetch() });
  const saveTimeline = trpc.creator.timeline.replaceApprovedItems.useMutation({ onSuccess: () => project.refetch() });
  const renderCandidate = trpc.creator.timeline.renderCandidate.useMutation({ onSuccess: () => project.refetch() });
  const qualityReview = trpc.creator.review.quality.useMutation({ onSuccess: () => project.refetch() });
  const tamilReview = trpc.creator.review.humanTamil.useMutation({ onSuccess: () => project.refetch() });
  const visualReview = trpc.creator.review.humanVisual.useMutation({ onSuccess: () => project.refetch() });
  const finalizeMaster = trpc.creator.review.finalizeMaster.useMutation({ onSuccess: () => project.refetch() });

  const operationError = [createProject.error, createScene.error, createShot.error, submitImage.error, submitVideo.error, retryGeneration.error, cancelGeneration.error, ingestAudio.error, saveCues.error, saveTimeline.error, renderCandidate.error, qualityReview.error, tamilReview.error, visualReview.error, finalizeMaster.error].find(Boolean);

  async function uploadApprovedAudio() {
    if (!audioFile || !workspaceId || !projectId || !audioApproved) return;
    const dataBase64 = await fileToBase64(audioFile);
    ingestAudio.mutate({ workspaceId, creatorProjectId: projectId, filename: audioFile.name, mimeType: audioFile.type === "audio/x-wav" ? "audio/x-wav" : "audio/wav", dataBase64, approved: true });
  }

  function addCaptionCue() {
    if (!captionText.trim() || captionEndMs <= captionStartMs) return;
    const cue: CueDraft = { startMs: captionStartMs, endMs: captionEndMs, text: captionText.trim(), language: "ta" };
    setCueDrafts(current => [...current, cue].sort((a, b) => a.startMs - b.startMs));
    setCaptionText("");
    setCaptionStartMs(captionEndMs);
    setCaptionEndMs(captionEndMs + 3000);
  }

  function buildTimelineFromApprovedAssets() {
    const timed = approvedVisualAssets
      .map(asset => ({ asset, shot: project.data?.shots.find(shot => shot.id === asset.shotId) }))
      .filter(entry => entry.shot && entry.shot.startMs !== null && entry.shot.endMs !== null)
      .sort((a, b) => Number(a.shot!.startMs) - Number(b.shot!.startMs));
    setTimelineDrafts(timed.map((entry, index) => ({ assetId: entry.asset.id, shotId: entry.shot!.id, startMs: Number(entry.shot!.startMs), endMs: Number(entry.shot!.endMs), track: 1, sortOrder: index })));
  }

  if (loading) return <div className="loading-screen">Loading Creator…</div>;
  if (!isAuthenticated) return <main className="landing"><h1>Creator requires an authenticated SakthiAI workspace.</h1><Link href="/">Return home</Link></main>;

  return (
    <main className="workspace" style={{ maxWidth: 1500, margin: "0 auto", padding: 24 }}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center", marginBottom: 20 }}>
        <div><Link href="/"><Button variant="ghost" size="sm"><ArrowLeft size={16}/> Workspace</Button></Link><div className="eyebrow">SAKTHIAI CREATOR · P0</div><h2>Murugan film production workspace</h2><p>Project → references → shots → jobs → timeline → governed review → final 16:9 master.</p></div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><Badge variant="outline"><ShieldCheck size={14}/> Human approval required</Badge><Badge variant="outline">{creatorStatus.data?.stage ?? "Runtime loading"}</Badge></div>
      </header>

      {operationError && <Card style={{ marginBottom: 16 }}><CardContent style={{ paddingTop: 16 }}><strong>Creator operation blocked:</strong> {errorText(operationError)}</CardContent></Card>}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, .7fr) minmax(0, 2fr)", gap: 16 }}>
        <aside style={{ display: "grid", gap: 16, alignContent: "start" }}>
          <Card><CardHeader><CardTitle>Creator projects</CardTitle></CardHeader><CardContent style={{ display: "grid", gap: 10 }}><Input value={projectName} onChange={e => setProjectName(e.target.value)} placeholder="Project name"/><Button disabled={!workspaceId || !projectName.trim() || createProject.isPending} onClick={() => createProject.mutate({ workspaceId: workspaceId!, name: projectName })}><Plus size={16}/> New Creator project</Button><div className="list">{projects.data?.map(item => <button key={item.id} className="list-row" style={{ width: "100%", textAlign: "left", border: 0, cursor: "pointer" }} onClick={() => setProjectId(item.id)}><span>{item.name}</span><small>{item.status} · creatorProjectId {item.id}</small></button>)}</div></CardContent></Card>
          <Card><CardHeader><CardTitle>Provider evidence</CardTitle></CardHeader><CardContent style={{ display: "grid", gap: 8 }}>{creatorStatus.data?.providers.map(provider => <div key={provider.provider} className="list-row"><span>{provider.provider}</span><small>{provider.configured ? "Configured — real output still requires evidence" : "Not configured"}</small></div>)}<small>Configuration alone never proves provider operation.</small></CardContent></Card>
          <Card><CardHeader><CardTitle>Project evidence</CardTitle></CardHeader><CardContent style={{ display: "grid", gap: 6 }}><small>Assets: {project.data?.assets.length ?? 0}</small><small>References: {project.data?.references?.length ?? 0}</small><small>Provider jobs: {project.data?.providerJobs?.length ?? 0}</small><small>Caption cues: {project.data?.captionCues?.length ?? 0}</small><small>Reviews: {project.data?.reviews?.length ?? 0}</small><small>Exports: {project.data?.exports?.length ?? 0}</small></CardContent></Card>
        </aside>

        <section style={{ display: "grid", gap: 16 }}>
          <Card><CardHeader><CardTitle><Clapperboard size={18}/> Storyboard / shot graph</CardTitle></CardHeader><CardContent style={{ display: "grid", gap: 16 }}>
            {!project.data ? <p>Select or create a Creator project.</p> : <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}><Input value={sceneTitle} onChange={e => setSceneTitle(e.target.value)} placeholder="Scene title"/><Button disabled={!projectId || !sceneTitle.trim() || createScene.isPending} onClick={() => createScene.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, sceneIndex: nextSceneIndex, title: sceneTitle })}><Plus size={16}/> Scene</Button></div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr auto", gap: 8 }}><Input value={shotTitle} onChange={e => setShotTitle(e.target.value)} placeholder="Shot title"/><Input value={shotPrompt} onChange={e => setShotPrompt(e.target.value)} placeholder="Generation prompt"/><Button disabled={!selectedScene || !shotTitle.trim() || createShot.isPending} onClick={() => createShot.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, sceneId: selectedScene!.id, shotIndex: nextShotIndex, title: shotTitle, prompt: shotPrompt })}><Plus size={16}/> Shot</Button></div>
              {project.data.scenes.map(scene => <div key={scene.id} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12 }}><strong>{scene.sceneIndex + 1}. {scene.title}</strong><div style={{ display: "grid", gap: 8, marginTop: 10 }}>{project.data.shots.filter(shot => shot.sceneId === scene.id).map(shot => <div key={shot.id} className="list-row"><div><span>{shot.shotIndex + 1}. {shot.title}</span><small>{shot.status} · {shot.startMs ?? "?"}–{shot.endMs ?? "?"} ms · shotId {shot.id}</small></div><div style={{ display: "flex", gap: 6 }}><Button size="sm" variant="outline" disabled={submitImage.isPending} onClick={() => submitImage.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, shotId: shot.id, prompt: shot.prompt || shot.title, aspectRatio: "16:9", imageSize: "2K" })}><Image size={14}/> Image</Button><Button size="sm" variant="outline" disabled={submitVideo.isPending} onClick={() => submitVideo.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, shotId: shot.id, prompt: shot.prompt || shot.title, aspectRatio: "16:9", resolution: "1080p", durationSeconds: 8 })}><Film size={14}/> Video</Button></div></div>)}</div></div>)}
            </>}
          </CardContent></Card>

          <Card><CardHeader><CardTitle>Generation jobs <Button size="sm" variant="ghost" onClick={() => project.refetch()}><RefreshCw size={14}/> Refresh</Button></CardTitle></CardHeader><CardContent><div className="list">{project.data?.generations.map(job => <div key={job.id} className="list-row"><div><span>#{job.id} · {job.kind} · {job.provider}</span><small>{job.status} · model {job.model}{job.outputAssetId ? ` · asset ${job.outputAssetId}` : ""}</small></div><div style={{ display: "flex", gap: 6 }}>{(job.status === "RETRYABLE" || job.status === "FAILED") && <Button size="sm" variant="outline" onClick={() => retryGeneration.mutate({ workspaceId: workspaceId!, generationId: job.id })}><RotateCcw size={14}/> Retry existing</Button>}{["SUBMITTED", "RUNNING"].includes(job.status) && <Button size="sm" variant="outline" onClick={() => cancelGeneration.mutate({ workspaceId: workspaceId!, generationId: job.id })}><Ban size={14}/> Cancel</Button>}</div></div>)}</div></CardContent></Card>

          <Card><CardHeader><CardTitle>1. Approved audio master</CardTitle></CardHeader><CardContent style={{ display: "grid", gap: 10 }}>
            <Input type="file" accept="audio/wav,.wav" onChange={e => setAudioFile(e.target.files?.[0])}/>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={audioApproved} onChange={e => setAudioApproved(e.target.checked)}/> I confirm this WAV is the approved immutable Murugan audio master.</label>
            <Button disabled={!audioFile || !audioApproved || ingestAudio.isPending || Boolean(project.data?.project.audioMasterAssetId)} onClick={uploadApprovedAudio}><Upload size={16}/> Lock approved audio master</Button>
            <small>{project.data?.project.audioMasterAssetId ? `Locked audio master asset ${project.data.project.audioMasterAssetId}` : "No audio master locked yet."}</small>
          </CardContent></Card>

          <Card><CardHeader><CardTitle>2. Tamil subtitle alignment</CardTitle></CardHeader><CardContent style={{ display: "grid", gap: 10 }}>
            <div style={{ display: "grid", gridTemplateColumns: "140px 140px 1fr auto", gap: 8 }}><Input type="number" value={captionStartMs} onChange={e => setCaptionStartMs(Number(e.target.value))}/><Input type="number" value={captionEndMs} onChange={e => setCaptionEndMs(Number(e.target.value))}/><Input value={captionText} onChange={e => setCaptionText(e.target.value)} placeholder="Tamil caption text"/><Button onClick={addCaptionCue}><Plus size={14}/> Cue</Button></div>
            <div className="list">{cueDrafts.map((cue, index) => <div key={`${cue.startMs}-${index}`} className="list-row"><span>{cue.startMs}–{cue.endMs} ms · {cue.text}</span><Button size="sm" variant="ghost" onClick={() => setCueDrafts(current => current.filter((_, i) => i !== index))}>Remove</Button></div>)}</div>
            <Button disabled={!activeTimeline || !cueDrafts.length || saveCues.isPending} onClick={() => saveCues.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, timelineId: activeTimeline!.id, cues: cueDrafts, humanTamilReviewed: true })}><ShieldCheck size={16}/> Validate and lock Tamil cues</Button>
            <small>{activeTimeline ? `Timeline ${activeTimeline.id} · ${activeTimeline.width}×${activeTimeline.height} @ ${activeTimeline.fps}fps` : "Timeline is created with the approved audio master."}</small>
          </CardContent></Card>

          <Card><CardHeader><CardTitle>3. Visual timeline → candidate render</CardTitle></CardHeader><CardContent style={{ display: "grid", gap: 10 }}>
            <Button variant="outline" disabled={!approvedVisualAssets.length} onClick={buildTimelineFromApprovedAssets}>Build draft from approved, timed shot assets</Button>
            <div className="list">{timelineDrafts.map((item, index) => <div key={`${item.assetId}-${index}`} className="list-row"><span>{index + 1}. asset {item.assetId} · shot {item.shotId ?? "—"} · {item.startMs}–{item.endMs} ms</span><Button size="sm" variant="ghost" onClick={() => setTimelineDrafts(current => current.filter((_, i) => i !== index).map((value, i) => ({ ...value, sortOrder: i })))}>Remove</Button></div>)}</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><Button disabled={!activeTimeline || !timelineDrafts.length || saveTimeline.isPending} onClick={() => saveTimeline.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, timelineId: activeTimeline!.id, items: timelineDrafts })}><CheckCircle2 size={16}/> Validate/save timeline</Button><Button disabled={!activeTimeline || renderCandidate.isPending} onClick={() => renderCandidate.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, timelineId: activeTimeline!.id, confirmCandidateOnly: true })}><Play size={16}/> Render 16:9 candidate</Button></div>
            <small>Candidate render remains non-final until quality + Tamil + visual gates all pass.</small>
          </CardContent></Card>

          <Card><CardHeader><CardTitle>4. Quality → Tamil → Visual → Final master</CardTitle></CardHeader><CardContent style={{ display: "grid", gap: 12 }}>
            <div>{latestRenderAsset ? <Badge>Latest render asset {latestRenderAsset.id}</Badge> : <Badge variant="outline">No render candidate yet</Badge>}</div>
            <Textarea value={sourcePrompt} onChange={e => setSourcePrompt(e.target.value)} placeholder="Approved source storyboard/prompt"/>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(160px,1fr))", gap: 8 }}>{qualityDimensionIds.map(id => <label key={id} style={{ display: "grid", gap: 4 }}><small>{id}</small><Input type="number" min={0} max={5} step={0.1} value={qualityScores[id]} onChange={e => setQualityScores(current => ({ ...current, [id]: Number(e.target.value) }))}/></label>)}</div>
            <Textarea value={criticalDefects} onChange={e => setCriticalDefects(e.target.value)} placeholder="Critical defects, one per line. Leave blank if none."/>
            <Button disabled={!latestRenderAsset || qualityReview.isPending} onClick={() => qualityReview.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, assetId: latestRenderAsset!.id, reviewerType: "HUMAN", sourcePromptOrStoryboard: sourcePrompt, dimensionScores: qualityScores, criticalDefects: criticalDefects.split("\n").map(v => v.trim()).filter(Boolean), notes: reviewNotes })}>Record governed quality review</Button>
            <Textarea value={reviewNotes} onChange={e => setReviewNotes(e.target.value)} placeholder="Human review evidence notes"/>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><Button disabled={!latestRenderAsset || tamilReview.isPending} onClick={() => tamilReview.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, assetId: latestRenderAsset!.id, decision: "PASS", notes: reviewNotes })}>Tamil PASS</Button><Button variant="outline" disabled={!latestRenderAsset || tamilReview.isPending} onClick={() => tamilReview.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, assetId: latestRenderAsset!.id, decision: "REJECT", notes: reviewNotes })}>Tamil REJECT</Button><Button disabled={!latestRenderAsset || visualReview.isPending} onClick={() => visualReview.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, assetId: latestRenderAsset!.id, decision: "PASS", notes: reviewNotes })}>Visual PASS</Button><Button variant="outline" disabled={!latestRenderAsset || visualReview.isPending} onClick={() => visualReview.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, assetId: latestRenderAsset!.id, decision: "REJECT", notes: reviewNotes })}>Visual REJECT</Button></div>
            <Button disabled={!latestRenderAsset || finalizeMaster.isPending} onClick={() => finalizeMaster.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, assetId: latestRenderAsset!.id })}><ShieldCheck size={16}/> Promote approved 16:9 final master</Button>
            <div className="list">{project.data?.reviews?.map(review => <div key={review.id} className="list-row"><span>{review.reviewType} · {review.decision}</span><small>asset {review.assetId ?? "—"} · review {review.id}</small></div>)}</div>
            <div className="list">{project.data?.exports?.map(item => <div key={item.id} className="list-row"><span>Export #{item.id} · {item.status}</span><small>{item.width}×{item.height} · {item.renderer} · asset {item.assetId ?? "pending"}</small></div>)}</div>
          </CardContent></Card>
        </section>
      </div>
    </main>
  );
}