import Link from "next/link";

export default function NotFound() {
  return (
    <main className="legal-page" id="main-content" tabIndex={-1}>
      <div className="container narrow">
        <p className="kicker">FirstLight · 404</p>
        <h1>Page not found.</h1>
        <p>This link may have moved, or the address may be incorrect.</p>
        <div className="cta-row">
          <Link href="/" className="btn">Back to FirstLight</Link>
          <Link href="/developers" className="btn btn-ghost">Developer docs</Link>
        </div>
      </div>
    </main>
  );
}
