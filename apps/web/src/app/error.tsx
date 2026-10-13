'use client';
import Link from 'next/link';
export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="page">
      <span className="eyebrow">WORKSPACE INTERRUPTED</span>
      <h1 style={{ marginTop: 12 }}>Let’s reopen your workspace.</h1>
      <p className="muted-copy" style={{ margin: '18px 0' }}>
        The page couldn’t finish loading. Your saved projects remain in your account.
      </p>
      <div className="section-actions">
        <button className="button primary" onClick={reset}>
          Try again
        </button>
        <Link className="button secondary" href="/">
          Return to projects
        </Link>
      </div>
    </div>
  );
}
