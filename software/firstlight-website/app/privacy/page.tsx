import Link from "next/link";

export const metadata = { title: "Privacy Policy — FirstLight" };

export default function Privacy() {
  return (
    <main className="legal-page" id="main-content">
      <div className="container narrow">
        <p className="kicker">StarDrive Inc.</p>
        <h1>Privacy Policy</h1>
        <p className="legal-updated">Last updated: July 5, 2026</p>

        <p>
          This Privacy Policy describes how StarDrive Inc. (&ldquo;StarDrive,&rdquo;
          &ldquo;we&rdquo;) collects and uses information in connection with the
          FirstLight website and the FirstLight Compose platform (the
          &ldquo;Services&rdquo;).
        </p>

        <h2>1. Information We Collect</h2>
        <p>
          <strong>Account data:</strong> your email address and a salted hash of your
          password (never the password itself), or your email as verified by Google
          sign-in. <strong>Usage data:</strong> board descriptions you submit,
          generated design artifacts, run history, plan and quota status.
          <strong> Payment data:</strong> handled entirely by Stripe; we receive
          subscription status and a customer reference, never card numbers.
          <strong> Technical data:</strong> standard server logs (IP address,
          timestamps, requests) used for security and operations.
        </p>

        <h2>2. Bring-Your-Own-Key AI</h2>
        <p>
          If you configure a personal AI provider API key, it is stored only in your
          browser&rsquo;s local storage and sent with your requests to authenticate
          against that provider. We do not persist your provider keys on our servers.
        </p>

        <h2>3. How We Use Information</h2>
        <p>
          To operate the Services: generating designs, maintaining your run history,
          enforcing plan limits, processing subscriptions, providing support, and
          securing the platform. Board descriptions are processed by third-party AI
          model providers (such as Anthropic) to power the design interview, reviews,
          and diagnosis; component lookups may be sent to distributor APIs (such as
          DigiKey) without your identity attached.
        </p>

        <h2>4. What We Don&rsquo;t Do</h2>
        <p>
          We do not sell your personal information. We do not use your private board
          designs to market to third parties. Your designs are visible only to your
          account unless you share them.
        </p>

        <h2>5. Cookies</h2>
        <p>
          We use a session cookie to keep you signed in and short-lived cookies during
          OAuth sign-in and checkout. No third-party advertising cookies.
        </p>

        <h2>6. Data Retention and Deletion</h2>
        <p>
          Account and run data are retained while your account is active. Email
          <a href="mailto:jack@thestardrive.com"> jack@thestardrive.com</a> to request
          deletion of your account and associated data; we will honor verified
          requests within 30 days, subject to legal retention obligations.
        </p>

        <h2>7. Security</h2>
        <p>
          Passwords are hashed (scrypt), sessions are signed, and access to run
          artifacts requires authentication. No system is perfectly secure; use a
          unique password.
        </p>

        <h2>8. Children</h2>
        <p>The Services are not directed to children under 13.</p>

        <h2>9. Changes</h2>
        <p>
          We may update this policy; material changes will be posted here with an
          updated date.
        </p>

        <h2>Contact</h2>
        <p>
          StarDrive Inc., <a href="mailto:jack@thestardrive.com">jack@thestardrive.com</a>
        </p>

        <p>
          <Link href="/" className="compose-link">&larr; Back to FirstLight</Link>
        </p>
      </div>
    </main>
  );
}
