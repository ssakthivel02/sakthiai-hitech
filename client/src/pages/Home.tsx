import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { startLogin } from "@/const";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  BrainCircuit,
  FileText,
  FolderKanban,
  LogOut,
  MessageCircle,
  ShieldCheck,
  UploadCloud,
} from "lucide-react";
import { Streamdown } from "streamdown";
import betaCapabilities from "../../../release/beta-capability-contract.json";

export default function Home() {
  const { user, loading, isAuthenticated, logout } = useAuth();
  const [workspaceId, setWorkspaceId] = useState<number>();
  const [message, setMessage] = useState("");
  const [language, setLanguage] = useState<"en" | "ta">("en");
  const [conversationId, setConversationId] = useState<number>();
  const [answer, setAnswer] = useState("");
  const [citations, setCitations] = useState<
    Array<{ filename: string; documentId: number; page?: number; excerpt: string }>
  >([]);
  const [projectName, setProjectName] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const fileIngestionCapability = betaCapabilities.capabilities.find(
    capability => capability.id === "file-ingestion",
  );
  // Security-sensitive beta features fail closed in the UI. Runtime evidence and
  // explicit owner approval are both required before upload controls are enabled.
  const fileUploadEnabled = Boolean(
    fileIngestionCapability &&
      fileIngestionCapability.status !== "coming-soon" &&
      fileIngestionCapability.runtimeEvidence === true &&
      fileIngestionCapability.ownerApproved === true,
  );

  const workspaceList = trpc.workspace.list.useQuery(undefined, { enabled: isAuthenticated });
  const ensureWorkspace = trpc.workspace.ensure.useMutation({
    onSuccess: workspace => setWorkspaceId(workspace.id),
  });
  useEffect(() => {
    if (workspaceList.data?.[0]?.workspace.id) setWorkspaceId(workspaceList.data[0].workspace.id);
    else if (isAuthenticated) ensureWorkspace.mutate();
  }, [workspaceList.data, isAuthenticated]);

  const activeWorkspace = workspaceId ?? workspaceList.data?.[0]?.workspace.id;
  const projects = trpc.projects.list.useQuery(
    { workspaceId: activeWorkspace! },
    { enabled: Boolean(activeWorkspace) },
  );
  const files = trpc.files.list.useQuery(
    { workspaceId: activeWorkspace! },
    { enabled: Boolean(activeWorkspace) },
  );
  const createProject = trpc.projects.create.useMutation({
    onSuccess: () => {
      setProjectName("");
      projects.refetch();
    },
  });
  const upload = trpc.files.upload.useMutation({
    onSuccess: () => {
      setFile(null);
      files.refetch();
    },
  });
  const send = trpc.chat.send.useMutation({
    onSuccess: result => {
      setConversationId(result.conversationId);
      setAnswer(result.answer);
      setCitations(result.citations);
    },
  });
  const canUse = Boolean(activeWorkspace);

  const encodedFile = async (current: File) => {
    const bytes = new Uint8Array(await current.arrayBuffer());
    let binary = "";
    bytes.forEach(byte => (binary += String.fromCharCode(byte)));
    return btoa(binary);
  };

  if (loading) return <div className="loading-screen">Loading your secure workspace…</div>;

  if (!isAuthenticated) {
    return (
      <main className="landing">
        <div className="eyebrow">SAKTHI AI NEXUS · W25 RECOVERY</div>
        <h1>Private AI workspaces for grounded conversations.</h1>
        <p>
          Chat in English or Tamil inside tenant-scoped workspaces. New document ingestion remains
          disabled until the malware-scanning runtime has passed controlled security acceptance.
        </p>
        <Button onClick={() => startLogin()}>Sign in securely</Button>
        <div className="feature-row">
          <span><ShieldCheck size={16}/> OAuth protected</span>
          <span><FileText size={16}/> Safe ingestion gated</span>
          <span><MessageCircle size={16}/> RAG citations</span>
        </div>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-mark">SA</div>
        <div>
          <div className="eyebrow">SAKTHI AI</div>
          <strong>NEXUS / W25</strong>
        </div>
        <nav aria-label="Workspace navigation">
          <a className="active" href="#chat"><MessageCircle size={17}/> Chat</a>
          <a href="#projects"><FolderKanban size={17}/> Projects <Badge>{projects.data?.length ?? 0}</Badge></a>
          <a href="#files"><FileText size={17}/> Files <Badge>{files.data?.length ?? 0}</Badge></a>
          <Link href="/intelligence"><BrainCircuit size={17}/> Intelligence</Link>
        </nav>
        <div className="identity">
          <div className="avatar">{(user?.name || "U").slice(0, 1)}</div>
          <div>
            <strong>{user?.name || "Workspace user"}</strong>
            <small>{user?.email || "Authenticated"}</small>
          </div>
          <button onClick={() => logout()} aria-label="Log out"><LogOut size={16}/></button>
        </div>
      </aside>

      <main className="workspace">
        <header>
          <div>
            <div className="eyebrow">SECURE WORKSPACE</div>
            <h2>Grounded intelligence, with receipts.</h2>
          </div>
          <Badge variant="outline"><ShieldCheck size={14}/> Tenant isolated</Badge>
        </header>

        <div className="workspace-grid">
          <section id="chat" className="main-column">
            <Card className="chat-card">
              <CardHeader>
                <div className="chat-title">
                  <div>
                    <CardTitle>Web Chat <span>·</span> {language === "ta" ? "தமிழ்" : "English"}</CardTitle>
                    <p>Ask across approved workspace sources.</p>
                  </div>
                  <div className="segmented" role="group" aria-label="Chat language">
                    <button
                      type="button"
                      aria-pressed={language === "en"}
                      className={language === "en" ? "selected" : ""}
                      onClick={() => setLanguage("en")}
                    >
                      EN
                    </button>
                    <button
                      type="button"
                      aria-pressed={language === "ta"}
                      className={language === "ta" ? "selected" : ""}
                      onClick={() => setLanguage("ta")}
                    >
                      தமிழ்
                    </button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="answer-area" aria-live="polite" aria-atomic="false">
                  {answer ? (
                    <>
                      <div className="answer-label">NEXUS RESPONSE</div>
                      <Streamdown>{answer}</Streamdown>
                      {citations.length > 0 && (
                        <div className="citation-list">
                          <div className="answer-label">CITATIONS</div>
                          {citations.map((citation, index) => (
                            <div className="citation" key={`${citation.documentId}-${index}`}>
                              <span>[{index + 1}]</span>
                              <div>
                                <strong>{citation.filename}</strong>
                                <small>documentId {citation.documentId} · page {citation.page ?? "—"}</small>
                                <p>{citation.excerpt}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="empty-state">
                      <MessageCircle size={28}/>
                      <strong>Your secure workspace is ready.</strong>
                      <p>
                        Grounded chat can use already approved workspace sources. New uploads remain
                        disabled until malware scanning is runtime-qualified.
                      </p>
                    </div>
                  )}
                </div>
                <div className="composer">
                  <Textarea
                    value={message}
                    onChange={event => setMessage(event.target.value)}
                    placeholder={language === "ta" ? "உங்கள் கேள்வியை தமிழில் கேளுங்கள்…" : "Ask a question about your sources…"}
                  />
                  <Button
                    disabled={!canUse || !message.trim() || send.isPending}
                    onClick={() =>
                      send.mutate({
                        workspaceId: activeWorkspace!,
                        conversationId,
                        message,
                        language,
                      })
                    }
                  >
                    {send.isPending ? "Thinking…" : "Send"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </section>

          <aside className="right-column">
            <Card id="projects">
              <CardHeader><CardTitle><FolderKanban size={18}/> Projects</CardTitle></CardHeader>
              <CardContent>
                <div className="inline-form">
                  <Input
                    value={projectName}
                    onChange={event => setProjectName(event.target.value)}
                    placeholder="New project name"
                  />
                  <Button
                    size="sm"
                    disabled={!projectName.trim() || !canUse}
                    onClick={() => createProject.mutate({ workspaceId: activeWorkspace!, name: projectName })}
                  >
                    Add
                  </Button>
                </div>
                <div className="list">
                  {projects.data?.map(project => (
                    <div className="list-row" key={project.id}>
                      <span>{project.name}</span>
                      <small>{project.description || "Workspace project"}</small>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card id="files">
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <CardTitle><UploadCloud size={18}/> Files & extraction</CardTitle>
                  <Badge variant="outline">{fileIngestionCapability?.publicLabel ?? "Unavailable"}</Badge>
                </div>
              </CardHeader>
              <CardContent>
                {!fileUploadEnabled && (
                  <p className="mb-3 text-sm leading-6 text-muted-foreground" role="status">
                    Safe document upload is not enabled in this beta. The malware scanner must pass
                    live clean-file, EICAR and scanner-unavailable acceptance before owner approval.
                  </p>
                )}
                <label className="dropzone" aria-disabled={!fileUploadEnabled}>
                  <UploadCloud size={22}/>
                  <strong>{fileUploadEnabled && file ? file.name : fileUploadEnabled ? "Choose PDF, DOCX, or text" : "Document ingestion is coming soon"}</strong>
                  <small>
                    {fileUploadEnabled
                      ? "Max 12 MB · scanned before extraction and storage"
                      : "Uploads fail closed until malware scanning is runtime-qualified"}
                  </small>
                  <input
                    type="file"
                    accept=".pdf,.docx,.txt,application/pdf"
                    disabled={!fileUploadEnabled}
                    onChange={event => setFile(event.target.files?.[0] || null)}
                  />
                </label>
                <Button
                  className="upload-button"
                  disabled={!fileUploadEnabled || !file || !canUse || upload.isPending}
                  onClick={async () => {
                    if (!file || !fileUploadEnabled) return;
                    upload.mutate({
                      workspaceId: activeWorkspace!,
                      filename: file.name,
                      mimeType: file.type || "text/plain",
                      dataBase64: await encodedFile(file),
                    });
                  }}
                >
                  {fileUploadEnabled ? (upload.isPending ? "Scanning & extracting…" : "Upload & extract") : "Coming Soon"}
                </Button>
                <div className="list">
                  {files.data?.map(currentFile => (
                    <div className="list-row" key={currentFile.id}>
                      <span>{currentFile.filename}</span>
                      <small>documentId {currentFile.id} · {currentFile.pageCount} page(s)</small>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </aside>
        </div>
      </main>
    </div>
  );
}
