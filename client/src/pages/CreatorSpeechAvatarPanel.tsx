import { useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { creatorIntentKey, type CreatorRequestIntent } from "@/lib/creatorIntent";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Ban, CheckCircle2, Mic, ShieldCheck, UserRound, Video } from "lucide-react";

type Asset = { id: number; assetType: string; mimeType: string; storageKey: string; immutable: number; reviewDecision: string; shotId: number | null; provenanceJson: string };
type Shot = { id: number; title: string };

type SpeechInfo = { text: string; languageCode: string; generationId: number };

/** Parses only what the server wrote for generated speech; anything else is not shown as reviewable speech. */
export function speechInfo(asset: Pick<Asset, "assetType" | "provenanceJson">): SpeechInfo | null {
  if (asset.assetType !== "AUDIO") return null;
  try {
    const p = JSON.parse(asset.provenanceJson) as { generationId?: unknown; parameters?: { kind?: unknown; prompt?: unknown; languageCode?: unknown } };
    if (p.parameters?.kind !== "SPEECH" || typeof p.parameters.prompt !== "string" || !Number.isInteger(p.generationId)) return null;
    return { text: p.parameters.prompt, languageCode: String(p.parameters.languageCode ?? "ta-IN"), generationId: p.generationId as number };
  } catch {
    return null;
  }
}

const LANGUAGE_LABEL: Record<string, string> = { "ta-IN": "Tamil", "en-IN": "English" };
const storageUrl = (key: string) => `/api/storage/${key.split("/").map(encodeURIComponent).join("/")}`;

/**
 * Speech, human speech review, consent records and avatar video for a Creator project. Every action goes through
 * the server's gates (paid switch, owner, per-kind allowlist, spend, consent, approved audio); this panel only
 * collects intent and shows what the server reports. It never marks anything approved on its own.
 */
export default function CreatorSpeechAvatarPanel(props: {
  workspaceId: number;
  creatorProjectId: number;
  shots: Shot[];
  assets: Asset[];
  audioMasterAssetId: number | null;
  onChanged: () => void;
  onError: (error: unknown) => void;
}) {
  const { workspaceId, creatorProjectId, shots, assets, audioMasterAssetId, onChanged, onError } = props;
  const [speechShotId, setSpeechShotId] = useState<number>();
  const [speechText, setSpeechText] = useState("");
  const [languageCode, setLanguageCode] = useState<"ta-IN" | "en-IN">("ta-IN");
  const [speaker, setSpeaker] = useState("");
  const [reviewNotes, setReviewNotes] = useState<Record<number, string>>({});
  const [listened, setListened] = useState<Record<number, boolean>>({});
  const [consentSubject, setConsentSubject] = useState("");
  const [consentEvidence, setConsentEvidence] = useState("");
  const [consentValidUntil, setConsentValidUntil] = useState("");
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [avatarConsentId, setAvatarConsentId] = useState<number>();
  const [avatarAudioId, setAvatarAudioId] = useState<number>();
  const [avatarShotId, setAvatarShotId] = useState<number>();
  const [avatarLive, setAvatarLive] = useState(false);
  const intents = useRef<Record<string, CreatorRequestIntent>>({});

  /** Successful submissions also keep their key. Unchanged repeated clicks never pay twice. */
  function keyFor(scope: string, payload: unknown) {
    return creatorIntentKey(intents.current, scope, payload, () => crypto.randomUUID());
  }

  const done = () => { onChanged(); consents.refetch(); };
  const consents = trpc.creator.speechAvatar.listConsents.useQuery({ workspaceId });
  const submitSpeech = trpc.creator.speechAvatar.submitSpeech.useMutation({ onSuccess: done, onError });
  const reviewSpeech = trpc.creator.speechAvatar.reviewSpeech.useMutation({ onSuccess: done, onError });
  const recordConsent = trpc.creator.speechAvatar.recordConsent.useMutation({ onSuccess: () => { setConsentSubject(""); setConsentEvidence(""); setConsentValidUntil(""); setConsentConfirmed(false); done(); }, onError });
  const revokeConsent = trpc.creator.speechAvatar.revokeConsent.useMutation({ onSuccess: done, onError });
  const submitAvatar = trpc.creator.speechAvatar.submitAvatarVideo.useMutation({ onSuccess: done, onError });

  const speechAssets = assets.map(asset => ({ asset, info: speechInfo(asset) })).filter((entry): entry is { asset: Asset; info: SpeechInfo } => Boolean(entry.info));
  const pendingSpeech = speechAssets.filter(entry => entry.asset.reviewDecision === "PENDING");
  const reviewedSpeech = speechAssets.filter(entry => entry.asset.reviewDecision !== "PENDING");
  const drivingAudio = assets.filter(asset =>
    (asset.id === audioMasterAssetId || speechInfo(asset)) && asset.reviewDecision === "APPROVED" && asset.immutable === 1);
  const now = Date.now();
  const activeConsents = (consents.data ?? []).filter(c => c.purpose === "avatar_video" && !c.revokedAt && (!c.validUntil || new Date(c.validUntil).getTime() > now));
  const selectedConsent = activeConsents.find(c => c.id === avatarConsentId);

  function sendSpeech() {
    if (!speechShotId || !speechText.trim()) return;
    const payload = { workspaceId, creatorProjectId, shotId: speechShotId, text: speechText.trim(), languageCode, speaker: speaker.trim() || undefined };
    submitSpeech.mutate({ ...payload, idempotencyKey: keyFor("speech", payload) });
  }

  function sendAvatar() {
    if (!selectedConsent || !avatarAudioId || !avatarShotId) return;
    const payload = { workspaceId, creatorProjectId, shotId: avatarShotId, avatarId: selectedConsent.providerSubjectId, consentId: selectedConsent.id, audioAssetId: avatarAudioId, live: avatarLive };
    submitAvatar.mutate({ ...payload, idempotencyKey: keyFor("avatar", payload) });
  }

  return (
    <Card data-testid="creator-speech-avatar">
      <CardHeader><CardTitle><Mic size={18}/> Speech and avatar video</CardTitle></CardHeader>
      <CardContent style={{ display: "grid", gap: 18 }}>
        <section aria-labelledby="speech-heading" style={{ display: "grid", gap: 8 }}>
          <h3 id="speech-heading" style={{ fontWeight: 600 }}>Generate speech</h3>
          <small>Paste the exact approved text. It is sent unchanged; Tamil and mixed Tamil/English text use the Tamil voice.</small>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 160px), 1fr))", gap: 8 }}>
            <label style={{ display: "grid", gap: 3 }}><small>Shot</small><select value={speechShotId ?? ""} onChange={e => setSpeechShotId(e.target.value ? Number(e.target.value) : undefined)}><option value="">Choose a shot</option>{shots.map(shot => <option key={shot.id} value={shot.id}>{shot.title} · shot {shot.id}</option>)}</select></label>
            <label style={{ display: "grid", gap: 3 }}><small>Language</small><select value={languageCode} onChange={e => setLanguageCode(e.target.value as "ta-IN" | "en-IN")}><option value="ta-IN">Tamil (ta-IN)</option><option value="en-IN">English (en-IN)</option></select></label>
            <label style={{ display: "grid", gap: 3 }}><small>Voice (optional)</small><Input value={speaker} onChange={e => setSpeaker(e.target.value.toLowerCase())} placeholder="provider default" pattern="[a-z0-9_]{2,64}"/></label>
          </div>
          <Textarea lang={languageCode === "ta-IN" ? "ta" : "en"} value={speechText} onChange={e => setSpeechText(e.target.value)} placeholder="முருகா வேல் வேல்…" maxLength={10_000}/>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Button disabled={!speechShotId || !speechText.trim() || submitSpeech.isPending} onClick={sendSpeech}><Mic size={16}/> Generate speech</Button>
            <small>{speechText.length.toLocaleString()} characters · charged per character. Repeating unchanged text/settings reuses its original job.</small>
          </div>
        </section>

        <section aria-labelledby="speech-review-heading" style={{ display: "grid", gap: 8 }}>
          <h3 id="speech-review-heading" style={{ fontWeight: 600 }}>Review generated speech</h3>
          <small>Listen to the whole clip and compare it with the approved text. PASS locks this exact audio so it can drive an avatar. The decision cannot be changed.</small>
          {!pendingSpeech.length && <small>No generated speech is waiting for review.</small>}
          {pendingSpeech.map(({ asset, info }) => (
            <div key={asset.id} className="list-row" style={{ display: "grid", gap: 8, alignItems: "stretch" }} data-testid={`speech-review-${asset.id}`}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}><Badge variant="outline">{LANGUAGE_LABEL[info.languageCode] ?? info.languageCode}</Badge><small>asset {asset.id} · generation {info.generationId}{asset.shotId ? ` · shot ${asset.shotId}` : ""}</small></div>
              <blockquote lang={info.languageCode === "ta-IN" ? "ta" : "en"} style={{ margin: 0, paddingLeft: 10, borderLeft: "3px solid var(--border)", whiteSpace: "pre-wrap" }}>{info.text}</blockquote>
              <audio controls preload="none" src={storageUrl(asset.storageKey)} onEnded={() => setListened(current => ({ ...current, [asset.id]: true }))} style={{ width: "100%" }} aria-label={`Generated speech, asset ${asset.id}`}/>
              <Textarea value={reviewNotes[asset.id] ?? ""} onChange={e => setReviewNotes(current => ({ ...current, [asset.id]: e.target.value }))} placeholder="What you checked: words, pronunciation, pace, nothing dropped or added"/>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <Button disabled={!listened[asset.id] || !(reviewNotes[asset.id] ?? "").trim() || reviewSpeech.isPending} onClick={() => reviewSpeech.mutate({ workspaceId, creatorProjectId, assetId: asset.id, decision: "PASS", notes: reviewNotes[asset.id] })}><CheckCircle2 size={14}/> PASS and lock</Button>
                <Button variant="outline" disabled={!(reviewNotes[asset.id] ?? "").trim() || reviewSpeech.isPending} onClick={() => reviewSpeech.mutate({ workspaceId, creatorProjectId, assetId: asset.id, decision: "REJECT", notes: reviewNotes[asset.id] })}><Ban size={14}/> Reject</Button>
                {!listened[asset.id] && <small>PASS unlocks after the clip has played to the end.</small>}
              </div>
            </div>
          ))}
          {reviewedSpeech.length > 0 && <div className="list">{reviewedSpeech.map(({ asset, info }) => <div key={asset.id} className="list-row"><span>asset {asset.id} · {LANGUAGE_LABEL[info.languageCode] ?? info.languageCode}</span><small>{asset.reviewDecision === "APPROVED" ? "Approved and locked" : "Rejected"}</small></div>)}</div>}
        </section>

        <section aria-labelledby="consent-heading" style={{ display: "grid", gap: 8 }}>
          <h3 id="consent-heading" style={{ fontWeight: 600 }}><ShieldCheck size={16} style={{ display: "inline", verticalAlign: "-2px" }}/> Avatar consent</h3>
          <small>An avatar of a real person needs that person's written consent. Record where the signed release is kept (not the document itself). Only the workspace owner can record or revoke.</small>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))", gap: 8 }}>
            <label style={{ display: "grid", gap: 3 }}><small>HeyGen avatar ID</small><Input value={consentSubject} onChange={e => setConsentSubject(e.target.value.trim())} placeholder="avatar_…"/></label>
            <label style={{ display: "grid", gap: 3 }}><small>Consent evidence reference</small><Input value={consentEvidence} onChange={e => setConsentEvidence(e.target.value)} placeholder="e.g. release-2026-11-001"/></label>
            <label style={{ display: "grid", gap: 3 }}><small>Valid until (optional)</small><Input type="date" value={consentValidUntil} onChange={e => setConsentValidUntil(e.target.value)}/></label>
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={consentConfirmed} onChange={e => setConsentConfirmed(e.target.checked)}/> I hold signed consent from the person shown for avatar video.</label>
          <Button disabled={!consentConfirmed || !/^[A-Za-z0-9_-]{4,128}$/.test(consentSubject) || consentEvidence.trim().length < 8 || recordConsent.isPending}
            onClick={() => recordConsent.mutate({ workspaceId, purpose: "avatar_video", provider: "heygen-avatar", providerSubjectId: consentSubject, evidenceReference: consentEvidence.trim(), validUntil: consentValidUntil ? new Date(`${consentValidUntil}T23:59:59Z`).toISOString() : undefined })}>
            <UserRound size={16}/> Record consent
          </Button>
          <div className="list">{(consents.data ?? []).map(consent => {
            const expired = consent.validUntil && new Date(consent.validUntil).getTime() <= now;
            const state = consent.revokedAt ? "Revoked" : expired ? "Expired" : "Active";
            return <div key={consent.id} className="list-row"><div><span>{consent.providerSubjectId} · {consent.purpose}</span><small>consent {consent.id} · {state}{consent.validUntil ? ` · until ${new Date(consent.validUntil).toISOString().slice(0, 10)}` : ""} · evidence {consent.evidenceReference}</small></div>{state === "Active" && <Button size="sm" variant="outline" disabled={revokeConsent.isPending} onClick={() => revokeConsent.mutate({ workspaceId, consentId: consent.id })}>Revoke</Button>}</div>;
          })}</div>
        </section>

        <section aria-labelledby="avatar-heading" style={{ display: "grid", gap: 8 }}>
          <h3 id="avatar-heading" style={{ fontWeight: 600 }}><Video size={16} style={{ display: "inline", verticalAlign: "-2px" }}/> Avatar video</h3>
          <small>Drives a consented avatar with approved, locked audio (the audio master or speech that passed review).</small>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))", gap: 8 }}>
            <label style={{ display: "grid", gap: 3 }}><small>Avatar (active consent)</small><select value={avatarConsentId ?? ""} onChange={e => setAvatarConsentId(e.target.value ? Number(e.target.value) : undefined)}><option value="">Choose</option>{activeConsents.map(c => <option key={c.id} value={c.id}>{c.providerSubjectId} · consent {c.id}</option>)}</select></label>
            <label style={{ display: "grid", gap: 3 }}><small>Approved audio</small><select value={avatarAudioId ?? ""} onChange={e => setAvatarAudioId(e.target.value ? Number(e.target.value) : undefined)}><option value="">Choose</option>{drivingAudio.map(a => <option key={a.id} value={a.id}>{a.id === audioMasterAssetId ? "Audio master" : "Reviewed speech"} · asset {a.id}</option>)}</select></label>
            <label style={{ display: "grid", gap: 3 }}><small>Shot</small><select value={avatarShotId ?? ""} onChange={e => setAvatarShotId(e.target.value ? Number(e.target.value) : undefined)}><option value="">Choose a shot</option>{shots.map(shot => <option key={shot.id} value={shot.id}>{shot.title} · shot {shot.id}</option>)}</select></label>
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={avatarLive} onChange={e => setAvatarLive(e.target.checked)}/> Live render (billed). Leave unticked for the provider's free, watermarked test render.</label>
          <Button disabled={!selectedConsent || !avatarAudioId || !avatarShotId || submitAvatar.isPending} onClick={sendAvatar}><Video size={16}/> Generate avatar video</Button>
          {!activeConsents.length && <small>No active avatar consent in this workspace yet.</small>}
          {!drivingAudio.length && <small>No approved, locked audio yet: lock the audio master or pass a speech review first.</small>}
          <small>Repeating the same consent, audio, shot and render mode reuses the original request, without a second charge.</small>
          <small>The avatar provider cannot stop a render once started; cancelling is refused rather than faked.</small>
        </section>
      </CardContent>
    </Card>
  );
}
