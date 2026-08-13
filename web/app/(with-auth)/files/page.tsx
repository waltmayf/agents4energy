'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { list, uploadData, getUrl, remove, type ListPaginateWithPathOutput } from 'aws-amplify/storage';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  UploadIcon,
  FileIcon,
  Trash2Icon,
  DownloadIcon,
  RefreshCwIcon,
  AlertCircleIcon,
  FolderOpenIcon,
} from 'lucide-react';
import { resolveS3Prefix } from '@/lib/s3-fs-path';
import { cn } from '@/lib/utils';

// Everything a signed-in user uploads/deletes here lives under the same
// `files/` root the agent's ReadFile/ListFiles/DeleteFile tools operate on
// (see web/lib/s3-fs-path.ts) — one flat, shared space, no per-user prefix.
const FILES_ROOT = resolveS3Prefix(null);

type FileItem = {
  path: string;
  relativePath: string;
  size?: number;
  lastModified?: Date;
};

function toFileItem(item: ListPaginateWithPathOutput['items'][number]): FileItem {
  return {
    path: item.path,
    relativePath: item.path.startsWith(FILES_ROOT) ? item.path.slice(FILES_ROOT.length) : item.path,
    size: item.size,
    lastModified: item.lastModified,
  };
}

function byNewest(a: FileItem, b: FileItem): number {
  return (b.lastModified?.getTime() ?? 0) - (a.lastModified?.getTime() ?? 0);
}

function formatBytes(bytes: number | undefined): string {
  if (bytes == null) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exp);
  return `${exp === 0 ? value : value.toFixed(1)} ${units[exp]}`;
}

type UploadState = { name: string; progress: number; error?: string };

export default function FilesPage() {
  const [items, setItems] = useState<FileItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nextToken, setNextToken] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<FileItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await list({ path: FILES_ROOT });
      setItems(res.items.map(toFileItem).sort(byNewest));
      setNextToken(res.nextToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  const handleLoadMore = useCallback(async () => {
    if (!nextToken) return;
    setLoadingMore(true);
    try {
      const res = await list({ path: FILES_ROOT, options: { nextToken } });
      const more = res.items.map(toFileItem);
      setItems((prev) => [...(prev ?? []), ...more].sort(byNewest));
      setNextToken(res.nextToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  }, [nextToken]);

  const uploadFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      if (files.length === 0) return;
      setUploads((prev) => [...prev, ...files.map((f) => ({ name: f.name, progress: 0 }))]);
      await Promise.all(
        files.map(async (file) => {
          try {
            const task = uploadData({
              path: `${FILES_ROOT}${file.name}`,
              data: file,
              options: {
                onProgress: ({ transferredBytes, totalBytes }) => {
                  const progress = totalBytes ? transferredBytes / totalBytes : 0;
                  setUploads((prev) => prev.map((u) => (u.name === file.name ? { ...u, progress } : u)));
                },
              },
            });
            await task.result;
            setUploads((prev) => prev.filter((u) => u.name !== file.name));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setUploads((prev) => prev.map((u) => (u.name === file.name ? { ...u, error: message } : u)));
          }
        }),
      );
      await loadFiles();
    },
    [loadFiles],
  );

  async function handleDownload(item: FileItem) {
    try {
      const { url } = await getUrl({ path: item.path, options: { validateObjectExistence: true } });
      window.open(url.toString(), '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await remove({ path: deleteTarget.path });
      setItems((prev) => (prev ?? []).filter((f) => f.path !== deleteTarget.path));
      setDeleteTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  }

  return (
    <div
      className="flex flex-col h-full min-h-0"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
        <div>
          <h1 className="font-semibold text-base">Files</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Shared workspace — anything uploaded here is immediately visible to agents via their
            ReadFile/ListFiles tools.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={loadFiles} disabled={loading} data-testid="refresh-files-button">
            <RefreshCwIcon className={cn('size-3.5', loading && 'animate-spin')} />
            Refresh
          </Button>
          <Button size="sm" onClick={() => fileInputRef.current?.click()} data-testid="upload-button">
            <UploadIcon />
            Upload
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) uploadFiles(e.target.files);
              e.target.value = '';
            }}
            data-testid="file-input"
          />
        </div>
      </div>

      {uploads.length > 0 && (
        <div className="px-6 py-3 border-b space-y-2 shrink-0">
          {uploads.map((u) => (
            <div key={u.name} className="flex items-center gap-3 text-xs">
              <span className="flex-1 truncate font-mono">{u.name}</span>
              {u.error ? (
                <span className="text-destructive flex items-center gap-1">
                  <AlertCircleIcon className="size-3" />
                  {u.error}
                  <button
                    type="button"
                    onClick={() => setUploads((prev) => prev.filter((x) => x.name !== u.name))}
                    className="ml-1 text-muted-foreground hover:text-foreground"
                    aria-label={`Dismiss error for ${u.name}`}
                  >
                    ×
                  </button>
                </span>
              ) : (
                <div className="w-32 h-1.5 rounded-full bg-muted overflow-hidden shrink-0">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${Math.round(u.progress * 100)}%` }}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-sm text-destructive bg-destructive/10 px-6 py-2">{error}</p>}

      <div className={cn('flex-1 overflow-y-auto', dragOver && 'bg-primary/5')}>
        {loading && !items && (
          <div className="flex items-center justify-center py-12">
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        )}

        {items && items.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center px-6">
            <FolderOpenIcon className="size-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No files yet. Upload one, or drop it here.</p>
          </div>
        )}

        {items && items.length > 0 && (
          <>
            <table className="w-full text-sm" data-testid="files-table">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground uppercase tracking-wide">
                  <th className="px-6 py-2 font-medium">Name</th>
                  <th className="px-6 py-2 font-medium">Size</th>
                  <th className="px-6 py-2 font-medium">Last modified</th>
                  <th className="px-6 py-2 font-medium w-24"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((f) => (
                  <tr key={f.path} className="border-b hover:bg-muted/50" data-testid={`file-row-${f.relativePath}`}>
                    <td className="px-6 py-2.5">
                      <span className="flex items-center gap-2 min-w-0">
                        <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="truncate font-mono text-xs">{f.relativePath}</span>
                      </span>
                    </td>
                    <td className="px-6 py-2.5 text-muted-foreground text-xs">{formatBytes(f.size)}</td>
                    <td className="px-6 py-2.5 text-muted-foreground text-xs">
                      {f.lastModified ? f.lastModified.toLocaleString() : '—'}
                    </td>
                    <td className="px-6 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => handleDownload(f)}
                          aria-label={`Download ${f.relativePath}`}
                        >
                          <DownloadIcon className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => setDeleteTarget(f)}
                          aria-label={`Delete ${f.relativePath}`}
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2Icon className="size-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {nextToken && (
              <div className="px-6 py-3">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full text-xs"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                  data-testid="load-more-files"
                >
                  {loadingMore ? <Spinner className="mr-1.5 size-3" /> : null}
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <Dialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete file?</DialogTitle>
          </DialogHeader>
          <div className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground font-mono">{deleteTarget?.relativePath}</span> will
            be permanently deleted. Agents using it will lose access immediately. This cannot be undone.
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting} data-testid="confirm-delete-file">
              {deleting ? <Spinner className="mr-1.5" /> : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
