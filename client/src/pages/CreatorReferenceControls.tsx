import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CheckCircle2, ImagePlus, LockKeyhole, Save } from "lucide-react";

type ReferenceKind = "CHARACTER" | "STYLE" | "LOCATION" | "OBJECT";
type TimingDraft = { startMs: number; endMs: number };

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("CREATOR_REFERENCE_FILE_READ_FAILED"));
    reader.onload = () => resolve(String(reader.result ?? "").split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });
}

function normalizeReferenceMimeType(file: File): "image/png" | "image/jpeg" | "image/webp" | null {
  if (file.type === "image/png" || file.type === "image/jpeg" || file.type === "image/webp") return file.type;
  return null;
}

export default function CreatorReferenceControls(props: {
  workspaceId: number;
  creatorProjectId: number;
  onChanged?: () => void;
}) {
  const { workspaceId, creatorProjectId, onChanged } = props;
  const project = trpc.creator.workspace.getProject.useQuery({ workspaceId, creatorProjectId });
  const [referenceFile, setReferenceFile] = useState<File>();
  const [referenceKind, setReferenceKind] = useState<ReferenceKind>("CHARACTER");
  const [referenceLabel, setReferenceLabel] = useState("Murugan canonical character");
  const [referenceApproved, setReferenceApproved] = useState(false);
  const [timings, setTimings] = useState<Record<number, TimingDraft>>({});
  const [localError, setLocalError] = useState("");

  useEffect(() => {
    if (!project.data?.shots) return;
    setTimings(current => {
      const next = { ...current };
      for (const shot of project.data.shots) {
        if (next[shot.id]) continue;
        next[shot.id] = {
          startMs: shot.startMs ?? 0,
          endMs: shot.endMs ?? ((shot.startMs ?? 0) + 8000),
        };
      }
      return next;
    });
  }, [project.data?.shots]);

  const ingestReference = trpc.creator.references.ingestApproved.useMutation({
    onSuccess: async () => {
      setReferenceFile(undefined);
      setReferenceApproved(false);
      setLocalError("");
      await project.refetch();
      onChanged?.();
    },
  });
  const updateShotTiming = trpc.creator.references.updateShotTiming.useMutation({
    onSuccess: async () => {
      setLocalError("");
      await project.refetch();
      onChanged?.();
    },
  });

  async function lockReference() {
    setLocalError("");
    if (!referenceFile || !referenceApproved || !referenceLabel.trim()) return;
    const mimeType = normalizeReferenceMimeType(referenceFile);
    if (!mimeType) {
      setLocalError("Only PNG, JPEG and WebP reference images are accepted.");
      return;
    }
    const dataBase64 = await fileToBase64(referenceFile);
    ingestReference.mutate({
      workspaceId,
      creatorProjectId,
      filename: referenceFile.name,
      mimeType,
      dataBase64,
      kind: referenceKind,
      label: referenceLabel.trim(),
      approved: true,
    });
  }

  function saveTiming(shotId: number) {
    const timing = timings[shotId];
    if (!timing) return;
    if (!Number.isInteger(timing.startMs) || !Number.isInteger(timing.endMs) || timing.startMs < 0 || timing.endMs <= timing.startMs) {
      setLocalError("Shot timing must use integer milliseconds with end greater than start.");
      return;
    }
    updateShotTiming.mutate({ workspaceId, creatorProjectId, shotId, ...timing });
  }

  const operationError = ingestReference.error ?? updateShotTiming.error;
  const errorMessage = localError || (operationError instanceof Error ? operationError.message : "");

  return (
    <>
      <Card>
        <CardHeader><CardTitle><LockKeyhole size={18}/> Immutable reference library</CardTitle></CardHeader>
        <CardContent style={{ display: "grid", gap: 12 }}>
          <p style={{ margin: 0 }}>Upload only a reference you have reviewed and approved. Once locked, Creator treats it as immutable project identity/style/location/object evidence.</p>
          <div style={{ display: "grid", gridTemplateColumns: "160px minmax(180px,1fr) minmax(220px,1fr)", gap: 8 }}>
            <select value={referenceKind} onChange={event => setReferenceKind(event.target.value as ReferenceKind)} style={{ minHeight: 40, border: "1px solid var(--border)", borderRadius: 8, padding: "0 10px", background: "var(--background)" }}>
              <option value="CHARACTER">CHARACTER</option>
              <option value="STYLE">STYLE</option>
              <option value="LOCATION">LOCATION</option>
              <option value="OBJECT">OBJECT</option>
            </select>
            <Input value={referenceLabel} onChange={event => setReferenceLabel(event.target.value)} placeholder="Reference label" />
            <Input type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" onChange={event => setReferenceFile(event.target.files?.[0])} />
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={referenceApproved} onChange={event => setReferenceApproved(event.target.checked)} />
            I reviewed this image and explicitly approve it as a locked project reference.
          </label>
          <Button disabled={!referenceFile || !referenceApproved || !referenceLabel.trim() || ingestReference.isPending} onClick={lockReference}>
            <ImagePlus size={16}/> Lock approved {referenceKind.toLowerCase()} reference
          </Button>
          {errorMessage && <small style={{ fontWeight: 600 }}>Reference/timing operation blocked: {errorMessage}</small>}
          <div className="list">
            {project.data?.references?.map(reference => (
              <div key={reference.id} className="list-row">
                <div><span>{reference.kind} · {reference.label}</span><small>reference {reference.id} · asset {reference.assetId}</small></div>
                <Badge variant="outline"><CheckCircle2 size={13}/> IMMUTABLE · APPROVED</Badge>
              </div>
            ))}
          </div>
          {!project.data?.references?.length && <small>No immutable project references locked yet.</small>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle><Save size={18}/> Shot timing</CardTitle></CardHeader>
        <CardContent style={{ display: "grid", gap: 10 }}>
          <p style={{ margin: 0 }}>Set audio-driven shot boundaries in integer milliseconds. These timings feed the approved visual timeline and deterministic render.</p>
          <div className="list">
            {project.data?.shots.map(shot => {
              const timing = timings[shot.id] ?? { startMs: shot.startMs ?? 0, endMs: shot.endMs ?? ((shot.startMs ?? 0) + 8000) };
              return (
                <div key={shot.id} className="list-row" style={{ alignItems: "center" }}>
                  <div style={{ minWidth: 220 }}><span>{shot.shotIndex + 1}. {shot.title}</span><small>shotId {shot.id}</small></div>
                  <div style={{ display: "grid", gridTemplateColumns: "130px 130px auto", gap: 8, alignItems: "center" }}>
                    <Input aria-label={`Shot ${shot.id} start milliseconds`} type="number" min={0} step={1} value={timing.startMs} onChange={event => setTimings(current => ({ ...current, [shot.id]: { ...timing, startMs: Number(event.target.value) } }))} />
                    <Input aria-label={`Shot ${shot.id} end milliseconds`} type="number" min={1} step={1} value={timing.endMs} onChange={event => setTimings(current => ({ ...current, [shot.id]: { ...timing, endMs: Number(event.target.value) } }))} />
                    <Button size="sm" variant="outline" disabled={updateShotTiming.isPending} onClick={() => saveTiming(shot.id)}><Save size={14}/> Save timing</Button>
                  </div>
                </div>
              );
            })}
          </div>
          {!project.data?.shots.length && <small>Create storyboard shots before setting timing.</small>}
        </CardContent>
      </Card>
    </>
  );
}
