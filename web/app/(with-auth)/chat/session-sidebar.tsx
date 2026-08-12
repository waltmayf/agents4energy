'use client';
import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '@/amplify/data/resource';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  PlusIcon,
  MessageSquareIcon,
  PencilIcon,
  CheckIcon,
  XIcon,
  RefreshCwIcon,
  AlertCircleIcon,
  Trash2Icon,
  PanelLeftCloseIcon,
} from 'lucide-react';
import { useSessionList, type SessionListItem } from './use-session-list';
import { DEFAULT_SESSION_NAME } from '@/lib/session-title';

const amplifyClient = generateClient<Schema>({ authMode: 'userPool' });

/** Compact relative-ish timestamp for the row (locale date). */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function SessionRow({
  session,
  active,
  onOpen,
  onRenamed,
  onDelete,
}: {
  session: SessionListItem;
  active: boolean;
  onOpen: (id: string) => void;
  onRenamed: (id: string, name: string) => void;
  onDelete: (session: SessionListItem) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.name ?? '');
  const [saving, setSaving] = useState(false);

  const displayName = session.name?.trim() || DEFAULT_SESSION_NAME;

  const save = useCallback(async () => {
    const next = draft.trim();
    if (!next || next === session.name) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await amplifyClient.models.ChatSession.update({ id: session.id, name: next });
      onRenamed(session.id, next);
      setEditing(false);
    } catch {
      // Keep the editor open on failure so the user can retry.
    } finally {
      setSaving(false);
    }
  }, [draft, session.id, session.name, onRenamed]);

  if (editing) {
    return (
      <div className="flex items-center gap-1 px-2 py-1.5">
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') setEditing(false);
          }}
          className="h-7 text-sm"
          disabled={saving}
        />
        <Button variant="ghost" size="icon-sm" title="Save name" onClick={save} disabled={saving}>
          {saving ? <Spinner /> : <CheckIcon className="size-4" />}
        </Button>
        <Button variant="ghost" size="icon-sm" title="Cancel" onClick={() => setEditing(false)} disabled={saving}>
          <XIcon className="size-4" />
        </Button>
      </div>
    );
  }

  return (
    <div
      className={`group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
        active ? 'bg-muted font-medium' : 'hover:bg-muted/60'
      }`}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        onClick={() => onOpen(session.id)}
      >
        <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{displayName}</span>
      </button>
      <span className="shrink-0 text-xs text-muted-foreground">{formatWhen(session.updatedAt)}</span>
      <Button
        variant="ghost"
        size="icon-sm"
        title="Rename"
        className="opacity-0 group-hover:opacity-100"
        onClick={() => {
          setDraft(session.name ?? '');
          setEditing(true);
        }}
      >
        <PencilIcon className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        title="Delete"
        className="text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
        onClick={() => onDelete(session)}
      >
        <Trash2Icon className="size-3.5" />
      </Button>
    </div>
  );
}

/** Confirmation splash shown before a session is permanently deleted. */
function DeleteSessionDialog({
  session,
  deleting,
  onConfirm,
  onCancel,
}: {
  session: SessionListItem | null;
  deleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const name = session?.name?.trim() || DEFAULT_SESSION_NAME;
  return (
    <Dialog open={session !== null} onOpenChange={(open) => !open && !deleting && onCancel()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Delete chat?</DialogTitle>
          <DialogDescription>
            &ldquo;{name}&rdquo; will be permanently deleted. This can&apos;t be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={deleting}>
            {deleting ? <Spinner /> : <Trash2Icon className="size-4" />}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Chat history sidebar (issue #351): lists the signed-in user's past sessions,
 * links each to `/chat?sessionId=<id>`, supports inline rename (issue #352),
 * delete-with-confirmation, and offers an explicit "New chat" that navigates to
 * a bare `/chat` (the no-param bootstrap in useChatSession then creates a fresh
 * session). Hidden by default; `onClose` collapses it back to the toggle button.
 */
export function SessionSidebar({
  activeSessionId,
  onClose,
}: {
  activeSessionId: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const { state, reload, patch, remove } = useSessionList();
  const [pendingDelete, setPendingDelete] = useState<SessionListItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const openSession = useCallback(
    (id: string) => {
      if (id === activeSessionId) return;
      router.push(`/chat?sessionId=${id}`);
    },
    [router, activeSessionId],
  );

  const newChat = useCallback(() => router.push('/chat'), [router]);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const { id } = pendingDelete;
    setDeleting(true);
    try {
      await amplifyClient.models.ChatSession.delete({ id });
      remove(id);
      setPendingDelete(null);
      // If the user just deleted the session they're viewing, start a fresh one
      // so the chat pane isn't left pointing at a now-missing session.
      if (id === activeSessionId) router.push('/chat');
    } catch {
      // Leave the dialog open on failure so the user can retry.
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, remove, activeSessionId, router]);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-background">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button variant="outline" size="sm" className="flex-1 justify-start" onClick={newChat}>
          <PlusIcon className="size-4" />
          New chat
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title="Refresh sessions"
          onClick={reload}
          disabled={state.status === 'loading'}
        >
          <RefreshCwIcon className="size-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" title="Hide sidebar" onClick={onClose}>
          <PanelLeftCloseIcon className="size-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {state.status === 'loading' && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Spinner /> Loading…
          </div>
        )}

        {state.status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center text-sm text-destructive">
            <AlertCircleIcon className="size-5" />
            <p className="px-2 text-xs">{state.message}</p>
            <Button variant="outline" size="sm" onClick={reload}>
              Retry
            </Button>
          </div>
        )}

        {state.status === 'ready' && state.sessions.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            No past sessions yet. Start chatting and they&apos;ll show up here.
          </p>
        )}

        {state.status === 'ready' &&
          state.sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              active={s.id === activeSessionId}
              onOpen={openSession}
              onRenamed={patch}
              onDelete={setPendingDelete}
            />
          ))}
      </div>

      <DeleteSessionDialog
        session={pendingDelete}
        deleting={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </aside>
  );
}
