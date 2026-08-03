'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronLeftIcon } from 'lucide-react';

/**
 * Fixed back-affordance shown on every non-root page. Links to the next page up
 * the hierarchy, computed by dropping the last path segment (`/agents` → `/`,
 * `/foo/bar` → `/foo`), so new nested routes get correct up-navigation for free.
 * Renders nothing at the root.
 */
export default function BackButton() {
  const pathname = usePathname();
  const segments = (pathname ?? '/').split('/').filter(Boolean);

  // Root has no parent — nothing to go up to.
  if (segments.length === 0) return null;

  const parent = '/' + segments.slice(0, -1).join('/');

  return (
    <Link
      href={parent}
      aria-label="Back to previous page"
      className="fixed left-3 top-3 z-50 flex size-8 items-center justify-center rounded-full border border-border bg-background/80 text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeftIcon className="size-4" />
    </Link>
  );
}
