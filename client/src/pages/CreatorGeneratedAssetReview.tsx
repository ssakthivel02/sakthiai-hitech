import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";

type GeneratedVisualAsset = {
  id: number;
  assetType: string;
  mimeType: string;
  storageKey: string;
  checksumSha256: string;
  byteSize: number | null;
  immutable: number;
  reviewDecision: string;
  shotId: number | null;
};

export default function CreatorGeneratedAssetReview({
  workspaceId, creatorProjectId, assets, onChanged,
}: {
  workspaceId: number;
  creatorProjectId: number;
  assets: GeneratedVisualAsset[];
  onChanged: () => void;
}) {
  const pending = assets.filter(asset =>
    (asset.assetType === "IMAGE" || asset.assetType === "VIDEO") && asset.reviewDecision === "PENDING",
  );
  const [selectedId, setSelectedId] = useState<number>();
  const selected = pending.find(asset => asset.id === selectedId) ?? pending[0];
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [videoCompleted, setVideoCompleted] = useState(false);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [notes, setNotes] = useState("");
  const mutation = trpc.creator.review.reviewGeneratedAsset.useMutation({
    onSuccess: () => {
      setNotes("");
      setReviewConfirmed(false);
      setVideoCompleted(false);
      onChanged();
    },
  });
  // A different artifact or checksum must never inherit prior playback/approval evidence.
  useEffect(() => {
    setPreviewLoaded(false);
    setVideoCompleted(false);
    setReviewConfirmed(false);
    setNotes("");
  }, [selected?.id, selected?.checksumSha256]);

  if (!pending.length) {
    return <Card><CardHeader><CardTitle>Generated visual approval</CardTitle></CardHeader><CardContent>
      <small>No generated IMAGE/VIDEO assets are awaiting owner review. Approved assets become eligible for the timeline; rejected assets remain excluded.</small>
    </CardContent></Card>;
  }
  const src = selected ? `/api/storage/${selected.storageKey.split("/").map(encodeURIComponent).join("/")}` : "";
  const canDecide = Boolean(selected && reviewConfirmed && notes.trim().length >= 8 && !mutation.isPending);
  const canApprove = canDecide && previewLoaded && (selected?.assetType !== "VIDEO" || videoCompleted);
  const decide = (decision: "APPROVE" | "REJECT") => {
    if (!selected || (decision === "APPROVE" ? !canApprove : !canDecide)) return;
    mutation.mutate({
      workspaceId, creatorProjectId, assetId: selected.id,
      expectedChecksumSha256: selected.checksumSha256,
      decision, notes: notes.trim(), confirmAssetReviewed: true,
    });
  };
  return <Card><CardHeader><CardTitle>Generated visual approval — owner decision</CardTitle></CardHeader>
    <CardContent style={{ display: "grid", gap: 10 }}>
      <small>Provider completion does not authorize timeline use. Inspect the exact immutable image/video, enter a reason and explicitly approve or reject. Approval verifies stored bytes on the server.</small>
      <label style={{ display: "grid", gap: 4 }}>
        <span>Pending generated artifact</span>
        <select value={selected?.id ?? ""} onChange={event => setSelectedId(Number(event.target.value))}>
          {pending.map(asset => <option key={asset.id} value={asset.id}>#{asset.id} · {asset.assetType} · shot {asset.shotId ?? "—"}</option>)}
        </select>
      </label>
      {selected && <div key={`${selected.id}-${selected.checksumSha256}`} style={{ display: "grid", gap: 8 }}>
        <Badge variant="outline">Asset {selected.id} · {selected.mimeType} · {selected.byteSize ?? "?"} bytes</Badge>
        {selected.assetType === "IMAGE"
          ? <img src={src} alt={`Generated visual asset ${selected.id} for human review`}
              onLoad={() => setPreviewLoaded(true)} onError={() => setPreviewLoaded(false)}
              style={{ width: "min(100%, 720px)", aspectRatio: "16 / 9", objectFit: "contain", background: "#111" }} />
          : <video src={src} controls playsInline preload="metadata"
              onLoadedData={() => setPreviewLoaded(true)}
              onEnded={() => setVideoCompleted(true)}
              onError={() => { setPreviewLoaded(false); setVideoCompleted(false); }}
              style={{ width: "min(100%, 720px)", aspectRatio: "16 / 9", background: "#111" }}
              aria-label={`Generated video asset ${selected.id} for human review`} />}
        <small>SHA-256: <code style={{ overflowWrap: "anywhere" }}>{selected.checksumSha256}</code></small>
        <label style={{ display: "flex", gap: 8, alignItems: "start" }}>
          <input type="checkbox" checked={reviewConfirmed} onChange={event => setReviewConfirmed(event.target.checked)} />
          I inspected this exact asset and confirm this is my human decision.
        </label>
        {selected.assetType === "VIDEO" && !videoCompleted && <small>Play the full video before approval. Rejection remains available if playback fails.</small>}
        <Textarea value={notes} onChange={event => setNotes(event.target.value)}
          placeholder="Record Tamil iconography, character continuity, visual quality or rejection reason (minimum 8 characters)" />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button disabled={!canApprove} onClick={() => decide("APPROVE")}>Approve for timeline</Button>
          <Button variant="destructive" disabled={!canDecide} onClick={() => decide("REJECT")}>Reject artifact</Button>
        </div>
        {mutation.error && <p role="alert">{mutation.error.message}</p>}
      </div>}
    </CardContent>
  </Card>;
}
