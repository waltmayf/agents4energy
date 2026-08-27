'use client';

import { getUrl } from 'aws-amplify/storage';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Download, ExternalLink } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { buttonVariants } from '@/components/ui/button';
import { MessageResponse } from '@/components/ai-elements/message';
import { SandboxedHtml } from '@/app/(with-auth)/chat/tool-widgets/sandboxed-html';
import { resolveFileRouteKey, S3FsPathError } from '@/lib/s3-fs-path';

type FileType = 'image' | 'html' | 'markdown' | 'pdf' | 'other';

function detectFileType(key: string): FileType {
  const extension = key.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(extension)) return 'image';
  if (extension === 'html' || extension === 'htm') return 'html';
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  if (extension === 'pdf') return 'pdf';
  return 'other';
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; fileType: FileType; fileUrl: string; textContent: string; fileName: string };

function FileContent() {
  const searchParams = useSearchParams();
  const rawS3Key = searchParams.get('s3Key') ?? '';
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setState({ status: 'loading' });
      let s3Key: string;
      try {
        // Scoped strictly to the `files/` prefix (issue #502) — this route
        // must never be usable to presign an arbitrary bucket key.
        s3Key = resolveFileRouteKey(rawS3Key);
      } catch (err) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: err instanceof S3FsPathError ? err.message : 'Invalid file reference',
          });
        }
        return;
      }

      try {
        const fileType = detectFileType(s3Key);
        const { url } = await getUrl({ path: s3Key });
        const fileUrl = url.toString();

        let textContent = '';
        if (fileType === 'html' || fileType === 'markdown') {
          const response = await fetch(fileUrl);
          if (!response.ok) throw new Error(`Failed to fetch file (${response.status})`);
          textContent = await response.text();
        }

        if (!cancelled) {
          setState({ status: 'ready', fileType, fileUrl, textContent, fileName: s3Key.split('/').pop() || s3Key });
        }
      } catch (err) {
        if (!cancelled) {
          setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [rawS3Key]);

  if (state.status === 'loading') {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center gap-2 bg-background">
        <Spinner className="size-8" />
        <p className="text-sm text-muted-foreground">Loading file…</p>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-background p-8">
        <div className="max-w-md rounded-lg border bg-card p-6 text-center shadow-sm">
          <h2 className="mb-2 text-lg font-semibold text-destructive">Unable to load file</h2>
          <p className="text-sm text-muted-foreground">{state.message}</p>
        </div>
      </div>
    );
  }

  const { fileType, fileUrl, textContent, fileName } = state;

  if (fileType === 'image') {
    return (
      <div className="flex h-screen w-full items-center justify-center overflow-auto bg-background p-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={fileUrl} alt={fileName} className="max-h-full max-w-full object-contain" />
      </div>
    );
  }

  if (fileType === 'html') {
    // Untrusted, agent-generated content — render via the same fully
    // sandboxed iframe used for tool-result HTML (SandboxedHtml), rather than
    // trusting it just because it lives under files/artifacts/.
    return (
      <div className="h-screen w-full bg-background p-4">
        <SandboxedHtml html={textContent} />
      </div>
    );
  }

  if (fileType === 'markdown') {
    return (
      <div className="h-screen w-full overflow-auto bg-background p-8">
        <div className="mx-auto max-w-4xl">
          <MessageResponse>{textContent}</MessageResponse>
        </div>
      </div>
    );
  }

  if (fileType === 'pdf') {
    return (
      <div className="flex h-screen w-full flex-col bg-background">
        <div className="flex items-center justify-between border-b px-4 py-2">
          <span className="truncate text-sm font-medium">{fileName}</span>
          <div className="flex items-center gap-2">
            <a href={fileUrl} download className={buttonVariants({ size: 'sm', variant: 'secondary' })}>
              <Download className="size-4" /> Download
            </a>
            <a
              href={fileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ size: 'sm', variant: 'ghost' })}
            >
              <ExternalLink className="size-4" /> Open in new tab
            </a>
          </div>
        </div>
        <object data={fileUrl} type="application/pdf" className="flex-1">
          <p className="p-4 text-sm text-muted-foreground">
            PDF preview isn&apos;t supported in this browser.{' '}
            <a href={fileUrl} className="underline" target="_blank" rel="noopener noreferrer">
              Open the file directly
            </a>
            .
          </p>
        </object>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full flex-col items-center justify-center gap-4 bg-background p-8">
      <p className="text-sm text-muted-foreground">This file type can&apos;t be previewed.</p>
      <a href={fileUrl} download className={buttonVariants()}>
        <Download className="size-4" /> Download {fileName}
      </a>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen w-full items-center justify-center bg-background">
          <Spinner className="size-8" />
        </div>
      }
    >
      <FileContent />
    </Suspense>
  );
}
