import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useRoute, useSearch } from "wouter";
import { ArrowLeft, FileText, Pencil, Search, Trash2 } from "lucide-react";
import { Streamdown } from "streamdown";
import { useAuth } from "@/_core/hooks/useAuth";
import { startLogin } from "@/const";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const METHOD_LABEL = { lexical: "Keyword match", semantic: "Meaning match", hybrid: "Keyword + meaning" } as const;
const formatDate = (value: Date | string) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const errorText = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong");

type ProjectOption = { id: number; name: string };
/** Rename, move and delete. The server is the authority (saver or workspace owner only); a refusal is shown, never hidden. */
function ArtifactActions({ workspaceId, artifact, projects, onDeleted }: { workspaceId: number; artifact: { id: number; title: string; projectId: number | null; language: "en" | "ta" }; projects: ProjectOption[]; onDeleted: () => void }) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(artifact.title);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { setTitle(artifact.title); setEditing(false); setConfirming(false); }, [artifact.id, artifact.title]);
  const refresh = () => Promise.all([utils.artifacts.list.invalidate(), utils.artifacts.get.invalidate(), utils.search.workspace.invalidate()]);
  const update = trpc.artifacts.update.useMutation({ onSuccess: async () => { setEditing(false); await refresh(); } });
  const remove = trpc.artifacts.delete.useMutation({ onSuccess: async () => { await refresh(); onDeleted(); } });
  const failure = update.error ?? remove.error;
  const busy = update.isPending || remove.isPending;
  const rename = (event: FormEvent) => { event.preventDefault(); const next = title.trim(); if (next && next !== artifact.title) update.mutate({ workspaceId, artifactId: artifact.id, title: next }); else setEditing(false); };

  return (
    <section aria-labelledby="artifact-actions" className="space-y-3 border-t pt-4">
      <h2 id="artifact-actions" className="text-sm font-semibold">Manage</h2>
      {editing ? (
        <form onSubmit={rename} className="flex flex-wrap gap-2">
          <label htmlFor="artifact-rename" className="sr-only">Artifact title</label>
          <Input id="artifact-rename" lang={artifact.language} value={title} maxLength={180} autoFocus onChange={event => setTitle(event.target.value)} className="min-w-0 flex-1" />
          <Button type="submit" size="sm" disabled={busy || !title.trim()}>Save title</Button>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { setTitle(artifact.title); setEditing(false); update.reset(); }}>Cancel</Button>
        </form>
      ) : (
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { remove.reset(); setEditing(true); }}><Pencil size={14} aria-hidden="true" /> Rename</Button>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="artifact-project" className="text-sm text-muted-foreground">Project</label>
        <select
          id="artifact-project"
          className="h-9 rounded-md border bg-background px-2 text-sm"
          value={artifact.projectId ?? ""}
          disabled={busy}
          onChange={event => update.mutate({ workspaceId, artifactId: artifact.id, projectId: event.target.value ? Number(event.target.value) : null })}
        >
          <option value="">No project</option>
          {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </div>
      {confirming ? (
        <div role="group" aria-label="Confirm delete" className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/50 p-3">
          <p className="text-sm">Delete this artifact permanently? The chat and your files are not affected.</p>
          <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => remove.mutate({ workspaceId, artifactId: artifact.id })}>Yes, delete</Button>
          <Button type="button" size="sm" variant="outline" disabled={busy} autoFocus onClick={() => setConfirming(false)}>Keep it</Button>
        </div>
      ) : (
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { update.reset(); setConfirming(true); }}><Trash2 size={14} aria-hidden="true" /> Delete…</Button>
      )}
      <div aria-live="polite">
        {busy ? <p role="status" className="text-sm text-muted-foreground">Saving…</p> : null}
        {failure && !busy ? <p role="alert" className="text-sm text-destructive">{failure.data?.code === "FORBIDDEN" ? "Only the member who saved this artifact or a workspace owner can change it." : `Could not complete that: ${errorText(failure)}`}</p> : null}
      </div>
    </section>
  );
}

export default function Artifacts() {
  const { loading, isAuthenticated } = useAuth();
  const [, navigate] = useLocation();
  const [match, params] = useRoute<{ id?: string }>("/artifacts/:id?");
  const searchString = useSearch();
  const query = (new URLSearchParams(searchString).get("q") ?? "").trim();
  const parsedId = match && params?.id ? Number(params.id) : undefined;
  const selectedId = parsedId !== undefined && Number.isInteger(parsedId) && parsedId > 0 ? parsedId : undefined;

  const [draft, setDraft] = useState(query);
  const [loginError, setLoginError] = useState<string>();
  useEffect(() => setDraft(query), [query]);

  const workspaces = trpc.workspace.list.useQuery(undefined, { enabled: isAuthenticated });
  const ensureWorkspace = trpc.workspace.ensure.useMutation({ onSuccess: () => workspaces.refetch() });
  useEffect(() => {
    if (isAuthenticated && workspaces.isSuccess && workspaces.data.length === 0 && !ensureWorkspace.isPending) ensureWorkspace.mutate();
  }, [isAuthenticated, workspaces.isSuccess, workspaces.data?.length]);
  const workspaceId = workspaces.data?.[0]?.workspace.id;
  const ready = Boolean(workspaceId);

  const recent = trpc.artifacts.list.useQuery({ workspaceId: workspaceId!, limit: 50 }, { enabled: ready });
  const projects = trpc.projects.list.useQuery({ workspaceId: workspaceId! }, { enabled: ready });
  const results = trpc.search.workspace.useQuery({ workspaceId: workspaceId!, query }, { enabled: ready && query.length > 0 });
  const opened = trpc.artifacts.get.useQuery({ workspaceId: workspaceId!, artifactId: selectedId! }, { enabled: ready && selectedId !== undefined, retry: false });

  const projectName = (projectId: number | null | undefined) => (projectId ? projects.data?.find(project => project.id === projectId)?.name : undefined);
  const withQuery = (path: string) => (query ? `${path}?q=${encodeURIComponent(query)}` : path);
  const base = selectedId ? `/artifacts/${selectedId}` : "/artifacts";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = draft.trim();
    navigate(next ? `${base}?q=${encodeURIComponent(next)}` : base);
  };

  if (loading) return <div className="loading-screen">Loading your secure workspace…</div>;

  if (!isAuthenticated) {
    return (
      <main className="mx-auto max-w-xl px-4 py-16">
        <h1 className="text-2xl font-semibold">Artifacts and search</h1>
        <p className="mt-3 text-muted-foreground">Sign in to open your saved answers and search your workspace.</p>
        <Button
          className="mt-6"
          onClick={() => {
            setLoginError(undefined);
            startLogin(window.location.pathname).catch((error: unknown) =>
              setLoginError(error instanceof Error && error.message === "OIDC login is not configured" ? "Sign-in is not configured on this deployment yet." : "Sign-in could not be started. Please try again."),
            );
          }}
        >
          Sign in securely
        </Button>
        {loginError ? <p role="alert" className="mt-3 text-sm text-destructive">{loginError}</p> : null}
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <Link href="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
              <ArrowLeft size={16} aria-hidden="true" /> Workspace
            </Link>
            <h1 className="text-xl font-semibold">Artifacts and search</h1>
          </div>
          <Badge variant="outline">Preview</Badge>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <section aria-label="Search and saved artifacts" className="min-w-0">
          <form role="search" aria-label="Search this workspace" onSubmit={submit} className="flex gap-2">
            <label htmlFor="workspace-search" className="sr-only">Search saved artifacts and files in this workspace</label>
            <Input id="workspace-search" type="search" value={draft} maxLength={500} onChange={event => setDraft(event.target.value)} placeholder="Search artifacts and files…" />
            <Button type="submit" disabled={!draft.trim() || !ready}><Search size={16} aria-hidden="true" /> Search</Button>
          </form>

          <div aria-live="polite" aria-atomic="false" className="mt-4 space-y-5">
            {!ready ? (
              <p role="status" className="text-sm text-muted-foreground">{workspaces.isError ? "Your workspace could not be loaded." : "Preparing your workspace…"}</p>
            ) : query ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm text-muted-foreground">Results for <strong lang="und">{query}</strong></p>
                  <Link href={base} className="text-sm underline underline-offset-2">Clear</Link>
                </div>
                {results.isLoading ? <p role="status" className="text-sm text-muted-foreground">Searching…</p> : null}
                {results.isError ? <p role="alert" className="text-sm text-destructive">Search failed: {errorText(results.error)}</p> : null}
                {results.data?.lowInformation ? <p className="text-sm text-muted-foreground">Those words are too common to search on. Add a more specific word or name.</p> : null}
                {results.data && !results.data.lowInformation && results.data.artifacts.length + results.data.documents.length === 0 ? <p className="text-sm text-muted-foreground">No matches in this workspace.</p> : null}
                {results.data && results.data.artifacts.length > 0 ? (
                  <div>
                    <h2 className="mb-2 text-sm font-semibold">Artifacts ({results.data.artifacts.length})</h2>
                    <ul className="space-y-2">
                      {results.data.artifacts.map(hit => (
                        <li key={hit.id}>
                          <Link href={withQuery(`/artifacts/${hit.id}`)} aria-current={hit.id === selectedId ? "page" : undefined} className={`block rounded-md border p-3 hover:bg-accent ${hit.id === selectedId ? "border-primary" : ""}`}>
                            <span className="flex items-start justify-between gap-2">
                              <span lang={hit.language} className="font-medium">{hit.title}</span>
                              <Badge variant="outline" className="shrink-0">{METHOD_LABEL[hit.retrievalMethod]}</Badge>
                            </span>
                            <span lang={hit.language} className="mt-1 block text-sm text-muted-foreground">{hit.snippet}</span>
                            {projectName(hit.projectId) ? <span className="mt-1 block text-xs text-muted-foreground">Project: {projectName(hit.projectId)}</span> : null}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {results.data && results.data.documents.length > 0 ? (
                  <div>
                    <h2 className="mb-2 text-sm font-semibold">Files ({results.data.documents.length})</h2>
                    <ul className="space-y-2">
                      {results.data.documents.map(hit => (
                        <li key={hit.documentId} className="rounded-md border p-3">
                          <span className="flex items-start justify-between gap-2">
                            <span className="inline-flex items-center gap-2 font-medium"><FileText size={16} aria-hidden="true" /> {hit.filename}</span>
                            <Badge variant="outline" className="shrink-0">{METHOD_LABEL[hit.retrievalMethod]}</Badge>
                          </span>
                          <span className="mt-1 block text-sm text-muted-foreground">{hit.snippet}</span>
                          <span className="mt-1 block text-xs text-muted-foreground">{hit.page ? `Page ${hit.page}` : hit.section ? `Section ${hit.section}` : "Document"}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            ) : (
              <div>
                <h2 className="mb-2 text-sm font-semibold">Saved artifacts</h2>
                {recent.isLoading ? <p role="status" className="text-sm text-muted-foreground">Loading…</p> : null}
                {recent.isError ? <p role="alert" className="text-sm text-destructive">Could not load artifacts: {errorText(recent.error)}</p> : null}
                {recent.data && recent.data.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing saved yet. Ask a question in <Link href="/" className="underline underline-offset-2">Chat</Link>, then choose “Save as artifact” under a grounded answer.</p>
                ) : null}
                <ul className="space-y-2">
                  {recent.data?.map(item => (
                    <li key={item.id}>
                      <Link href={`/artifacts/${item.id}`} aria-current={item.id === selectedId ? "page" : undefined} className={`block rounded-md border p-3 hover:bg-accent ${item.id === selectedId ? "border-primary" : ""}`}>
                        <span lang={item.language} className="block font-medium">{item.title}</span>
                        <span className="mt-1 block text-xs text-muted-foreground">{formatDate(item.createdAt)}{projectName(item.projectId) ? ` · ${projectName(item.projectId)}` : ""}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>

        <section aria-label="Artifact viewer" className="min-w-0">
          {selectedId === undefined ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">Select an artifact to reopen it with the evidence it was grounded on.</CardContent>
            </Card>
          ) : opened.isLoading ? (
            <p role="status" className="text-sm text-muted-foreground">Opening artifact…</p>
          ) : opened.isError ? (
            <Card>
              <CardContent className="py-10 text-center text-sm" role="alert">
                {opened.error.data?.code === "NOT_FOUND" ? "This artifact is not available in your workspace." : `Could not open this artifact: ${errorText(opened.error)}`}
              </CardContent>
            </Card>
          ) : opened.data ? (
            <article aria-labelledby="artifact-title">
              <Card>
                <CardHeader>
                  <CardTitle id="artifact-title" lang={opened.data.language} className="text-lg">{opened.data.title}</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    Saved {formatDate(opened.data.createdAt)}
                    {projectName(opened.data.projectId) ? ` · Project: ${projectName(opened.data.projectId)}` : ""}
                    {` · ${opened.data.language === "ta" ? "தமிழ்" : "English"}`}
                  </p>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div lang={opened.data.language} className="text-sm leading-6">
                    <Streamdown>{opened.data.content}</Streamdown>
                  </div>
                  <section aria-labelledby="artifact-evidence">
                    <h2 id="artifact-evidence" className="mb-1 text-sm font-semibold">Evidence ({opened.data.citations.length})</h2>
                    <p className="mb-2 text-xs text-muted-foreground">Copied from the answer when it was saved.</p>
                    <ol className="space-y-2">
                      {opened.data.citations.map((citation, index) => (
                        <li key={`${citation.documentId}-${citation.chunkId ?? index}`} className="rounded-md border p-3 text-sm">
                          <strong>[{index + 1}] {citation.filename}</strong>
                          <span className="block text-xs text-muted-foreground">{citation.page ? `Page ${citation.page}` : citation.section ? `Section ${citation.section}` : "Document"}</span>
                          <p className="mt-1">{citation.excerpt}</p>
                        </li>
                      ))}
                    </ol>
                  </section>
                  <ArtifactActions workspaceId={workspaceId!} artifact={opened.data} projects={projects.data ?? []} onDeleted={() => navigate(withQuery("/artifacts"))} />
                </CardContent>
              </Card>
            </article>
          ) : null}
        </section>
      </main>
    </div>
  );
}
