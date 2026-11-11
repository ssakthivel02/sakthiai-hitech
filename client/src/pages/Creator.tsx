import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, Clapperboard, Film, Image, Plus, RefreshCw, ShieldCheck, Upload, Play, RotateCcw, Ban, CheckCircle2, Smartphone, FileJson } from "lucide-react";
import CreatorReferenceControls from "./CreatorReferenceControls";
import CreatorSpendAdminPanel from "./CreatorSpendAdminPanel";
import CreatorSpeechAvatarPanel from "./CreatorSpeechAvatarPanel";
import CreatorGeneratedAssetReview from "./CreatorGeneratedAssetReview";
import { creatorIntentKey, type CreatorRequestIntent } from "@/lib/creatorIntent";
import { describeCreatorError } from "@shared/creatorErrors";
import { creatorReviewReadiness } from "@/lib/creatorReviewReadiness";
import { creatorCandidateReadiness } from "@/lib/creatorCandidateReadiness";

type CueDraft = { startMs: number; endMs: number; text: string; language: "ta" | "en" };
type TimelineDraft = { assetId: number; shotId?: number; startMs: number; endMs: number; track: 1; sortOrder: number };
type FrameSelection = { firstFrameAssetId?: number; lastFrameAssetId?: number };

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

function CreatorErrorNotice({ error }: { error: unknown }) {
  const view = describeCreatorError(errorText(error));
  return (
    <Card style={{ marginBottom: 16 }} role="alert" aria-live="assertive" data-testid="creator-error" data-error-code={view.code}>
      <CardContent style={{ paddingTop: 16, display: "grid", gap: 4 }}>
        <strong>{view.title}</strong>
        <span>{view.detail}</span>
        {view.action && <span>{view.action}</span>}
        <small>Code: {view.code}</small>
      </CardContent>
    </Card>
  );
}

/** Masters and delivery derivatives are both RENDER assets; only masters can be reviewed and promoted. */
function renderSource(provenanceJson: string | null | undefined): string | null {
  try {
    const value = JSON.parse(provenanceJson ?? "{}") as { source?: unknown };
    return typeof value.source === "string" ? value.source : null;
  } catch {
    return null;
  }
}

/** Display persisted scorer evidence without trusting malformed or legacy review JSON. */
function creatorQualityEvidence(value: string | null | undefined) {
  if (!value) return null;
  try {
    const raw = JSON.parse(value) as {
      weightedScore?: unknown;
      candidateArtifact?: { checksumSha256?: unknown };
      remediationSummary?: { items?: unknown };
    };
    if (!raw || typeof raw !== "object") return null;
    const entries = raw.remediationSummary?.items;
    const items = Array.isArray(entries) ? entries.flatMap(item => {
      if (!item || typeof item !== "object" ||
          typeof item.id !== "string" || typeof item.problem !== "string") return [];
      const actions: string[] = Array.isArray(item.actions)
        ? item.actions.filter((action: unknown): action is string => typeof action === "string")
        : [];
      return [{ id: item.id as string, priority: typeof item.priority === "string" ? item.priority : "REVIEW",
        problem: item.problem as string, actions }];
    }) : [];
    return {
      weightedScore: typeof raw.weightedScore === "number" && Number.isFinite(raw.weightedScore)
        ? raw.weightedScore : null,
      checksumSha256: typeof raw.candidateArtifact?.checksumSha256 === "string"
        ? raw.candidateArtifact.checksumSha256 : null,
      items,
    };
  } catch {
    return null;
  }
}

function downloadJson(filename: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function provenanceIds(sourceAssetIdsJson: string | null | undefined) {
  if (!sourceAssetIdsJson) return [] as number[];
  try {
    const value = JSON.parse(sourceAssetIdsJson);
    return Array.isArray(value) ? value.filter((item): item is number => Number.isInteger(item) && item > 0) : [];
  } catch {
    return [] as number[];
  }
}

export default function Creator() {
  const { isAuthenticated, loading, user } = useAuth();
  const [workspaceId, setWorkspaceId] = useState<number>();
  const [projectId, setProjectId] = useState<number>();
  const [projectName, setProjectName] = useState("Murugan Album Film");
  const [sceneTitle, setSceneTitle] = useState("Opening");
  const [shotTitle, setShotTitle] = useState("Murugan hero reveal");
  const [shotPrompt, setShotPrompt] = useState("Cinematic Murugan devotional film frame, respectful Tamil iconography, 16:9 composition");
  const [frameSelections, setFrameSelections] = useState<Record<number, FrameSelection>>({});
  const [audioFile, setAudioFile] = useState<File>();
  const [audioApproved, setAudioApproved] = useState(false);
  const [captionText, setCaptionText] = useState("");
  const [captionStartMs, setCaptionStartMs] = useState(0);
  const [captionEndMs, setCaptionEndMs] = useState(3000);
  const [cueDrafts, setCueDrafts] = useState<CueDraft[]>([]);
  const [tamilCuesReviewed, setTamilCuesReviewed] = useState(false);
  const [timelineDrafts, setTimelineDrafts] = useState<TimelineDraft[]>([]);
  const [reviewNotes, setReviewNotes] = useState("");
  const [sourcePrompt, setSourcePrompt] = useState("");
  const [criticalDefects, setCriticalDefects] = useState("");
  const [qualityScores, setQualityScores] = useState<Record<(typeof qualityDimensionIds)[number], string>>(
    () => Object.fromEntries(qualityDimensionIds.map(id => [id, ""])) as Record<(typeof qualityDimensionIds)[number], string>,
  );
  const generationIntents = useRef<Record<string, CreatorRequestIntent>>({});
  // Human review attestation is specific to the exact cue draft and project.
  useEffect(() => { setTamilCuesReviewed(false); }, [projectId, cueDrafts]);

  function idempotencyKeyFor(scope: string, payload: unknown) {
    return creatorIntentKey(generationIntents.current, scope, payload, () => crypto.randomUUID());
  }

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
  // UI is fail-closed across the entire persisted timeline, not merely one
  // approved frame or one locked cue. The server remains authoritative.
  const candidatePrerequisites = creatorCandidateReadiness({
    project: project.data?.project,
    timeline: activeTimeline,
    assets: project.data?.assets,
    items: project.data?.timelineItems,
    cues: project.data?.captionCues,
  });
  const canRequestCandidate = Object.values(candidatePrerequisites).every(Boolean);
  const renderAssets = project.data?.assets?.filter(asset => asset.assetType === "RENDER" && renderSource(asset.provenanceJson) === "deterministic-creator-render") ?? [];
  const latestRenderAsset = [...renderAssets].sort((a, b) => b.id - a.id)[0];
  const finalMaster = [...renderAssets].filter(asset => asset.reviewDecision === "APPROVED").sort((a, b) => b.id - a.id)[0];
  const [watchedRenderAssetId, setWatchedRenderAssetId] = useState<number>();
  // New render means a new review. Never carry over an earlier candidate's
  // playback, pre-filled verdict, notes or quality scores.
  useEffect(() => {
    setWatchedRenderAssetId(undefined);
    setReviewNotes("");
    setSourcePrompt("");
    setCriticalDefects("");
    setQualityScores(Object.fromEntries(qualityDimensionIds.map(id => [id, ""])) as Record<(typeof qualityDimensionIds)[number], string>);
  }, [latestRenderAsset?.id]);
  const reviewGate = creatorReviewReadiness({
    candidateId: latestRenderAsset?.id,
    candidateDecision: latestRenderAsset?.reviewDecision,
    watchedAssetId: watchedRenderAssetId,
    notes: reviewNotes,
    source: sourcePrompt,
    qualityScores,
    dimensionIds: qualityDimensionIds,
    reviews: project.data?.reviews ?? [],
  });
  const latestQualityReview = project.data?.reviews.find(review =>
    review.assetId === latestRenderAsset?.id && review.reviewType === "QUALITY");
  const latestQualityEvidence = creatorQualityEvidence(latestQualityReview?.scoresJson);
  const [panelError, setPanelError] = useState<unknown>();
  const [manifestError, setManifestError] = useState<unknown>();
  const utils = trpc.useUtils();
  const pollGeneration = trpc.creator.pollGeneration.useMutation();
  // Provider completion alone does not persist a Creator artifact. Polling is
  // explicitly user-initiated: no background provider requests or paid resubmits.
  const [pollingGenerationId, setPollingGenerationId] = useState<number>();
  const [pollError, setPollError] = useState<unknown>();
  const pollingGenerationRef = useRef(false);

  async function checkGenerationResult(generationId: number) {
    if (!workspaceId || pollingGenerationRef.current) return;
    pollingGenerationRef.current = true;
    setPollingGenerationId(generationId);
    setPollError(undefined);
    try {
      await pollGeneration.mutateAsync({ workspaceId, generationId });
      await project.refetch();
    } catch (error) {
      setPollError(error);
    } finally {
      pollingGenerationRef.current = false;
      setPollingGenerationId(undefined);
    }
  }
  const approvedVisualAssets = project.data?.assets?.filter(asset => (asset.assetType === "IMAGE" || asset.assetType === "VIDEO") && asset.reviewDecision === "APPROVED") ?? [];
  const eligibleConditioningAssets = project.data?.assets?.filter(asset =>
    (asset.assetType === "IMAGE" || asset.assetType === "REFERENCE") &&
    asset.reviewDecision === "APPROVED" &&
    asset.immutable === 1 &&
    ["image/png", "image/jpeg", "image/webp"].includes(asset.mimeType)
  ) ?? [];

  useEffect(() => {
    setFrameSelections({});
  }, [projectId]);

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
  // Keep each accepted submission's key: another click with unchanged inputs
  // must return its existing job rather than pay for a second generation.
  const submitImage = trpc.creator.submitImage.useMutation({ onSuccess: () => project.refetch() });
  const submitVideo = trpc.creator.submitVideo.useMutation({ onSuccess: () => project.refetch() });
  const retryGeneration = trpc.creator.retryGeneration.useMutation({ onSuccess: () => project.refetch() });
  const cancelGeneration = trpc.creator.cancelGeneration.useMutation({ onSuccess: () => project.refetch() });
  const ingestAudio = trpc.creator.audio.ingestApprovedMaster.useMutation({ onSuccess: () => { setAudioFile(undefined); setAudioApproved(false); project.refetch(); } });
  const saveCues = trpc.creator.audio.replaceCaptionCues.useMutation({ onSuccess: () => { setTamilCuesReviewed(false); project.refetch(); } });
  const saveTimeline = trpc.creator.timeline.replaceApprovedItems.useMutation({ onSuccess: () => project.refetch() });
  const renderCandidate = trpc.creator.timeline.renderCandidate.useMutation({ onSuccess: () => project.refetch() });
  const qualityReview = trpc.creator.review.quality.useMutation({ onSuccess: () => project.refetch() });
  const tamilReview = trpc.creator.review.humanTamil.useMutation({ onSuccess: () => project.refetch() });
  const visualReview = trpc.creator.review.humanVisual.useMutation({ onSuccess: () => project.refetch() });
  const finalizeMaster = trpc.creator.review.finalizeMaster.useMutation({ onSuccess: () => project.refetch() });
  const renderVertical = trpc.creator.timeline.renderVerticalDerivative.useMutation({ onSuccess: () => project.refetch() });
  const reviewCrop = trpc.creator.timeline.reviewVerticalDerivative.useMutation({ onSuccess: () => project.refetch() });
  const [cropNotes, setCropNotes] = useState<Record<number, string>>({});
  const [cropWatched, setCropWatched] = useState<Record<number, boolean>>({});

  async function downloadManifest(exportId: number) {
    if (!workspaceId || !projectId) return;
    try {
      setManifestError(undefined);
      const manifest = await utils.creator.timeline.exportManifest.fetch({ workspaceId, creatorProjectId: projectId, exportId });
      downloadJson(`sakthiai-export-${exportId}-manifest.json`, manifest);
    } catch (error) {
      setManifestError(error);
    }
  }

  const operationError = [createProject.error, createScene.error, createShot.error, submitImage.error, submitVideo.error, retryGeneration.error, cancelGeneration.error, ingestAudio.error, saveCues.error, saveTimeline.error, renderCandidate.error, qualityReview.error, tamilReview.error, visualReview.error, finalizeMaster.error, renderVertical.error, reviewCrop.error, manifestError, panelError, pollError].find(Boolean);

  function submitImageForShot(shot: { id: number; title: string; prompt: string | null }) {
    if (!workspaceId || !projectId) return;
    const payload = {
      workspaceId,
      creatorProjectId: projectId,
      shotId: shot.id,
      prompt: shot.prompt || shot.title,
      aspectRatio: "16:9" as const,
      imageSize: "2K" as const,
    };
    const idempotencyKey = idempotencyKeyFor(`IMAGE:${shot.id}`, payload);
    submitImage.mutate({ ...payload, idempotencyKey });
  }

  function submitVideoForShot(
    shot: { id: number; title: string; prompt: string | null },
    selectedFrames: FrameSelection,
  ) {
    if (!workspaceId || !projectId) return;
    const payload = {
      workspaceId,
      creatorProjectId: projectId,
      shotId: shot.id,
      prompt: shot.prompt || shot.title,
      aspectRatio: "16:9" as const,
      resolution: "1080p" as const,
      durationSeconds: 8 as const,
      firstFrameAssetId: selectedFrames.firstFrameAssetId,
      lastFrameAssetId: selectedFrames.lastFrameAssetId,
    };
    const idempotencyKey = idempotencyKeyFor(`VIDEO:${shot.id}`, payload);
    submitVideo.mutate({ ...payload, idempotencyKey });
  }

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
    <main className="workspace creator-page" style={{ maxWidth: 1500, margin: "0 auto", padding: 24 }}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center", marginBottom: 20, flexWrap: "wrap" }}>
        <div><Link href="/"><Button variant="ghost" size="sm"><ArrowLeft size={16}/> Workspace</Button></Link><div className="eyebrow">SAKTHIAI CREATOR · P0</div><h2>Murugan film production workspace</h2><p>Project → references → shots → jobs → timeline → governed review → final 16:9 master.</p></div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><Badge variant="outline"><ShieldCheck size={14}/> Human approval required</Badge><Badge variant="outline" style={{ whiteSpace: "normal", overflowWrap: "anywhere", maxWidth: "100%" }}>{creatorStatus.data?.stage ?? "Runtime loading"}</Badge></div>
      </header>

      {user?.role === "admin" && <CreatorSpendAdminPanel />}
      {operationError ? <CreatorErrorNotice error={operationError} /> : null}

      <div className="creator-layout">
        <aside style={{ display: "grid", gap: 16, alignContent: "start" }}>
          <Card><CardHeader><CardTitle>Creator projects</CardTitle></CardHeader><CardContent style={{ display: "grid", gap: 10 }}><Input value={projectName} onChange={e => setProjectName(e.target.value)} placeholder="Project name"/><Button disabled={!workspaceId || !projectName.trim() || createProject.isPending} onClick={() => createProject.mutate({ workspaceId: workspaceId!, name: projectName })}><Plus size={16}/> New Creator project</Button><div className="list">{projects.data?.map(item => <button key={item.id} className="list-row" style={{ width: "100%", textAlign: "left", border: 0, cursor: "pointer" }} onClick={() => setProjectId(item.id)}><span>{item.name}</span><small>{item.status} · creatorProjectId {item.id}</small></button>)}</div></CardContent></Card>
          <Card><CardHeader><CardTitle>Provider evidence</CardTitle></CardHeader><CardContent style={{ display: "grid", gap: 8 }}>{creatorStatus.data?.providers.map(provider => <div key={provider.provider} className="list-row"><span>{provider.provider}</span><small>{provider.configured ? "Configured — real output still requires evidence" : "Not configured"}</small></div>)}<small>Configuration alone never proves provider operation.</small></CardContent></Card>
          <Card><CardHeader><CardTitle>Project evidence</CardTitle></CardHeader><CardContent style={{ display: "grid", gap: 6 }}><small>Assets: {project.data?.assets.length ?? 0}</small><small>References: {project.data?.references?.length ?? 0}</small><small>Conditioning assets: {eligibleConditioningAssets.length}</small><small>Provider jobs: {project.data?.providerJobs?.length ?? 0}</small><small>Caption cues: {project.data?.captionCues?.length ?? 0}</small><small>Reviews: {project.data?.reviews?.length ?? 0}</small><small>Exports: {project.data?.exports?.length ?? 0}</small></CardContent></Card>
        </aside>

        <section style={{ display: "grid", gap: 16 }}>
          <Card><CardHeader><CardTitle><Clapperboard size={18}/> Storyboard / shot graph</CardTitle></CardHeader><CardContent style={{ display: "grid", gap: 16 }}>
            {!project.data ? <p>Select or create a Creator project.</p> : <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}><Input value={sceneTitle} onChange={e => setSceneTitle(e.target.value)} placeholder="Scene title"/><Button disabled={!projectId || !sceneTitle.trim() || createScene.isPending} onClick={() => createScene.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, sceneIndex: nextSceneIndex, title: sceneTitle })}><Plus size={16}/> Scene</Button></div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 160px), 1fr))", gap: 8 }}><Input value={shotTitle} onChange={e => setShotTitle(e.target.value)} placeholder="Shot title"/><Input value={shotPrompt} onChange={e => setShotPrompt(e.target.value)} placeholder="Generation prompt"/><Button disabled={!selectedScene || !shotTitle.trim() || createShot.isPending} onClick={() => createShot.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, sceneId: selectedScene!.id, shotIndex: nextShotIndex, title: shotTitle, prompt: shotPrompt })}><Plus size={16}/> Shot</Button></div>
              {project.data.scenes.map(scene => <div key={scene.id} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12 }}><strong>{scene.sceneIndex + 1}. {scene.title}</strong><div style={{ display: "grid", gap: 8, marginTop: 10 }}>{project.data.shots.filter(shot => shot.sceneId === scene.id).map(shot => {
                const selectedFrames = frameSelections[shot.id] ?? {};
                return <div key={shot.id} className="list-row" style={{ alignItems: "stretch", gap: 10, flexWrap: "wrap" }}><div style={{ minWidth: "min(220px, 100%)", flex: "1 1 220px" }}><span>{shot.shotIndex + 1}. {shot.title}</span><small>{shot.status} · {shot.startMs ?? "?"}–{shot.endMs ?? "?"} ms · shotId {shot.id}</small><small>Next Veo lock: first {selectedFrames.firstFrameAssetId ?? "—"} · last {selectedFrames.lastFrameAssetId ?? "—"}</small></div><div style={{ display: "grid", gap: 6, minWidth: "min(340px, 100%)", flex: "1 1 340px" }}><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 6 }}><label style={{ display: "grid", gap: 3 }}><small>First frame</small><select value={selectedFrames.firstFrameAssetId ?? ""} onChange={e => setFrameSelections(current => ({ ...current, [shot.id]: { ...(current[shot.id] ?? {}), firstFrameAssetId: e.target.value ? Number(e.target.value) : undefined } }))}><option value="">None</option>{eligibleConditioningAssets.map(asset => <option key={`first-${asset.id}`} value={asset.id}>asset {asset.id} · {asset.assetType}{asset.shotId ? ` · shot ${asset.shotId}` : ""}</option>)}</select></label><label style={{ display: "grid", gap: 3 }}><small>Last frame</small><select value={selectedFrames.lastFrameAssetId ?? ""} onChange={e => setFrameSelections(current => ({ ...current, [shot.id]: { ...(current[shot.id] ?? {}), lastFrameAssetId: e.target.value ? Number(e.target.value) : undefined } }))}><option value="">None</option>{eligibleConditioningAssets.map(asset => <option key={`last-${asset.id}`} value={asset.id}>asset {asset.id} · {asset.assetType}{asset.shotId ? ` · shot ${asset.shotId}` : ""}</option>)}</select></label></div><div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}><Button size="sm" variant="outline" disabled={submitImage.isPending} onClick={() => submitImageForShot(shot)}><Image size={14}/> Image</Button><Button size="sm" variant="outline" disabled={submitVideo.isPending} onClick={() => submitVideoForShot(shot, selectedFrames)}><Film size={14}/> Video</Button></div></div></div>;
              })}</div></div>)}
              {!eligibleConditioningAssets.length && <small>No approved immutable image/reference asset exists yet. Generate/approve an image or lock a reference before conditioned Veo submission.</small>}
            </>}
          </CardContent></Card>

          <Card><CardHeader><CardTitle>Generation jobs <Button size="sm" variant="ghost" onClick={() => project.refetch()}><RefreshCw size={14}/> Refresh</Button></CardTitle></CardHeader><CardContent><small>Repeating an unchanged request in this session reuses its original generation. Change the request details to start a separately billable generation.</small><div className="list">{project.data?.generations.map(job => {
            const sourceIds = provenanceIds(job.sourceAssetIdsJson);
            return <div key={job.id} className="list-row"><div><span>#{job.id} · {job.kind} · {job.provider}</span><small>{job.status} · model {job.model}{job.outputAssetId ? ` · asset ${job.outputAssetId}` : ""}</small>{sourceIds.length > 0 && <small>Source/conditioning provenance assets: {sourceIds.join(", ")}</small>}</div><div style={{ display: "flex", gap: 6 }}>{job.status === "RETRYABLE" && <Button size="sm" variant="outline" onClick={() => retryGeneration.mutate({ workspaceId: workspaceId!, generationId: job.id })}><RotateCcw size={14}/> Retry existing</Button>}{job.status === "SUBMISSION_UNKNOWN" && <Badge variant="outline">Reconciliation required</Badge>}{["SUBMITTED", "RUNNING"].includes(job.status) && <Button size="sm" variant="outline" disabled={pollingGenerationId !== undefined} onClick={() => void checkGenerationResult(job.id)}><RefreshCw size={14}/> {pollingGenerationId === job.id ? "Checking…" : "Check result"}</Button>}{["SUBMITTED", "RUNNING"].includes(job.status) && <Button size="sm" variant="outline" onClick={() => cancelGeneration.mutate({ workspaceId: workspaceId!, generationId: job.id })}><Ban size={14}/> Cancel</Button>}</div></div>;
          })}</div></CardContent></Card>

          {workspaceId && projectId && project.data && <CreatorGeneratedAssetReview
            workspaceId={workspaceId}
            creatorProjectId={projectId}
            assets={project.data.assets}
            onChanged={() => { void project.refetch(); }}
          />}

          {workspaceId && projectId && <CreatorReferenceControls workspaceId={workspaceId} creatorProjectId={projectId} onChanged={() => project.refetch()} />}

          {workspaceId && projectId && project.data && <CreatorSpeechAvatarPanel workspaceId={workspaceId} creatorProjectId={projectId} shots={project.data.shots} assets={project.data.assets} audioMasterAssetId={project.data.project.audioMasterAssetId ?? null} onChanged={() => { setPanelError(undefined); project.refetch(); }} onError={setPanelError} />}

          <Card><CardHeader><CardTitle>1. Approved audio master</CardTitle></CardHeader><CardContent style={{ display: "grid", gap: 10 }}>
            <Input type="file" accept="audio/wav,.wav" onChange={e => setAudioFile(e.target.files?.[0])}/>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={audioApproved} onChange={e => setAudioApproved(e.target.checked)}/> I confirm this WAV is the approved immutable Murugan audio master.</label>
            <Button disabled={!audioFile || !audioApproved || ingestAudio.isPending || Boolean(project.data?.project.audioMasterAssetId)} onClick={uploadApprovedAudio}><Upload size={16}/> Lock approved audio master</Button>
            <small>{project.data?.project.audioMasterAssetId ? `Locked audio master asset ${project.data.project.audioMasterAssetId}` : "No audio master locked yet."}</small>
          </CardContent></Card>

          <Card><CardHeader><CardTitle>2. Tamil subtitle alignment</CardTitle></CardHeader><CardContent style={{ display: "grid", gap: 10 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 140px), 1fr))", gap: 8 }}><Input type="number" value={captionStartMs} onChange={e => setCaptionStartMs(Number(e.target.value))}/><Input type="number" value={captionEndMs} onChange={e => setCaptionEndMs(Number(e.target.value))}/><Input value={captionText} onChange={e => setCaptionText(e.target.value)} placeholder="Tamil caption text"/><Button onClick={addCaptionCue}><Plus size={14}/> Cue</Button></div>
            <div className="list">{cueDrafts.map((cue, index) => <div key={`${cue.startMs}-${index}`} className="list-row"><span>{cue.startMs}–{cue.endMs} ms · {cue.text}</span><Button size="sm" variant="ghost" onClick={() => setCueDrafts(current => current.filter((_, i) => i !== index))}>Remove</Button></div>)}</div>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={tamilCuesReviewed} onChange={e => setTamilCuesReviewed(e.target.checked)}/> I personally reviewed every Tamil cue and its timing for this project.</label>
            <Button disabled={!activeTimeline || !cueDrafts.length || !tamilCuesReviewed || saveCues.isPending} onClick={() => { if (!tamilCuesReviewed) return; saveCues.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, timelineId: activeTimeline!.id, cues: cueDrafts, humanTamilReviewed: true }); }}><ShieldCheck size={16}/> Validate and lock Tamil cues</Button>
            <small>{activeTimeline ? `Timeline ${activeTimeline.id} · ${activeTimeline.width}×${activeTimeline.height} @ ${activeTimeline.fps}fps` : "Timeline is created with the approved audio master."}</small>
          </CardContent></Card>

          <Card><CardHeader><CardTitle>3. Visual timeline → candidate render</CardTitle></CardHeader><CardContent style={{ display: "grid", gap: 10 }}>
            <Button variant="outline" disabled={!approvedVisualAssets.length} onClick={buildTimelineFromApprovedAssets}>Build draft from approved, timed shot assets</Button>
            <div className="list">{timelineDrafts.map((item, index) => <div key={`${item.assetId}-${index}`} className="list-row"><span>{index + 1}. asset {item.assetId} · shot {item.shotId ?? "—"} · {item.startMs}–{item.endMs} ms</span><Button size="sm" variant="ghost" onClick={() => setTimelineDrafts(current => current.filter((_, i) => i !== index).map((value, i) => ({ ...value, sortOrder: i })))}>Remove</Button></div>)}</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><Button disabled={!activeTimeline || !timelineDrafts.length || saveTimeline.isPending} onClick={() => saveTimeline.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, timelineId: activeTimeline!.id, items: timelineDrafts })}><CheckCircle2 size={16}/> Validate/save timeline</Button><Button disabled={!canRequestCandidate || renderCandidate.isPending} onClick={() => renderCandidate.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, timelineId: activeTimeline!.id, confirmCandidateOnly: true })}><Play size={16}/> Render 16:9 candidate</Button></div>
            <small>Candidate render requires locked audio, a saved approved visual timeline, and locked Tamil cues. Missing: {Object.entries(candidatePrerequisites).filter(([, ready]) => !ready).map(([name]) => name).join(", ") || "none"}. Quality, Tamil and visual approvals remain separate mandatory gates.</small>
          </CardContent></Card>

          <Card><CardHeader><CardTitle>4. Quality → Tamil → Visual → Final master</CardTitle></CardHeader><CardContent style={{ display: "grid", gap: 12 }}>
            <div>{latestRenderAsset ? <Badge>Latest render asset {latestRenderAsset.id}</Badge> : <Badge variant="outline">No render candidate yet</Badge>}</div>
            {latestRenderAsset && <div style={{ display: "grid", gap: 8 }}>
              <video
                key={latestRenderAsset.id}
                controls
                playsInline
                preload="metadata"
                src={`/api/storage/${latestRenderAsset.storageKey.split("/").map(encodeURIComponent).join("/")}`}
                onEnded={() => setWatchedRenderAssetId(latestRenderAsset.id)}
                onError={() => setWatchedRenderAssetId(undefined)}
                style={{ width: "min(100%, 800px)", aspectRatio: "16 / 9", background: "#000" }}
                aria-label={`Review 16:9 candidate render ${latestRenderAsset.id}`}
              />
              <small>{reviewGate.watched
                ? "This candidate played to the end. Record your own quality scores and evidence notes before approval."
                : "Play this exact 16:9 candidate through to the end before recording a PASS. An earlier render's playback never counts."}</small>
            </div>}
            <Textarea value={sourcePrompt} onChange={e => setSourcePrompt(e.target.value)} placeholder="Approved source storyboard/prompt"/>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 160px), 1fr))", gap: 8 }}>{qualityDimensionIds.map(id => <label key={id} style={{ display: "grid", gap: 4 }}><small>{id}</small><Input type="number" min={0} max={5} step={0.1} value={qualityScores[id]} onChange={e => setQualityScores(current => ({ ...current, [id]: e.target.value }))}/></label>)}</div>
            <Textarea value={criticalDefects} onChange={e => setCriticalDefects(e.target.value)} placeholder="Critical defects, one per line. Leave blank if none."/>
            <Button disabled={!reviewGate.quality || qualityReview.isPending} onClick={() => qualityReview.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, assetId: latestRenderAsset!.id, reviewerType: "HUMAN", sourcePromptOrStoryboard: sourcePrompt, dimensionScores: Object.fromEntries(qualityDimensionIds.map(id => [id, Number(qualityScores[id])])) as Record<(typeof qualityDimensionIds)[number], number>, criticalDefects: criticalDefects.split("\n").map(v => v.trim()).filter(Boolean), notes: reviewNotes })}>Record governed quality review</Button>
            {latestQualityReview && <div data-testid="creator-quality-remediation" role="status" style={{ display: "grid", gap: 6, padding: 12, border: "1px solid currentColor", borderRadius: 8 }}>
              <strong>Recorded quality decision: {latestQualityReview.decision}</strong>
              {latestQualityEvidence ? <>
                <small>Scored candidate SHA-256: {latestQualityEvidence.checksumSha256 ?? "unavailable"} · weighted score: {latestQualityEvidence.weightedScore ?? "unavailable"}</small>
                {latestQualityEvidence.items.length > 0
                  ? latestQualityEvidence.items.map((item, index) => <div key={`${item.id}-${index}`} style={{ display: "grid", gap: 4 }}>
                      <strong>{item.priority} · {item.id}</strong><span>{item.problem}</span>
                      {item.actions.map((action, actionIndex) => <small key={actionIndex}>{action}</small>)}
                    </div>)
                  : <small>No dimension-specific remediation recorded.</small>}
              </> : <small>Quality evidence cannot be read. Do not promote this candidate until the persisted review is reconciled.</small>}
              {(latestQualityReview.decision === "REGENERATE" || latestQualityReview.decision === "REJECT") &&
                <small>This candidate is blocked from human PASS and final-master promotion. Create a separately attributed replacement; do not overwrite the reviewed artifact.</small>}
            </div>}
            <Textarea value={reviewNotes} onChange={e => setReviewNotes(e.target.value)} placeholder="Human review evidence notes"/>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><Button disabled={!reviewGate.tamilPass || tamilReview.isPending} onClick={() => tamilReview.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, assetId: latestRenderAsset!.id, decision: "PASS", notes: reviewNotes })}>Tamil PASS</Button><Button variant="outline" disabled={!reviewGate.tamilReject || tamilReview.isPending} onClick={() => tamilReview.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, assetId: latestRenderAsset!.id, decision: "REJECT", notes: reviewNotes })}>Tamil REJECT</Button><Button disabled={!reviewGate.visualPass || visualReview.isPending} onClick={() => visualReview.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, assetId: latestRenderAsset!.id, decision: "PASS", notes: reviewNotes })}>Visual PASS</Button><Button variant="outline" disabled={!reviewGate.visualReject || visualReview.isPending} onClick={() => visualReview.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, assetId: latestRenderAsset!.id, decision: "REJECT", notes: reviewNotes })}>Visual REJECT</Button></div>
            <Button disabled={!reviewGate.finalize || finalizeMaster.isPending} onClick={() => finalizeMaster.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, assetId: latestRenderAsset!.id })}><ShieldCheck size={16}/> Promote approved 16:9 final master</Button>
            <div className="list">{project.data?.reviews?.map(review => <div key={review.id} className="list-row"><span>{review.reviewType} · {review.decision}</span><small>asset {review.assetId ?? "—"} · review {review.id}</small></div>)}</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <Button variant="outline" disabled={!finalMaster || !activeTimeline || renderVertical.isPending} onClick={() => renderVertical.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, timelineId: activeTimeline!.id, finalMasterAssetId: finalMaster!.id })}><Smartphone size={16}/> Render 9:16 mobile version</Button>
              <small>{finalMaster ? `From final master asset ${finalMaster.id}. Centre-cropped to 1080×1920: check nothing important (the Vel, faces) is cut off.` : "Available once a 16:9 final master is approved."}</small>
            </div>
            <div className="list">{project.data?.exports?.map(item => {
              const vertical = item.height > item.width;
              const asset = project.data?.assets.find(candidate => candidate.id === item.assetId);
              const cropPending = vertical && item.status === "SUCCEEDED" && asset?.reviewDecision === "PENDING" && renderSource(asset.provenanceJson) === "deterministic-creator-derivative";
              return <div key={item.id} className="list-row" style={{ display: "grid", gap: 8, alignItems: "stretch" }} data-testid={`export-${item.id}`}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                  <div><span>Export #{item.id} · {item.status} · {vertical ? "9:16 mobile" : "16:9"}</span><small>{item.width}×{item.height} · {item.renderer} · asset {item.assetId ?? "pending"}{vertical && asset ? ` · crop ${asset.reviewDecision === "APPROVED" ? "approved" : asset.reviewDecision === "REJECTED" ? "rejected" : "not yet checked"}` : ""}</small></div>
                  {item.status === "SUCCEEDED" && <Button size="sm" variant="ghost" onClick={() => downloadManifest(item.id)}><FileJson size={14}/> Provenance manifest</Button>}
                </div>
                {cropPending && asset && <div style={{ display: "grid", gap: 6 }}>
                  <video controls preload="none" playsInline src={`/api/storage/${asset.storageKey.split("/").map(encodeURIComponent).join("/")}`} onEnded={() => setCropWatched(current => ({ ...current, [asset.id]: true }))} style={{ width: "min(100%, 270px)", aspectRatio: "9 / 16", background: "#000" }} aria-label={`9:16 version, asset ${asset.id}`}/>
                  <Textarea value={cropNotes[asset.id] ?? ""} onChange={e => setCropNotes(current => ({ ...current, [asset.id]: e.target.value }))} placeholder="Crop check: Murugan, the Vel, the peacock and the captions are fully in frame"/>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <Button size="sm" disabled={!cropWatched[asset.id] || !(cropNotes[asset.id] ?? "").trim() || reviewCrop.isPending} onClick={() => reviewCrop.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, assetId: asset.id, decision: "PASS", notes: cropNotes[asset.id] })}><CheckCircle2 size={14}/> Crop PASS</Button>
                    <Button size="sm" variant="outline" disabled={!(cropNotes[asset.id] ?? "").trim() || reviewCrop.isPending} onClick={() => reviewCrop.mutate({ workspaceId: workspaceId!, creatorProjectId: projectId!, assetId: asset.id, decision: "REJECT", notes: cropNotes[asset.id] })}><Ban size={14}/> Crop REJECT</Button>
                    {!cropWatched[asset.id] && <small>PASS unlocks after the video has played to the end.</small>}
                  </div>
                </div>}
              </div>;
            })}</div>
          </CardContent></Card>
        </section>
      </div>
    </main>
  );
}
