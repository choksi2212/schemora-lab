import Link from 'next/link';
export default function NotFound() {
  return (
    <div className="page">
      <span className="eyebrow">PAGE NOT FOUND</span>
      <h1 style={{ marginTop: 12 }}>This blueprint isn’t here.</h1>
      <p className="muted-copy" style={{ margin: '18px 0' }}>
        Check the link or return to your project workspace.
      </p>
      <Link href="/" className="button primary">
        Back to projects
      </Link>
    </div>
  );
}
